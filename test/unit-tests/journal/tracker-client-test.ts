/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { webcrypto } from "node:crypto";

import { MatronJournalClient } from "../../../src/journal/client";
import type { ClientState, JournalEvent, TrackerItem } from "../../../src/journal/types";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function item(over: Partial<TrackerItem> = {}): TrackerItem {
    return {
        id: "it_1",
        num: 1,
        kind: "question",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        title: "Pick a colour",
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
        ...over,
    };
}

function marker(type: string, payload: Record<string, unknown>): JournalEvent {
    return { kind: "journal", seq: 1, convo_id: "c1", ts: 1, sender: "journal", type, payload };
}

// Tracker api surface used by the client's loaders/mutators. jest.fn() everything we touch.
interface TrackerApiMock {
    items: jest.Mock;
    item: jest.Mock;
    postItemComment: jest.Mock;
    closeItem: jest.Mock;
    reopenItem: jest.Mock;
}

interface Internals {
    state: ClientState;
    api?: Partial<TrackerApiMock>;
    database?: { applyJournal: jest.Mock; reconcileOwnMessage: jest.Mock };
    handleJournal(event: JournalEvent): Promise<void>;
    handleTrackerMarker(event: JournalEvent): void;
}

function internals(client: MatronJournalClient): Internals {
    return client as unknown as Internals;
}

function makeClient(overrides: Partial<ClientState> = {}): { client: MatronJournalClient; state: Internals } {
    const client = new MatronJournalClient();
    const state = internals(client);
    state.state = { ...client.getSnapshot(), phase: "signed-in", ...overrides };
    return { client, state };
}

// A microtask flush so the fire-and-forget loaders inside handleTrackerMarker settle.
const flush = (): Promise<void> => Promise.resolve().then(() => undefined);

describe("MatronJournalClient tracker view state", () => {
    beforeAll(() => {
        if (!globalThis.crypto) {
            (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
        } else if (typeof globalThis.crypto.randomUUID !== "function") {
            (globalThis.crypto as { randomUUID: () => string }).randomUUID = () => webcrypto.randomUUID();
        }
    });

    it("openTrackerView opens the inbox view", () => {
        const { client } = makeClient();

        client.openTrackerView({ view: "inbox" });

        expect(client.getSnapshot().trackerView).toEqual({
            open: true,
            view: "inbox",
            selectedItemId: undefined,
        });
    });

    it("openTrackerView merges the previous selection", () => {
        const { client } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 9 },
        });

        client.openTrackerView({ itemId: 3 });

        expect(client.getSnapshot().trackerView).toEqual({
            open: true,
            view: "inbox",
            selectedItemId: 3,
        });
    });

    it("closeTrackerView clears the pane", () => {
        const { client } = makeClient({ trackerView: { open: true, view: "inbox" } });

        client.closeTrackerView();

        expect(client.getSnapshot().trackerView).toBeUndefined();
    });

    // F1: selecting a DIFFERENT row must invalidate the previously loaded detail up front, so its
    // action handlers (reply/close/reopen) can never fire against the new selection's num.
    it("openTrackerItem clears a cached detail when selecting a different item", () => {
        const { client } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 7 },
            trackerItem: { item: item({ num: 7 }), comments: [] },
        });

        client.openTrackerItem(9);

        expect(client.getSnapshot().trackerItem).toBeNull();
        expect(client.getSnapshot().trackerView?.selectedItemId).toBe(9);
    });

    it("openTrackerItem keeps the cached detail when re-selecting the same item", () => {
        const detail = { item: item({ num: 7 }), comments: [] };
        const { client } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 7 },
            trackerItem: detail,
        });

        client.openTrackerItem(7);

        expect(client.getSnapshot().trackerItem).toEqual(detail);
    });
});

