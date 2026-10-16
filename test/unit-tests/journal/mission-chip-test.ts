/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError } from "../../../src/journal/api";
import {
    archiveStore,
    favoriteStore,
    MatronJournalClient,
    pinnedStore,
    unreadStore,
} from "../../../src/journal/client";
import { MatronApp, MissionChip } from "../../../src/journal/components";
import {
    chipLabel,
    linkLine,
    missionSections,
    shortDate,
    titleNamesMission,
} from "../../../src/journal/conversation-missions";
import type {
    ClientState,
    Conversation,
    ConversationMissionLink,
    JournalEvent,
    Session,
} from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });

const DAY = 86_400_000;
const T0 = new Date(2026, 8, 29, 12).getTime();

function link(over: Partial<ConversationMissionLink> = {}): ConversationMissionLink {
    return {
        id: "ms_1",
        num: 12,
        state: "open",
        title: "Ship the docs",
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
        conversations: 1,
        milestones: 0,
        last_milestone: null,
        current: false,
        active: true,
        how: null,
        joined_at: T0,
        ended_at: null,
        ...over,
    };
}

const CURRENT = link({ id: "ms_1", num: 12, title: "Ship the docs", current: true, joined_at: T0 });
const ALSO_OLD = link({ id: "ms_2", num: 20, title: "Fix the login", joined_at: T0 - 3 * DAY });
const ALSO_NEW = link({ id: "ms_3", num: 21, title: "Tidy the logs", joined_at: T0 - DAY });
const ENDED = link({
    id: "ms_4",
    num: 8,
    title: "Old launch",
    active: false,
    joined_at: T0 - 9 * DAY,
    ended_at: T0 - 5 * DAY,
});
const CLOSED = link({
    id: "ms_5",
    num: 9,
    title: "Closed one",
    state: "closed",
    closed_at: T0 - 2 * DAY,
    joined_at: null,
});

describe("conversation mission sections", () => {
    it("splits links into Current, Also on (newest joined first) and Earlier (latest ended first)", () => {
        const sections = missionSections([ENDED, ALSO_OLD, CLOSED, CURRENT, ALSO_NEW]);
        expect(sections.current?.id).toBe("ms_1");
        expect(sections.alsoOn.map((row) => row.id)).toEqual(["ms_3", "ms_2"]);
        expect(sections.earlier.map((row) => row.id)).toEqual(["ms_5", "ms_4"]);
    });

    it("never makes an ended or closed link current", () => {
        const sections = missionSections([link({ current: true, state: "closed" })]);
        expect(sections.current).toBeNull();
        expect(sections.earlier).toHaveLength(1);
    });

    it("labels the chip with the headline mission and +n for the rest", () => {
        expect(chipLabel([CURRENT, ALSO_NEW, ENDED])).toEqual({ number: "#12", name: "Ship the docs", others: 2 });
        // No current: the newest active one, else the most recent earlier one.
        expect(chipLabel([ALSO_OLD, ALSO_NEW])?.number).toBe("#21");
        expect(chipLabel([ENDED, CLOSED])).toEqual({ number: "#9", name: "Closed one", others: 1 });
        expect(chipLabel([])).toBeNull();
    });

    it("drops the mission's name when the conversation title already says it", () => {
        expect(chipLabel([CURRENT], "[ab] Ship the docs")?.name).toBeNull();
        expect(chipLabel([CURRENT], "Something else")?.name).toBe("Ship the docs");
        expect(titleNamesMission({ title: "Long", name: "Docs" }, "🐣 [ab] Docs")).toBe(true);
        expect(titleNamesMission({ title: "Ship the docs site before launch", name: null }, "Ship the docs…")).toBe(
            true,
        );
        expect(titleNamesMission({ title: "Ship", name: null }, "")).toBe(false);
    });

    it("words each row's dates", () => {
        expect(linkLine(CURRENT)).toBe(`Current · since ${shortDate(T0)}`);
        expect(linkLine(ALSO_NEW)).toBe(`Also on · joined ${shortDate(T0 - DAY)}`);
        expect(linkLine(ENDED)).toBe(`${shortDate(T0 - 9 * DAY)} → ${shortDate(T0 - 5 * DAY)}`);
        expect(linkLine(CLOSED)).toBe(`until ${shortDate(T0 - 2 * DAY)}`);
        expect(linkLine(link({ current: true, joined_at: null }))).toBe("Current");
        expect(shortDate(T0)).toBe("29 Sep");
    });
});

