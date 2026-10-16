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

    // ── Missions ──────────────────────────────────────────────────────────────────────────────

    it("GET /missions with no state filter", async () => {
        await api().missions();
        expect(url()).toBe("https://journal.example/missions");
        expect(init().method ?? "GET").toBe("GET");
        expect(init().headers).toEqual(expect.objectContaining({ Authorization: "Bearer token" }));
    });

    it("GET /missions?state= carries the encoded state filter", async () => {
        await api().missions("closed");
        expect(url()).toBe("https://journal.example/missions?state=closed");
    });

    it("GET /missions/:id for a mission detail", async () => {
        await api().mission(42);
        expect(url()).toBe("https://journal.example/missions/42");
    });

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

    it("GET /items sends several kinds as one comma-separated value", async () => {
        await api().items({ state: "closed", kind: ["question", "decision", "notice"], sort: "updated" });
        expect(url()).toBe("https://journal.example/items?state=closed&kind=question%2Cdecision%2Cnotice&sort=updated");
    });

    it("GET /items includes a since=0 boundary but drops an undefined cursor", async () => {
        await api().items({ since: 0 });
        expect(url()).toBe("https://journal.example/items?since=0");
    });

    it("GET /items?convo= lists one conversation's items", async () => {
        await api().items({ convo: "c-1", state: "open", sort: "rank", limit: 500 });
        expect(url()).toBe("https://journal.example/items?convo=c-1&state=open&sort=rank&limit=500");
    });

    it("POST /items files a new item with an Idempotency-Key", async () => {
        await api().createItem({ kind: "task", title: "Write tests", body: "", convo_id: "c-1" }, "key-1");
        expect(url()).toBe("https://journal.example/items");
        expect(init().method).toBe("POST");
        expect(JSON.parse(init().body!)).toEqual({ kind: "task", title: "Write tests", body: "", convo_id: "c-1" });
        expect(init().headers["Idempotency-Key"]).toBe("key-1");
    });

    it("POST /items/:id/rank sends a position or the new neighbours", async () => {
        await api().rankItem("it_a", { position: "top" });
        expect(url()).toBe("https://journal.example/items/it_a/rank");
        expect(init().method).toBe("POST");
        expect(JSON.parse(init().body!)).toEqual({ position: "top" });
        await api().rankItem("it_a", { after: "it_b", before: "it_c" });
        expect(JSON.parse(init(1).body!)).toEqual({ after: "it_b", before: "it_c" });
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

    it("passes an opaque it_/ms_ id through unchanged", async () => {
        await api().item("it_abc123");
        expect(url()).toBe("https://journal.example/items/it_abc123");
        await api().mission("ms_def456");
        expect(url(1)).toBe("https://journal.example/missions/ms_def456");
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

    // ── Mission mutations ──────────────────────────────────────────────────────────────────────

    it("PATCH /missions/:id edits the mission and carries the Idempotency-Key", async () => {
        await api().patchMission(3, { title: "New name", body: "why" }, "idem-mission");
        expect(url()).toBe("https://journal.example/missions/3");
        expect(init().method).toBe("PATCH");
        expect(init().headers).toEqual(expect.objectContaining({ "Idempotency-Key": "idem-mission" }));
        expect(JSON.parse(init().body as string)).toEqual({ title: "New name", body: "why" });
    });

    it("POST /missions/:id/close sends the summary and carries the Idempotency-Key", async () => {
        await api().closeMission(3, { summary: "wrapped up" }, "idem-mclose");
        expect(url()).toBe("https://journal.example/missions/3/close");
        expect(init().method).toBe("POST");
        expect(init().headers).toEqual(expect.objectContaining({ "Idempotency-Key": "idem-mclose" }));
        expect(JSON.parse(init().body as string)).toEqual({ summary: "wrapped up" });
    });

    it("omits the Idempotency-Key header when a mutation is called without a key", async () => {
        await api().closeItem(9, { resolution: "cancelled" });
        expect(init().headers["Idempotency-Key"]).toBeUndefined();
    });

    // ── Memories (spec 2026-09-27 memories) ───────────────────────────────────────────────────

    it("GET /memories", async () => {
        await api().memories();
        expect(url()).toBe("https://journal.example/memories");
        expect(init().method ?? "GET").toBe("GET");
        expect(init().headers).toEqual(expect.objectContaining({ Authorization: "Bearer token" }));
    });

    it("PUT /memories/:name carries the whole memory as JSON, name URL-encoded", async () => {
        await api().putMemory("avoid-elm", {
            description: "Never use elm.",
            body: "**Why:** reserved.",
            type: "feedback",
        });
        expect(url()).toBe("https://journal.example/memories/avoid-elm");
        expect(init().method).toBe("PUT");
        expect(JSON.parse(init().body ?? "{}")).toEqual({
            description: "Never use elm.",
            body: "**Why:** reserved.",
            type: "feedback",
        });
    });

    it("DELETE /memories/:name", async () => {
        await api().deleteMemory("avoid-elm");
        expect(url()).toBe("https://journal.example/memories/avoid-elm");
        expect(init().method).toBe("DELETE");
    });

    // ── Notice items + user settings ──────────────────────────────────────────────────────────

    // The journal only sends `kind: "notice"` to a client that asks for it; others see a task.
    it("asks for notice items on every authenticated request", async () => {
        await api().items({ state: "open" });
        await api().mission(42);
        await api().project(7);
        for (const call of [0, 1, 2]) {
            expect(init(call).headers).toEqual(expect.objectContaining({ "X-Matron-Item-Kinds": "notice" }));
        }
    });

    // The journal sends raw `![caption](attachment:<ref>)` refs only to a client that places them.
    it("asks for inline attachment refs on every request that sends the item-kinds header", async () => {
        await api().items({ state: "open" });
        await api().item(3);
        await api().postItemComment(3, { body: "hi" }, "idem-inline");
        await api().mission(42);
        await api().project(7);
        for (const call of [0, 1, 2, 3, 4]) {
            expect(init(call).headers).toEqual(
                expect.objectContaining({ "X-Matron-Item-Kinds": "notice", "X-Matron-Item-Inline": "attachments" }),
            );
        }
    });

    it("keeps a caller's own headers alongside the item-kinds header", async () => {
        await api().postItemComment(3, { action: "Seen", body: "Seen" }, "idem-seen");
        expect(init().headers).toEqual(
            expect.objectContaining({
                "X-Matron-Item-Kinds": "notice",
                "X-Matron-Item-Inline": "attachments",
                "Idempotency-Key": "idem-seen",
            }),
        );
        expect(JSON.parse(init().body ?? "{}")).toEqual({ action: "Seen", body: "Seen" });
    });

    it("forwards the item-kinds header through the desktop bridge", async () => {
        const journalRequest = jest.fn().mockResolvedValue({
            status: 200,
            headers: {},
            body: new NodeTextEncoder().encode(JSON.stringify({ items: [], next_cursor: null })).buffer,
        });
        (window as Window & { electron?: unknown }).electron = { journalRequest };
        await api().items();
        expect(journalRequest.mock.calls[0][0].headers).toEqual({
            "X-Matron-Item-Kinds": "notice",
            "X-Matron-Item-Inline": "attachments",
        });
    });

    it("GET /settings", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ notices: true }));
        await expect(api().settings()).resolves.toEqual({ notices: true });
        expect(url()).toBe("https://journal.example/settings");
        expect(init().method ?? "GET").toBe("GET");
    });

    it("PATCH /settings sends the changed setting", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ notices: false }));
        await expect(api().patchSettings({ notices: false })).resolves.toEqual({ notices: false });
        expect(url()).toBe("https://journal.example/settings");
        expect(init().method).toBe("PATCH");
        expect(JSON.parse(init().body ?? "{}")).toEqual({ notices: false });
    });
});
