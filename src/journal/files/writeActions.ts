/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Files-pane write confirm machine — pure, no React, no DOM, so the safety rules
 * are unit-testable in isolation from the dialog that renders them.
 *
 * Three phases: `idle` (no pending write — represented by `undefined`), `confirming` (the
 * dialog is up and the user has NOT yet agreed), `mutating` (the request is in flight). The
 * load-bearing invariants, all enforced here rather than in the components:
 *
 *   1. No write leaves the client without passing through `confirming` → `submit`. There is no
 *      transition from idle straight to mutating.
 *   2. `submit` while already `mutating` is ignored — the double-submit guard is in the machine,
 *      not in a disabled attribute that a fast second click can beat.
 *   3. `cancel` (Escape / ✕ / backdrop) is ignored while `mutating` — a destructive request that
 *      is already on the wire cannot be "cancelled" client-side, and pretending otherwise would
 *      tell the user nothing happened when the server is busy trashing a directory.
 *   4. A failure returns to `confirming` WITH the error, so the dialog explains itself and the
 *      user can retry or back out — it never silently closes over a failed destructive op.
 */

import { extensionOf, joinPath } from "./format";
import { sanitizeFileName } from "./filesApi";

/**
 * What the user typed for the pending write. It lives HERE rather than in the dialog because
 * the machine has to be able to hold onto one: an attempt whose outcome is unknown pins the exact
 * payload it sent, so the retry is a byte-for-byte replay (see WriteState.replay).
 */
export interface WriteInput {
    name?: string;
    content?: string;
    /**
     * For an edit: the bytes the editor was seeded with. The hook re-reads the file immediately
     * before saving and refuses if it no longer matches, so a draft that went stale while the
     * dialog sat open cannot silently replace newer content.
     */
    baseline?: string;
}

/** What the user asked for. The editable input (new name, text content) lives in the dialog. */
export type PendingWrite =
    | { kind: "mkdir"; dir: string }
    | { kind: "rename"; dir: string; path: string; name: string; isDir: boolean }
    | { kind: "delete"; path: string; name: string; isDir: boolean }
    | { kind: "upload"; dir: string; files: File[]; index: number }
    | { kind: "edit"; path: string; name: string };

export interface WriteState {
    pending: PendingWrite;
    phase: "confirming" | "mutating";
    /**
     * The `Idempotency-Key` for the next attempt at this target. Minted when the write is opened
     * and RETAINED across an uncertain failure (timeout / dropped response), which is what makes
     * that retry a replay rather than a second mutation. It is REPLACED after a definite
     * refusal: nothing happened, and the user is being told to change the name, so carrying the
     * key over would hand the server a different payload under a key it has already fingerprinted.
     */
    idempotencyKey: string;
    /** Surfaced inside the dialog after a failed attempt (uniform messageForFileStatus copy). */
    error?: string;
    /**
     * The payload of an attempt whose outcome is UNKNOWN, pinned so the retry replays it exactly.
     *
     * Retaining the key alone is not enough. The server fingerprints key + request body, so a
     * retry that carries the same key with a CHANGED payload is refused with the same reason-
     * agnostic 409 as a name collision — the client cannot tell the two apart on the wire, reads
     * it as a definite refusal, and mints a fresh key. The next attempt then executes as a NEW
     * mutation, leaving the silently-committed original AND the renamed copy. So while the
     * outcome is unresolved the payload is not the user's to change: the dialog locks its
     * fields, and the hook submits THIS, not whatever the fields hold. Cancel is the way out, and
     * it re-reads the listing so the user sees what actually landed before deciding again.
     *
     * The server side of this was read, not assumed (matron-journal `src/files-write-http.js`):
     * `reserve(key, fingerprint)` throws `idem-key-conflict` when a key returns with a different
     * fingerprint, and `denialToStatus` maps that to 409 with a bare `{error:'denied'}` body — no
     * distinguishing reason, which is exactly why the client cannot classify that 409 and has to
     * prevent the mismatch instead. That replay window is FINITE — `IDEM_TTL_MS`, 120s
     * — so the pin carries an expiry (`replayExpiresAt`) and the write stops being retryable
     * before the key can age out, rather than quietly becoming a second mutation behind a UI that
     * still promises a replay. What is left after that is a SERVER-side gap, not a client one:
     * reconciling an unresolved write against what actually happened needs an outcome the server
     * can still be asked for.
     */
    replay?: WriteInput;
    /**
     * When the pinned replay stops BEING a replay (see limits.REPLAY_WINDOW_MS). Minted by the
     * caller, like the key — the reducer reads no clock. Past it the write is no longer retryable
     * and the hook reconciles against the server instead of sending.
     */
    replayExpiresAt?: number;
    /**
     * The same deadline on a MONOTONIC clock (`performance.now()`). The wall-clock one above is
     * what the server's TTL is nominally measured in, but a wall clock can be set BACKWARDS — by
     * NTP correction, by the user, by a laptop waking up — and a rollback between the send and
     * the failure would leave the client inside an apparent window the server had already left in
     * real elapsed time, quietly turning the next retry into a fresh mutation. Whichever of the two
     * elapses first ends the replay, so a rollback can only ever make the client MORE conservative.
     */
    replayExpiresAtMono?: number;
}

