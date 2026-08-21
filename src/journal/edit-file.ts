/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/**
 * Client-side plumbing for the bridge `edit_file` RPC (loop #548): the guarded,
 * atomic edit of an EXISTING file inside the bridge's pinned allowed roots.
 *
 * The wire contract this MUST match exactly (bridge lib/edit-file.js + journal-rpc.js):
 *   params: {
 *     path: string,                       // absolute, inside a pinned root
 *     // EXACTLY ONE mode — never both keys on the wire:
 *     content?: string,                   // "content" mode: full replace
 *     old_string?: string, new_string?: string,  // "replace" mode: unique splice
 *     expected_sha256?: string,           // optional compare-and-swap (64 hex)
 *   }
 *   ok result: { path: string, bytes: number, mode: "content" | "replace" }
 *   error { code, detail }:
 *     - edit-file's own (underscored):  bad_request | bad_workdir | stale
 *                                       | not_found | ambiguous_match | too_large
 *     - path rejections (hyphenated, verbatim FileLinkDenied reasons):
 *         relative-path | symlink | not-a-file | outside-scope | outside-workdir
 *         | sensitive | unreadable | too-large | bad-workdir
 *     - transport (origin !== "agent"): not_connected | not_ready | timeout | …
 *
 * This module is pure (no React, no network) so the param shape and the
 * error-code mapping — the review-critical CAS + path-safety surface — are unit
 * tested in isolation. The client method is a thin build → agentRpc → classify
 * wrapper.
 */

import { type RpcReply } from "./types";

/** One of the two mutually-exclusive edit modes the RPC accepts. */
export type EditFileEdit =
    { mode: "content"; content: string } | { mode: "replace"; oldString: string; newString: string };

export interface EditFileInput {
    /** Absolute path to an existing file inside a bridge-pinned root. */
    path: string;
    edit: EditFileEdit;
    /**
     * Optional compare-and-swap precondition — the sha256 (hex) the caller
     * believes the file currently holds. When present the bridge applies the
     * edit ONLY if the live content still hashes to it, else -> "stale". Empty
     * string is treated as absent (no precondition).
     */
    expectedSha256?: string;
}

export type EditFileOutcome =
    | { kind: "saved"; path: string; bytes: number; mode: "content" | "replace" }
    /** expected_sha256 no longer matched — the file changed under us. */
    | { kind: "stale" }
    /** replace mode: old_string not present in the file. */
    | { kind: "not-found" }
    /** replace mode: old_string occurs more than once — must be unique. */
    | { kind: "ambiguous" }
    /** the file, or the edited result, exceeds the bridge's size cap. */
    | { kind: "too-large" }
    /** path failed the bridge's safety boundary; `reason` is verbatim. */
    | { kind: "path-rejected"; reason: string }
    /** the bridge has no allowed roots pinned — editing is unavailable there. */
    | { kind: "no-scope" }
    /** malformed request (should not happen from this UI). */
    | { kind: "invalid"; detail?: string }
    /**
     * No reply arrived (timeout/teardown), but the edit MAY have committed —
     * a timeout only proves non-delivery of the RESPONSE, not non-execution.
     * The bridge has no dedupe and treats expected_sha256 as the only replay
     * guard, so a blind retry could apply the edit twice. Verify, don't retry.
     */
    | { kind: "uncertain" }
    /** proven non-delivery (relay refused to forward) — safe to retry. */
    | { kind: "unreachable"; message: string }
    /** unexpected bridge error. */
    | { kind: "error"; message: string };

/** FileLinkDenied reasons the bridge surfaces verbatim as the RPC error code. */
const PATH_REJECT_REASONS: ReadonlySet<string> = new Set([
    "relative-path",
    "symlink",
    "not-a-file",
    "outside-scope",
    "outside-workdir",
    "sensitive",
    "unreadable",
    "bad-workdir",
    // "too-large" is intercepted by the switch above (folded into the
    // too-large outcome alongside edit-file's own too_large), not here.
]);

