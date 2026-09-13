/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Files-pane write confirm machine (Phase 2, T-3.2) — pure, no React, no DOM, so the safety rules
 * are unit-testable in isolation from the dialog that renders them.
 *
 * Three phases per P23: `idle` (no pending write — represented by `undefined`), `confirming` (the
 * dialog is up and the operator has NOT yet agreed), `mutating` (the request is in flight). The
 * load-bearing invariants, all enforced here rather than in the components:
 *
 *   1. No write leaves the client without passing through `confirming` → `submit`. There is no
 *      transition from idle straight to mutating.
 *   2. `submit` while already `mutating` is ignored — the double-submit guard is in the machine,
 *      not in a disabled attribute that a fast second click can beat.
 *   3. `cancel` (Escape / ✕ / backdrop) is ignored while `mutating` — a destructive request that
 *      is already on the wire cannot be "cancelled" client-side, and pretending otherwise would
 *      tell the operator nothing happened when the server is busy trashing a directory.
 *   4. A failure returns to `confirming` WITH the error, so the dialog explains itself and the
 *      operator can retry or back out — it never silently closes over a failed destructive op.
 */

import { extensionOf, joinPath } from "./format";
import { sanitizeFileName } from "./filesApi";

/** What the operator asked for. The editable input (new name, text content) lives in the dialog. */
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
     * The `Idempotency-Key` for THIS target, minted once when the write is opened and retained
     * across every failed attempt + retry (V2/P32). Minting it per API call instead would defeat
     * the point: a retry after a lost response would look like a brand-new mutation to the server
     * and be executed a second time. A new key is minted only for a genuinely new target (the next
     * file in an upload queue), never for a retry of the same one.
     */
    idempotencyKey: string;
    /** Surfaced inside the dialog after a failed attempt (uniform messageForFileStatus copy). */
    error?: string;
}

export type WriteEvent =
    // Keys are minted by the caller, not here — the reducer stays pure (no crypto.randomUUID).
    | { type: "open"; pending: PendingWrite; idempotencyKey: string }
    | { type: "submit" }
    /** The request succeeded. `next` carries the remaining upload queue head, if any. */
    | { type: "settled"; next?: PendingWrite; nextKey?: string }
    | { type: "failed"; message: string }
    | { type: "cancel" };

export function writeReducer(state: WriteState | undefined, event: WriteEvent): WriteState | undefined {
    switch (event.type) {
        case "open":
            // Never interrupt an in-flight mutation with a new dialog (invariant 3's corollary:
            // the operator would otherwise lose the outcome of the destructive op they just ran).
            if (state?.phase === "mutating") return state;
            return { pending: event.pending, phase: "confirming", idempotencyKey: event.idempotencyKey };
        case "submit":
            if (!state || state.phase !== "confirming") return state;
            return { pending: state.pending, phase: "mutating", idempotencyKey: state.idempotencyKey };
        case "settled":
            if (state?.phase !== "mutating") return state;
            return event.next
                ? { pending: event.next, phase: "confirming", idempotencyKey: event.nextKey ?? state.idempotencyKey }
                : undefined;
        case "failed":
            if (state?.phase !== "mutating") return state;
            // The key survives the failure — that is what makes the retry a replay, not a re-run.
            return {
                pending: state.pending,
                phase: "confirming",
                idempotencyKey: state.idempotencyKey,
                error: event.message,
            };
        case "cancel":
            if (state?.phase === "mutating") return state;
            return undefined;
    }
}

/** Escape / ✕ / backdrop may dismiss only while the operator still owns the decision. */
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
 * What the operator gets back if this was a mistake. Both destructive paths are recoverable via
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
