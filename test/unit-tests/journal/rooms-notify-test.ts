/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError } from "../../../src/journal/api";
import { ConvoNotifyBell, RoomsControl } from "../../../src/journal/ChatHeaderRooms";
import {
    archiveStore,
    favoriteStore,
    type LiveListener,
    MatronJournalClient,
    pinnedStore,
    unreadStore,
} from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import { isJoinedRoom, roomsLabel, roomsOf, roomTitle } from "../../../src/journal/conversation-rooms";
import {
    activeOverrides,
    applyNotifyChange,
    convoNotifyState,
    convoNotifySummary,
    DesktopNotifier,
    eventKey,
    muteEnd,
    notificationsFor,
    notifyChangeBody,
    type NotifyView,
} from "../../../src/journal/notifications";
import { SettingsSheet } from "../../../src/journal/SettingsSheet";
import type { ClientState, Conversation, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const MINUTE = 60_000;

const SESSION: Session = {
    serverUrl: "https://journal.example.com",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

function convo(id: string, over: Partial<Conversation> = {}): Conversation {
    return {
        id,
        title: `[${id.slice(0, 2).padEnd(2, "x")}] Chat ${id}`,
        session_state: "waiting",
        last_seq: 1,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        last_ts: 1,
        read_up_to_seq: 1,
        ...over,
    };
}

function view(over: Partial<NotifyView> = {}): NotifyView {
    return {
        mode: "all",
        events: {
            prompts: true,
            questions: true,
            notices: true,
            coordinator_done: true,
            other_done: true,
            stopped: true,
            rooms: false,
            activity: false,
        },
        has_coordinator: false,
        convos: [],
        device_level: "all",
        ...over,
    };
}

// ── Rooms rule ────────────────────────────────────────────────────────────────────────────────

describe("conversation rooms", () => {
    const me = convo("me");
    const bob = convo("bob", { title: "[bo] Bob's session" });
    const quiet = convo("r-quiet", { title: "↔️ [qq] Quiet room", participant_convos: ["me", "bob"] });
    const busy = convo("r-busy", {
        title: "↔️ [bb] Busy room",
        session_state: "running",
        snippet: "hi",
        last_ts: NOW - MINUTE,
        participant_convos: ["bob", "me", "ghost"],
    });
    const older = convo("r-older", { snippet: "x", last_ts: NOW - 60 * MINUTE, participant_convos: ["me"] });
    const elsewhere = convo("r-else", { participant_convos: ["bob"] });

    it("lists every room the conversation is in, newest activity first and never-active last", () => {
        const rooms = roomsOf("me", [me, bob, quiet, busy, older, elsewhere]);
        expect(rooms.map((room) => room.id)).toEqual(["r-busy", "r-older", "r-quiet"]);
        expect(rooms[0]).toMatchObject({ title: "Busy room", state: "running", lastActivity: NOW - MINUTE });
        expect(rooms[2].lastActivity).toBeUndefined();
    });

    it("names the other participants it knows and counts the rest", () => {
        const [busyRoom] = roomsOf("me", [me, bob, busy]);
        expect(busyRoom.peers.map((peer) => peer.id)).toEqual(["bob"]);
        expect(busyRoom.unknownPeers).toBe(1);
    });

    it("is never a room of itself, and reads states and titles as the Mac does", () => {
        const self = convo("me", { participant_convos: ["me"] });
        expect(roomsOf("me", [self])).toEqual([]);
        expect(roomsOf("me", [convo("r", { session_state: "starting", participant_convos: ["me"] })])[0].state).toBe(
            "waiting",
        );
        expect(roomTitle({ id: "r9", title: "  " })).toBe("r9");
        expect(roomTitle({ id: "r9", title: "🔗 Planning" })).toBe("Planning");
    });

    it("labels the control, and has none for a chat in no room", () => {
        expect(roomsLabel(2)).toBe("Rooms · 2");
        expect(roomsLabel(0)).toBeNull();
    });

    it("files a joined room's activity under the rooms switch", () => {
        expect(isJoinedRoom(busy)).toBe(true);
        expect(isJoinedRoom(convo("r", { participant_convos: [] }))).toBe(false);
        expect(eventKey({ kind: "activity" }, { isCoordinator: false, isRoom: isJoinedRoom(busy) })).toBe("rooms");
    });
});

// ── Settings changes ──────────────────────────────────────────────────────────────────────────

describe("notification setting changes", () => {
    it("writes each change as the journal's PUT /notify body", () => {
        expect(notifyChangeBody({ kind: "mode", mode: "custom" })).toEqual({ mode: "custom" });
        expect(notifyChangeBody({ kind: "event", event: "rooms", on: true })).toEqual({ events: { rooms: true } });
        expect(notifyChangeBody({ kind: "device_level", level: "off" })).toEqual({ device_level: "off" });
        expect(notifyChangeBody({ kind: "convo_level", convoId: "c1", level: null })).toEqual({
            convo: { convo_id: "c1", level: null },
        });
        expect(notifyChangeBody({ kind: "convo_mute", convoId: "c1", until: 5 })).toEqual({
            convo: { convo_id: "c1", mute_until: 5 },
        });
        expect(notifyChangeBody({ kind: "clear_convo", convoId: "c1" })).toEqual({
            convo: { convo_id: "c1", level: null, mute_until: null },
        });
    });

    it("applies a change as the journal will", () => {
        const custom = applyNotifyChange(view(), { kind: "event", event: "activity", on: true });
        expect(custom.mode).toBe("custom");
        expect(custom.events.activity).toBe(true);
        expect(applyNotifyChange(custom, { kind: "event", event: "prompts", on: false }).events.prompts).toBe(true);
        const coordinator = applyNotifyChange(custom, { kind: "mode", mode: "coordinator" });
        expect(coordinator.events).toMatchObject({ other_done: false, stopped: false, activity: false });
        expect(applyNotifyChange(custom, { kind: "mode", mode: "custom" }).events.activity).toBe(true);

        const levelled = applyNotifyChange(view({ convos: [{ convo_id: "a", level: "all", mute_until: null }] }), {
            kind: "convo_level",
            convoId: "b",
            level: "needs_me",
        });
        expect(levelled.convos.map((row) => row.convo_id)).toEqual(["b", "a"]);
        const muted = applyNotifyChange(levelled, { kind: "convo_mute", convoId: "b", until: NOW + MINUTE });
        expect(muted.convos[0]).toEqual({ convo_id: "b", level: "needs_me", mute_until: NOW + MINUTE });
        // A row left with neither a level nor a mute is gone, as the journal deletes it.
        const unlevelled = applyNotifyChange(levelled, { kind: "convo_level", convoId: "b", level: null });
        expect(unlevelled.convos.map((row) => row.convo_id)).toEqual(["a"]);
        expect(applyNotifyChange(muted, { kind: "clear_convo", convoId: "b" }).convos).toHaveLength(1);
    });

    it("ends a mute after an hour, eight hours, or at 08:00 tomorrow", () => {
        expect(muteEnd("hour", NOW)).toBe(NOW + 60 * MINUTE);
        expect(muteEnd("eight_hours", NOW)).toBe(NOW + 8 * 60 * MINUTE);
        expect(muteEnd("tomorrow_morning", NOW)).toBe(new Date(2026, 9, 15, 8, 0).getTime());
    });

    it("reads a conversation's state, a lapsed mute as none", () => {
        const settings = view({
            convos: [
                { convo_id: "a", level: "none", mute_until: null },
                { convo_id: "b", level: null, mute_until: NOW + MINUTE },
                { convo_id: "c", level: null, mute_until: NOW - MINUTE },
            ],
        });
        expect(convoNotifyState(settings, "a", NOW)).toEqual({ level: "none", mutedUntil: null, silenced: true });
        expect(convoNotifyState(settings, "b", NOW).silenced).toBe(true);
        expect(convoNotifyState(settings, "c", NOW)).toEqual({ level: null, mutedUntil: null, silenced: false });
        expect(activeOverrides(settings, NOW).map((row) => row.convo_id)).toEqual(["a", "b"]);
        expect(convoNotifySummary({ level: "needs_me", mutedUntil: null, silenced: false }, NOW)).toBe("Needs me");
        expect(convoNotifySummary({ level: null, mutedUntil: NOW + MINUTE, silenced: true }, NOW)).toMatch(
            /^Muted until /,
        );
    });
});

// ── The notifier's settings store ─────────────────────────────────────────────────────────────

interface Internals {
    state: ClientState;
    emit(): void;
    emitLive(call: (listener: LiveListener) => void): void;
}

function signedIn(conversations: Conversation[], selected = "me"): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = client as unknown as Internals;
    internals.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        selectedConversationId: selected,
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function storeSetup(api: { notifySettings: jest.Mock; updateNotify: jest.Mock }) {
    const client = signedIn([convo("me"), convo("c2")]);
    const notifier = new DesktopNotifier(client, {
        Notification: undefined,
        channel: () => undefined,
        storage: undefined,
        document: undefined,
        window: undefined,
        now: () => NOW,
        api: () => ({ ...api, coordinator: jest.fn().mockResolvedValue({ convo_id: null }) }),
    });
    return { client, notifier };
}

describe("notification settings store", () => {
    it("reads the settings on connect even with desktop notifications off", async () => {
        const api = { notifySettings: jest.fn().mockResolvedValue(view()), updateNotify: jest.fn() };
        const { notifier } = storeSetup(api);
        const stop = notifier.start();
        await flush();
        expect(api.notifySettings).toHaveBeenCalled();
        expect(notifier.getSettingsSnapshot().view?.mode).toBe("all");
        stop();
    });

    it("shows a change at once and keeps the journal's answer", async () => {
        let answer!: (value: unknown) => void;
        const api = {
            notifySettings: jest.fn().mockResolvedValue(view()),
            updateNotify: jest.fn(() => new Promise((resolve) => (answer = resolve))),
        };
        const { notifier } = storeSetup(api);
        const stop = notifier.start();
        await flush();
        const write = notifier.setConvoLevel("c2", "needs_me");
        expect(api.updateNotify).toHaveBeenCalledWith({ convo: { convo_id: "c2", level: "needs_me" } });
        expect(convoNotifyState(notifier.getSettingsSnapshot().view, "c2", NOW).level).toBe("needs_me");
        answer(view({ convos: [{ convo_id: "c2", level: "needs_me", mute_until: null }] }));
        await write;
        expect(notifier.getSettingsSnapshot().view?.convos).toEqual([
            { convo_id: "c2", level: "needs_me", mute_until: null },
        ]);
        stop();
    });

    it("takes back exactly the change the journal refused, and says so", async () => {
        const api = {
            notifySettings: jest.fn().mockResolvedValue(view()),
            updateNotify: jest.fn().mockRejectedValue(new Error("offline")),
        };
        const { notifier } = storeSetup(api);
        const stop = notifier.start();
        await flush();
        await notifier.muteConvo("c2", "hour");
        expect(api.updateNotify).toHaveBeenCalledWith({ convo: { convo_id: "c2", mute_until: NOW + 60 * MINUTE } });
        const snapshot = notifier.getSettingsSnapshot();
        expect(snapshot.view?.convos).toEqual([]);
        expect(snapshot.error).toBe("Couldn't save notification settings — offline");
        stop();
    });

    it("keeps the later write's answer when an earlier write answers last", async () => {
        const answers: Array<(value: unknown) => void> = [];
        const api = {
            notifySettings: jest.fn().mockResolvedValue(view()),
            updateNotify: jest.fn(() => new Promise((resolve) => answers.push(resolve))),
        };
        const { notifier } = storeSetup(api);
        const stop = notifier.start();
        await flush();
        const first = notifier.setConvoLevel("c2", "needs_me");
        const second = notifier.setConvoLevel("c2", "none");
        answers[1](view({ convos: [{ convo_id: "c2", level: "none", mute_until: null }] }));
        await second;
        answers[0](view({ convos: [{ convo_id: "c2", level: "needs_me", mute_until: null }] }));
        await first;
        expect(convoNotifyState(notifier.getSettingsSnapshot().view, "c2", NOW).level).toBe("none");
        stop();
    });

    it("keeps a write in flight showing over a live frame", async () => {
        const api = {
            notifySettings: jest.fn().mockResolvedValue(view()),
            updateNotify: jest.fn(() => new Promise(() => undefined)),
        };
        const { client, notifier } = storeSetup(api);
        const stop = notifier.start();
        await flush();
        void notifier.changeSettings({ kind: "event", event: "rooms", on: true });
        (client as unknown as Internals).emitLive((listener) =>
            listener.frame?.({
                kind: "notify",
                settings: { mode: "all", has_coordinator: true, convos: [] },
            } as never),
        );
        const shown = notifier.getSettingsSnapshot().view!;
        expect(shown.has_coordinator).toBe(true);
        expect(shown.mode).toBe("custom");
        expect(shown.events.rooms).toBe(true);
        stop();
    });

    it("keeps this device's level from a write when an older read answers after it", async () => {
        let answerRead!: (value: unknown) => void;
        const api = {
            notifySettings: jest.fn().mockResolvedValueOnce(view()),
            updateNotify: jest.fn().mockResolvedValue(view({ device_level: "needs_me" })),
        };
        const { notifier } = storeSetup(api);
        const stop = notifier.start();
        await flush();
        api.notifySettings.mockImplementationOnce(() => new Promise((resolve) => (answerRead = resolve)));
        const read = notifier.refreshSettings();
        await notifier.changeSettings({ kind: "device_level", level: "needs_me" });
        answerRead(view({ device_level: "all" }));
        await read;
        expect(notifier.getSettingsSnapshot().view?.device_level).toBe("needs_me");
        stop();
    });

    it("marks a journal without the route as unsupported", async () => {
        const api = {
            notifySettings: jest.fn().mockRejectedValue(new JournalApiError("not found", 404)),
            updateNotify: jest.fn(),
        };
        const { notifier } = storeSetup(api);
        const stop = notifier.start();
        await flush();
        expect(notifier.getSettingsSnapshot().view).toBeNull();
        stop();
    });
});

// ── Header controls and Settings ──────────────────────────────────────────────────────────────

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(element);
    });
    return { container, root };
}

