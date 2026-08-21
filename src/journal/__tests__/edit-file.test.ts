/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { buildEditFileParams, classifyEditFileReply, pathRejectMessage } from "../edit-file";
import { type RpcReply } from "../types";

const SHA = "a".repeat(64);

describe("buildEditFileParams", () => {
    it("sends only content in content mode, never old_string", () => {
        const params = buildEditFileParams({ path: "/box/app/.env", edit: { mode: "content", content: "X=1\n" } });
        expect(params).toEqual({ path: "/box/app/.env", content: "X=1\n" });
        expect("old_string" in params).toBe(false);
        expect("new_string" in params).toBe(false);
    });

    it("sends only old_string/new_string in replace mode, never content", () => {
        const params = buildEditFileParams({
            path: "/box/app/config.ts",
            edit: { mode: "replace", oldString: "port = 3000", newString: "port = 4000" },
        });
        expect(params).toEqual({
            path: "/box/app/config.ts",
            old_string: "port = 3000",
            new_string: "port = 4000",
        });
        expect("content" in params).toBe(false);
    });

    it("threads expected_sha256 for the compare-and-swap when supplied", () => {
        const params = buildEditFileParams({
            path: "/box/app/config.ts",
            edit: { mode: "replace", oldString: "a", newString: "b" },
            expectedSha256: SHA,
        });
        expect(params.expected_sha256).toBe(SHA);
    });

    it("omits expected_sha256 entirely when absent or empty (absence reads as absence)", () => {
        const absent = buildEditFileParams({ path: "/p", edit: { mode: "content", content: "" } });
        expect("expected_sha256" in absent).toBe(false);
        const empty = buildEditFileParams({ path: "/p", edit: { mode: "content", content: "" }, expectedSha256: "" });
        expect("expected_sha256" in empty).toBe(false);
    });
});

describe("classifyEditFileReply", () => {
    it("maps an ok result to a saved outcome", () => {
        const reply: RpcReply = {
            ok: true,
            origin: "agent",
            result: { path: "/box/app/.env", bytes: 12, mode: "content" },
        };
        expect(classifyEditFileReply(reply)).toEqual({
            kind: "saved",
            path: "/box/app/.env",
            bytes: 12,
            mode: "content",
        });
    });

    it("maps a stale CAS mismatch to the stale outcome (the file changed under us)", () => {
        const reply: RpcReply = {
            ok: false,
            origin: "agent",
            code: "stale",
            detail: "file no longer matches expected_sha256",
        };
        expect(classifyEditFileReply(reply)).toEqual({ kind: "stale" });
    });

    it("maps replace-mode match failures", () => {
        expect(classifyEditFileReply({ ok: false, origin: "agent", code: "not_found" })).toEqual({ kind: "not-found" });
        expect(classifyEditFileReply({ ok: false, origin: "agent", code: "ambiguous_match" })).toEqual({
            kind: "ambiguous",
        });
    });

    it("maps too_large (edit result) and too-large (source file) to the same too-large outcome", () => {
        expect(classifyEditFileReply({ ok: false, origin: "agent", code: "too_large" })).toEqual({ kind: "too-large" });
        expect(classifyEditFileReply({ ok: false, origin: "agent", code: "too-large" })).toEqual({ kind: "too-large" });
    });

    it("maps every path-rejection reason to a path-rejected outcome carrying the reason", () => {
        for (const reason of [
            "relative-path",
            "symlink",
            "not-a-file",
            "outside-scope",
            "outside-workdir",
            "sensitive",
            "unreadable",
            "bad-workdir",
        ]) {
            expect(classifyEditFileReply({ ok: false, origin: "agent", code: reason })).toEqual({
                kind: "path-rejected",
                reason,
            });
        }
    });

    it("distinguishes bad_workdir (no roots pinned) from bad-workdir (path rejection)", () => {
        expect(classifyEditFileReply({ ok: false, origin: "agent", code: "bad_workdir" })).toEqual({
            kind: "no-scope",
        });
        expect(classifyEditFileReply({ ok: false, origin: "agent", code: "bad-workdir" })).toEqual({
            kind: "path-rejected",
            reason: "bad-workdir",
        });
    });

    it("maps bad_request to invalid, carrying detail", () => {
        expect(
            classifyEditFileReply({
                ok: false,
                origin: "agent",
                code: "bad_request",
                detail: "path must be a non-empty string",
            }),
        ).toEqual({ kind: "invalid", detail: "path must be a non-empty string" });
    });

    it("treats non-agent origins (relay/timeout/teardown) as unreachable, not a rejected edit", () => {
        expect(classifyEditFileReply({ ok: false, origin: "relay", code: "not_connected" }).kind).toBe("unreachable");
        expect(classifyEditFileReply({ ok: false, origin: "timeout", code: "timeout" }).kind).toBe("unreachable");
    });

    it("fails loud on an unknown agent code rather than silently succeeding", () => {
        const outcome = classifyEditFileReply({ ok: false, origin: "agent", code: "internal", detail: "boom" });
        expect(outcome).toEqual({ kind: "error", message: "internal: boom" });
    });

    it("fails loud on a malformed ok result shape", () => {
        expect(classifyEditFileReply({ ok: true, origin: "agent", result: null }).kind).toBe("error");
    });
});

describe("pathRejectMessage", () => {
    it("gives a distinct non-empty message for each reason", () => {
        for (const reason of [
            "relative-path",
            "symlink",
            "not-a-file",
            "outside-scope",
            "outside-workdir",
            "sensitive",
            "unreadable",
            "too-large",
            "bad-workdir",
        ]) {
            expect(pathRejectMessage(reason).length).toBeGreaterThan(0);
        }
    });

    it("falls back to naming the raw reason for an unknown one", () => {
        expect(pathRejectMessage("brand-new-reason")).toContain("brand-new-reason");
    });
});
