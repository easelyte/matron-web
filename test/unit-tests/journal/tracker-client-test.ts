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

    it("loadInbox fetches open items app-wide and writes the inbox", async () => {
        const { client, state } = makeClient();
        state.api = { items: jest.fn().mockResolvedValue({ items: [item()], next_cursor: null }) };

        await client.loadInbox();

        expect(state.api.items).toHaveBeenCalledWith({ state: "open" });
        expect(client.getSnapshot().inboxItems).toEqual([item()]);
    });

    it("loadItem populates the open item detail", async () => {
        const { client, state } = makeClient();
        const detail = { item: item({ num: 7 }), comments: [] };
        state.api = { item: jest.fn().mockResolvedValue(detail) };

        await client.loadItem(7);

        expect(state.api.item).toHaveBeenCalledWith(7);
        expect(client.getSnapshot().trackerItem).toEqual(detail);
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