describe("chat header rooms and bell", () => {
    let getNotify: jest.SpyInstance;
    let putNotify: jest.SpyInstance;
    beforeEach(() => {
        getNotify = jest
            .spyOn(JournalApi.prototype, "notifySettings")
            .mockResolvedValue(view({ convos: [{ convo_id: "r-busy", level: "none", mute_until: null }] }));
        putNotify = jest
            .spyOn(JournalApi.prototype, "updateNotify")
            .mockImplementation(async () => view({ convos: [{ convo_id: "me", level: "all", mute_until: null }] }));
        jest.spyOn(JournalApi.prototype, "coordinator").mockResolvedValue({ convo_id: null });
    });
    afterEach(() => {
        jest.restoreAllMocks();
        document.body.innerHTML = "";
    });

    // Recent enough to share one day in the sidebar.
    const recent = { created_at: Date.now() - 60 * MINUTE, last_ts: Date.now() - 60 * MINUTE };
    const conversations = [
        convo("me", recent),
        convo("bob", { ...recent, title: "[bo] Bob's session" }),
        convo("r-busy", {
            title: "↔️ [bb] Busy room",
            session_state: "running",
            snippet: "hi",
            created_at: recent.created_at,
            last_ts: Date.now() - 5 * MINUTE,
            participant_convos: ["me", "bob"],
        }),
        convo("r-quiet", { ...recent, title: "↔️ [qq] Quiet room", participant_convos: ["bob", "me"] }),
    ];

    it("puts Rooms · n and the bell in the chat header", async () => {
        const client = signedIn(conversations);
        const { container, root } = await render(React.createElement(MatronApp, { client }));
        await act(flush);
        expect(getNotify).toHaveBeenCalled();
        const header = container.querySelector(".mj_ChatHeader")!;
        expect(header.querySelector(".mj_RoomsControl_trigger")?.textContent).toBe("Rooms · 2");
        expect(header.querySelector(".mj_NotifyBell_trigger")?.getAttribute("aria-label")).toBe("Notifications");
        await act(async () => root.unmount());
    });

    it("lists the rooms with their peers, state, activity and muted state, and opens one", async () => {
        const client = signedIn(conversations);
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        const stop = notificationsFor(client).start();
        await act(flush);
        const { container, root } = await render(
            React.createElement(RoomsControl, {
                client,
                state: client.getSnapshot(),
                conversation: conversations[0],
            }),
        );
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_RoomsControl_trigger")!.click());
        const rows = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomsMenu_item")];
        const labels = rows.map((row) => row.getAttribute("aria-label"));
        expect(labels[0]).toMatch(/^Running, Busy room, notifications off, .+/);
        expect(labels[1]).toBe("Waiting, Quiet room");
        expect(rows[0].querySelector(".mj_RoomsMenu_peers")?.textContent).toBe("with Bob's session");
        // The label replaces the row's content, so the peers line is its description.
        const peersId = rows[0].getAttribute("aria-describedby")!;
        expect(container.querySelector(`[id="${peersId}"]`)?.textContent).toBe("with Bob's session");
        rows[0].focus();
        await act(async () => {
            rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        });
        expect(document.activeElement).toBe(rows[1]);
        await act(async () => {
            rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        });
        expect(document.activeElement).toBe(rows[0]);
        expect(rows[0].querySelector(".mj_RoomsMenu_time")?.textContent).toBeTruthy();
        expect(rows[0].querySelector(".mj_RoomsMenu_muted")).not.toBeNull();
        expect(rows[1].querySelector(".mj_RoomsMenu_muted")).toBeNull();
        await act(async () => rows[1].click());
        expect(select).toHaveBeenCalledWith("r-quiet");
        expect(container.querySelector(".mj_RoomsMenu")).toBeNull();
        await act(async () => root.unmount());
        stop();
    });

    describe("on a narrow header", () => {
        // Every header ResizeObserver reports a 900px pane: below the fold width, above the
        // usage and title collapse widths.
        beforeEach(() => {
            class NarrowObserver {
                public constructor(private readonly callback: ResizeObserverCallback) {}
                public observe(target: Element): void {
                    this.callback(
                        [{ target, borderBoxSize: [{ inlineSize: 900, blockSize: 60 }] } as never],
                        this as never,
                    );
                }
                public disconnect(): void {}
            }
            globalThis.ResizeObserver = NarrowObserver as unknown as typeof ResizeObserver;
        });
        afterEach(() => {
            delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        });

        it("folds Rooms and the bell into the ⋯ menu", async () => {
            const client = signedIn(conversations);
            const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
            const { container, root } = await render(React.createElement(MatronApp, { client }));
            await act(flush);
            await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
            const header = container.querySelector(".mj_ChatHeader")!;
            expect(header.querySelector(".mj_RoomsControl")).toBeNull();
            expect(header.querySelector(".mj_NotifyBell")).toBeNull();

            const overflow = header.querySelector<HTMLButtonElement>(".mj_HeaderOverflowTrigger")!;
            await act(async () => overflow.click());
            const menu = header.querySelector<HTMLElement>(".mj_ConversationMenu")!;
            expect(menu.querySelector('[role="group"][aria-label="Agent chat rooms"]')?.textContent).toMatch(
                /^Rooms · 2/,
            );
            const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
            // The first room takes focus; the arrow keys walk the level choices too.
            expect(document.activeElement).toBe(items[0]);
            const allLevel = menu.querySelector<HTMLElement>('[data-level="all"]')!;
            items[1].focus();
            await act(async () => {
                items[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
            });
            expect(document.activeElement).toBe(allLevel);

            await act(async () => allLevel.click());
            expect(putNotify).toHaveBeenCalledWith({ convo: { convo_id: "me", level: "all" } });
            expect(header.querySelector(".mj_ConversationMenu")).toBeNull();

            await act(async () => overflow.click());
            await act(async () =>
                header
                    .querySelector<HTMLButtonElement>('.mj_OverflowSection [aria-label^="Waiting, Quiet room"]')!
                    .click(),
            );
            expect(select).toHaveBeenCalledWith("r-quiet");
            await act(async () => root.unmount());
        });

        it("keeps the bell-slash in the header while the chat is silenced", async () => {
            getNotify.mockResolvedValue(view({ convos: [{ convo_id: "me", level: "none", mute_until: null }] }));
            const client = signedIn(conversations);
            const { container, root } = await render(React.createElement(MatronApp, { client }));
            await act(flush);
            await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
            const header = container.querySelector(".mj_ChatHeader")!;
            expect(header.querySelector(".mj_RoomsControl")).toBeNull();
            expect(header.querySelector(".mj_NotifyBell_trigger")?.getAttribute("aria-label")).toBe(
                "Notifications off for this conversation",
            );
            await act(async () => root.unmount());
        });
    });

    it("draws no rooms control for a chat in no room", async () => {
        const client = signedIn([convo("me")]);
        const { container, root } = await render(
            React.createElement(RoomsControl, { client, state: client.getSnapshot(), conversation: convo("me") }),
        );
        expect(container.querySelector(".mj_RoomsControl")).toBeNull();
        await act(async () => root.unmount());
    });

    it("sets the conversation's level and mutes it from the bell", async () => {
        const client = signedIn(conversations);
        const stop = notificationsFor(client).start();
        await act(flush);
        const { container, root } = await render(React.createElement(ConvoNotifyBell, { client, convoId: "me" }));
        const trigger = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>(".mj_NotifyBell_trigger")!;
        await act(async () => trigger().click());
        const checked = container.querySelector('[role="menuitemradio"][aria-checked="true"]');
        expect(checked?.getAttribute("data-level")).toBe("default");
        await act(async () => container.querySelector<HTMLButtonElement>('[data-level="all"]')!.click());
        expect(putNotify).toHaveBeenCalledWith({ convo: { convo_id: "me", level: "all" } });

        putNotify.mockImplementation(async (body: { convo: { mute_until: number } }) =>
            view({ convos: [{ convo_id: "me", level: "all", mute_until: body.convo.mute_until }] }),
        );
        await act(async () => trigger().click());
        await act(async () => container.querySelector<HTMLButtonElement>('[data-mute="eight_hours"]')!.click());
        expect(trigger().getAttribute("aria-label")).toBe("Notifications off for this conversation");
        await act(async () => trigger().click());
        expect(container.querySelector('[data-mute="unmute"]')?.textContent).toMatch(/^Unmute \(muted until /);
        await act(async () => root.unmount());
        stop();
    });

    it("hides the bell on a journal without notification settings", async () => {
        getNotify.mockRejectedValue(new JournalApiError("not found", 404));
        const client = signedIn(conversations);
        const stop = notificationsFor(client).start();
        await act(flush);
        const { container, root } = await render(React.createElement(ConvoNotifyBell, { client, convoId: "me" }));
        expect(container.querySelector(".mj_NotifyBell")).toBeNull();
        await act(async () => root.unmount());
        stop();
    });

    it("edits the mode, the switches, this device and the overrides in Settings → Notifications", async () => {
        const client = signedIn(conversations);
        jest.spyOn(client, "showDefaults").mockReturnValue(() => undefined);
        jest.spyOn(client, "showBoxDefaults").mockReturnValue(() => undefined);
        putNotify.mockImplementation(async (body: Record<string, unknown>) => {
            if (body.mode) return view({ mode: "coordinator" });
            return view({ convos: [] });
        });
        const { container, root } = await render(
            React.createElement(SettingsSheet, {
                client,
                session: SESSION,
                connection: "online",
                onSignOut: () => undefined,
                onClose: () => undefined,
            }),
        );
        await act(flush);
        expect(container.querySelector<HTMLInputElement>('[data-notify-mode="all"]')!.checked).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('[data-notify-event="prompts"]')!.disabled).toBe(true);
        const override = container.querySelector('[data-notify-override="r-busy"]')!;
        expect(override.textContent).toContain("Busy room");
        expect(override.textContent).toContain("None");
        await act(async () => override.querySelector<HTMLButtonElement>(".mj_SettingsSheet_clear")?.click());
        expect(putNotify).toHaveBeenCalledWith({ convo: { convo_id: "r-busy", level: null, mute_until: null } });
        expect(container.querySelector('[data-notify-override="r-busy"]')).toBeNull();

        await act(async () => container.querySelector<HTMLInputElement>('[data-notify-mode="coordinator"]')!.click());
        expect(putNotify).toHaveBeenCalledWith({ mode: "coordinator" });
        expect(container.textContent).toContain("Until a Coordinator is set, Coordinator mode acts as Every session.");

        await act(async () => container.querySelector<HTMLButtonElement>('[data-notify-event="rooms"]')!.click());
        expect(putNotify).toHaveBeenCalledWith({ events: { rooms: true } });

        const device = container.querySelector<HTMLSelectElement>('[data-setting="notify-device-level"]')!;
        await act(async () => {
            device.value = "needs_me";
            device.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(putNotify).toHaveBeenCalledWith({ device_level: "needs_me" });

        await act(async () => root.unmount());
    });
});
