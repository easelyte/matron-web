/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * React binding for the Files write confirm machine (Phase 2, T-3.2/T-3.3). Owns the phase state,
 * performs the FilesApi call for whichever write is pending, and reports the outcome back through
 * the reducer. The pane above it stays declarative: it calls `begin(...)` from an affordance and
 * renders <FileWriteDialog> when `state` is set.
 *
 * Two guards that are NOT in the disabled attributes:
 *  - `inFlight` — a synchronous ref set before the first await, so two clicks landing in the same
 *    tick cannot both issue a destructive request (a `disabled` prop only takes effect after the
 *    re-render).
 *  - `alive` — the hook drops every outcome after unmount, so a slow delete that resolves once the
 *    pane is closed can never dispatch into a dead tree or fire a refresh.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { JournalApiError } from "../api";
import { REPLAY_WINDOW_MS } from "./limits";
import type { FilesApiLike } from "./filesApi";
import { messageForFileStatus, readEditableText, sanitizeFileName } from "./filesApi";
import { joinPath } from "./format";
import {
    advanceUpload,
    targetLabel,
    uploadHead,
    writeReducer,
    type PendingWrite,
    type WriteInput,
    type WriteState,
} from "./writeActions";

export interface FileWrites {
    /** Undefined = idle (no dialog). */
    state: WriteState | undefined;
    begin: (pending: PendingWrite) => void;
    cancel: () => void;
    submit: (input: WriteInput) => void;
    /** Transient post-write line for the pane (dry-run, already-gone, trash destination). */
    notice: string | undefined;
    dismissNotice: () => void;
}

interface Outcome {
    /** The remaining head of an upload queue. PARKED by the caller, never opened directly. */
    next?: PendingWrite;
    notice?: string;
}

function newKey(): string {
    return crypto.randomUUID();
}

/**
 * A refusal raised in THIS module, before any request was issued: an empty name, a draft that went
 * stale, a file that is not text. Nothing reached the server, so the outcome is definite BY
 * CONSTRUCTION — and that has to be expressible as more than "status 0", because a lost response
 * carries status 0 too. Overloading the HTTP status to mean two opposite things is what made these
 * local refusals masquerade as unconfirmed mutations.
 */
class LocalRefusal extends JournalApiError {}

