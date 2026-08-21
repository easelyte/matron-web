/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { FilesApi } from "../../../src/journal/files/filesApi";
import { breadcrumb, extensionOf, humanizeMtime, humanizeSize, joinPath } from "../../../src/journal/files/format";
import { CODE_HIGHLIGHT_MAX, highlightFile, languageForFilename } from "../../../src/journal/files/highlight";
import { DOWNLOAD_URL_TTL_MS } from "../../../src/journal/files/limits";

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
        expect(humanizeMtime(now - 30 * 86_400_000, now)).not.toMatch(/ago|just now/);
    });

    it("extensionOf / joinPath", () => {
        expect(extensionOf("client.ts")).toBe("ts");
        expect(extensionOf("Makefile")).toBe("");
        expect(extensionOf(".gitignore")).toBe("");
        expect(joinPath("/root/a", "b.txt")).toBe("/root/a/b.txt");
        expect(joinPath("/root/a/", "b.txt")).toBe("/root/a/b.txt");
    });
});

// F4: breadcrumbs are built from the read-root DOWN to path — NEVER above the jail.
describe("breadcrumb (read-root jail)", () => {
    const root = "/root/.openclaw/workspace";

    it("spans root → path, root labelled by basename, nothing above root", () => {
        expect(breadcrumb(root, `${root}/src/journal`)).toEqual([
            { label: "workspace", path: root },
            { label: "src", path: `${root}/src` },
            { label: "journal", path: `${root}/src/journal` },
        ]);
    });

    it("never emits a segment above root (no '/', 'root', '.openclaw')", () => {
        for (const crumb of breadcrumb(root, `${root}/a/b/c`)) {
            expect(crumb.path.startsWith(root)).toBe(true);
            expect(["/", "root", ".openclaw"]).not.toContain(crumb.label);
        }
    });

    it("at the root itself → a single root crumb", () => {
        expect(breadcrumb(root, root)).toEqual([{ label: "workspace", path: root }]);
    });

    it("path not under root → only the root crumb (never fabricates ancestors)", () => {
        expect(breadcrumb(root, "/etc/passwd")).toEqual([{ label: "workspace", path: root }]);
    });

    it("root = '/' degrades cleanly", () => {
        expect(breadcrumb("/", "/root/x")).toEqual([
            { label: "/", path: "/" },
            { label: "root", path: "/root" },
            { label: "x", path: "/root/x" },
        ]);
    });
});

describe("highlight helper", () => {
    it("maps extensions to curated languages", () => {
        expect(languageForFilename("a.ts")).toBe("typescript");
        expect(languageForFilename("a.py")).toBe("python");
        expect(languageForFilename("a.unknownext")).toBeUndefined();
    });

    it("highlights known code and never throws", () => {
        const result = highlightFile("a.ts", "const x: number = 1;");
        expect(result.skipped).toBe(false);
        expect(result.html).toContain("hljs");
    });

    it("skips highlighting above the size cap (returns escaped text)", () => {
        const result = highlightFile("a.ts", "a".repeat(CODE_HIGHLIGHT_MAX + 1));
        expect(result.skipped).toBe(true);
        expect(result.html).not.toContain("<span");
    });

    it("escapes HTML in the skipped path", () => {
        const big = "<script>".padEnd(CODE_HIGHLIGHT_MAX + 1, "x");
        expect(highlightFile("a.txt", big).html).toContain("&lt;script&gt;");
    });
});

// ── FilesApi: transport parsing + lifecycle (F3/F5/F7/F8) ────────────────────────────────────────
const SERVER = "http://127.0.0.1:9810";

interface FakeResponseBody {
    status: number;
    body?: unknown;
}

function fakeResponse({ status, body }: FakeResponseBody): Response {
    const text = JSON.stringify(body ?? {});
    return {
        status,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
        blob: async () => ({ size: text.length, type: "application/octet-stream" }),
        clone: () => ({ text: async () => text }),
        text: async () => text,
    } as unknown as Response;
}

