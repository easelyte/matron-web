/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { webcrypto } from "node:crypto";

import { BROWSER_MEMORY_SAFETY_MAX_BYTES, MatronJournalClient, voiceNoteFile } from "../../../src/journal/client";
import type {
    ClientState,
    JournalEvent,
    Memory,
    Mission,
    MissionDetail,
    TrackerItem,
} from "../../../src/journal/types";

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
    memories: jest.Mock;
    putMemory: jest.Mock;
    deleteMemory: jest.Mock;
    projects: jest.Mock;
    project: jest.Mock;
    uploadMedia: jest.Mock;
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

    // Markers are not followed while the pane is closed, so a cached detail kept across a close
    // could reopen with a stale status and live actions.
    it("closeTrackerView drops the cached mission detail and orphans its in-flight load", async () => {
        const { client, state } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail({ num: 5 }),
        });
        state.api = { mission: jest.fn().mockResolvedValue(missionDetail({ num: 5 })) };

        const inFlight = client.loadMission(5);
        client.closeTrackerView();
        await inFlight;

        expect(client.getSnapshot().trackerMission).toBeNull();
    });

    it("closeTrackerView drops the cached item detail and orphans its in-flight load", async () => {
        const { client, state } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 7 },
            trackerItem: { item: item({ num: 7 }), comments: [] },
        });
        state.api = { item: jest.fn().mockResolvedValue({ item: item({ num: 7 }), comments: [] }) };

        const inFlight = client.loadItem(7);
        client.closeTrackerView();
        await inFlight;

        expect(client.getSnapshot().trackerItem).toBeNull();
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
        const { client, state } = makeClient({ trackerView: { open: true, view: "inbox" } });
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

    it("keeps the missions error while a retry is still in flight", async () => {
        const { client, state } = makeClient();
        let resolveRetry!: (value: { missions: Mission[] }) => void;
        state.api = {
            missions: jest
                .fn()
                .mockRejectedValueOnce(new Error("offline"))
                .mockReturnValueOnce(new Promise((resolve) => (resolveRetry = resolve))),
        };

        await client.loadMissions();
        const retry = client.loadMissions();
        await flush();
        expect(client.getSnapshot().missionsError).toBe("offline");

        resolveRetry({ missions: [] });
        await retry;
        expect(client.getSnapshot().missionsError).toBeUndefined();
    });

    it("keeps the memories error while a retry is still in flight", async () => {
        const { client, state } = makeClient();
        let resolveRetry!: (value: { memories: [] }) => void;
        state.api = {
            memories: jest
                .fn()
                .mockRejectedValueOnce(new Error("offline"))
                .mockReturnValueOnce(new Promise((resolve) => (resolveRetry = resolve))),
        };

        await client.loadMemories();
        const retry = client.loadMemories();
        await flush();
        expect(client.getSnapshot().memoriesError).toBe("offline");

        resolveRetry({ memories: [] });
        await retry;
        expect(client.getSnapshot().memoriesError).toBeUndefined();
    });

    it("loadInbox records its own error, which only the next inbox load clears", async () => {
        const { client, state } = makeClient();
        state.api = {
            items: jest
                .fn()
                .mockRejectedValueOnce(new Error("offline"))
                .mockResolvedValueOnce({ items: [], next_cursor: null }),
            item: jest.fn().mockResolvedValue({ item: item(), comments: [] }),
        };

        await client.loadInbox();
        expect(client.getSnapshot().inboxError).toBe("offline");

        // Another tracker load clears the shared banner error but not the inbox's own.
        await client.loadItem(1);
        expect(client.getSnapshot().trackerError).toBeUndefined();
        expect(client.getSnapshot().inboxError).toBe("offline");

        await client.loadInbox();
        expect(client.getSnapshot().inboxError).toBeUndefined();
        expect(client.getSnapshot().inboxItems).toEqual([]);
    });

    it("loadItem records its own error keyed by item, which only a successful item load clears", async () => {
        const { client, state } = makeClient();
        state.api = {
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
            item: jest
                .fn()
                .mockRejectedValueOnce(new Error("gone away"))
                .mockResolvedValueOnce({ item: item({ num: 7 }), comments: [] }),
        };

        await client.loadItem(7);
        expect(client.getSnapshot().itemLoadError).toEqual({ id: "7", message: "gone away" });

        // An inbox load clears the shared banner error but not the item's own.
        await client.loadInbox();
        expect(client.getSnapshot().trackerError).toBeUndefined();
        expect(client.getSnapshot().itemLoadError).toEqual({ id: "7", message: "gone away" });

        await client.loadItem(7);
        expect(client.getSnapshot().itemLoadError).toBeUndefined();
        expect(client.getSnapshot().trackerItem?.item.num).toBe(7);
    });

    // A stalled retry must not drop the stale note: the record on screen is still the old one.
    it("keeps the item load error while a retry is in flight", async () => {
        const { client, state } = makeClient();
        let resolveRetry!: (value: unknown) => void;
        state.api = {
            item: jest
                .fn()
                .mockRejectedValueOnce(new Error("gone away"))
                .mockReturnValueOnce(new Promise((resolve) => (resolveRetry = resolve))),
        };

        await client.loadItem(7);
        const retry = client.loadItem(7);
        expect(client.getSnapshot().itemLoadError).toEqual({ id: "7", message: "gone away" });

        resolveRetry({ item: item({ num: 7 }), comments: [] });
        await retry;
        expect(client.getSnapshot().itemLoadError).toBeUndefined();
    });

    it("keys the item load error without a leading #, so it matches a numeric selection", async () => {
        const { client, state } = makeClient();
        state.api = { item: jest.fn().mockRejectedValue(new Error("gone away")) };

        await client.loadItem("#7");
        expect(client.getSnapshot().itemLoadError).toEqual({ id: "7", message: "gone away" });
    });

    it("loadMissions records its own error, which only the next missions load clears", async () => {
        const { client, state } = makeClient();
        state.api = {
            missions: jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ missions: [] }),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        };

        await client.loadMissions();
        expect(client.getSnapshot().missionsError).toBe("offline");

        // A concurrent inbox success clears the shared banner error, not the missions list's own.
        await client.loadInbox();
        expect(client.getSnapshot().trackerError).toBeUndefined();
        expect(client.getSnapshot().missionsError).toBe("offline");

        await client.loadMissions();
        expect(client.getSnapshot().missionsError).toBeUndefined();
        expect(client.getSnapshot().missions).toEqual([]);
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

    it("loadMission records its own error keyed by mission, which only a successful mission load clears", async () => {
        const { client, state } = makeClient();
        state.api = {
            missions: jest.fn().mockResolvedValue({ missions: [] }),
            mission: jest
                .fn()
                .mockRejectedValueOnce(new Error("gone away"))
                .mockResolvedValueOnce(missionDetail({ num: 5 })),
        };

        await client.loadMission(5);
        expect(client.getSnapshot().missionLoadError).toEqual({ id: "5", message: "gone away" });
        expect(client.getSnapshot().trackerMission).toBeUndefined();

        // A missions-list load clears the shared banner error but not the mission's own.
        await client.loadMissions();
        expect(client.getSnapshot().trackerError).toBeUndefined();
        expect(client.getSnapshot().missionLoadError).toEqual({ id: "5", message: "gone away" });

        await client.loadMission(5);
        expect(client.getSnapshot().missionLoadError).toBeUndefined();
        expect(client.getSnapshot().trackerMission?.mission.num).toBe(5);
    });

    it("keeps the mission load error while a retry is in flight", async () => {
        const { client, state } = makeClient();
        let resolveRetry!: (value: unknown) => void;
        state.api = {
            mission: jest
                .fn()
                .mockRejectedValueOnce(new Error("gone away"))
                .mockReturnValueOnce(new Promise((resolve) => (resolveRetry = resolve))),
        };

        await client.loadMission(5);
        const retry = client.loadMission(5);
        expect(client.getSnapshot().missionLoadError).toEqual({ id: "5", message: "gone away" });

        resolveRetry(missionDetail({ num: 5 }));
        await retry;
        expect(client.getSnapshot().missionLoadError).toBeUndefined();
    });

    it("keys the mission load error without a leading #, so it matches a numeric selection", async () => {
        const { client, state } = makeClient();
        state.api = { mission: jest.fn().mockRejectedValue(new Error("gone away")) };

        await client.loadMission("#5");
        expect(client.getSnapshot().missionLoadError).toEqual({ id: "5", message: "gone away" });
    });

    it("surfaces a tracker error and stops loading when a fetch rejects", async () => {
        const { client, state } = makeClient({ trackerView: { open: true, view: "missions" } });
        state.api = { missions: jest.fn().mockRejectedValue(new Error("offline")) };

        await client.loadMissions();

        expect(client.getSnapshot().trackerError).toBe("offline");
        expect(client.getSnapshot().trackerLoading).toBe(false);
    });

    // A list load that settles after the user moved to Work or Memories keeps its own error for its
    // tab, but never raises the shared banner over the tab now showing.
    it("a list load failing after a switch to Memories records its own error but not the banner", async () => {
        const { client, state } = makeClient({ trackerView: { open: true, view: "inbox" } });
        let rejectWalk!: (error: Error) => void;
        state.api = {
            items: jest.fn(() => new Promise((_resolve, reject) => (rejectWalk = reject))),
            memories: jest.fn().mockResolvedValue({ memories: [] }),
        };

        const walk = client.loadInbox();
        client.openTrackerView({ view: "memories", itemId: null, missionId: null, memoryName: null });
        await client.loadMemories();
        rejectWalk(new Error("offline"));
        await walk;

        expect(client.getSnapshot().inboxError).toBe("offline");
        expect(client.getSnapshot().trackerError).toBeUndefined();
    });
});