describe("MatronJournalClient tracker loaders", () => {
    it("loadInbox fetches open items app-wide and writes the inbox", async () => {
        const { client, state } = makeClient();
        state.api = { items: jest.fn().mockResolvedValue({ items: [item()], next_cursor: null }) };

        await client.loadInbox();

        expect(state.api.items).toHaveBeenCalledWith({ state: "open" });
        expect(client.getSnapshot().inboxItems).toEqual([item()]);
    });

    // F3: the item list is cursor-paginated. loadInbox must follow next_cursor to the end and dedupe,
    // or the inbox (and its "Needs you" section) silently drops every open item past the first page.
    it("loadInbox follows next_cursor across pages and dedupes by id", async () => {
        const { client, state } = makeClient();
        const items = jest
            .fn()
            .mockResolvedValueOnce({
                items: [item({ id: "it_1", num: 1 }), item({ id: "it_2", num: 2 })],
                next_cursor: "cursor-2",
            })
            .mockResolvedValueOnce({
                // it_2 repeats across the page boundary — must be deduped, not double-counted.
                items: [item({ id: "it_2", num: 2 }), item({ id: "it_3", num: 3 })],
                next_cursor: null,
            });
        state.api = { items };

        await client.loadInbox();

        expect(items).toHaveBeenCalledTimes(2);
        expect(items).toHaveBeenNthCalledWith(1, { state: "open" });
        expect(items).toHaveBeenNthCalledWith(2, { state: "open", cursor: "cursor-2" });
        expect((client.getSnapshot().inboxItems ?? []).map((row) => row.id)).toEqual(["it_1", "it_2", "it_3"]);
        expect(client.getSnapshot().trackerError).toBeUndefined();
    });

    // F2: reaching the runaway page cap while the server still has more pages must NOT present the
    // partial list as authoritative — publish what we have but surface the truncation as an error,
    // or a silent cap re-creates the false "nothing needs you" the pagination walk exists to prevent.
    it("loadInbox flags a partial inbox when the page cap is reached with more pages remaining", async () => {
        const { client, state } = makeClient();
        // Every page keeps returning a next_cursor → the walk can only stop at the MAX_PAGES guard.
        const items = jest
            .fn()
            .mockImplementation(() =>
                Promise.resolve({ items: [item({ id: `it_${items.mock.calls.length}` })], next_cursor: "more" }),
            );
        state.api = { items };

        await client.loadInbox();

        expect(items).toHaveBeenCalledTimes(20); // MAX_PAGES
        expect(client.getSnapshot().inboxItems?.length).toBe(20);
        expect(client.getSnapshot().trackerError).toMatch(/partial inbox/i);
        expect(client.getSnapshot().trackerLoading).toBe(false);
    });

    // F2: a slower earlier inbox load must not overwrite a newer one — a marker can restart loadInbox
    // mid-pagination, and the older walk could otherwise finish last and restore rows the newer load
    // already dropped.
    it("loadInbox ignores a superseded concurrent load", async () => {
        const { client, state } = makeClient();
        let resolveStale!: (value: { items: TrackerItem[]; next_cursor: null }) => void;
        const stalePending = new Promise<{ items: TrackerItem[]; next_cursor: null }>((resolve) => {
            resolveStale = resolve;
        });
        state.api = {
            items: jest
                .fn()
                .mockReturnValueOnce(stalePending)
                .mockResolvedValueOnce({ items: [item({ id: "fresh" })], next_cursor: null }),
        };

        const first = client.loadInbox(); // older load, still paginating
        await client.loadInbox(); // newer load resolves first → wins
        expect((client.getSnapshot().inboxItems ?? []).map((row) => row.id)).toEqual(["fresh"]);

        resolveStale({ items: [item({ id: "stale" })], next_cursor: null }); // older load resolves — ignored
        await first;
        expect((client.getSnapshot().inboxItems ?? []).map((row) => row.id)).toEqual(["fresh"]);
    });

    it("loadItem populates the open item detail", async () => {
        const { client, state } = makeClient();
        const detail = { item: item({ num: 7 }), comments: [] };
        state.api = { item: jest.fn().mockResolvedValue(detail) };

        await client.loadItem(7);

        expect(state.api.item).toHaveBeenCalledWith(7);
        expect(client.getSnapshot().trackerItem).toEqual(detail);
    });

    // F1: a superseded (out-of-order) response must not overwrite a newer selection's detail. The
    // first (older) request resolves LAST, but the request-generation guard drops its result.
    it("loadItem ignores a superseded out-of-order response", async () => {
        const { client, state } = makeClient();
        const stale = { item: item({ num: 7 }), comments: [] };
        const current = { item: item({ num: 9 }), comments: [] };
        let resolveStale!: (value: typeof stale) => void;
        const stalePending = new Promise<typeof stale>((resolve) => {
            resolveStale = resolve;
        });
        state.api = { item: jest.fn().mockReturnValueOnce(stalePending).mockResolvedValueOnce(current) };

        const first = client.loadItem(7); // older request, still pending
        await client.loadItem(9); // newer request resolves first → wins
        expect(client.getSnapshot().trackerItem).toEqual(current);

        resolveStale(stale); // older request finally resolves — must be ignored
        await first;
        expect(client.getSnapshot().trackerItem).toEqual(current);
    });

    it("surfaces a tracker error and stops loading when a fetch rejects", async () => {
        const { client, state } = makeClient();
        state.api = { items: jest.fn().mockRejectedValue(new Error("offline")) };

        await client.loadInbox();

        expect(client.getSnapshot().trackerError).toBe("offline");
        expect(client.getSnapshot().trackerLoading).toBe(false);
    });
});

