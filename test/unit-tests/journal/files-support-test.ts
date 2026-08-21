/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApiError } from "../../../src/journal/api";
import { FilesApi } from "../../../src/journal/files/filesApi";
import { breadcrumb, extensionOf, humanizeMtime, humanizeSize, joinPath } from "../../../src/journal/files/format";
import { CODE_HIGHLIGHT_MAX, highlightFile, languageForFilename } from "../../../src/journal/files/highlight";

describe("format helpers", () => {
    it("humanizeSize", () => {
        expect(humanizeSize(0)).toBe("0 B");
        expect(humanizeSize(-5)).toBe("0 B");
        expect(humanizeSize(512)).toBe("512 B");
        expect(humanizeSize(1024)).toBe("1 KB");
        expect(humanizeSize(1536)).toBe("1.5 KB");
        expect(humanizeSize(5 * 1024 * 1024)).toBe("5 MB");
    });

    it("humanizeMtime is relative then absolute", () => {
        const now = 1_000_000_000_000;
        expect(humanizeMtime(now, now)).toBe("just now");
        expect(humanizeMtime(now - 5 * 60_000, now)).toBe("5m ago");
        expect(humanizeMtime(now - 3 * 3_600_000, now)).toBe("3h ago");
        expect(humanizeMtime(now - 2 * 86_400_000, now)).toBe("2d ago");
        expect(humanizeMtime(0, now)).toBe("");
        // Beyond a week → an absolute date string (locale-dependent, so just assert non-relative).
        expect(humanizeMtime(now - 30 * 86_400_000, now)).not.toMatch(/ago|just now/);
    });

    it("extensionOf / joinPath", () => {
        expect(extensionOf("client.ts")).toBe("ts");
        expect(extensionOf("README.md")).toBe("md");
        expect(extensionOf("Makefile")).toBe("");
        expect(extensionOf(".gitignore")).toBe("");
        expect(joinPath("/root/a", "b.txt")).toBe("/root/a/b.txt");
        expect(joinPath("/root/a/", "b.txt")).toBe("/root/a/b.txt");
    });

    it("breadcrumb builds root-first ancestors", () => {
        expect(breadcrumb("/root/.openclaw/workspace")).toEqual([
            { label: "/", path: "/" },
            { label: "root", path: "/root" },
            { label: ".openclaw", path: "/root/.openclaw" },
            { label: "workspace", path: "/root/.openclaw/workspace" },
        ]);
        expect(breadcrumb("/")).toEqual([{ label: "/", path: "/" }]);
    });
});

describe("highlight helper", () => {
    it("maps extensions to curated languages", () => {
        expect(languageForFilename("a.ts")).toBe("typescript");
        expect(languageForFilename("a.tsx")).toBe("typescript");
        expect(languageForFilename("a.py")).toBe("python");
        expect(languageForFilename("a.unknownext")).toBeUndefined();
    });

    it("highlights known code and never throws", () => {
        const result = highlightFile("a.ts", "const x: number = 1;");
        expect(result.skipped).toBe(false);
        expect(result.html).toContain("hljs");
    });

    it("skips highlighting above the size cap (returns escaped text)", () => {
        const big = "a".repeat(CODE_HIGHLIGHT_MAX + 1);
        const result = highlightFile("a.ts", big);
        expect(result.skipped).toBe(true);
        expect(result.html).not.toContain("<span");
    });

    it("escapes HTML in the skipped path", () => {
        const big = "<script>".padEnd(CODE_HIGHLIGHT_MAX + 1, "x");
        expect(highlightFile("a.txt", big).html).toContain("&lt;script&gt;");
    });
});

// Environment-independent fake so the test never depends on jsdom's fetch/Response.
function fakeFetch(status: number, body: unknown): jest.Mock {
    const text = JSON.stringify(body);
    return jest.fn().mockResolvedValue({
        status,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
        clone: () => ({ text: async () => text }),
        text: async () => text,
    });
}

describe("FilesApi response parsing", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("parses a directory listing and drops malformed entries", async () => {
        globalThis.fetch = fakeFetch(200, {
            path: "/root/x",
            parent: "/root",
            entries: [
                { name: "src", kind: "dir", size: 0, mtime: 1, mime: "" },
                { name: "a.ts", kind: "file", size: 10, mtime: 2, mime: "text/plain" },
                { kind: "file" }, // no name → dropped
            ],
            truncated: true,
        }) as unknown as typeof fetch;
        const api = new FilesApi("http://127.0.0.1:9810", "tok");
        const listing = await api.listDir("/root/x");
        expect(listing.entries).toHaveLength(2);
        expect(listing.entries[0]).toEqual({ name: "src", kind: "dir", size: 0, mtime: 1, mime: "" });
        expect(listing.truncated).toBe(true);
        expect(listing.parent).toBe("/root");
    });

    it("parses file meta including is_text", async () => {
        globalThis.fetch = fakeFetch(200, {
            kind: "file",
            size: 42,
            mtime: 7,
            mime: "text/markdown",
            is_text: true,
        }) as unknown as typeof fetch;
        const api = new FilesApi("http://127.0.0.1:9810", "tok");
        const meta = await api.fileMeta("/root/x/README.md");
        expect(meta).toEqual({ kind: "file", size: 42, mtime: 7, mime: "text/markdown", isText: true });
    });

    it("maps a 403 to a typed JournalApiError", async () => {
        globalThis.fetch = fakeFetch(403, { error: "forbidden" }) as unknown as typeof fetch;
        const api = new FilesApi("http://127.0.0.1:9810", "tok");
        await expect(api.listDir("/etc")).rejects.toMatchObject({
            status: 403,
            code: "forbidden",
        });
        await expect(api.listDir("/etc")).rejects.toBeInstanceOf(JournalApiError);
    });
});
