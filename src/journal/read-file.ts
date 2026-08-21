/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/**
 * Client-side plumbing for the bridge `read_file` RPC (loop #548 follow-up):
 * the guarded read of an EXISTING file inside the bridge's pinned allowed roots.
 *
 * Its reason to exist is edit_file's compare-and-swap. The in-client editor
 * authors whole-file content, and expected_sha256 is the only replay/concurrency
 * guard edit_file has — but a client can't compute that digest without first
 * reading the exact bytes. read_file returns the current content + a sha256 over
 * those exact bytes, so the editor can load-then-edit and auto-fill the CAS
 * (on-by-default protection instead of an opt-in one it could never compute).
 *
 * The wire contract this MUST match exactly (bridge lib/read-file.js + journal-rpc.js):
 *   params: { path: string }               // absolute, inside a pinned root
 *   ok result: { path: string, content: string, sha256: string, bytes: number, mode?: number }
 *     - sha256 is over the EXACT bytes edit_file's CAS re-hashes — pass it back
 *       verbatim as edit_file's expected_sha256 and an unchanged file's edit passes.
 *   error { code, detail } (a SUBSET of edit_file's vocabulary — read_file never
 *   emits stale / not_found / ambiguous_match, which are edit-only):
 *     - own (underscored):  bad_request | bad_workdir | too_large
 *     - path rejections (hyphenated, verbatim FileLinkDenied reasons):
 *         relative-path | symlink | not-a-file | outside-scope | outside-workdir
 *         | sensitive | unreadable | bad-workdir
 *       (a MISSING or unreadable file surfaces as `unreadable` — validateAndOpen
 *        maps ENOENT/EACCES there, since read_file has no dedicated not_found)
 *     - transport (origin !== "agent"): not_connected | not_ready | timeout | …
 *
 * Pure (no React, no network) so the param shape + error-code mapping are unit
 * tested in isolation; the client method is a thin build -> agentRpc -> classify.
 */

import { type RpcReply } from "./types";

export interface ReadFileInput {
    /** Absolute path to an existing file inside a bridge-pinned root. */
    path: string;
}

export type ReadFileOutcome =
    | {
          kind: "loaded";
          path: string;
          /** Current file bytes decoded as utf8 — the textarea seed. */
          content: string;
          /** sha256 (hex) over the exact bytes — hand straight to edit_file's CAS. */
          sha256: string;
          bytes: number;
          /** Permission bits (octal number), when the bridge could stat them. */
          mode?: number;
      }
    /**
     * The file could not be read — it may not exist yet, or isn't readable
     * (the bridge maps both to `unreadable`). The editor keeps the form usable
     * so the operator can still author content manually.
     */
    | { kind: "not-found" }
    /** the file exceeds the bridge's read-size cap. */
    | { kind: "too-large" }
    /**
     * The file isn't UTF-8 text (invalid/binary bytes that wouldn't survive a
     * decode -> re-encode round-trip). The bridge refuses it so a load-then-save
     * can't silently corrupt it — the editor only handles text files.
     */
    | { kind: "not-text" }
    /** path failed the bridge's safety boundary; `reason` is verbatim. */
    | { kind: "path-rejected"; reason: string }
    /** the bridge has no allowed roots pinned — editing is unavailable there. */
    | { kind: "no-scope" }
    /** malformed request (should not happen from this UI). */
    | { kind: "invalid"; detail?: string }
    /**
     * No reply arrived, OR a relay refused to forward. A read has NO side
     * effects, so — unlike edit_file — both are simply safe to retry.
     */
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
    "bad-workdir",
    // "unreadable" is intercepted by the switch (mapped to not-found), and
    // "too-large" is folded into the too-large outcome — neither lands here.
]);

/** Build the wire params. read_file takes exactly one field: the path. */
export function buildReadFileParams(input: ReadFileInput): Record<string, unknown> {
    return { path: input.path };
}

function transportMessage(code: string): string {
    if (code === "not_connected" || code === "not_ready") return "Still connecting — try again in a moment.";
    if (code === "timeout") return "The box didn't respond — try again.";
    return "Couldn't reach that box — try again.";
}

/**
 * Map an RPC reply onto a UI-ready outcome. Parse-don't-validate the success
 * shape: a degraded/version-skewed bridge returning a partial result (missing
 * content, a non-hex sha) must NOT load as a false success and then arm a
 * meaningless CAS — every field is required and exactly typed. Anything unknown
 * fails loud rather than rendering a silent success.
 */
export function classifyReadFileReply(reply: RpcReply): ReadFileOutcome {
    if (reply.ok) {
        const result = reply.result;
        if (typeof result === "object" && result !== null && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            const path = record.path;
            const content = record.content;
            const sha256 = record.sha256;
            const bytes = record.bytes;
            const mode = record.mode;
            if (
                typeof path === "string" &&
                path.length > 0 &&
                typeof content === "string" &&
                typeof sha256 === "string" &&
                /^[0-9a-f]{64}$/i.test(sha256) &&
                typeof bytes === "number" &&
                Number.isInteger(bytes) &&
                bytes >= 0
            ) {
                return {
                    kind: "loaded",
                    path,
                    content,
                    sha256,
                    bytes,
                    mode: typeof mode === "number" && Number.isInteger(mode) ? mode : undefined,
                };
            }
        }
        return { kind: "error", message: "Reading the file returned an unexpected response." };
    }
    if (reply.origin !== "agent") {
        // A read has no side effects, so a relay refusal AND a timeout/teardown
        // are equally safe to retry (contrast edit_file, where a timeout may
        // have committed and a blind retry could double-apply).
        return { kind: "unreachable", message: transportMessage(reply.code) };
    }
    switch (reply.code) {
        case "too_large": // read_file's own size code
        case "too-large": // defensive: guard's raw reason, if ever passed through
            return { kind: "too-large" };
        case "not_text": // bridge refuses non-round-trippable (binary/invalid-utf8) files
            return { kind: "not-text" };
        case "bad_workdir":
            return { kind: "no-scope" };
        case "bad_request":
            return { kind: "invalid", detail: reply.detail };
        case "unreadable":
            // A missing OR unreadable file both arrive here; offer manual authoring.
            return { kind: "not-found" };
        default:
            if (PATH_REJECT_REASONS.has(reply.code)) return { kind: "path-rejected", reason: reply.code };
            return { kind: "error", message: reply.detail ? `${reply.code}: ${reply.detail}` : reply.code };
    }
}