async function perform(
    api: FilesApiLike,
    pending: PendingWrite,
    input: WriteInput,
    idempotencyKey: string,
): Promise<Outcome> {
    switch (pending.kind) {
        case "mkdir": {
            const name = sanitizeFileName(input.name ?? "");
            if (!name) throw new LocalRefusal("Enter a folder name.", 0, "invalid-name");
            const result = await api.mkdir(joinPath(pending.dir, name));
            return { notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "rename": {
            const name = sanitizeFileName(input.name ?? "");
            if (!name) throw new LocalRefusal("Enter a name.", 0, "invalid-name");
            const result = await api.move(pending.path, joinPath(pending.dir, name), { idempotencyKey });
            return { notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "upload": {
            const file = uploadHead(pending);
            if (!file) return {};
            const result = await api.upload(file, { targetDir: pending.dir, name: input.name, idempotencyKey });
            // A new target gets its own key when it is released; the current one is never reused.
            return { next: advanceUpload(pending), notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "edit": {
            // Lost-update guard. The dialog read the file when it opened; an agent may have
            // rewritten it since. Re-read immediately before the overwrite and refuse if the bytes
            // moved, so a stale draft cannot silently replace newer content. This is a NARROWING
            // check, not an atomic one: the wire contract carries no revision token / If-Match, so
            // a write landing inside this last millisecond window is still possible (and is what a
            // server-side expected-revision check would have to close). The prior version does go
            // to .matron-trash/, so even the residual case stays recoverable.
            const content = input.content ?? "";
            if (input.baseline !== undefined) {
                // Same STRICT read the editor opened with — comparing non-fatally decoded strings
                // could let two different byte sequences look identical and defeat the guard.
                const reread = await readEditableText(api, pending.path);
                if (!reread.ok) {
                    throw new LocalRefusal(
                        "This file is no longer valid UTF-8 text on the server, so it can't be saved from here.",
                        0,
                        "not-text",
                    );
                }
                const current = reread.text;
                if (current === content && current !== input.baseline) {
                    // The file already IS what we were about to write: an earlier attempt committed
                    // and only its response was lost. Report the truth (done) rather than a bogus
                    // "someone else changed this" — the retry of an ambiguous success must resolve,
                    // not deadlock behind the stale-edit guard.
                    return { notice: `${pending.name} was already saved.` };
                }
                if (current !== input.baseline) {
                    throw new LocalRefusal(
                        "This file changed on the server after you opened it. Close the editor and reopen it so you are editing the current version.",
                        0,
                        "stale-edit",
                    );
                }
            }
            // overwrite:true — the edit affordance only exists for a file that is already there,
            // and the server copies the prior version into .matron-trash/ before replacing it.
            const result = await api.writeFile(pending.path, content, { overwrite: true, idempotencyKey });
            return { notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "delete": {
            const result = await api.deleteEntry(pending.path, {
                confirm: true,
                recursive: pending.isDir,
                idempotencyKey,
            });
            if (result.dryRun) return { notice: DRY_RUN_NOTICE };
            if (result.alreadyMissing) return { notice: `${pending.name} was already gone.` };
            return {
                notice: result.trashed
                    ? `${pending.name} moved to ${result.trashed}`
                    : `${pending.name} was moved to the server's trash.`,
            };
        }
    }
}

const DRY_RUN_NOTICE = "The server is in dry-run mode: it recorded the request and changed nothing.";

/**
 * Has the pinned replay stopped being one? True as soon as EITHER deadline has passed: the wall
 * clock (what the server's TTL is nominally measured in) or the monotonic one (which a clock
 * adjustment cannot move). Taking the earlier of the two means a rollback or a sleeping laptop can
 * only ever cost a replay that was still valid — never grant one that was not.
 */
function replayHasLapsed(state: WriteState): boolean {
    if (state.replayExpiresAt !== undefined && Date.now() >= state.replayExpiresAt) return true;
    return state.replayExpiresAtMono !== undefined && performance.now() >= state.replayExpiresAtMono;
}

// Transport-level codes whose own message is a bare internal string; these take the uniform copy.
const TRANSPORT_CODES = new Set(["timeout", "disposed", "aborted"]);

/**
 * Did this failure leave the outcome UNKNOWN (the request may have committed) rather than
 * definitely refused? Classified by where the refusal CAME FROM, because the HTTP status alone
 * cannot say: status 0 covers both a lost response and a local pre-flight refusal, and a 2xx can
 * arrive with a body we cannot read — a write that certainly DID commit.
 *
 *  - LocalRefusal            → definite. Nothing was sent.
 *  - `disposed`              → definite. The session was torn down; the pane is going away with it.
 *  - status 0 (transport)    → UNKNOWN. Timed out, dropped, or an unparseable/absent reply.
 *  - 2xx with a bad body     → UNKNOWN, and specifically likely-COMMITTED: the server answered
 *                              success and we could not read it (filesApi's JSON.parse throw keeps
 *                              the response status). Classifying this as definite is what let a
 *                              delete be blind-retried and a fresh key be minted over a write that
 *                              had already landed.
 *  - 408 / any 5xx           → UNKNOWN, 507 included. A gateway that timed out or lost an upstream
 *                              success it never saw is indistinguishable from one that stopped the
 *                              request — except that the first one committed. 507 was previously
 *                              carved out as definite because the JOURNAL raises it only from
 *                              write-ahead gates (audit-fail-closed, trash-write-failed,
 *                              metadata-preserve-failed), all of which refuse before the
 *                              irreversible call. That reasoning authenticates the status by its
 *                              CONTENT, which nothing on the wire supports: any intermediary can
 *                              emit 507, including one that ran out of storage while relaying a
 *                              response to a write that had already committed. Believing it there
 *                              makes a retried delete remove the replacement. Until the origin is
 *                              provable (a signed reason the client can read), the conservative
 *                              reading is the only sound one.
 *  - other 4xx               → definite. An application verdict: nothing happened.
 *  - anything not typed      → UNKNOWN. An unrecognized shape is not evidence of non-mutation.
 */
function outcomeIsUnknown(error: unknown): boolean {
    if (error instanceof LocalRefusal) return false;
    if (!(error instanceof JournalApiError)) return true;
    if (error.code === "disposed") return false;
    if (error.status === 0) return true;
    if (error.status >= 200 && error.status < 300) return true;
    return error.status === 408 || error.status >= 500;
}

function describeFailure(error: unknown): string {
    if (error instanceof JournalApiError) {
        // A success status we could not read. `messageForFileStatus` has no copy for a 2xx (it maps
        // to the generic loading error), and "something went wrong" would be a lie in the one
        // direction that matters: the change most likely WENT THROUGH.
        if (error.status >= 200 && error.status < 300) {
            return "The server accepted this but its reply couldn't be read, so the result is unconfirmed.";
        }
        if (outcomeIsUnknown(error)) {
            return "The server didn't confirm this, so it may or may not have gone through.";
        }
        // Client-side refusals (bad name, stale edit, unconfirmed response) carry their own
        // specific, actionable message. Server DENIALS get the uniform, reason-agnostic copy so the
        // UI never leaks WHY a path was rejected.
        const ownMessage = error.status === 0 && error.code !== undefined && !TRANSPORT_CODES.has(error.code);
        return ownMessage ? error.message : messageForFileStatus(error.status, error.code);
    }
    return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * What the pane currently knows about the directory, so a SUSPENDED upload queue can be resumed
 * only once the reconciling re-read has actually answered for the same place it was queued in.
 *
 * `settled` and `writable` are deliberately SEPARATE. `writable` alone conflates "the re-read has
 * not answered yet" with "the answer was no", and a parked queue has to treat those oppositely:
 * the first is a wait, the second is terminal. Collapsing them left the queue parked on a
 * read-only answer, where a later swing back to writable (another listing of the same directory —
 * toggling hidden files, a retry) would resurrect a selection the operator had been told was gone.
 *
 * `writable` is the SERVER's answer for this exact directory (`listingIsWritable(ctx, realDir)` in
 * the journal's files-write-http.js, returned by /files/list). It is an affordance gate, not the
 * security boundary: the write endpoints re-check `fileEnableWrites`/`fileWriteRoots` and run the
 * path guard on every request, so a stale `true` here costs a rejected request, not an
 * unauthorized write.
 */
export interface DirectoryReadiness {
    /**
     * The listing's own three states, passed through rather than collapsed. Each means something
     * different to a parked queue: `loading` is the barrier (wait), `error` is "ask again" (wait,
     * with a Retry on screen — a dropped socket must not cost the operator their selection, and the
     * notice explicitly promises the files will be offered again), and only `loaded` is an
     * ANSWER — which either authorizes the rest of the selection or ends it.
     */
    status: "loading" | "loaded" | "error";
    /** The server says this directory accepts writes right now. Only meaningful when loaded. */
    writable: boolean;
    path: string;
}

export function useFileWrites(
    api: FilesApiLike | undefined,
    onWritten: () => void,
    directory: DirectoryReadiness,
): FileWrites {
    const [state, dispatch] = useReducer(writeReducer, undefined);
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const stateRef = useRef<WriteState | undefined>(undefined);
    stateRef.current = state;
    const inFlight = useRef(false);
    const alive = useRef(true);
    useEffect(() => {
        // Set on SETUP, not just at ref init: StrictMode replays passive effects as
        // setup -> cleanup -> setup, so an init-only `true` would be left false by the first
        // cleanup and every later write would have its outcome dropped, wedging the dialog in
        // `mutating` forever (P23 — no unreachable terminal state).
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    /**
     * The tail of an upload selection whose head expired unresolved. Parked here rather than in
     * reducer state because it is deliberately NOT a pending write yet: it must not render, and
     * must not be submittable, until the reconciling re-read has answered.
     */
    const held = useRef<PendingWrite | undefined>(undefined);

    const begin = useCallback((pending: PendingWrite) => {
        setNotice(undefined);
        // A new write the operator started themselves supersedes anything parked.
        held.current = undefined;
        // One key per TARGET, minted here and kept through every retry of that target.
        dispatch({ type: "open", pending, idempotencyKey: newKey() });
    }, []);
    // Give up on an UNRESOLVED write and go and look at the server instead. An attempt may have
    // landed, so this is not a no-op: re-read the directory and say so, and let the pane's own
    // `writable`-is-derived-from-the-listing rule take the write affordances away until it answers
    // (FilesPane.onWritten). The operator decides from what is actually there rather than
    // repeating the write under a fresh key and ending up with two copies.
    const reconcile = useCallback(
        (current: WriteState, expired: boolean) => {
            const label = targetLabel(current.pending, current.replay);
            // An EXPIRY is not a decision the operator made — it is a deadline passing while they
            // were reading the notice. Reconciling the whole PendingWrite would take the rest of a
            // multi-file selection with it: files they never saw, dropped under a message naming
            // only the first. So the queue is carried forward on expiry.
            //
            // But it is SUSPENDED, not re-opened here. This re-read is the reconciliation barrier
            // (FilesPane): every write affordance goes away until a fresh listing lands, precisely
            // so no further mutation can be aimed at directory state the operator was just told to
            // go and check. Opening the next dialog immediately would punch a hole straight
            // through it — the dialog renders independently of `writable`, so its confirm button
            // would still send while the re-read was in flight, had failed, or had come back
            // read-only. The queue is released by the effect below, once the barrier lifts.
            //
            // An explicit cancel is the opposite — the operator asking to stop — and still
            // abandons the selection.
            const next = expired && current.pending.kind === "upload" ? advanceUpload(current.pending) : undefined;
            held.current = next;
            dispatch({ type: "cancel" });

            const queued = next?.kind === "upload" ? next.files.length - next.index : 0;
            const stillQueued =
                queued > 0
                    ? ` ${queued} more file${queued === 1 ? "" : "s"} from that selection ${queued === 1 ? "is" : "are"} still queued — ${queued === 1 ? "it" : "they"} will be offered again once the folder has been re-read.`
                    : "";
            setNotice(
                expired
                    ? `Couldn't confirm whether ${label} was written, and it can no longer be retried safely. The folder is being re-read — check what is actually there.${stillQueued}`
                    : `Couldn't confirm whether ${label} was written. The folder is being re-read — check what is actually there before trying again.`,
            );
            onWritten();
        },
        [onWritten],
    );

    const cancel = useCallback(() => {
        held.current = undefined;
        const current = stateRef.current;
        if (current?.phase === "confirming" && current.replay !== undefined) {
            reconcile(current, false);
            return;
        }
        dispatch({ type: "cancel" });
    }, [reconcile]);

    // A pin is only a replay while the SERVER still remembers the key. Stop offering the retry
    // before that window closes, rather than letting the confirm button quietly turn into a second
    // mutation behind copy that still promises a replay.
    const replayExpiresAt = state?.phase === "confirming" ? state.replayExpiresAt : undefined;
    const replayExpiresAtMono = state?.phase === "confirming" ? state.replayExpiresAtMono : undefined;
    useEffect(() => {
        if (replayExpiresAt === undefined && replayExpiresAtMono === undefined) return;
        // Fire on whichever deadline arrives first — the wall clock can be moved, the monotonic
        // one cannot, and the replay has to end at the earlier of the two.
        const delays = [
            replayExpiresAt === undefined ? undefined : replayExpiresAt - Date.now(),
            replayExpiresAtMono === undefined ? undefined : replayExpiresAtMono - performance.now(),
        ].filter((value): value is number => value !== undefined);
        const timer = setTimeout(
            () => {
                const current = stateRef.current;
                if (current?.phase === "confirming" && current.replay !== undefined) reconcile(current, true);
            },
            Math.max(0, Math.min(...delays)),
        );
        return () => clearTimeout(timer);
    }, [replayExpiresAt, replayExpiresAtMono, reconcile]);

    // Release a suspended upload queue once the barrier lifts: a listing has landed, it is still
    // writable, and it is the SAME directory the files were queued for. A refresh that fails, or
    // that comes back without the capability, simply never releases it — the operator is left in
    // the read-only view the server actually authorized, which is the safe way round. Navigating
    // elsewhere drops it: that is the operator moving on, and resuming into another directory
    // would aim their selection somewhere they never chose.
    const { status: dirStatus, writable: dirWritable, path: dirPath } = directory;
    useEffect(() => {
        const next = held.current;
        if (next === undefined) return;
        // Navigation is checked FIRST and unconditionally. A destination that never becomes
        // writable would otherwise leave the selection parked, and coming back to the original
        // directory later would resurrect a dialog the operator had reason to believe was gone.
        if (next.kind !== "upload" || next.dir !== dirPath) {
            held.current = undefined;
            return;
        }
        // Still out, or it failed and the operator has a Retry in front of them: the barrier stays
        // up and the queue waits. A transient network error is not an answer, and treating it as
        // one silently discarded files the notice had just promised would be offered again.
        if (dirStatus !== "loaded") return;
        // It ANSWERED. Either it authorizes the rest of the selection or the selection is over —
        // there is no third state in which the queue lingers, waiting to be re-entered later.
        held.current = undefined;
        if (!dirWritable) return;
        dispatch({ type: "open", pending: next, idempotencyKey: newKey() });
    }, [dirStatus, dirWritable, dirPath]);

    const dismissNotice = useCallback(() => {
        setNotice(undefined);
    }, []);

    const submit = useCallback(
        (input: WriteInput) => {
            const current = stateRef.current;
            if (!current || current.phase !== "confirming") return;
            if (inFlight.current) return; // synchronous double-submit guard
            if (!dirWritable) {
                // The capability is re-checked HERE, at the moment of acting, not only where the
                // affordance was rendered. The dialog outlives the listing that opened it — a
                // re-read can be in flight, have failed, or have come back without write access
                // while it sits there — and a check that gates only the rendering does not gate
                // the action (P19). Backstop to the barrier above, not a replacement for it.
                setNotice(
                    `Writing isn't available in this folder right now, so ${targetLabel(current.pending, current.replay)} wasn't sent.`,
                );
                held.current = undefined;
                dispatch({ type: "cancel" });
                return;
            }
            if (replayHasLapsed(current)) {
                // The timer above normally gets here first, but a backgrounded tab has its timers
                // throttled — so the deadline is enforced where it matters, on the send.
                reconcile(current, true);
                return;
            }
            if (!api) {
                // `failed` is only meaningful from `mutating`, so step through it — otherwise the
                // reducer drops the event and the dialog sits there with no explanation.
                dispatch({ type: "submit" });
                dispatch({
                    type: "failed",
                    message: messageForFileStatus(401),
                    idempotencyKey: current.idempotencyKey,
                });
                return;
            }
            inFlight.current = true;
            // While an outcome is unresolved the payload is PINNED: the retry has to be a replay of
            // the attempt that may already have committed, never whatever the fields now hold. The
            // dialog locks its fields for the same reason; this is the enforcement, not the hint.
            const attempt = current.replay ?? input;
            // Stamped BEFORE the request leaves, because that is what the server's clock is
            // measuring against — see the deadline note where `failed` is dispatched. Both clocks
            // are read: wall for the server's TTL, monotonic so a backwards wall-clock adjustment
            // cannot extend the window.
            const sentAt = Date.now();
            const sentAtMono = performance.now();
            dispatch({ type: "submit" });
            void (async () => {
                try {
                    const outcome = await perform(api, current.pending, attempt, current.idempotencyKey);
                    if (!alive.current) return;
                    setNotice(outcome.notice);
                    // The rest of the selection goes behind the barrier, exactly like the expiry
                    // path: this success triggers a re-read, and until that answers there is no
                    // current listing to authorize the next write. Dispatching it as a successor
                    // here would leave a live confirm button in front of a directory whose
                    // capability may have just been revoked.
                    held.current = outcome.next;
                    dispatch({ type: "settled" });
                    // Refresh AFTER the transition so the listing and the dialog agree; runs for
                    // every success, including mid-queue uploads.
                    onWritten();
                } catch (error) {
                    if (!alive.current) return;
                    if (current.pending.kind === "delete" && outcomeIsUnknown(error)) {
                        // DELETE now carries an `Idempotency-Key`, so a retry CAN be a replay — but
                        // only against a journal whose reservation survived, and nothing on the
                        // wire proves this 5xx even came from the journal rather than an
                        // intermediary that already let the write through. Making the operator's
                        // safety depend on which journal build is deployed is the wrong trade, so
                        // the conservative reading stands: close the dialog, re-read the listing,
                        // and let them look at what is actually there before deleting again.
                        setNotice(
                            `Couldn't confirm whether ${current.pending.name} was deleted. The folder has been refreshed — check it before trying again.`,
                        );
                        dispatch({ type: "settled" });
                        onWritten();
                        return;
                    }
                    const unresolved = outcomeIsUnknown(error);
                    dispatch({
                        type: "failed",
                        message: describeFailure(error),
                        // Uncertain → keep the key so the retry replays. Definite → mint a new one.
                        idempotencyKey: unresolved ? current.idempotencyKey : newKey(),
                        // ...and a replay needs the same BODY as well as the same key, or the
                        // server's key+payload fingerprint refuses it as a conflict.
                        replay: unresolved ? attempt : undefined,
                        // ONE deadline per unresolved write, anchored to the first send and carried
                        // across every later failure. Two reasons it cannot be measured from HERE:
                        // a request can commit immediately and still not reject until the 120s
                        // write timeout, by which point a window measured from the failure is
                        // already fiction; and re-deriving it per attempt RENEWS it on each
                        // ambiguous retry, so a write could stay "retryable" indefinitely while the
                        // server's 120s record aged out underneath it. The server starts counting
                        // when it settles, which is at or after the send — so anchoring here is the
                        // conservative end of the skew, which is the end we want to be wrong on.
                        replayExpiresAt: unresolved
                            ? (current.replayExpiresAt ?? sentAt + REPLAY_WINDOW_MS)
                            : undefined,
                        replayExpiresAtMono: unresolved
                            ? (current.replayExpiresAtMono ?? sentAtMono + REPLAY_WINDOW_MS)
                            : undefined,
                    });
                } finally {
                    inFlight.current = false;
                }
            })();
        },
        [api, dirWritable, onWritten, reconcile],
    );

    return { state, begin, cancel, submit, notice, dismissNotice };
}