/**
 * Build the wire params. Guarantees the RPC's exclusive-mode contract: content
 * mode sends ONLY `content`, replace mode sends ONLY `old_string`+`new_string`
 * — never both, which the bridge rejects as bad_request. expected_sha256 is
 * omitted entirely (not sent as "") when absent, so absence reads as absence.
 */
export function buildEditFileParams(input: EditFileInput): Record<string, unknown> {
    const params: Record<string, unknown> = { path: input.path };
    if (input.edit.mode === "content") {
        params.content = input.edit.content;
    } else {
        params.old_string = input.edit.oldString;
        params.new_string = input.edit.newString;
    }
    if (typeof input.expectedSha256 === "string" && input.expectedSha256.length > 0) {
        params.expected_sha256 = input.expectedSha256;
    }
    return params;
}

function transportMessage(code: string): string {
    if (code === "not_connected" || code === "not_ready") return "Still connecting — try again in a moment.";
    if (code === "timeout") return "The box didn't respond — try again.";
    return "Couldn't reach that box — try again.";
}

/**
 * Map an RPC reply onto a UI-ready outcome. Known codes get a typed kind the
 * component renders a specific message + recovery for; anything unknown falls
 * back to a fail-loud `error` carrying the raw code (never a silent success).
 */
export function classifyEditFileReply(reply: RpcReply): EditFileOutcome {
    if (reply.ok) {
        // Parse-don't-validate the success shape: a degraded/version-skewed
        // bridge returning a partial result must NOT render as a false "Saved"
        // (empty path / 0 bytes). Every field is required and exactly typed.
        const result = reply.result;
        if (typeof result === "object" && result !== null && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            const path = record.path;
            const bytes = record.bytes;
            const mode = record.mode;
            if (
                typeof path === "string" &&
                path.length > 0 &&
                typeof bytes === "number" &&
                Number.isInteger(bytes) &&
                bytes >= 0 &&
                (mode === "content" || mode === "replace")
            ) {
                return { kind: "saved", path, bytes, mode };
            }
        }
        return { kind: "error", message: "The edit returned an unexpected response." };
    }
    if (reply.origin !== "agent") {
        // A relay refusal PROVES the request never reached the box, so a retry
        // is safe. A timeout/teardown proves only that no RESPONSE arrived —
        // the edit may already have committed — so it must NOT invite a blind
        // retry (no bridge dedupe). See the "uncertain" outcome. (P32 retry safety)
        if (reply.origin === "relay") {
            return { kind: "unreachable", message: transportMessage(reply.code) };
        }
        return { kind: "uncertain" };
    }
    switch (reply.code) {
        case "stale":
            return { kind: "stale" };
        case "not_found":
            return { kind: "not-found" };
        case "ambiguous_match":
            return { kind: "ambiguous" };
        case "too_large": // edit-file's own: result exceeds the cap
        case "too-large": // FileLinkDenied: source file exceeds the read cap
            return { kind: "too-large" };
        case "bad_workdir":
            return { kind: "no-scope" };
        case "bad_request":
            return { kind: "invalid", detail: reply.detail };
        default:
            if (PATH_REJECT_REASONS.has(reply.code)) return { kind: "path-rejected", reason: reply.code };
            return { kind: "error", message: reply.detail ? `${reply.code}: ${reply.detail}` : reply.code };
    }
}

/** Human-readable, non-crashing copy for each path-rejection reason. */
export function pathRejectMessage(reason: string): string {
    switch (reason) {
        case "relative-path":
            return "The path must be absolute (start with /).";
        case "symlink":
            return "That path is a symlink — the bridge only edits real files.";
        case "not-a-file":
            return "That path isn't a regular file.";
        case "outside-scope":
        case "outside-workdir":
            return "That file is outside the folders the bridge is allowed to edit.";
        case "sensitive":
            return "The bridge refuses to edit that file (it's a sensitive path).";
        case "unreadable":
            return "The bridge couldn't read that file.";
        case "too-large":
            return "That file is too large to edit.";
        case "bad-workdir":
            return "The target folder isn't accessible on the box.";
        default:
            return `The bridge rejected that path (${reason}).`;
    }
}
