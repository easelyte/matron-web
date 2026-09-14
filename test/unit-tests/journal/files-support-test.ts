/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { FilesApi, messageForFileStatus, sanitizeFileName } from "../../../src/journal/files/filesApi";
import { breadcrumb, extensionOf, humanizeMtime, humanizeSize, joinPath } from "../../../src/journal/files/format";
import { CODE_HIGHLIGHT_MAX, highlightFile, languageForFilename } from "../../../src/journal/files/highlight";
import { DOWNLOAD_URL_TTL_MS, FETCH_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "../../../src/journal/files/limits";
import {
    advanceUpload,
    canDismiss,
    isDestructive,
    isEditableText,
    nameIsSubmittable,
    recoveryNote,
    writeReducer,
    type PendingWrite,
    type WriteState,
} from "../../../src/journal/files/writeActions";

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

    // F2: a superseded mtime generation is revoked so a long session doesn't retain every revision.
    it("revokes the prior mtime generation when a newer one is cached", async () => {
        globalThis.fetch = jest.fn().mockResolvedValue(fakeResponse({ status: 200 })) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const g1 = await api.contentUrl("/root/f.png", { mtime: 1 });
        expect(revoked).not.toContain(g1); // still current → not revoked
        const g2 = await api.contentUrl("/root/f.png", { mtime: 2 });
        expect(g2).not.toBe(g1);
        expect(revoked).toContain(g1); // prior generation superseded → revoked
        const other = await api.contentUrl("/root/g.png", { mtime: 1 });
        expect(revoked).not.toContain(other); // a different (disposition,path) is untouched
    });

    // F3: the shared (deduped) content request is NOT bound to one view's AbortSignal — a sibling
    // subscriber aborting (StrictMode effect replay / rapid close→reopen) must not reject the fetch
    // another subscriber is awaiting.
    it("does not abort a shared content request when a caller's signal aborts", async () => {
        globalThis.fetch = jest.fn((_url: unknown, opts?: { signal?: AbortSignal }) => {
            const signal = opts?.signal;
            return new Promise<Response>((resolve, reject) => {
                if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
                signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                setTimeout(() => resolve(fakeResponse({ status: 200 })), 0);
            });
        }) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const controller = new AbortController();
        const pending = api.contentUrl("/root/f.png", { mtime: 1, signal: controller.signal });
        controller.abort(); // sibling teardown — must NOT reach the shared fetch's signal
        await expect(pending).resolves.toMatch(/^blob:mock\//);
    });

    // F1: the body read is bounded by the timeout, not just the header phase — a 2xx-then-stalled
    // body times out instead of leaving the pane loading forever.
    it("bounds the response BODY read by the timeout, not just headers", async () => {
        jest.useFakeTimers();
        globalThis.fetch = jest.fn((_url: unknown, opts?: { signal?: AbortSignal }) => {
            const signal = opts?.signal;
            const stalled = {
                status: 200,
                arrayBuffer: () =>
                    new Promise((_res, reject) =>
                        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
                    ),
                blob: () =>
                    new Promise((_res, reject) =>
                        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
                    ),
                clone: () => ({ text: async () => "{}" }),
                text: async () => "{}",
            } as unknown as Response;
            return Promise.resolve(stalled); // headers arrive; body never settles on its own
        }) as unknown as typeof fetch;
        const api = new FilesApi(SERVER, "tok");
        const pending = api.textContent("/root/big.md");
        await Promise.resolve();
        await Promise.resolve(); // let fetch resolve + the body read begin (abort listener attached)
        jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
        await expect(pending).rejects.toMatchObject({ code: "timeout" });
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

// -- Phase 2 writes -----------------------------------------------------------------------------
// The wire contract is shared with the journal backend, so these tests pin the exact request the
// client emits (method, path, query flags, headers, body) as much as the parsed response.

interface SentRequest {
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
}

function captureFetch(response: FakeResponseBody): { calls: SentRequest[] } {
    const calls: SentRequest[] = [];
    globalThis.fetch = jest.fn((url: unknown, init?: RequestInit) => {
        calls.push({
            url: String(url),
            method: init?.method,
            body: init?.body,
            headers: init?.headers as Record<string, string>,
        });
        return Promise.resolve(fakeResponse(response));
    }) as unknown as typeof fetch;
    return { calls };
}

describe("sanitizeFileName", () => {
    it("reduces any input to a single safe path component", () => {
        expect(sanitizeFileName("notes.txt")).toBe("notes.txt");
        expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
        expect(sanitizeFileName("a\\b\\c.txt")).toBe("c.txt");
        expect(sanitizeFileName("  spaced.md  ")).toBe("spaced.md");
        expect(sanitizeFileName("bell.txt")).toBe("bell.txt");
    });

    it("returns empty (never a fabricated name) for input that is only separators or dots", () => {
        expect(sanitizeFileName("")).toBe("");
        expect(sanitizeFileName("/")).toBe("");
        expect(sanitizeFileName("..")).toBe("");
        expect(sanitizeFileName("   ")).toBe("");
    });
});

describe("FilesApi writes", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.useRealTimers();
    });

    it("listDir reports writable only when the server says so (absent means read-only)", async () => {
        captureFetch({ status: 200, body: { path: "/root/x", entries: [] } });
        expect((await new FilesApi(SERVER, "tok").listDir("/root/x")).writable).toBe(false);
        captureFetch({ status: 200, body: { path: "/root/x", entries: [], writable: true } });
        expect((await new FilesApi(SERVER, "tok").listDir("/root/x")).writable).toBe(true);
        // A truthy-but-not-true value must not be coerced into a write capability.
        captureFetch({ status: 200, body: { path: "/root/x", entries: [], writable: "yes" } });
        expect((await new FilesApi(SERVER, "tok").listDir("/root/x")).writable).toBe(false);
    });

    it("upload POSTs the full sanitized destination path in the query with an Idempotency-Key", async () => {
        const { calls } = captureFetch({ status: 200, body: { path: "/root/x/a.png", bytes: 12 } });
        const file = new File([new Uint8Array(12)], "a.png", { type: "image/png" });
        const result = await new FilesApi(SERVER, "tok").upload(file, { targetDir: "/root/x" });
        expect(calls[0].method).toBe("POST");
        expect(calls[0].url).toContain("/files/upload?path=%2Froot%2Fx%2Fa.png");
        expect(calls[0].body).toBe(file); // streamed, never buffered into an ArrayBuffer first
        expect(calls[0].headers?.["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
        expect(result).toEqual({ path: "/root/x/a.png", bytes: 12, dryRun: false });
    });

    it("upload strips any directory part from the chosen name before building the target", async () => {
        const { calls } = captureFetch({ status: 200, body: { path: "/root/x/passwd", bytes: 1 } });
        const file = new File([new Uint8Array(1)], "a.png");
        await new FilesApi(SERVER, "tok").upload(file, { targetDir: "/root/x", name: "../../etc/passwd" });
        expect(decodeURIComponent(calls[0].url)).toContain("path=/root/x/passwd");
    });

    it("upload refuses a name that sanitizes to nothing WITHOUT issuing a request", async () => {
        const { calls } = captureFetch({ status: 200, body: {} });
        const file = new File([new Uint8Array(1)], "a.png");
        await expect(
            new FilesApi(SERVER, "tok").upload(file, { targetDir: "/root/x", name: ".." }),
        ).rejects.toMatchObject({ code: "invalid-name" });
        expect(calls).toHaveLength(0);
    });

    it("mkdir POSTs {path}", async () => {
        const { calls } = captureFetch({ status: 200, body: { path: "/root/x/new" } });
        const result = await new FilesApi(SERVER, "tok").mkdir("/root/x/new");
        expect(calls[0].url).toContain("/files/mkdir");
        expect(JSON.parse(String(calls[0].body))).toEqual({ path: "/root/x/new" });
        expect(result).toEqual({ path: "/root/x/new", dryRun: false });
    });

    it("move POSTs {from,to} and echoes the server's canonical pair", async () => {
        const { calls } = captureFetch({ status: 200, body: { from: "/root/x/a", to: "/root/x/b" } });
        const result = await new FilesApi(SERVER, "tok").move("/root/x/a", "/root/x/b");
        expect(JSON.parse(String(calls[0].body))).toEqual({ from: "/root/x/a", to: "/root/x/b" });
        expect(result).toEqual({ from: "/root/x/a", to: "/root/x/b", dryRun: false });
    });

    it("writeFile omits `overwrite` unless it is explicitly true (create-only is the safe default)", async () => {
        const { calls } = captureFetch({ status: 200, body: { path: "/root/x/n.md", bytes: 3 } });
        const api = new FilesApi(SERVER, "tok");
        await api.writeFile("/root/x/n.md", "abc");
        expect(JSON.parse(String(calls[0].body))).toEqual({ path: "/root/x/n.md", content: "abc" });
        await api.writeFile("/root/x/n.md", "abc", { overwrite: true });
        expect(JSON.parse(String(calls[1].body))).toEqual({ path: "/root/x/n.md", content: "abc", overwrite: true });
        expect(calls[1].headers?.["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    });

    it("deleteEntry always sends confirm=1 and maps the discriminated response", async () => {
        const { calls } = captureFetch({
            status: 200,
            body: { path: "/root/x/a", trashed: "/root/.matron-trash/2026-a", already_missing: false },
        });
        const result = await new FilesApi(SERVER, "tok").deleteEntry("/root/x/a", { confirm: true, recursive: true });
        expect(calls[0].method).toBe("DELETE");
        expect(calls[0].url).toContain("recursive=1");
        expect(calls[0].url).toContain("confirm=1");
        expect(result).toEqual({
            path: "/root/x/a",
            trashed: "/root/.matron-trash/2026-a",
            alreadyMissing: false,
            dryRun: false,
        });
    });

    it("deleteEntry never fabricates a trash path for an already-missing target", async () => {
        captureFetch({ status: 200, body: { path: "/root/x/a", trashed: null, already_missing: true } });
        const result = await new FilesApi(SERVER, "tok").deleteEntry("/root/x/a", { confirm: true });
        expect(result.trashed).toBeNull();
        expect(result.alreadyMissing).toBe(true);
    });

    it("surfaces a dry-run response as dryRun (server validated + audited, changed nothing)", async () => {
        captureFetch({ status: 200, body: { dry_run: true } });
        const result = await new FilesApi(SERVER, "tok").mkdir("/root/x/new");
        expect(result.dryRun).toBe(true);
    });

    it.each([[403], [409], [413], [507], [404]])("maps a %i denial to a typed JournalApiError", async (status) => {
        captureFetch({ status, body: { error: "denied" } });
        await expect(new FilesApi(SERVER, "tok").deleteEntry("/root/x/a", { confirm: true })).rejects.toMatchObject({
            status,
            code: "denied",
        });
    });

    it("gives 409 and 507 their own operator copy (never the generic fallback)", () => {
        expect(messageForFileStatus(409)).toMatch(/conflicts/i);
        expect(messageForFileStatus(507)).toMatch(/Nothing was changed/i);
        expect(messageForFileStatus(409)).not.toBe(messageForFileStatus(500));
        expect(messageForFileStatus(507)).not.toBe(messageForFileStatus(500));
    });

    // P33: a write response that does not match the contract is NOT a success. The client must
    // never echo the requested path back as "done" — that would close the dialog (and advance an
    // upload queue) while the actual outcome on disk is unknown.
    it("refuses an empty 2xx body instead of reporting a fabricated success", async () => {
        globalThis.fetch = jest.fn().mockResolvedValue({
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode("").buffer,
            clone: () => ({ text: async () => "" }),
        } as unknown as Response) as unknown as typeof fetch;
        await expect(new FilesApi(SERVER, "tok").mkdir("/root/x/new")).rejects.toMatchObject({
            code: "unconfirmed",
        });
    });

    it("refuses a 2xx whose body is missing the contract's fields", async () => {
        const api = new FilesApi(SERVER, "tok");
        captureFetch({ status: 200, body: {} });
        await expect(api.mkdir("/root/x/new")).rejects.toMatchObject({ code: "unconfirmed" });
        captureFetch({ status: 200, body: { path: "/root/x/n.md" } }); // no `bytes`
        await expect(api.writeFile("/root/x/n.md", "abc")).rejects.toMatchObject({ code: "unconfirmed" });
        captureFetch({ status: 200, body: { from: "/root/x/a" } }); // no `to`
        await expect(api.move("/root/x/a", "/root/x/b")).rejects.toMatchObject({ code: "unconfirmed" });
        // A delete without the already_missing discriminant is unreadable: trashed-or-no-op unknown.
        captureFetch({ status: 200, body: { path: "/root/x/a", trashed: null } });
        await expect(api.deleteEntry("/root/x/a", { confirm: true })).rejects.toMatchObject({
            code: "unconfirmed",
        });
    });

    it("carries a caller-supplied Idempotency-Key on upload / write / move (retry replays)", async () => {
        const api = new FilesApi(SERVER, "tok");
        const key = "stable-key-1";
        const a = captureFetch({ status: 200, body: { path: "/root/x/n.md", bytes: 3 } });
        await api.writeFile("/root/x/n.md", "abc", { overwrite: true, idempotencyKey: key });
        expect(a.calls[0].headers?.["Idempotency-Key"]).toBe(key);
        const b = captureFetch({ status: 200, body: { from: "/root/x/a", to: "/root/x/b" } });
        await api.move("/root/x/a", "/root/x/b", { idempotencyKey: key });
        expect(b.calls[0].headers?.["Idempotency-Key"]).toBe(key);
        const c = captureFetch({ status: 200, body: { path: "/root/x/a.png", bytes: 1 } });
        await api.upload(new File([new Uint8Array(1)], "a.png"), { targetDir: "/root/x", idempotencyKey: key });
        expect(c.calls[0].headers?.["Idempotency-Key"]).toBe(key);
    });

    it("bounds a write by the longer WRITE_TIMEOUT_MS, not the 30 s read timeout", async () => {
        jest.useFakeTimers();
        globalThis.fetch = jest.fn(
            (_url: unknown, opts?: { signal?: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                }),
        ) as unknown as typeof fetch;
        const pending = new FilesApi(SERVER, "tok").writeFile("/root/x/n.md", "abc", { overwrite: true });
        let settled = false;
        void pending.catch(() => {
            settled = true;
        });
        jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false); // the 30 s READ deadline must not abort an in-flight write
        jest.advanceTimersByTime(WRITE_TIMEOUT_MS - FETCH_TIMEOUT_MS);
        await expect(pending).rejects.toMatchObject({ code: "timeout" });
    });
});

// -- Confirm machine (T-3.2): the safety rules, independent of any dialog ------------------------
describe("write confirm machine", () => {
    const del: PendingWrite = { kind: "delete", path: "/root/x/a", name: "a", isDir: false };
    const mkdir: PendingWrite = { kind: "mkdir", dir: "/root/x" };
    const KEY = "key-1";
    const confirming: WriteState = { pending: del, phase: "confirming", idempotencyKey: KEY };
    const mutating: WriteState = { pending: del, phase: "mutating", idempotencyKey: KEY };

    it("cannot reach `mutating` without passing through `confirming`", () => {
        expect(writeReducer(undefined, { type: "submit" })).toBeUndefined();
        expect(writeReducer(undefined, { type: "open", pending: del, idempotencyKey: KEY })).toEqual(confirming);
        expect(writeReducer(confirming, { type: "submit" })).toEqual(mutating);
    });

    it("ignores a second submit while a request is in flight (double-submit guard)", () => {
        expect(writeReducer(mutating, { type: "submit" })).toBe(mutating);
    });

    it("ignores cancel while mutating, and dismisses while confirming", () => {
        expect(writeReducer(mutating, { type: "cancel" })).toBe(mutating);
        expect(writeReducer(confirming, { type: "cancel" })).toBeUndefined();
        expect(canDismiss(mutating)).toBe(false);
        expect(canDismiss(confirming)).toBe(true);
        expect(canDismiss(undefined)).toBe(false);
    });

    it("refuses to swap the pending target out from under an in-flight mutation", () => {
        expect(writeReducer(mutating, { type: "open", pending: mkdir, idempotencyKey: "key-2" })).toBe(mutating);
    });

    it("a failure returns to confirming WITH the error (never silently closes)", () => {
        // Uncertain failure: the caller hands back the SAME key, so the retry replays.
        expect(writeReducer(mutating, { type: "failed", message: "boom", idempotencyKey: KEY })).toEqual({
            pending: del,
            phase: "confirming",
            idempotencyKey: KEY,
            error: "boom",
        });
        // Definite refusal: the caller mints a fresh key, because the operator is about to change
        // the payload (a new name) and the server fingerprints key+payload.
        expect(writeReducer(mutating, { type: "failed", message: "409", idempotencyKey: "key-2" })).toEqual({
            pending: del,
            phase: "confirming",
            idempotencyKey: "key-2",
            error: "409",
        });
    });

    it("success always closes — a queued successor is released by the barrier, not the reducer", () => {
        // The rest of an upload selection is parked by the hook and re-offered only once the
        // post-write re-read confirms the directory is still writable, so there is deliberately no
        // way to walk straight from a success into the next confirmation here.
        expect(writeReducer(mutating, { type: "settled" })).toBeUndefined();
    });

    it("marks only the content-destroying writes destructive, and says how to recover them", () => {
        expect(isDestructive(del)).toBe(true);
        expect(isDestructive({ kind: "edit", path: "/root/x/a", name: "a" })).toBe(true);
        expect(isDestructive(mkdir)).toBe(false);
        expect(isDestructive({ kind: "upload", dir: "/root/x", files: [], index: 0 })).toBe(false);
        expect(recoveryNote(del)).toMatch(/\.matron-trash\//);
        expect(recoveryNote({ kind: "edit", path: "/root/x/a", name: "a" })).toMatch(/\.matron-trash\//);
        expect(recoveryNote(mkdir)).toBeUndefined();
    });

    it("walks an upload queue and stops at the end", () => {
        const files = [new File([], "a"), new File([], "b")];
        const queue: PendingWrite = { kind: "upload", dir: "/root/x", files, index: 0 };
        expect(advanceUpload(queue)).toEqual({ ...queue, index: 1 });
        expect(advanceUpload({ ...queue, index: 1 })).toBeUndefined();
    });

    it("refuses a rename that would be a no-op or an unusable name", () => {
        const rename: PendingWrite = { kind: "rename", dir: "/root/x", path: "/root/x/a", name: "a", isDir: false };
        expect(nameIsSubmittable(rename, "a")).toBe(false); // unchanged: would 409 at the server
        expect(nameIsSubmittable(rename, "..")).toBe(false);
        expect(nameIsSubmittable(rename, "b")).toBe(true);
    });

    it("offers inline editing only for text-ish files within the editor cap", () => {
        const max = 1000;
        expect(isEditableText({ name: "a.md", kind: "file", mime: "text/markdown", size: 10 }, max)).toBe(true);
        expect(isEditableText({ name: "a.json", kind: "file", mime: "application/json", size: 10 }, max)).toBe(true);
        // No MIME from the server, but a known text extension: still editable (the read proves it).
        expect(isEditableText({ name: "a.yml", kind: "file", mime: "", size: 10 }, max)).toBe(true);
        expect(isEditableText({ name: "a.png", kind: "file", mime: "image/png", size: 10 }, max)).toBe(false);
        expect(isEditableText({ name: "a.md", kind: "file", mime: "text/markdown", size: max + 1 }, max)).toBe(false);
        expect(isEditableText({ name: "src", kind: "dir", mime: "", size: 0 }, max)).toBe(false);
    });
});
