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
    next?: PendingWrite;
    nextKey?: string;
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
            const next = advanceUpload(pending);
            return {
                next,
                // A new target gets its own key; the current one is never reused for another file.
                nextKey: next ? newKey() : undefined,
                notice: result.dryRun ? DRY_RUN_NOTICE : undefined,
            };
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
            const result = await api.deleteEntry(pending.path, { confirm: true, recursive: pending.isDir });
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
 *  - 507                     → definite. OUR server's explicit "couldn't do this safely": the
 *                              journal raises it only from write-ahead gates (audit-fail-closed
 *                              before any irreversible call, trash-write-failed and
 *                              metadata-preserve-failed before the atomic swap), so it proves
 *                              non-mutation rather than merely reporting trouble.
 *  - 408 / other 5xx         → UNKNOWN. A gateway that timed out or lost an upstream success it
 *                              never saw is indistinguishable from one that stopped the request —
 *                              except that the first one committed.
 *  - other 4xx               → definite. An application verdict: nothing happened.
 *  - anything not typed      → UNKNOWN. An unrecognized shape is not evidence of non-mutation.
 */
function outcomeIsUnknown(error: unknown): boolean {
    if (error instanceof LocalRefusal) return false;
    if (!(error instanceof JournalApiError)) return true;
    if (error.code === "disposed") return false;
    if (error.status === 0) return true;
    if (error.status >= 200 && error.status < 300) return true;
    if (error.status === 507) return false;
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

export function useFileWrites(api: FilesApiLike | undefined, onWritten: () => void): FileWrites {
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

    const begin = useCallback((pending: PendingWrite) => {
        setNotice(undefined);
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
            dispatch({ type: "cancel" });
            setNotice(
                expired
                    ? `Couldn't confirm whether ${label} was written, and it can no longer be retried safely. The folder is being re-read — check what is actually there.`
                    : `Couldn't confirm whether ${label} was written. The folder is being re-read — check what is actually there before trying again.`,
            );
            onWritten();
        },
        [onWritten],
    );

    const cancel = useCallback(() => {
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
    useEffect(() => {
        if (replayExpiresAt === undefined) return;
        const timer = setTimeout(
            () => {
                const current = stateRef.current;
                if (current?.phase === "confirming" && current.replay !== undefined) reconcile(current, true);
            },
            Math.max(0, replayExpiresAt - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [replayExpiresAt, reconcile]);

    const dismissNotice = useCallback(() => setNotice(undefined), []);

    const submit = useCallback(
        (input: WriteInput) => {
            const current = stateRef.current;
            if (!current || current.phase !== "confirming") return;
            if (inFlight.current) return; // synchronous double-submit guard
            if (current.replayExpiresAt !== undefined && Date.now() >= current.replayExpiresAt) {
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
            dispatch({ type: "submit" });
            void (async () => {
                try {
                    const outcome = await perform(api, current.pending, attempt, current.idempotencyKey);
                    if (!alive.current) return;
                    setNotice(outcome.notice);
                    dispatch({ type: "settled", next: outcome.next, nextKey: outcome.nextKey });
                    // Refresh AFTER the transition so the listing and the dialog agree; runs for
                    // every success, including mid-queue uploads.
                    onWritten();
                } catch (error) {
                    if (!alive.current) return;
                    if (current.pending.kind === "delete" && outcomeIsUnknown(error)) {
                        // DELETE is the one write the frozen wire contract gives no
                        // `Idempotency-Key`, so a blind in-dialog retry is not a replay — if the
                        // first request actually committed and another actor recreated the path in
                        // the gap, the retry would delete the REPLACEMENT. Treat an unknown outcome
                        // as unknown: close the dialog, re-read the listing, and make the operator
                        // look at what is actually there before deciding to delete again.
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
                        replayExpiresAt: unresolved ? Date.now() + REPLAY_WINDOW_MS : undefined,
                    });
                } finally {
                    inFlight.current = false;
                }
            })();
        },
        [api, onWritten, reconcile],
    );

    return { state, begin, cancel, submit, notice, dismissNotice };
}
