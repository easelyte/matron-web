/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { webcrypto } from "node:crypto";

import { MatronJournalClient } from "../../../src/journal/client";
import type { ClientState, JournalEvent, Mission, MissionDetail, TrackerItem } from "../../../src/journal/types";

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
        origin_convo_title: "Brand chat",
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

function mission(over: Partial<Mission> = {}): Mission {
    return {
        id: "ms_1",
        num: 5,
        state: "open",
        title: "Ship the tracker",
        body: "",
        close_summary: null,
        closed_by: null,
        closed_over_open_items: 0,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
        last_milestone_at: null,
        closed_at: null,
        open_items: 0,
        needs_you: 0,
        conversations: 0,
        milestones: 0,
        last_milestone: null,
        ...over,
    };
}

function missionDetail(over: Partial<Mission> = {}): MissionDetail {
    return { mission: mission(over), milestones: [], items: [], conversations: [] };
}

function marker(type: string, payload: Record<string, unknown>): JournalEvent {
    return { kind: "journal", seq: 1, convo_id: "c1", ts: 1, sender: "journal", type, payload };
}

// Tracker api surface used by the client's loaders/mutators. jest.fn() everything we touch.
interface TrackerApiMock {
    missions: jest.Mock;
    items: jest.Mock;
    item: jest.Mock;
    mission: jest.Mock;
    postItemComment: jest.Mock;
    closeItem: jest.Mock;
    reopenItem: jest.Mock;
    patchMission: jest.Mock;
    closeMission: jest.Mock;
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

    it("openTrackerView closes the Files pane and sets the requested view", () => {
        const { client } = makeClient({ filesView: { open: true, path: "/root" } });

        client.openTrackerView({ view: "missions" });

        expect(client.getSnapshot().filesView).toBeUndefined();
        expect(client.getSnapshot().trackerView).toEqual({
            open: true,
            view: "missions",
            selectedItemId: undefined,
            selectedMissionId: undefined,
        });
    });

    it("openTrackerView defaults to the inbox view and merges the previous selection", () => {
        const { client } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 9 },
        });

        client.openTrackerView({ itemId: 3 });

        expect(client.getSnapshot().trackerView).toEqual({
            open: true,
            view: "missions",
            selectedItemId: 3,
            selectedMissionId: 9,
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

    it("openTrackerMission clears a cached detail when selecting a different mission", () => {
        const { client } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail({ num: 5 }),
        });

        client.openTrackerMission(8);

        expect(client.getSnapshot().trackerMission).toBeNull();
        expect(client.getSnapshot().trackerView?.selectedMissionId).toBe(8);
    });

    // F3: item and mission selection are mutually exclusive. A cross-kind deep link (item→mission)
    // must clear the item selection AND its cache, or the retained item would win the pane's
    // precedence and shadow the mission just opened.
    it("openTrackerMission clears a live item selection and its cached detail", () => {
        const { client } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 7 },
            trackerItem: { item: item({ num: 7 }), comments: [] },
        });

        client.openTrackerMission(5);

        const view = client.getSnapshot().trackerView;
        expect(view?.view).toBe("missions");
        expect(view?.selectedMissionId).toBe(5);
        expect(view?.selectedItemId).toBeUndefined();
        expect(client.getSnapshot().trackerItem).toBeNull();
    });

    it("openTrackerItem clears a live mission selection and its cached detail", () => {
        const { client } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail({ num: 5 }),
        });

        client.openTrackerItem(7);

        const view = client.getSnapshot().trackerView;
        expect(view?.view).toBe("inbox");
        expect(view?.selectedItemId).toBe(7);
        expect(view?.selectedMissionId).toBeUndefined();
        expect(client.getSnapshot().trackerMission).toBeNull();
    });
});

