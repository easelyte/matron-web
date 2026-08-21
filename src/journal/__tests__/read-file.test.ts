/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { buildReadFileParams, classifyReadFileReply } from "../read-file";
import { type RpcReply } from "../types";

const SHA = "a".repeat(64);

describe("buildReadFileParams", () => {
    it("sends exactly the path", () => {
        expect(buildReadFileParams({ path: "/box/app/config.ts" })).toEqual({ path: "/box/app/config.ts" });
    });
});

describe("classifyReadFileReply", () => {
    it("maps an ok result to a loaded outcome carrying content + sha + bytes + mode", () => {
        const reply: RpcReply = {
            ok: true,
            origin: "agent",
            result: { path: "/box/app/config.ts", content: "PORT=3000\n", sha256: SHA, bytes: 10, mode: 0o644 },
        };
        expect(classifyReadFileReply(reply)).toEqual({
            kind: "loaded",
            path: "/box/app/config.ts",
            content: "PORT=3000\n",
            sha256: SHA,
            bytes: 10,
            mode: 0o644,
        });
    });

    it('loads an empty file (content "", bytes 0)', () => {
        const reply: RpcReply = {
            ok: true,
            origin: "agent",
            result: { path: "/p", content: "", sha256: SHA, bytes: 0 },
        };
        expect(classifyReadFileReply(reply)).toEqual({
            kind: "loaded",
            path: "/p",
            content: "",
            sha256: SHA,
            bytes: 0,
            mode: undefined,
        });
    });

    it("maps too_large (and defensively too-large) to the too-large outcome", () => {
        expect(classifyReadFileReply({ ok: false, origin: "agent", code: "too_large" })).toEqual({ kind: "too-large" });
        expect(classifyReadFileReply({ ok: false, origin: "agent", code: "too-large" })).toEqual({ kind: "too-large" });
    });

    it("maps bad_workdir (no roots pinned) to no-scope", () => {
        expect(classifyReadFileReply({ ok: false, origin: "agent", code: "bad_workdir" })).toEqual({
            kind: "no-scope",
        });
    });

    it("maps a missing/unreadable file to not-found (offer manual authoring)", () => {
        expect(classifyReadFileReply({ ok: false, origin: "agent", code: "unreadable" })).toEqual({
            kind: "not-found",
        });
    });

    it("maps every path-rejection reason to a path-rejected outcome carrying the reason", () => {
        for (const reason of [
            "relative-path",
            "symlink",
            "not-a-file",
            "outside-scope",
            "outside-workdir",
            "sensitive",
            "bad-workdir",
        ]) {
            expect(classifyReadFileReply({ ok: false, origin: "agent", code: reason })).toEqual({
                kind: "path-rejected",
                reason,
            });
        }
    });

    it("maps bad_request to invalid, carrying detail", () => {
        expect(
            classifyReadFileReply({
                ok: false,
                origin: "agent",
                code: "bad_request",
                detail: "path must be a non-empty string",
            }),
        ).toEqual({ kind: "invalid", detail: "path must be a non-empty string" });
    });

    it("treats a relay refusal AND a timeout as retry-safe unreachable (a read has no side effects)", () => {
        expect(classifyReadFileReply({ ok: false, origin: "relay", code: "not_connected" }).kind).toBe("unreachable");
        expect(classifyReadFileReply({ ok: false, origin: "timeout", code: "timeout" }).kind).toBe("unreachable");
        expect(classifyReadFileReply({ ok: false, origin: "teardown", code: "gone" }).kind).toBe("unreachable");
    });

    it("fails loud on an unknown agent code rather than silently succeeding", () => {
        expect(classifyReadFileReply({ ok: false, origin: "agent", code: "internal", detail: "boom" })).toEqual({
            kind: "error",
            message: "internal: boom",
        });
    });

    it("fails loud on every malformed ok shape instead of loading a false success + arming a dud CAS", () => {
        expect(classifyReadFileReply({ ok: true, origin: "agent", result: null }).kind).toBe("error");
        expect(classifyReadFileReply({ ok: true, origin: "agent", result: {} }).kind).toBe("error");
        // Missing content.
        expect(
            classifyReadFileReply({ ok: true, origin: "agent", result: { path: "/p", sha256: SHA, bytes: 1 } }).kind,
        ).toBe("error");
        // Missing / non-string path.
        expect(
            classifyReadFileReply({ ok: true, origin: "agent", result: { content: "x", sha256: SHA, bytes: 1 } }).kind,
        ).toBe("error");
        // Non-hex sha would make the CAS meaningless — reject.
        expect(
            classifyReadFileReply({
                ok: true,
                origin: "agent",
                result: { path: "/p", content: "x", sha256: "nothex", bytes: 1 },
            }).kind,
        ).toBe("error");
        // Negative / non-integer bytes.
        expect(
            classifyReadFileReply({
                ok: true,
                origin: "agent",
                result: { path: "/p", content: "x", sha256: SHA, bytes: -1 },
            }).kind,
        ).toBe("error");
    });
});