describe("MatronJournalClient tracker mutations", () => {
    it("closeTrackerItem calls the api then refetches the item and the loaded inbox", async () => {
        const { client, state } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 1 },
            inboxItems: [item({ num: 1 })],
        });
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
        const { client, state } = makeClient({ trackerView: { open: true, view: "inbox", selectedItemId: 1 } });
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

    // Mission rows show item-derived counts, so an item write refreshes a loaded missions list too.
    it("closeTrackerItem refreshes a loaded missions list", async () => {
        const { client, state } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 1 },
            missions: [mission()],
        });
        state.api = {
            closeItem: jest.fn().mockResolvedValue({}),
            item: jest.fn().mockResolvedValue({ item: item({ state: "closed" }), comments: [] }),
            missions: jest.fn().mockResolvedValue({ missions: [] }),
        };

        await client.closeTrackerItem(1, "done");

        expect(state.api.missions).toHaveBeenCalledTimes(1);
    });

    it("closeTrackerMission calls the api then refetches the mission and the loaded list", async () => {
        const { client, state } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail(),
            missions: [mission()],
        });
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

    it.each([
        ["saveMissionEdits", (client: MatronJournalClient) => client.saveMissionEdits("ms_1", { title: "t" })],
        ["closeTrackerMission", (client: MatronJournalClient) => client.closeTrackerMission("ms_1", "done")],
    ])("%s does not supersede the load of a mission selected while the write was in flight", async (_name, run) => {
        const { client, state } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail(),
        });
        let landWrite!: () => void;
        const write = new Promise((resolve) => {
            landWrite = () => resolve({});
        });
        state.api = {
            patchMission: jest.fn().mockReturnValue(write),
            closeMission: jest.fn().mockReturnValue(write),
            mission: jest.fn().mockResolvedValue(missionDetail({ id: "ms_9", num: 9 })),
            missions: jest.fn(),
        };

        const pending = run(client);
        // Back, then open #9 while the write is still in flight; the pane's effect loads #9.
        client.openTrackerMission(9);
        const nine = client.loadMission(9);
        landWrite();

        await expect(pending).resolves.toBe(true);
        await nine;
        expect(state.api.mission).toHaveBeenCalledTimes(1);
        expect(state.api.mission).toHaveBeenCalledWith(9);
        expect(client.getSnapshot().trackerMission?.mission?.num).toBe(9);
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

    // The user can go Back and open another item while a write is in flight. Refetching the mutated
    // item then would bump the detail generation and drop the newer selection's load.
    it.each([
        ["commentItem", (client: MatronJournalClient) => client.commentItem(7, { body: "on it" })],
        ["closeTrackerItem", (client: MatronJournalClient) => client.closeTrackerItem(7, "done")],
        ["reopenTrackerItem", (client: MatronJournalClient) => client.reopenTrackerItem(7)],
    ])("%s does not supersede the load of an item selected while the write was in flight", async (_name, run) => {
        const { client, state } = makeClient({ trackerView: { open: true, view: "inbox", selectedItemId: 7 } });
        let landWrite!: () => void;
        const write = new Promise((resolve) => {
            landWrite = () => resolve({});
        });
        state.api = {
            postItemComment: jest.fn().mockReturnValue(write),
            closeItem: jest.fn().mockReturnValue(write),
            reopenItem: jest.fn().mockReturnValue(write),
            item: jest.fn().mockResolvedValue({ item: item({ num: 9 }), comments: [] }),
            items: jest.fn(),
        };

        const pending = run(client);
        // Back, then open #9 while the write is still in flight; the pane's effect loads #9.
        client.openTrackerItem(9);
        const nine = client.loadItem(9);
        landWrite();

        await expect(pending).resolves.toBe(true);
        await nine;
        expect(state.api.item).toHaveBeenCalledTimes(1);
        expect(state.api.item).toHaveBeenCalledWith(9);
        expect(client.getSnapshot().trackerItem?.item.num).toBe(9);
    });

    it("refetches the mutated item when the selection is written with a leading #", async () => {
        const { client, state } = makeClient({ trackerView: { open: true, view: "inbox", selectedItemId: 7 } });
        state.api = {
            closeItem: jest.fn().mockResolvedValue({}),
            item: jest.fn().mockResolvedValue({ item: item({ num: 7 }), comments: [] }),
            items: jest.fn(),
        };

        await client.closeTrackerItem("#7", "done");

        expect(state.api.item).toHaveBeenCalledWith("#7");
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
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    const OPEN = { open: true, view: "inbox" } as const;

    it("refetches the open item and the loaded inbox on a matching item marker", async () => {
        const { state } = makeClient({
            trackerView: OPEN,
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

        jest.advanceTimersByTime(250);
        expect(state.api.items).toHaveBeenCalled();
    });

    it("refetches only the inbox when the item marker is for a different open item", async () => {
        const { state } = makeClient({
            trackerView: OPEN,
            trackerItem: { item: item({ num: 2 }), comments: [] },
            inboxItems: [item({ num: 2 })],
        });
        state.api = {
            item: jest.fn().mockResolvedValue({ item: item(), comments: [] }),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        };

        state.handleTrackerMarker(marker("item", { num: 99, action: "created" }));
        jest.advanceTimersByTime(250);
        await flush();

        expect(state.api.item).not.toHaveBeenCalled();
        expect(state.api.items).toHaveBeenCalled();
    });

    it("coalesces a burst of item markers into one inbox walk", async () => {
        const { state } = makeClient({ trackerView: OPEN, inboxItems: [item({ num: 2 })] });
        state.api = { item: jest.fn(), items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }) };

        for (let num = 1; num <= 5; num += 1) state.handleTrackerMarker(marker("item", { num, action: "created" }));
        expect(state.api.items).not.toHaveBeenCalled();
        jest.advanceTimersByTime(250);
        await flush();
        expect(state.api.items).toHaveBeenCalledTimes(1);

        // A later marker arms a fresh refetch.
        state.handleTrackerMarker(marker("item", { num: 6, action: "created" }));
        jest.advanceTimersByTime(250);
        await flush();
        expect(state.api.items).toHaveBeenCalledTimes(2);
    });

    it("is a no-op when the pane is closed and nothing is loaded", async () => {
        const { state } = makeClient();
        state.api = { item: jest.fn(), items: jest.fn() };

        state.handleTrackerMarker(marker("item", { num: 2, action: "commented" }));
        jest.advanceTimersByTime(250);
        await flush();

        expect(state.api.item).not.toHaveBeenCalled();
        expect(state.api.items).not.toHaveBeenCalled();
    });

    // Closing the pane leaves the loaded data in the store; details and missions must not keep
    // refetching in the background for the rest of the session (reopening remounts the pane, which
    // reloads them). The inbox is the exception: it feeds the For you badge on the rail.
    it("refetches only the inbox once the pane is closed, for the For you badge", async () => {
        const { client, state } = makeClient({
            trackerView: OPEN,
            trackerItem: { item: item({ num: 2 }), comments: [] },
            inboxItems: [item({ num: 2 })],
            missions: [mission()],
        });
        state.api = {
            item: jest.fn(),
            items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
            missions: jest.fn(),
        };
        client.closeTrackerView();

        state.handleTrackerMarker(marker("item", { num: 2, action: "commented" }));
        jest.advanceTimersByTime(250);
        await flush();

        expect(state.api.item).not.toHaveBeenCalled();
        expect(state.api.missions).not.toHaveBeenCalled();
        expect(state.api.items).toHaveBeenCalledTimes(1);
    });

    it("keeps a pending inbox refetch when the pane closes before it fires", async () => {
        const { client, state } = makeClient({ trackerView: OPEN, inboxItems: [item({ num: 2 })] });
        state.api = { item: jest.fn(), items: jest.fn().mockResolvedValue({ items: [], next_cursor: null }) };

        state.handleTrackerMarker(marker("item", { num: 3, action: "created" }));
        client.closeTrackerView();
        jest.advanceTimersByTime(250);
        await flush();

        expect(state.api.items).toHaveBeenCalledTimes(1);
    });

    it("coalesces a burst of mission and milestone markers into one missions refetch", async () => {
        const { state } = makeClient({ trackerView: { open: true, view: "missions" }, missions: [mission()] });
        state.api = { mission: jest.fn(), missions: jest.fn().mockResolvedValue({ missions: [] }) };

        state.handleTrackerMarker(marker("mission", { num: 5, action: "updated" }));
        state.handleTrackerMarker(marker("milestone", { num: 12, mission_num: 5, action: "created" }));
        state.handleTrackerMarker(marker("milestone", { num: 13, mission_num: 6, action: "created" }));
        expect(state.api.missions).not.toHaveBeenCalled();
        jest.advanceTimersByTime(250);
        await flush();

        expect(state.api.missions).toHaveBeenCalledTimes(1);
    });

    it("refreshes the missions list and the open mission when an item marker lands", async () => {
        const { state } = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            trackerMission: missionDetail({ num: 5 }),
            missions: [mission()],
        });
        state.api = {
            item: jest.fn(),
            mission: jest.fn().mockResolvedValue(missionDetail({ num: 5 })),
            missions: jest.fn().mockResolvedValue({ missions: [] }),
        };

        state.handleTrackerMarker(marker("item", { num: 3, action: "closed" }));
        state.handleTrackerMarker(marker("item", { num: 4, action: "commented" }));
        jest.advanceTimersByTime(250);
        await flush();

        expect(state.api.missions).toHaveBeenCalledTimes(1);
        expect(state.api.mission).toHaveBeenCalledTimes(1);
        expect(state.api.mission).toHaveBeenCalledWith(5);
    });

    it("fires the marker refetch through handleJournal", async () => {
        const { client, state } = makeClient({
            trackerView: OPEN,
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

    describe("memories (spec 2026-09-27 memories)", () => {
        function memory(over: Partial<Memory> = {}): Memory {
            return {
                id: "me_1",
                name: "avoid-elm",
                type: "feedback",
                description: "Never use elm.",
                body: "",
                origin_convo_id: "c1",
                origin_device_id: 2,
                created_by: "agent",
                updated_by: "agent",
                created_at: 1,
                updated_at: 2,
                ...over,
            };
        }

        it("loadMemories fetches the list and stores it sorted by name", async () => {
            const { client, state } = makeClient();
            state.api = {
                memories: jest
                    .fn()
                    .mockResolvedValue({ memories: [memory({ name: "b" }), memory({ id: "me_2", name: "a" })] }),
            };

            await client.loadMemories();

            expect(client.getSnapshot().memories?.map((m) => m.name)).toEqual(["a", "b"]);
            expect(client.getSnapshot().trackerLoading).toBe(false);
            expect(client.getSnapshot().memoriesError).toBeUndefined();
        });

        it("loadMemories failure sets memoriesError and keeps any loaded list", async () => {
            const { client, state } = makeClient({ memories: [memory()] });
            state.api = { memories: jest.fn().mockRejectedValue(new Error("HTTP 404")) };

            await client.loadMemories();

            expect(client.getSnapshot().memoriesError).toMatch(/404/);
            expect(client.getSnapshot().memories).toEqual([memory()]);
        });

        it("saveMemory PUTs then reloads; deleteMemory clears a selection of that name and reloads", async () => {
            const { client, state } = makeClient({
                trackerView: { open: true, view: "memories", selectedMemoryName: "avoid-elm" },
            });
            const putMemory = jest.fn().mockResolvedValue({ memory: memory() });
            const deleteMemory = jest.fn().mockResolvedValue({ memory: memory() });
            const memories = jest.fn().mockResolvedValue({ memories: [memory()] });
            state.api = { putMemory, deleteMemory, memories };

            expect(
                await client.saveMemory("avoid-elm", { description: "Never use elm.", body: "", type: "feedback" }),
            ).toBe(true);
            expect(putMemory).toHaveBeenCalledWith("avoid-elm", {
                description: "Never use elm.",
                body: "",
                type: "feedback",
            });
            expect(memories).toHaveBeenCalledTimes(1);

            expect(await client.deleteMemory("avoid-elm")).toBe(true);
            expect(deleteMemory).toHaveBeenCalledWith("avoid-elm");
            expect(client.getSnapshot().trackerView?.selectedMemoryName).toBeUndefined();
            expect(client.getSnapshot().trackerView?.view).toBe("memories");
            expect(memories).toHaveBeenCalledTimes(2);
        });

        it("a failed save reports trackerError and returns false", async () => {
            const { client, state } = makeClient();
            state.api = { putMemory: jest.fn().mockRejectedValue(new Error("HTTP 409")), memories: jest.fn() };
            expect(await client.saveMemory("x", { description: "d" })).toBe(false);
            expect(client.getSnapshot().trackerError).toMatch(/409/);
            expect(state.api?.memories).not.toHaveBeenCalled();
        });

        it("openTrackerMemory selects the name in the memories view and clears item/mission selections", () => {
            const { client } = makeClient({
                trackerView: { open: true, view: "inbox", selectedItemId: 7 },
                trackerItem: { item: item({ num: 7 }), comments: [] },
            });
            client.openTrackerMemory("avoid-elm");
            expect(client.getSnapshot().trackerView).toEqual({
                open: true,
                view: "memories",
                selectedItemId: undefined,
                selectedMissionId: undefined,
                selectedMemoryName: "avoid-elm",
            });
            expect(client.getSnapshot().trackerItem).toBeNull();
            client.closeTrackerMemory();
            expect(client.getSnapshot().trackerView?.selectedMemoryName).toBeUndefined();
        });

        it("a memory marker refetches the loaded list once per burst, and nothing when the pane is closed", async () => {
            jest.useFakeTimers();
            try {
                const { state } = makeClient({
                    trackerView: { open: true, view: "memories" },
                    memories: [memory()],
                });
                const memories = jest.fn().mockResolvedValue({ memories: [memory()] });
                state.api = { memories };
                state.handleTrackerMarker(
                    marker("memory", { memory_id: "me_1", action: "saved", created: true, by: "agent" }),
                );
                state.handleTrackerMarker(
                    marker("memory", { memory_id: "me_1", action: "saved", created: true, by: "agent" }),
                );
                expect(memories).not.toHaveBeenCalled();
                jest.advanceTimersByTime(250);
                await flush();
                expect(memories).toHaveBeenCalledTimes(1);

                const closed = makeClient({ memories: [memory()] });
                const closedMemories = jest.fn();
                closed.state.api = { memories: closedMemories };
                closed.state.handleTrackerMarker(marker("memory", { memory_id: "me_1", action: "deleted" }));
                jest.advanceTimersByTime(250);
                await flush();
                expect(closedMemories).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });
    });
});

describe("MatronJournalClient projects (unify step 7)", () => {
    const project = {
        id: "pj_1",
        num: 2645,
        state: "open",
        title: "Web/Mac design unification",
        body: "Audit, then Mac leads.",
        status: "Phase 2 running.",
        status_by: "agent",
        status_updated_at: 2,
        created_at: 1,
        updated_at: 2,
        missions: { running: 1, waiting: 0, idle: 0, quiet: 0, closed: 0 },
        needs_you: 1,
        open_items: 4,
        last_activity_at: 3,
    };

    it("loadProjects writes the project list", async () => {
        const { client, state } = makeClient();
        state.api = { projects: jest.fn().mockResolvedValue({ projects: [project] }) };
        await client.loadProjects();
        expect(client.getSnapshot().projects).toEqual([project]);
        expect(client.getSnapshot().projectsError).toBeUndefined();
    });

    it("loadProjects keeps the last good list and records the error on failure", async () => {
        const { client, state } = makeClient({ projects: [project] } as Partial<ClientState>);
        state.api = { projects: jest.fn().mockRejectedValue(new Error("offline")) };
        await client.loadProjects();
        expect(client.getSnapshot().projects).toEqual([project]);
        expect(client.getSnapshot().projectsError).toBe("offline");
    });

    it("loadProject stores the detail and ignores a superseded load", async () => {
        const { client, state } = makeClient();
        let resolveFirst!: (value: unknown) => void;
        const detail = (title: string) => ({
            project: { ...project, title },
            missions: [],
            needs_you: [],
            recent_milestones: [],
            sessions_by_box: {},
        });
        state.api = {
            project: jest
                .fn()
                .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
                .mockResolvedValueOnce(detail("newer")),
        };
        const first = client.loadProject(2645);
        await client.loadProject(2645);
        resolveFirst(detail("older"));
        await first;
        expect(client.getSnapshot().trackerProject?.project.title).toBe("newer");
    });

    it("openTrackerProject selects the project on the projects view and clears a mission selection", () => {
        const { client } = makeClient({ trackerView: { open: true, view: "missions", selectedMissionId: 9 } });
        client.openTrackerProject(2645);
        expect(client.getSnapshot().trackerView).toMatchObject({
            open: true,
            view: "missions",
            selectedProjectId: 2645,
            selectedMissionId: undefined,
        });
    });

    it("a matron://project link opens that project's page, clearing any item or mission", () => {
        const { client } = makeClient({ trackerView: { open: true, view: "inbox", selectedItemId: 12 } });
        client.openTrackerLink("project", 2645);
        expect(client.getSnapshot().trackerView).toMatchObject({
            open: true,
            view: "missions",
            selectedProjectId: 2645,
            selectedItemId: undefined,
            selectedMissionId: undefined,
        });
        // Non-positive or non-integer numbers are ignored.
        client.openTrackerLink("project", 0);
        client.openTrackerLink("project", "x");
        expect(client.getSnapshot().trackerView?.selectedProjectId).toBe(2645);
    });

    it("openTrackerItem keeps the project only when asked, so back can return to it", () => {
        const { client } = makeClient({ trackerView: { open: true, view: "missions", selectedProjectId: 2645 } });
        client.openTrackerItem(3939, { keepProject: true });
        expect(client.getSnapshot().trackerView).toMatchObject({
            view: "inbox",
            selectedItemId: 3939,
            selectedProjectId: 2645,
        });
        client.openTrackerItem(7940);
        expect(client.getSnapshot().trackerView?.selectedProjectId).toBeUndefined();
    });
});

describe("MatronJournalClient projects (review fixes)", () => {
    const project = (num: number) =>
        ({
            id: `pj_${num}`,
            num,
            state: "open",
            title: `Project ${num}`,
            body: "",
            status: null,
            status_by: null,
            status_updated_at: null,
            created_at: 1,
            updated_at: 1,
            missions: { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 },
            needs_you: 0,
            open_items: 0,
            last_activity_at: 1,
        }) as const;
    const detail = (num: number, extra: Record<string, unknown> = {}) => ({
        project: project(num),
        missions: [],
        needs_you: [],
        recent_milestones: [],
        sessions_by_box: {},
        ...extra,
    });

    afterEach(() => jest.useRealTimers());

    it("treats a 404 from GET /projects as an older journal without projects", async () => {
        const { JournalApiError } = await import("../../../src/journal/api");
        const { client, state } = makeClient();
        state.api = { projects: jest.fn().mockRejectedValue(new JournalApiError("not found", 404)) };
        await client.loadProjects();
        expect(client.getSnapshot().projectsUnsupported).toBe(true);
        expect(client.getSnapshot().projectsError).toBeUndefined();
    });

    it("follows a merged project to the one it was merged into", async () => {
        const { client, state } = makeClient({
            trackerView: { open: true, view: "missions", selectedProjectId: 5000 },
        });
        state.api = {
            project: jest.fn().mockResolvedValue(detail(2645, { merged_from: { id: "pj_5000", num: 5000 } })),
        };
        await client.loadProject(5000);
        expect(client.getSnapshot().trackerView?.selectedProjectId).toBe(2645);
        expect(client.getSnapshot().trackerProject?.project.num).toBe(2645);
    });

    it("keeps a project load error separate from the list error", async () => {
        const { client, state } = makeClient();
        state.api = { project: jest.fn().mockRejectedValue(new Error("boom")) };
        await client.loadProject(2645);
        expect(client.getSnapshot().projectLoadError).toEqual({ id: "2645", message: "boom" });
        expect(client.getSnapshot().projectsError).toBeUndefined();
    });

    it("refreshes the project list and the open project on mission markers", async () => {
        jest.useFakeTimers();
        const { state } = makeClient({
            trackerView: { open: true, view: "missions", selectedProjectId: 2645 },
            projects: [project(2645)],
            trackerProject: detail(2645),
        } as Partial<ClientState>);
        state.api = {
            projects: jest.fn().mockResolvedValue({ projects: [project(2645)] }),
            project: jest.fn().mockResolvedValue(detail(2645)),
            missions: jest.fn().mockResolvedValue({ missions: [] }),
        };
        state.handleTrackerMarker(marker("mission", { num: 1, action: "updated" }));
        jest.advanceTimersByTime(250);
        expect(state.api.projects).toHaveBeenCalled();
        expect(state.api.project).toHaveBeenCalledWith(2645);
    });

    it("drops the cached project when the tracker closes", () => {
        const { client } = makeClient({
            trackerView: { open: true, view: "missions", selectedProjectId: 2645 },
            trackerProject: detail(2645),
        } as Partial<ClientState>);
        client.closeTrackerView();
        expect(client.getSnapshot().trackerProject).toBeNull();
    });
});

// The item reply box uploads each staged file (and a voice note) to /media before posting the
// comment with the blob refs.
describe("MatronJournalClient tracker attachments", () => {
    // jsdom's File has no arrayBuffer(); give the test file one that answers its contents.
    const file = (contents: string, name: string, options?: FilePropertyBag): File => {
        const made = new File([contents], name, options);
        Object.defineProperty(made, "arrayBuffer", {
            value: async () => Uint8Array.from(Buffer.from(contents)).buffer,
        });
        return made;
    };

    it("uploadTrackerAttachment uploads the bytes and returns the comment attachment", async () => {
        const { client, state } = makeClient();
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "m_1", size: 5, content_type: "image/png" });
        state.api = { uploadMedia };
        const attachment = await client.uploadTrackerAttachment(file("hello", "shot.png", { type: "image/png" }));

        expect(attachment).toEqual({ blob_ref: "m_1", mime: "image/png", name: "shot.png", size: 5 });
        expect(uploadMedia).toHaveBeenCalledTimes(1);
        const [bytes, type, signal] = uploadMedia.mock.calls[0];
        expect(Buffer.from(bytes as ArrayBuffer).toString()).toBe("hello");
        expect(type).toBe("image/png");
        expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("uploadTrackerAttachment falls back to a generic type for a file the browser could not type", async () => {
        const { client, state } = makeClient();
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "m_2", size: 3, content_type: "" });
        state.api = { uploadMedia };

        const attachment = await client.uploadTrackerAttachment(file("abc", "notes.bin"));

        expect(uploadMedia.mock.calls[0][1]).toBe("application/octet-stream");
        expect(attachment).toEqual({ blob_ref: "m_2", mime: "application/octet-stream", name: "notes.bin", size: 3 });
    });

    it("uploadTrackerAttachment resolves null and surfaces the error when the upload fails", async () => {
        const { client, state } = makeClient();
        state.api = { uploadMedia: jest.fn().mockRejectedValue(new Error("offline")) };

        const attachment = await client.uploadTrackerAttachment(file("x", "a.txt", { type: "text/plain" }));

        expect(attachment).toBeNull();
        expect(client.getSnapshot().trackerError).toContain("offline");
    });

    it("uploadTrackerAttachment refuses an empty file without reading or uploading it", async () => {
        const { client, state } = makeClient();
        const uploadMedia = jest.fn();
        state.api = { uploadMedia };

        const attachment = await client.uploadTrackerAttachment(file("", "blank.txt", { type: "text/plain" }));

        expect(attachment).toBeNull();
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(client.getSnapshot().trackerError).toBe("Couldn't upload blank.txt: that file is empty.");
    });

    it("uploadTrackerAttachment refuses a file over the browser memory cap without reading it", async () => {
        const { client, state } = makeClient();
        const uploadMedia = jest.fn();
        state.api = { uploadMedia };
        const huge = new File(["x"], "huge.mov", { type: "video/quicktime" });
        Object.defineProperty(huge, "size", { value: BROWSER_MEMORY_SAFETY_MAX_BYTES + 1 });
        const read = jest.fn();
        Object.defineProperty(huge, "arrayBuffer", { value: read });

        const attachment = await client.uploadTrackerAttachment(huge);

        expect(attachment).toBeNull();
        expect(read).not.toHaveBeenCalled();
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(client.getSnapshot().trackerError).toBe(
            "Couldn't upload huge.mov: this file is too large for this browser to upload safely.",
        );
    });

    it("voiceNoteFile names the recording after the recorder's mime", () => {
        const cases: Array<[string, string, string]> = [
            ["audio/webm;codecs=opus", "voice-note.webm", "audio/webm;codecs=opus"],
            ["audio/mp4", "voice-note.m4a", "audio/mp4"],
            ["audio/ogg;codecs=opus", "voice-note.ogg", "audio/ogg;codecs=opus"],
            ["", "voice-note.webm", "audio/webm"],
        ];
        for (const [type, name, mime] of cases) {
            const file = voiceNoteFile(new Blob(["v"], { type }));
            expect(file.name).toBe(name);
            expect(file.type).toBe(mime);
        }
    });
});

describe("MatronJournalClient notices and user settings", () => {
    beforeAll(() => {
        if (typeof globalThis.crypto?.randomUUID !== "function") {
            (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
        }
    });

    type SettingsInternals = Omit<Internals, "api" | "database"> & {
        api?: Partial<TrackerApiMock> & { settings?: jest.Mock; patchSettings?: jest.Mock };
        handleFrame(frame: unknown): Promise<void>;
        handleReady(hello?: unknown): Promise<void>;
        database?: unknown;
        connection?: unknown;
    };

    it("markItemSeen posts the Seen tap and drops the closed notice from Needs you at once", async () => {
        const notice = item({ id: "it_9", num: 9, kind: "notice", actions: ["Seen"] });
        const other = item({ id: "it_2", num: 2 });
        const { client, state } = makeClient({ inboxItems: [notice, other] });
        let releaseRefetch: (value: unknown) => void = () => undefined;
        state.api = {
            postItemComment: jest.fn().mockResolvedValue({
                item: { ...notice, state: "closed", resolution: "done", awaiting: null },
                comment: {},
            }),
            // Hold the inbox refetch so the test sees the store before it lands.
            items: jest.fn().mockReturnValue(new Promise((resolve) => (releaseRefetch = resolve))),
        };

        const done = client.markItemSeen(9);
        await flush();
        await flush();

        expect(state.api.postItemComment).toHaveBeenCalledWith(9, { action: "Seen", body: "Seen" }, expect.any(String));
        expect(client.getSnapshot().inboxItems?.map((row) => row.num)).toEqual([2]);

        releaseRefetch({ items: [other], next_cursor: null });
        await expect(done).resolves.toBe(true);
    });

    it("markItemSeen updates the open item detail with the closed notice", async () => {
        const notice = item({ id: "it_9", num: 9, kind: "notice" });
        const closed = { ...notice, state: "closed" as const, resolution: "done" as const, awaiting: null };
        const { client, state } = makeClient({
            trackerView: { open: true, view: "inbox", selectedItemId: 9 },
            trackerItem: { item: notice, comments: [] },
        });
        state.api = {
            postItemComment: jest.fn().mockResolvedValue({ item: closed, comment: {} }),
            item: jest.fn().mockResolvedValue({ item: closed, comments: [] }),
        };

        await client.markItemSeen(9);

        expect(client.getSnapshot().trackerItem?.item.state).toBe("closed");
    });

    it("a Seen tap during the first inbox walk is not undone when the walk lands", async () => {
        const notice = item({ id: "it_9", num: 9, kind: "notice", actions: ["Seen"], updated_at: 100 });
        const other = item({ id: "it_2", num: 2 });
        const closed = {
            ...notice,
            state: "closed" as const,
            resolution: "done" as const,
            awaiting: null,
            updated_at: 200,
        };
        const { client, state } = makeClient();
        let releaseFirstWalk: (value: unknown) => void = () => undefined;
        const items = jest
            .fn()
            // The connect-time walk: its page was read before the Seen tap and still has the notice.
            .mockReturnValueOnce(new Promise((resolve) => (releaseFirstWalk = resolve)))
            // A follow-up walk whose answer is still stale (a lagging replica, say).
            .mockResolvedValue({ items: [notice, other], next_cursor: null });
        state.api = { items, postItemComment: jest.fn().mockResolvedValue({ item: closed, comment: {} }) };

        const firstWalk = client.loadInbox();
        expect(client.getSnapshot().inboxItems).toBeUndefined();

        const seen = client.markItemSeen(9);
        await flush();
        await flush();
        releaseFirstWalk({ items: [notice, other], next_cursor: null });
        await firstWalk;
        await expect(seen).resolves.toBe(true);

        // The write refetched even though the inbox had not published yet, and the walk's older copy
        // of the notice did not come back.
        expect(items).toHaveBeenCalledTimes(2);
        expect(client.getSnapshot().inboxItems?.map((row) => row.num)).toEqual([2]);
    });

    it("an item marker during the first inbox walk schedules a refetch", async () => {
        jest.useFakeTimers();
        try {
            const { client, state } = makeClient();
            let releaseFirstWalk: (value: unknown) => void = () => undefined;
            const items = jest
                .fn()
                .mockReturnValueOnce(new Promise((resolve) => (releaseFirstWalk = resolve)))
                .mockResolvedValue({ items: [], next_cursor: null });
            state.api = { items };

            const firstWalk = client.loadInbox();
            state.handleTrackerMarker(marker("item", { num: 9 }));
            jest.advanceTimersByTime(300);
            releaseFirstWalk({ items: [item({ id: "it_9", num: 9 })], next_cursor: null });
            await firstWalk;
            await flush();
            await flush();

            expect(items).toHaveBeenCalledTimes(2);
            expect(client.getSnapshot().inboxItems).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("a successful settings load or a live settings frame clears a stale save error", async () => {
        const { client, state } = makeClient({ userSettings: { notices: true }, userSettingsError: "offline" });
        const internal = state as SettingsInternals;
        internal.api = { settings: jest.fn().mockResolvedValue({ notices: true }) };

        await client.loadSettings();
        expect(client.getSnapshot().userSettingsError).toBeUndefined();

        internal.state = { ...internal.state, userSettingsError: "offline" };
        await internal.handleFrame({ kind: "control", op: "settings", settings: { notices: false } });
        expect(client.getSnapshot().userSettingsError).toBeUndefined();
        expect(client.getSnapshot().userSettings).toEqual({ notices: false });
    });

    it("loadSettings stores the notices setting", async () => {
        const { client, state } = makeClient();
        (state as SettingsInternals).api = { settings: jest.fn().mockResolvedValue({ notices: false }) };

        await client.loadSettings();

        expect(client.getSnapshot().userSettings).toEqual({ notices: false });
        expect(client.getSnapshot().userSettingsUnsupported).toBe(false);
    });

    it("loadSettings marks settings unsupported on a 404 (an older journal)", async () => {
        const { JournalApiError } = await import("../../../src/journal/api");
        const { client, state } = makeClient();
        (state as SettingsInternals).api = {
            settings: jest.fn().mockRejectedValue(new JournalApiError("Not found", 404)),
        };

        await client.loadSettings();

        expect(client.getSnapshot().userSettingsUnsupported).toBe(true);
        expect(client.getSnapshot().userSettings).toBeUndefined();
    });

    it("setNoticesSetting PATCHes and keeps the journal's answer", async () => {
        const { client, state } = makeClient({ userSettings: { notices: true } });
        const patchSettings = jest.fn().mockResolvedValue({ notices: false });
        (state as SettingsInternals).api = { patchSettings };

        await expect(client.setNoticesSetting(false)).resolves.toBe(true);

        expect(patchSettings).toHaveBeenCalledWith({ notices: false });
        expect(client.getSnapshot().userSettings).toEqual({ notices: false });
    });

    it("setNoticesSetting puts the old value back and reports a failed save", async () => {
        const { client, state } = makeClient({ userSettings: { notices: true } });
        (state as SettingsInternals).api = { patchSettings: jest.fn().mockRejectedValue(new Error("offline")) };

        await expect(client.setNoticesSetting(false)).resolves.toBe(false);

        expect(client.getSnapshot().userSettings).toEqual({ notices: true });
        expect(client.getSnapshot().userSettingsError).toBe("offline");
    });

    it("applies the settings control frame live and ignores a malformed one", async () => {
        const { client, state } = makeClient({ userSettings: { notices: true } });
        const internal = state as SettingsInternals;

        await internal.handleFrame({ kind: "control", op: "settings", settings: { notices: false } });
        expect(client.getSnapshot().userSettings).toEqual({ notices: false });

        await internal.handleFrame({ kind: "control", op: "settings", settings: { notices: "yes" } });
        expect(client.getSnapshot().userSettings).toEqual({ notices: false });
    });

    it("on (re)connect takes the settings from hello_ok and loads the inbox for the badge", async () => {
        const { client, state } = makeClient();
        const internal = state as SettingsInternals;
        internal.database = { outbox: jest.fn().mockResolvedValue([]), cursor: jest.fn().mockResolvedValue(undefined) };
        internal.connection = { send: jest.fn() };
        internal.api = { items: jest.fn().mockResolvedValue({ items: [item()], next_cursor: null }) };

        await internal.handleReady({ kind: "control", op: "hello_ok", settings: { notices: false } });
        await flush();

        expect(client.getSnapshot().userSettings).toEqual({ notices: false });
        expect(internal.api.items).toHaveBeenCalledWith({ state: "open" });
        expect(client.getSnapshot().inboxItems).toHaveLength(1);
    });
});