describe("MatronJournalClient tracker loaders", () => {
    it("loadMissions writes the mission list into the store", async () => {
        const { client, state } = makeClient();
        state.api = { missions: jest.fn().mockResolvedValue({ missions: [mission()] }) };

        await client.loadMissions();

        expect(state.api.missions).toHaveBeenCalled();
        expect(client.getSnapshot().missions).toEqual([mission()]);
        expect(client.getSnapshot().trackerLoading).toBe(false);
    });

    // F2: mission markers restart loadMissions independently of the pane, so a slower earlier request
    // must not overwrite a newer one — otherwise a closed/obsolete list resurrects.
    it("loadMissions ignores a superseded concurrent load", async () => {
        const { client, state } = makeClient();
        let resolveStale!: (value: { missions: Mission[] }) => void;
        const stalePending = new Promise<{ missions: Mission[] }>((resolve) => {
            resolveStale = resolve;
        });
        state.api = {
            missions: jest
                .fn()
                .mockReturnValueOnce(stalePending)
                .mockResolvedValueOnce({ missions: [mission({ num: 9, title: "fresh" })] }),
        };

        const first = client.loadMissions(); // older request, still pending
        await client.loadMissions(); // newer request resolves first → wins
        expect(client.getSnapshot().missions?.map((m) => m.title)).toEqual(["fresh"]);

        resolveStale({ missions: [mission({ num: 1, title: "stale" })] }); // older resolves — ignored
        await first;
        expect(client.getSnapshot().missions?.map((m) => m.title)).toEqual(["fresh"]);
    });

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

    // F2: like loadItem/loadMission, a slower earlier inbox load must not overwrite a newer one — a
    // marker can restart loadInbox mid-pagination, and the older walk could otherwise finish last
    // and restore rows the newer load already dropped.
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

    it("loadMission populates the open mission detail", async () => {
        const { client, state } = makeClient();
        const detail = missionDetail({ num: 5 });
        state.api = { mission: jest.fn().mockResolvedValue(detail) };

        await client.loadMission(5);

        expect(state.api.mission).toHaveBeenCalledWith(5);
        expect(client.getSnapshot().trackerMission).toEqual(detail);
    });

    it("surfaces a tracker error and stops loading when a fetch rejects", async () => {
        const { client, state } = makeClient();
        state.api = { missions: jest.fn().mockRejectedValue(new Error("offline")) };

        await client.loadMissions();

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

    it("closeTrackerMission calls the api then refetches the mission and the loaded list", async () => {
        const { client, state } = makeClient({ missions: [mission()] });
        state.api = {
            closeMission: jest.fn().mockResolvedValue({}),
            mission: jest.fn().mockResolvedValue(missionDetail({ state: "closed" })),
            missions: jest.fn().mockResolvedValue({ missions: [] }),
        };

        await client.closeTrackerMission("ms_1", "wrapped up");

        expect(state.api.closeMission).toHaveBeenCalledWith("ms_1", { summary: "wrapped up" }, expect.any(String));
        expect(state.api.mission).toHaveBeenCalledWith("ms_1");
        expect(state.api.missions).toHaveBeenCalled();
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

    it("refetches the open mission and the loaded list on a matching mission marker", async () => {
        const { state } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail({ num: 5 }),
            missions: [mission()],
        });
        state.api = {
            mission: jest.fn().mockResolvedValue(missionDetail({ num: 5 })),
            missions: jest.fn().mockResolvedValue({ missions: [] }),
        };

        state.handleTrackerMarker(marker("mission", { num: 5, action: "updated" }));
        await flush();

        expect(state.api.mission).toHaveBeenCalledWith(5);
        expect(state.api.missions).toHaveBeenCalled();
    });

    it("refetches the parent mission on a milestone marker carrying its mission_num", async () => {
        const { state } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail({ num: 5 }),
            missions: [mission()],
        });
        state.api = {
            mission: jest.fn().mockResolvedValue(missionDetail({ num: 5 })),
            missions: jest.fn().mockResolvedValue({ missions: [] }),
        };

        state.handleTrackerMarker(marker("milestone", { num: 12, mission_num: 5, action: "created" }));
        await flush();

        expect(state.api.mission).toHaveBeenCalledWith(5);
        expect(state.api.missions).toHaveBeenCalled();
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

// Mobile nav / header "needs you" badge. Primed on every connection ready (so a reconnect heals any
// markers missed while offline), kept live by item markers, and derived from the full inbox when
// that is loaded so the two never disagree.
describe("MatronJournalClient tracker needs-you badge", () => {
    it("refreshTrackerBadge counts open items awaiting the user across pages", async () => {
        const { client, state } = makeClient();
        state.api = {
            items: jest
                .fn()
                .mockResolvedValueOnce({
                    items: [item({ id: "it_1", num: 1 }), item({ id: "it_2", num: 2 })],
                    next_cursor: "p2",
                })
                .mockResolvedValueOnce({
                    items: [item({ id: "it_2", num: 2 }), item({ id: "it_3", num: 3, awaiting: "agent" })],
                    next_cursor: null,
                }),
        };

        await client.refreshTrackerBadge();

        expect(state.api.items).toHaveBeenNthCalledWith(1, { state: "open", awaiting: "user" });
        expect(state.api.items).toHaveBeenNthCalledWith(2, { state: "open", awaiting: "user", cursor: "p2" });
        // it_2 deduped across pages; it_3 is not awaiting the user (defensive client-side filter).
        expect(client.getSnapshot().trackerNeedsYou).toBe(2);
    });

    it("keeps the last known count when the badge fetch fails (best-effort, never an error banner)", async () => {
        const { client, state } = makeClient({ trackerNeedsYou: 4 });
        state.api = { items: jest.fn().mockRejectedValue(new Error("offline")) };

        await client.refreshTrackerBadge();

        expect(client.getSnapshot().trackerNeedsYou).toBe(4);
        expect(client.getSnapshot().trackerError).toBeUndefined();
    });

    it("loadInbox derives the badge from the full open-item list", async () => {
        const { client, state } = makeClient();
        state.api = {
            items: jest.fn().mockResolvedValue({
                items: [
                    item({ id: "it_1", num: 1, awaiting: "user" }),
                    item({ id: "it_2", num: 2, awaiting: "agent" }),
                    item({ id: "it_3", num: 3, awaiting: "user" }),
                ],
                next_cursor: null,
            }),
        };

        await client.loadInbox();

        expect(client.getSnapshot().trackerNeedsYou).toBe(2);
    });

    it("an item marker refreshes a primed badge even when the inbox is not loaded", async () => {
        const { client, state } = makeClient({ trackerNeedsYou: 0 });
        state.api = {
            item: jest.fn(),
            items: jest.fn().mockResolvedValue({ items: [item()], next_cursor: null }),
        };

        state.handleTrackerMarker(marker("item", { num: 1, action: "created" }));
        await flush();
        await flush();

        expect(state.api.items).toHaveBeenCalledWith({ state: "open", awaiting: "user" });
        expect(client.getSnapshot().trackerNeedsYou).toBe(1);
    });

    it("a successful comment refreshes a primed badge when the inbox is not loaded", async () => {
        const { client, state } = makeClient({ trackerNeedsYou: 1 });
        state.api = {
            postItemComment: jest.fn().mockResolvedValue({}),
            item: jest.fn().mockResolvedValue({ item: item({ awaiting: "agent" }), comments: [] }),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        };

        await client.commentItem(1, { body: "on it" });

        expect(state.api.items).toHaveBeenCalledWith({ state: "open", awaiting: "user" });
        expect(client.getSnapshot().trackerNeedsYou).toBe(0);
    });
});

describe("MatronJournalClient tracker needs-you badge (review round 1)", () => {
    it("an item marker mid-prime supersedes the in-flight prime (stale response dropped)", async () => {
        const { client, state } = makeClient();
        let resolvePrime!: (value: { items: TrackerItem[]; next_cursor: null }) => void;
        state.api = {
            items: jest
                .fn()
                .mockReturnValueOnce(new Promise((resolve) => (resolvePrime = resolve)))
                .mockResolvedValueOnce({ items: [item({ id: "it_1" }), item({ id: "it_2" })], next_cursor: null }),
        };

        const prime = client.refreshTrackerBadge(); // connection ready → prime in flight
        state.handleTrackerMarker(marker("item", { num: 2, action: "created" }));
        await flush();
        await flush();
        resolvePrime({ items: [], next_cursor: null }); // older state lands last
        await prime;

        expect(state.api.items).toHaveBeenCalledTimes(2);
        expect(client.getSnapshot().trackerNeedsYou).toBe(2);
    });

    it("marks the count partial when the page guard is hit with pages remaining", async () => {
        const { client, state } = makeClient();
        let n = 0;
        state.api = {
            items: jest.fn(() => {
                n += 1;
                return Promise.resolve({ items: [item({ id: `it_${n}`, num: n })], next_cursor: "more" });
            }),
        };

        await client.refreshTrackerBadge();

        expect(state.api.items).toHaveBeenCalledTimes(20);
        expect(client.getSnapshot().trackerNeedsYou).toBe(20);
        expect(client.getSnapshot().trackerNeedsYouPartial).toBe(true);
    });
});
