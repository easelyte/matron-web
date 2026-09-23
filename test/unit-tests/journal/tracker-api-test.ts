/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi } from "../../../src/journal/api";

const fetchMock = jest.fn();

function jsonResponse(body: unknown, status = 200): Pick<Response, "status" | "headers" | "arrayBuffer"> {
    const encoded = new NodeTextEncoder().encode(JSON.stringify(body));
    return {
        status,
        headers: new Headers({ "Content-Type": "application/json" }),
        arrayBuffer: async () => encoded.buffer,
    };
}

function url(call = 0): string {
    return String(fetchMock.mock.calls[call][0]);
}

function init(call = 0): RequestInit & { headers: Record<string, string>; body?: string } {
    return fetchMock.mock.calls[call][1];
}

describe("JournalApi tracker routes", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(jsonResponse({}));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    const api = (): JournalApi => new JournalApi("https://journal.example", "token");

    // ── Items list + detail ────────────────────────────────────────────────────────────────────

    it("GET /items with no filter omits the query string entirely", async () => {
        await api().items();
        expect(url()).toBe("https://journal.example/items");
    });

    it("GET /items serialises every filter param in a stable order", async () => {
        await api().items({
            state: "open",
            kind: "question",
            awaiting: "user",
            label: "billing",
            sort: "rank",
            since: 1700,
            limit: 50,
            cursor: "cur_9",
        });
        expect(url()).toBe(
            "https://journal.example/items?state=open&kind=question&awaiting=user&label=billing&sort=rank&since=1700&limit=50&cursor=cur_9",
        );
    });

    it("GET /items includes a since=0 boundary but drops an undefined cursor", async () => {
        await api().items({ since: 0 });
        expect(url()).toBe("https://journal.example/items?since=0");
    });

    it("GET /items/:id for an item detail", async () => {
        await api().item(7);
        expect(url()).toBe("https://journal.example/items/7");
    });

    // ── encodeTrackerId path segment ───────────────────────────────────────────────────────────

    it("strips a leading # from a #num ref", async () => {
        await api().item("#12");
        expect(url()).toBe("https://journal.example/items/12");
    });

    it("passes an opaque it_ id through unchanged", async () => {
        await api().item("it_abc123");
        expect(url()).toBe("https://journal.example/items/it_abc123");
    });

    it("stringifies a bare numeric id", async () => {
        await api().item(305);
        expect(url()).toBe("https://journal.example/items/305");
    });

    // ── Item mutations ──────────────────────────────────────────────────────────────────────────

    it("PATCH /items/:id sends the patch body and no Idempotency-Key", async () => {
        await api().patchItem(9, { title: "Renamed", awaiting: "agent", mission: null });
        expect(url()).toBe("https://journal.example/items/9");
        expect(init().method).toBe("PATCH");
        expect(init().headers).toEqual(
            expect.objectContaining({ Authorization: "Bearer token", "Content-Type": "application/json" }),
        );
        expect(init().headers["Idempotency-Key"]).toBeUndefined();
        expect(JSON.parse(init().body as string)).toEqual({ title: "Renamed", awaiting: "agent", mission: null });
    });

    it("POST /items/:id/comments carries the body and the Idempotency-Key header", async () => {
        await api().postItemComment(9, { body: "on it" }, "idem-comment");
        expect(url()).toBe("https://journal.example/items/9/comments");
        expect(init().method).toBe("POST");
        expect(init().headers).toEqual(expect.objectContaining({ "Idempotency-Key": "idem-comment" }));
        expect(JSON.parse(init().body as string)).toEqual({ body: "on it" });
    });

    it("POST /items/:id/close sends the resolution + comment and the Idempotency-Key", async () => {
        await api().closeItem("#9", { resolution: "done", comment: "shipped" }, "idem-close");
        expect(url()).toBe("https://journal.example/items/9/close");
        expect(init().method).toBe("POST");
        expect(init().headers).toEqual(expect.objectContaining({ "Idempotency-Key": "idem-close" }));
        expect(JSON.parse(init().body as string)).toEqual({ resolution: "done", comment: "shipped" });
    });

    it("POST /items/:id/reopen defaults to an empty body and carries the Idempotency-Key", async () => {
        await api().reopenItem(9, {}, "idem-reopen");
        expect(url()).toBe("https://journal.example/items/9/reopen");
        expect(init().method).toBe("POST");
        expect(init().headers).toEqual(expect.objectContaining({ "Idempotency-Key": "idem-reopen" }));
        expect(JSON.parse(init().body as string)).toEqual({});
    });

    it("omits the Idempotency-Key header when a mutation is called without a key", async () => {
        await api().closeItem(9, { resolution: "cancelled" });
        expect(init().headers["Idempotency-Key"]).toBeUndefined();
    });
});