export type WriteEvent =
    // Keys are minted by the caller, not here — the reducer stays pure (no crypto.randomUUID).
    | { type: "open"; pending: PendingWrite; idempotencyKey: string }
    | { type: "submit" }
    /**
     * The request succeeded. It carries NO successor: the remaining head of an upload queue is
     * parked by the hook and released only once the post-write re-read has landed and the
     * directory is still writable. Opening it from here would put a submittable dialog in front of
     * the user while the listing that authorizes it is still in flight.
     */
    | { type: "settled" }
    /**
     * `idempotencyKey` is the key to use for the NEXT attempt. The caller retains the current one
     * after an UNCERTAIN failure (so the retry replays) and mints a fresh one after a DEFINITE
     * refusal — where nothing happened, and where the user is invited to change the name, so
     * reusing the key would present the server a different payload under the same key.
     */
    | {
          type: "failed";
          message: string;
          idempotencyKey: string;
          replay?: WriteInput;
          replayExpiresAt?: number;
          replayExpiresAtMono?: number;
      }
    | { type: "cancel" };

export function writeReducer(state: WriteState | undefined, event: WriteEvent): WriteState | undefined {
    switch (event.type) {
        case "open":
            // Never interrupt an in-flight mutation with a new dialog (invariant 3's corollary:
            // the user would otherwise lose the outcome of the destructive op they just ran).
            if (state?.phase === "mutating") return state;
            return { pending: event.pending, phase: "confirming", idempotencyKey: event.idempotencyKey };
        case "submit":
            if (!state || state.phase !== "confirming") return state;
            return { pending: state.pending, phase: "mutating", idempotencyKey: state.idempotencyKey };
        case "settled":
            if (state?.phase !== "mutating") return state;
            return undefined;
        case "failed":
            if (state?.phase !== "mutating") return state;
            return {
                pending: state.pending,
                phase: "confirming",
                idempotencyKey: event.idempotencyKey,
                error: event.message,
                // Present only for an UNCERTAIN failure; a definite refusal clears it, because
                // nothing happened and the user is being asked to change the name.
                replay: event.replay,
                replayExpiresAt: event.replayExpiresAt,
                replayExpiresAtMono: event.replayExpiresAtMono,
            };
        case "cancel":
            if (state?.phase === "mutating") return state;
            return undefined;
    }
}

/**
 * Is this write's outcome unresolved (an attempt may have committed, and we could not confirm it)?
 * Such a write must not be retried with a changed payload, and dismissing it has to re-read the
 * listing rather than drop the user back into a stale view of the directory.
 */
export function isUnresolved(state: WriteState | undefined): boolean {
    return state?.phase === "confirming" && state.replay !== undefined;
}

/** How to refer to the target in user-facing copy. */
export function targetLabel(pending: PendingWrite, input?: WriteInput): string {
    const typed = input?.name ? sanitizeFileName(input.name) : undefined;
    if (typed) return typed;
    if (pending.kind === "upload") return uploadHead(pending)?.name ?? "that upload";
    if (pending.kind === "mkdir") return "that folder";
    return pending.name;
}

/** Escape / ✕ / backdrop may dismiss only while the user still owns the decision. */
export function canDismiss(state: WriteState | undefined): boolean {
    return state !== undefined && state.phase === "confirming";
}