describe("FilesApi", () => {
    const originalFetch = globalThis.fetch;
    const originalCreate = globalThis.URL.createObjectURL;
    const originalRevoke = globalThis.URL.revokeObjectURL;
    let created: string[];
    let revoked: string[];

    beforeEach(() => {
        created = [];
        revoked = [];
        globalThis.URL.createObjectURL = jest.fn(() => {
            const url = `blob:mock/${created.length}`;
            created.push(url);
            return url;
        });
        globalThis.URL.revokeObjectURL = jest.fn((url: string) => {
            revoked.push(url);
        });
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.URL.createObjectURL = originalCreate;
        globalThis.URL.revokeObjectURL = originalRevoke;
        jest.useRealTimers();
    });

    it("parses a directory listing incl. the F4 `root` field and drops malformed entries", async () => {
        globalThis.fetch = jest.fn().mockResolvedValue(
            fakeResponse({
                status: 200,
                body: {
                    path: "/root/x",
                    root: "/root",
                    parent: "/root",
                    entries: [
                        { name: "src", kind: "dir", size: 0, mtime: 1, mime: "" },
                        { kind: "file" }, // no name → dropped
                    ],
                    truncated: true,
                },
            }),
        ) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const listing = await api.listDir("/root/x");
        expect(listing.root).toBe("/root");
        expect(listing.entries).toHaveLength(1);
        expect(listing.parent).toBe("/root");
        expect(listing.truncated).toBe(true);
    });

    it("parses file meta including is_text", async () => {
        globalThis.fetch = jest.fn().mockResolvedValue(
            fakeResponse({
                status: 200,
                body: { kind: "file", size: 42, mtime: 7, mime: "text/markdown", is_text: true },
            }),
        ) as unknown as typeof fetch;
        const meta = await new FilesApi(SERVER, "tok").fileMeta("/root/x/README.md");
        expect(meta).toEqual({ kind: "file", size: 42, mtime: 7, mime: "text/markdown", isText: true });
    });

    it("maps a 403 to a typed JournalApiError", async () => {
        globalThis.fetch = jest
            .fn()
            .mockResolvedValue(fakeResponse({ status: 403, body: { error: "forbidden" } })) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        await expect(api.listDir("/etc")).rejects.toMatchObject({ status: 403, code: "forbidden" });
    });

    // F7: content cache keyed by (disposition, mtime, path) — a changed mtime busts it.
    it("caches content URLs by mtime; a changed mtime re-fetches", async () => {
        const fetchMock = jest.fn().mockResolvedValue(fakeResponse({ status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const a1 = await api.contentUrl("/root/f.png", { mtime: 1 });
        const a2 = await api.contentUrl("/root/f.png", { mtime: 1 });
        expect(a2).toBe(a1); // same mtime → cached, one fetch
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const b = await api.contentUrl("/root/f.png", { mtime: 2 });
        expect(b).not.toBe(a1); // changed mtime → new fetch + new URL
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // F8/F3: dispose aborts an in-flight request (abort-on-teardown).
    it("dispose() aborts an in-flight request", async () => {
        globalThis.fetch = jest.fn(
            (_url: unknown, opts?: { signal?: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                }),
        ) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const pending = api.listDir("/root/x");
        api.dispose();
        await expect(pending).rejects.toMatchObject({ code: "disposed" });
    });

    // F3: a content fetch that RESOLVES after sign-out mints a URL that is dropped AND revoked.
    it("revokes and drops a content URL that resolves after dispose", async () => {
        const resolvers: Array<() => void> = [];
        globalThis.fetch = jest.fn(
            () => new Promise<Response>((resolve) => resolvers.push(() => resolve(fakeResponse({ status: 200 })))),
        ) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const pending = api.contentUrl("/root/f.png", { mtime: 1 });
        api.dispose();
        resolvers.forEach((r) => r()); // fetch resolves AFTER dispose
        await expect(pending).rejects.toMatchObject({ code: "disposed" });
        expect(created).toHaveLength(1);
        expect(revoked).toContain(created[0]); // minted-then-revoked, never leaked
    });

    it("dispose() revokes every cached content URL", async () => {
        globalThis.fetch = jest.fn().mockResolvedValue(fakeResponse({ status: 200 })) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const url = await api.contentUrl("/root/f.png", { mtime: 1 });
        api.dispose();
        expect(revoked).toContain(url);
    });

    // F5: download rejects on a denial so the caller can surface it (not an unhandled rejection).
    it("download() rejects on a 413 (visible failure)", async () => {
        globalThis.fetch = jest
            .fn()
            .mockResolvedValue(fakeResponse({ status: 413, body: { error: "too_large" } })) as unknown as typeof fetch;
        await expect(new FilesApi(SERVER, "tok").download("/root/big.bin", "big.bin")).rejects.toMatchObject({
            status: 413,
        });
    });

    // F3: downloads are NOT session-cached and their URL is revoked on a TTL.
    it("download() is not cached and revokes its URL after the TTL", async () => {
        jest.useFakeTimers();
        const fetchMock = jest.fn().mockResolvedValue(fakeResponse({ status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        await api.download("/root/a.zip", "a.zip");
        await api.download("/root/a.zip", "a.zip");
        expect(fetchMock).toHaveBeenCalledTimes(2); // re-fetched, never cached
        expect(created).toHaveLength(2);
        expect(revoked).toHaveLength(0);
        jest.advanceTimersByTime(DOWNLOAD_URL_TTL_MS + 1);
        expect(revoked).toHaveLength(2); // both transient URLs revoked
    });

    // F3: a download whose bytes arrive after sign-out is dropped — old-session bytes never saved.
    it("drops a download that completes after dispose", async () => {
        const resolvers: Array<() => void> = [];
        globalThis.fetch = jest.fn(
            () => new Promise<Response>((resolve) => resolvers.push(() => resolve(fakeResponse({ status: 200 })))),
        ) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const pending = api.download("/root/a.zip", "a.zip");
        api.dispose();
        resolvers.forEach((r) => r());
        await pending; // resolves (void), does not throw
        expect(created).toHaveLength(0); // no object URL minted → no anchor click → nothing saved
    });
});