describe("JournalApi.conversationMissions", () => {
    afterEach(() => jest.restoreAllMocks());

    it("reads flat and nested rows alike", async () => {
        const api = new JournalApi("https://journal.example", "t");
        const json = jest.spyOn(api as unknown as { json: () => Promise<unknown> }, "json").mockResolvedValue({
            missions: [
                { ...CURRENT, current: true, active: true, joined_at: T0 },
                { mission: { ...ALSO_NEW }, current: false, ended_at: T0 },
                { bogus: true },
            ],
        });
        const links = await api.conversationMissions("c 1");
        expect(json).toHaveBeenCalledWith("/conversations/c%201/missions");
        expect(links.map((row) => [row.num, row.current, row.active])).toEqual([
            [12, true, true],
            [21, false, false],
        ]);
    });
});

// ── The header chip ─────────────────────────────────────────────────────────────────────────────

const CONVERSATION: Conversation = {
    id: "c1",
    title: "One",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

interface Internals {
    state: ClientState;
    api?: Record<string, jest.Mock>;
    handleTrackerMarker(event: JournalEvent): void;
    conversationMissionsCache: Map<string, ConversationMissionLink[]>;
}

function signedIn(conversationMissions: jest.Mock): { client: MatronJournalClient; internals: Internals } {
    const client = new MatronJournalClient();
    const internals = client as unknown as Internals;
    internals.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    internals.api = { conversationMissions };
    return { client, internals };
}

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(element);
    });
    return { container, root };
}

describe("chat header mission chip", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("shows the conversation's current mission with +n, fetched for the selected conversation", async () => {
        const fetch = jest.fn().mockResolvedValue([CURRENT, ALSO_NEW, ENDED]);
        const { client } = signedIn(fetch);
        const { container, root } = await render(React.createElement(MatronApp, { client }));

        expect(fetch).toHaveBeenCalledWith("c1");
        const chip = container.querySelector<HTMLButtonElement>(".mj_ChatHeader .mj_MissionChip_trigger")!;
        expect(chip).not.toBeNull();
        expect(chip.textContent).toBe("#12Ship the docs+2");
        expect(chip.querySelector(".mj_MissionChip_name")?.textContent).toBe("Ship the docs");
        expect(chip.className).toContain("mj_MissionChip_trigger_current");
        expect(chip.getAttribute("aria-label")).toContain("Mission 12, Ship the docs, and 2 more");
        await act(async () => root.unmount());
    });

    it("is hidden when the conversation has no mission, or the journal has no such route", async () => {
        for (const fetch of [
            jest.fn().mockResolvedValue([]),
            jest.fn().mockRejectedValue(new JournalApiError("not found", 404)),
        ]) {
            const { client } = signedIn(fetch);
            const { container, root } = await render(React.createElement(MatronApp, { client }));
            expect(fetch).toHaveBeenCalled();
            expect(container.querySelector(".mj_ChatHeader")).not.toBeNull();
            expect(container.querySelector(".mj_MissionChip")).toBeNull();
            expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [] });
            await act(async () => root.unmount());
        }
    });

    it("never shows another conversation's missions", async () => {
        const fetch = jest.fn().mockReturnValue(new Promise(() => undefined));
        const { client, internals } = signedIn(fetch);
        internals.state = { ...internals.state, conversationMissions: { convoId: "c2", links: [CURRENT] } };
        const { container, root } = await render(React.createElement(MatronApp, { client }));
        expect(container.querySelector(".mj_MissionChip")).toBeNull();
        await act(async () => root.unmount());
    });

    it("lists Current, Also on and Earlier, and opens the picked mission's page", async () => {
        const client = { openTrackerMission: jest.fn() } as unknown as MatronJournalClient;
        const { container, root } = await render(
            React.createElement(MissionChip, {
                client,
                conversation: CONVERSATION,
                links: [ENDED, ALSO_NEW, CURRENT],
            }),
        );
        const trigger = container.querySelector<HTMLButtonElement>(".mj_MissionChip_trigger")!;
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        await act(async () => trigger.click());
        expect(trigger.getAttribute("aria-expanded")).toBe("true");

        const groups = [...container.querySelectorAll('[role="menu"] [role="group"]')];
        expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Current", "Also on", "Earlier"]);
        const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        expect(items.map((item) => item.querySelector(".mj_MissionMenu_title")?.textContent)).toEqual([
            "#12 Ship the docs",
            "#21 Tidy the logs",
            "#8 Old launch",
        ]);
        expect(document.activeElement).toBe(items[0]);

        await act(async () => items[1].click());
        expect(client.openTrackerMission).toHaveBeenCalledWith(21);
        expect(container.querySelector('[role="menu"]')).toBeNull();
        await act(async () => root.unmount());
    });

    it("leaves out empty groups and renders nothing without links", async () => {
        const client = { openTrackerMission: jest.fn() } as unknown as MatronJournalClient;
        const { container, root } = await render(
            React.createElement(MissionChip, { client, conversation: CONVERSATION, links: [CURRENT] }),
        );
        expect(container.querySelector(".mj_MissionChip_more")?.textContent).toBe("");
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_MissionChip_trigger")!.click());
        expect(
            [...container.querySelectorAll('[role="group"]')].map((group) => group.getAttribute("aria-label")),
        ).toEqual(["Current"]);
        await act(async () =>
            root.render(React.createElement(MissionChip, { client, conversation: CONVERSATION, links: [] })),
        );
        expect(container.innerHTML).toBe("");
        await act(async () => root.unmount());
    });
});