describe("MatronJournalClient tracker mutations", () => {
    it("closeTrackerItem calls the api then refetches the item and the loaded inbox", async () => {
        const { client, state } = makeClient({ inboxItems: [item({ num: 1 })] });
        state.api = {
            closeItem: jest.fn().mockResolvedValue({}),
            item: jest.fn().mockResolvedValue({ item: item({ state: "closed" }), comments: [] }),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        };

        await client.closeTrackerItem(1, "done");

        expect(state.api.closeItem).toHaveBeenCalledWith(
            1,
            { resolution: "done", comment: undefined },
            expect.any(String),
        );
        expect(state.api.item).toHaveBeenCalledWith(1);
        expect(state.api.items).toHaveBeenCalledWith({ state: "open" });
    });

    it("commentItem posts with a fresh idempotency key and refetches the item", async () => {
        const { client, state } = makeClient();
        state.api = {
            postItemComment: jest.fn().mockResolvedValue({}),
            item: jest.fn().mockResolvedValue({ item: item(), comments: [] }),
            items: jest.fn(),
        };

        await client.commentItem(1, { body: "on it" });

        expect(state.api.postItemComment).toHaveBeenCalledWith(1, { body: "on it" }, expect.any(String));
        expect(state.api.item).toHaveBeenCalledWith(1);
        // The inbox is not loaded, so it is not refetched.
        expect(state.api.items).not.toHaveBeenCalled();
    });

    // F1: a caller that can retry an ambiguous send (ItemDetail keeps the draft on failure) supplies
    // a STABLE key so the retry reuses it and the server dedupes the replay instead of duplicating.
    it("commentItem forwards a caller-supplied idempotency key verbatim", async () => {
        const { client, state } = makeClient();
        state.api = {
            postItemComment: jest.fn().mockResolvedValue({}),
            item: jest.fn().mockResolvedValue({ item: item(), comments: [] }),
            items: jest.fn(),
        };

        await client.commentItem(1, { body: "retry me" }, "stable-key-123");

        expect(state.api.postItemComment).toHaveBeenCalledWith(1, { body: "retry me" }, "stable-key-123");
    });

    // F2: the draft-preservation contract lives in the return value — true only on a confirmed write,
    // false on any handled failure — so ItemDetail.send can clear the reply only when it truly landed.
    it("commentItem resolves true on success and false on a handled failure", async () => {
        const { client, state } = makeClient();
        state.api = {
            postItemComment: jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("offline")),
            item: jest.fn().mockResolvedValue({ item: item(), comments: [] }),
            items: jest.fn(),
        };

        await expect(client.commentItem(1, { body: "landed" })).resolves.toBe(true);
        await expect(client.commentItem(1, { body: "failed" })).resolves.toBe(false);
        expect(client.getSnapshot().trackerError).toBe("offline");
    });

    it("records a tracker error and skips the refetch when the mutation itself rejects", async () => {
        const { client, state } = makeClient({ inboxItems: [item()] });
        state.api = {
            closeItem: jest.fn().mockRejectedValue(new Error("forbidden")),
            item: jest.fn(),
            items: jest.fn(),
        };

        await client.closeTrackerItem(1, "done");

        expect(client.getSnapshot().trackerError).toBe("forbidden");
        expect(state.api.item).not.toHaveBeenCalled();
        expect(state.api.items).not.toHaveBeenCalled();
    });
});

describe("MatronJournalClient handleTrackerMarker (WS invalidation)", () => {
    it("refetches the open item and the loaded inbox on a matching item marker", async () => {
        const { state } = makeClient({
            trackerItem: { item: item({ num: 2 }), comments: [] },
            inboxItems: [item({ num: 2 })],
        });
        state.api = {
            item: jest.fn().mockResolvedValue({ item: item({ num: 2 }), comments: [] }),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        };

        state.handleTrackerMarker(marker("item", { num: 2, action: "commented" }));
        await flush();

        expect(state.api.item).toHaveBeenCalledWith(2);
        expect(state.api.items).toHaveBeenCalled();
    });

    it("refetches only the inbox when the item marker is for a different open item", async () => {
        const { state } = makeClient({
            trackerItem: { item: item({ num: 2 }), comments: [] },
            inboxItems: [item({ num: 2 })],
        });
        state.api = {
            item: jest.fn().mockResolvedValue({ item: item(), comments: [] }),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        };

        state.handleTrackerMarker(marker("item", { num: 99, action: "created" }));
        await flush();

        expect(state.api.item).not.toHaveBeenCalled();
        expect(state.api.items).toHaveBeenCalled();
    });

    it("is a no-op when the pane is closed and nothing is loaded", async () => {
        const { state } = makeClient();
        state.api = { item: jest.fn(), items: jest.fn() };

        state.handleTrackerMarker(marker("item", { num: 2, action: "commented" }));
        await flush();

        expect(state.api.item).not.toHaveBeenCalled();
        expect(state.api.items).not.toHaveBeenCalled();
    });

    it("fires the marker refetch through handleJournal", async () => {
        const { client, state } = makeClient({
            trackerItem: { item: item({ num: 2 }), comments: [] },
            inboxItems: [item({ num: 2 })],
        });
        state.database = {
            applyJournal: jest.fn().mockResolvedValue(false),
            reconcileOwnMessage: jest.fn().mockResolvedValue(null),
        };
        state.api = {
            item: jest.fn().mockResolvedValue({ item: item({ num: 2 }), comments: [] }),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        };

        await internals(client).handleJournal(marker("item", { num: 2, action: "commented" }));

        expect(state.api.item).toHaveBeenCalledWith(2);
    });
});