/**
 * Destructive = the write can destroy content that exists right now (delete, overwrite-on-save).
 * Drives the destructive button treatment AND the recovery note. `mkdir`/`upload`/`rename` only
 * ever ADD or relocate — the server refuses a colliding destination rather than clobbering it.
 */
export function isDestructive(pending: PendingWrite): boolean {
    return pending.kind === "delete" || pending.kind === "edit";
}

/** The file a queued upload is currently confirming. */
export function uploadHead(pending: PendingWrite): File | undefined {
    return pending.kind === "upload" ? pending.files[pending.index] : undefined;
}

/** Next queue position after a successful upload, or undefined when the queue is drained. */
export function advanceUpload(pending: PendingWrite): PendingWrite | undefined {
    if (pending.kind !== "upload") return undefined;
    const index = pending.index + 1;
    return index < pending.files.length ? { ...pending, index } : undefined;
}

/** Dialog title. Deliberately states the ACT ("Delete", "Replace"), never a neutral "Confirm". */
export function titleFor(pending: PendingWrite): string {
    switch (pending.kind) {
        case "mkdir":
            return "New folder";
        case "rename":
            return pending.isDir ? "Rename folder" : "Rename file";
        case "delete":
            return pending.isDir ? "Delete folder" : "Delete file";
        case "upload":
            return "Upload file";
        case "edit":
            return "Edit file";
    }
}

/** Primary-button label. Same rule: name the act, so the destructive one is never "OK". */
export function confirmLabelFor(pending: PendingWrite): string {
    switch (pending.kind) {
        case "mkdir":
            return "Create folder";
        case "rename":
            return "Rename";
        case "delete":
            return "Delete";
        case "upload":
            return "Upload";
        case "edit":
            return "Save changes";
    }
}

/**
 * What the user gets back if this was a mistake. Both destructive paths are recoverable via
 * the server-side `.matron-trash/` (delete MOVES; overwrite copies the prior version there first),
 * and saying so is the point — an honest destructive confirm tells you the blast radius AND the
 * undo. Non-destructive writes return undefined (nothing to reassure about).
 */
export function recoveryNote(pending: PendingWrite): string | undefined {
    if (pending.kind === "delete") {
        return pending.isDir
            ? "The folder and everything in it moves to .matron-trash/ on the server, so it can still be recovered."
            : "It moves to .matron-trash/ on the server, so it can still be recovered.";
    }
    if (pending.kind === "edit") {
        return "The current version is copied to .matron-trash/ before it is replaced, so it can still be recovered.";
    }
    return undefined;
}

/** The destination path a name-taking write would produce, for the dialog's "→ path" line. */
export function destinationFor(pending: PendingWrite, name: string): string | undefined {
    const clean = sanitizeFileName(name);
    if (!clean) return undefined;
    if (pending.kind === "mkdir" || pending.kind === "upload") return joinPath(pending.dir, clean);
    if (pending.kind === "rename") return joinPath(pending.dir, clean);
    return undefined;
}

/**
 * A name is submittable when it survives sanitization AND actually differs from the current one
 * (renaming a file to its own name would just 409 `dest-exists` at the server).
 */
export function nameIsSubmittable(pending: PendingWrite, name: string): boolean {
    const clean = sanitizeFileName(name);
    if (!clean) return false;
    if (pending.kind === "rename") return clean !== pending.name;
    return true;
}

/** Text-ish entries get the inline edit affordance; everything else stays read-only preview. */
const EDITABLE_EXT = new Set([
    "md",
    "markdown",
    "mdx",
    "txt",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "sh",
    "bash",
    "zsh",
    "py",
    "js",
    "jsx",
    "ts",
    "tsx",
    "css",
    "pcss",
    "scss",
    "html",
    "xml",
    "sql",
    "csv",
    "log",
]);

export function isEditableText(
    entry: { name: string; kind: string; mime: string; size: number },
    max: number,
): boolean {
    if (entry.kind !== "file") return false;
    if (entry.size > max) return false;
    const mime = entry.mime.trim().toLowerCase();
    if (mime.startsWith("text/")) return true;
    if (mime === "application/json" || mime === "application/xml") return true;
    // A server that reports no MIME (or octet-stream for an unknown extension) still gets the
    // affordance for the extensions we KNOW are text — the editor loads the content first, so a
    // wrong guess surfaces as a failed text read, not a corrupted binary.
    return EDITABLE_EXT.has(extensionOf(entry.name));
}