describe("conversation missions in the client", () => {
    const marker = (convoId: string, payload: Record<string, unknown> = {}): JournalEvent => ({
        kind: "journal",
        seq: 5,
        convo_id: convoId,
        ts: 1,
        sender: "journal",
        type: "mission",
        payload: { mission_id: "ms_1", num: 12, action: "joined", ...payload },
    });

    // Marker refetches are coalesced on a 250 ms timer; run it and let the load settle.
    const flushMarkers = async (): Promise<void> => {
        jest.advanceTimersByTime(250);
        await jest.runAllTimersAsync();
    };

    afterEach(() => jest.useRealTimers());

    it("refetches the chip's missions on a mission marker in the conversation on screen", async () => {
        jest.useFakeTimers();
        const fetch = jest.fn().mockResolvedValue([CURRENT]);
        const { client, internals } = signedIn(fetch);
        await client.loadConversationMissions("c1");
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [CURRENT] });

        internals.handleTrackerMarker(marker("c1"));
        await flushMarkers();
        expect(fetch).toHaveBeenCalledTimes(2);
        // Another conversation's marker about a mission the chip does not list costs nothing.
        internals.handleTrackerMarker(marker("c2", { mission_id: "ms_9", num: 99 }));
        await flushMarkers();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("coalesces a burst of markers into one fetch", async () => {
        jest.useFakeTimers();
        const fetch = jest.fn().mockResolvedValue([CURRENT]);
        const { internals } = signedIn(fetch);
        internals.handleTrackerMarker(marker("c1", { action: "left" }));
        internals.handleTrackerMarker(marker("c1", { action: "current_changed" }));
        internals.handleTrackerMarker(marker("c1"));
        expect(fetch).not.toHaveBeenCalled();
        await flushMarkers();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith("c1");
    });

    it("follows a rename or close of a listed mission written to its origin conversation", async () => {
        jest.useFakeTimers();
        const renamed = { ...CURRENT, title: "Ship the new docs" };
        const fetch = jest.fn().mockResolvedValueOnce([CURRENT]).mockResolvedValueOnce([renamed]);
        const { client, internals } = signedIn(fetch);
        await client.loadConversationMissions("c1");
        internals.handleTrackerMarker(marker("c-origin", { action: "updated" }));
        await flushMarkers();
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [renamed] });
    });

    it("follows a marker that lands while the first load is in flight, or after it failed", async () => {
        jest.useFakeTimers();
        let resolveFirst!: (links: ConversationMissionLink[]) => void;
        const fetch = jest
            .fn()
            .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValueOnce([CURRENT])
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce([ALSO_NEW]);
        const { client, internals } = signedIn(fetch);
        const first = client.loadConversationMissions("c1");
        // The marker's load starts after the first and wins over its pre-join answer.
        internals.handleTrackerMarker(marker("c1"));
        await flushMarkers();
        resolveFirst([]);
        await first;
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [CURRENT] });

        internals.state = { ...internals.state, conversationMissions: undefined };
        internals.conversationMissionsCache.clear();
        await client.loadConversationMissions("c1");
        expect(client.getSnapshot().conversationMissions).toBeUndefined();
        internals.handleTrackerMarker(marker("c1"));
        await flushMarkers();
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [ALSO_NEW] });
    });

    it("never publishes or caches a load that was in flight when a marker landed", async () => {
        jest.useFakeTimers();
        let resolveFirst!: (links: ConversationMissionLink[]) => void;
        let resolveSecond!: (links: ConversationMissionLink[]) => void;
        const fetch = jest
            .fn()
            .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
            .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
        const { client, internals } = signedIn(fetch);
        const first = client.loadConversationMissions("c1");
        internals.handleTrackerMarker(marker("c1"));
        // The pre-join answer lands before the marker's refetch has even started.
        resolveFirst([]);
        await first;
        expect(client.getSnapshot().conversationMissions).toBeUndefined();
        expect(internals.conversationMissionsCache.has("c1")).toBe(false);
        jest.advanceTimersByTime(250);
        resolveSecond([CURRENT]);
        await jest.runAllTimersAsync();
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [CURRENT] });
    });

    it("keeps the newest answer cached when an older request for the same conversation lands last", async () => {
        let resolveFirst!: (links: ConversationMissionLink[]) => void;
        const fetch = jest
            .fn()
            .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValueOnce([CURRENT]);
        const { client, internals } = signedIn(fetch);
        const first = client.loadConversationMissions("c1");
        await client.loadConversationMissions("c1");
        resolveFirst([]);
        await first;
        expect(internals.conversationMissionsCache.get("c1")).toEqual([CURRENT]);
    });

    it("shows a conversation's last missions at once on returning to it, then refreshes them", async () => {
        let resolveThird!: (links: ConversationMissionLink[]) => void;
        const fetch = jest
            .fn()
            .mockResolvedValueOnce([CURRENT])
            .mockResolvedValueOnce([ALSO_NEW])
            .mockReturnValueOnce(new Promise((resolve) => (resolveThird = resolve)));
        const { client } = signedIn(fetch);
        await client.loadConversationMissions("c1");
        await client.loadConversationMissions("c2");
        const back = client.loadConversationMissions("c1");
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [CURRENT] });
        resolveThird([CURRENT, ALSO_OLD]);
        await back;
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c1", links: [CURRENT, ALSO_OLD] });
    });

    it("keeps what it showed on a transient failure and ignores a superseded load", async () => {
        let resolveFirst!: (links: ConversationMissionLink[]) => void;
        const fetch = jest
            .fn()
            .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValueOnce([ALSO_NEW])
            .mockRejectedValueOnce(new Error("offline"));
        const { client } = signedIn(fetch);
        const first = client.loadConversationMissions("c1");
        await client.loadConversationMissions("c2");
        resolveFirst([CURRENT]);
        await first;
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c2", links: [ALSO_NEW] });

        await client.loadConversationMissions("c2");
        expect(client.getSnapshot().conversationMissions).toEqual({ convoId: "c2", links: [ALSO_NEW] });
    });
});
