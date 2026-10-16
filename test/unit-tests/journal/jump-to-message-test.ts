/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import {
    isJumpToLastOwnShortcut,
    landingSeq,
    newestOwnMessageSeq,
    focusScrollTop,
} from "../../../src/journal/jump-to-message";
import type { ClientState, Conversation, JournalEvent, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

const conversation = (id: string, lastSeq = 0): Conversation => ({
    id,
    title: id,
    session_state: "idle",
    last_seq: lastSeq,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    read_up_to_seq: 0,
});

const event = (seq: number, overrides: Partial<JournalEvent> = {}): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: 1_700_000_000_000 + seq * 1000,
    sender: "agent:box-a",
    type: "text",
    payload: { body: `message ${seq}` },
    ...overrides,
});

const own = (seq: number, overrides: Partial<JournalEvent> = {}): JournalEvent =>
    event(seq, { sender: "user:alice", ...overrides });

interface ClientInternals {
    state: ClientState;
    database?: unknown;
    api?: unknown;
    history: Map<string, { initialized: boolean; hasMore: boolean; oldestSeq?: number }>;
}

const internals = (client: MatronJournalClient): ClientInternals => client as unknown as ClientInternals;

/**
 * A journal holding `server` (every conversation's events) and a device database that keeps
 * whatever history pages it is given, so paging back behaves as it does against a real journal.
 */
function pagingClient(
    server: JournalEvent[],
    options: { selected?: string; conversations?: Conversation[] } = {},
): { client: MatronJournalClient; messages: jest.Mock } {
    const client = new MatronJournalClient();
    const stored = new Map<number, JournalEvent>();
    const database = {
        events: jest.fn(async (id: string) =>
            [...stored.values()].filter((row) => row.convo_id === id).sort((a, b) => a.seq - b.seq),
        ),
        outbox: jest.fn().mockResolvedValue([]),
        putHistory: jest.fn(async (rows: JournalEvent[]) => {
            for (const row of rows) stored.set(row.seq, row);
        }),
        reconcilePersistedOwnMessages: jest.fn().mockResolvedValue([]),
        markLocallyRead: jest.fn().mockResolvedValue(undefined),
    };
    const messages = jest.fn(async (id: string, beforeSeq: number | undefined, limit: number) => {
        const older = server
            .filter((row) => row.convo_id === id && (beforeSeq === undefined || row.seq < beforeSeq))
            .sort((a, b) => b.seq - a.seq)
            .slice(0, limit);
        return { events: older };
    });
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: options.conversations ?? [conversation("c1", 1000), conversation("c2", 1000)],
        selectedConversationId: options.selected,
        connection: "online",
    };
    internals(client).database = database;
    internals(client).api = { messages };
    return { client, messages };
}

const range = (from: number, to: number, make: (seq: number) => JournalEvent = event): JournalEvent[] =>
    Array.from({ length: to - from + 1 }, (_, index) => make(from + index));

describe("jump-to-message helpers", () => {
    it("lands on the exact row, else the nearest row before it, else the oldest row", () => {
        expect(landingSeq([10, 20, 30], 20)).toBe(20);
        expect(landingSeq([10, 20, 30], 25)).toBe(20);
        expect(landingSeq([10, 20, 30], 99)).toBe(30);
        expect(landingSeq([10, 20, 30], 5)).toBe(10);
        expect(landingSeq([], 5)).toBeUndefined();
    });

    it("finds the newest message the user wrote, skipping agent rows and tracker fallbacks", () => {
        expect(
            newestOwnMessageSeq([
                own(1),
                own(2, { type: "image", payload: { media_id: "m" } }),
                own(3, { type: "prompt_reply", payload: {} }),
                event(4),
                own(5, { payload: { body: "card", fallback_for: "item" } }),
            ]),
        ).toBe(2);
        expect(newestOwnMessageSeq([event(1)])).toBeUndefined();
    });

    it("binds ⇧⌘U on a Mac and Ctrl+Shift+U elsewhere", () => {
        const key = { key: "U", shiftKey: true, altKey: false, metaKey: false, ctrlKey: false };
        expect(isJumpToLastOwnShortcut({ ...key, metaKey: true }, true)).toBe(true);
        expect(isJumpToLastOwnShortcut({ ...key, ctrlKey: true }, true)).toBe(false);
        expect(isJumpToLastOwnShortcut({ ...key, ctrlKey: true }, false)).toBe(true);
        expect(isJumpToLastOwnShortcut({ ...key, ctrlKey: true, shiftKey: false }, false)).toBe(false);
        expect(isJumpToLastOwnShortcut({ ...key, ctrlKey: true, altKey: true }, false)).toBe(false);
    });

    it("centres a row that fits and puts a tall row's top near the top, within the scroll range", () => {
        const scroller = document.createElement("div");
        const row = document.createElement("li");
        Object.defineProperties(scroller, {
            clientHeight: { value: 400 },
            scrollHeight: { value: 5000 },
            scrollTop: { value: 1000, writable: true },
        });
        scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
        row.getBoundingClientRect = () => ({ top: 900, height: 100 }) as DOMRect;
        // Row is 800px below the scroller's top; centring a 100px row in 400px leaves 150px above.
        expect(focusScrollTop(scroller, row)).toBe(1000 + 800 - 150);
        row.getBoundingClientRect = () => ({ top: 900, height: 1200 }) as DOMRect;
        expect(focusScrollTop(scroller, row)).toBe(1000 + 800 - 16);
        row.getBoundingClientRect = () => ({ top: 99_999, height: 10 }) as DOMRect;
        expect(focusScrollTop(scroller, row)).toBe(4600);
    });
});

describe("client.focusMessage", () => {
    it("opens the conversation and pages back until the target seq is loaded", async () => {
        const { client, messages } = pagingClient(range(1, 400));
        await expect(client.focusMessage("c1", 150)).resolves.toBe(true);

        const state = client.getSnapshot();
        expect(state.selectedConversationId).toBe("c1");
        expect(state.events.some((row) => row.seq === 150)).toBe(true);
        // 400 → 321, 320 → 241, 240 → 161, 160 → 81: four pages of 80.
        expect(messages).toHaveBeenCalledTimes(4);
        expect(state.focusTarget).toEqual({ conversationId: "c1", seq: 150, token: expect.any(Number) });
    });

    it("does not page when the target is already loaded", async () => {
        const { client, messages } = pagingClient(range(1, 50), { selected: "c1" });
        await client.focusMessage("c1", 40);
        expect(messages).toHaveBeenCalledTimes(1); // the opening page only
        messages.mockClear();
        await client.focusMessage("c1", 20);
        expect(messages).not.toHaveBeenCalled();
        expect(client.getSnapshot().focusTarget?.seq).toBe(20);
    });

    it("stops at the start of history and still hands over a target", async () => {
        const { client, messages } = pagingClient(range(100, 200));
        await client.focusMessage("c1", 7);
        expect(messages).toHaveBeenCalledTimes(2); // 200 → 121, then the last 21 rows
        expect(client.getSnapshot().focusTarget?.seq).toBe(7);
    });

    it("gives up paging after a bounded number of pages", async () => {
        const { client, messages } = pagingClient(range(1, 3000));
        await client.focusMessage("c1", 1);
        expect(messages).toHaveBeenCalledTimes(21); // the opening page, then at most 20 more
        expect(client.getSnapshot().focusTarget?.seq).toBe(1);
    });

    it("drops a jump superseded by a newer one", async () => {
        const { client } = pagingClient(range(1, 400));
        const first = client.focusMessage("c1", 10);
        const second = client.focusMessage("c1", 390);
        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(true);
        expect(client.getSnapshot().focusTarget?.seq).toBe(390);
    });

    it("drops a jump when another conversation is opened mid-way", async () => {
        const { client } = pagingClient(range(1, 400));
        const jump = client.focusMessage("c1", 10);
        await Promise.resolve();
        await client.selectConversation("c2");
        await expect(jump).resolves.toBe(false);
        expect(client.getSnapshot().focusTarget).toBeUndefined();
        expect(client.getSnapshot().selectedConversationId).toBe("c2");
    });

    it("drops a jump when the tracker is opened mid-way, so returning later flashes nothing", async () => {
        const { client } = pagingClient(range(1, 2000), { selected: "c1" });
        await client.selectConversation("c1");
        const load = client.loadOlderHistory.bind(client);
        let pages = 0;
        jest.spyOn(client, "loadOlderHistory").mockImplementation(async (opts) => {
            if (++pages === 2) client.openTrackerView({ view: "inbox" });
            await load(opts);
        });
        await expect(client.focusMessage("c1", 5)).resolves.toBe(false);
        expect(pages).toBe(2);
        client.closeTrackerView();
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });

    it("withdraws a target not yet landed when the tracker opens", async () => {
        const { client } = pagingClient(range(1, 50), { selected: "c1" });
        await client.focusMessage("c1", 40);
        expect(client.getSnapshot().focusTarget).toBeDefined();
        client.openTrackerView({ view: "inbox" });
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });

    it("clears the target only for the token it was handed over with", async () => {
        const { client } = pagingClient(range(1, 50), { selected: "c1" });
        await client.focusMessage("c1", 40);
        const token = client.getSnapshot().focusTarget!.token;
        client.clearFocusTarget(token - 1);
        expect(client.getSnapshot().focusTarget).toBeDefined();
        client.clearFocusTarget(token);
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });
});

describe("client.jumpToLastOwnMessage", () => {
    it("pages back until the user's own message is loaded and targets it", async () => {
        const server = range(1, 300, (seq) => (seq === 50 ? own(seq) : event(seq)));
        const { client, messages } = pagingClient(server, { selected: "c1" });
        await client.loadOlderHistory();
        messages.mockClear();

        await expect(client.jumpToLastOwnMessage()).resolves.toBe(true);
        expect(client.getSnapshot().focusTarget?.seq).toBe(50);
        expect(messages).toHaveBeenCalledTimes(3); // 221–300 loaded already; 141–220, 61–140, 1–60
    });

    it("answers false and leaves the transcript alone when the user never wrote here", async () => {
        const { client } = pagingClient(range(1, 30), { selected: "c1" });
        await expect(client.jumpToLastOwnMessage()).resolves.toBe(false);
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });
});

describe("timeline landing", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;
    let frames: FrameRequestCallback[];

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        jest.useFakeTimers();
        frames = [];
        jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
        });
        jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    });

    afterEach(async () => {
        if (rendered) await act(async () => rendered!.root.unmount());
        rendered?.container.remove();
        rendered = undefined;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    async function render(client: MatronJournalClient): Promise<HTMLDivElement> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => root.render(React.createElement(MatronApp, { client })));
        rendered = { container, root };
        return container;
    }

    const runFrames = async (): Promise<void> => {
        await act(async () => {
            for (let i = 0; i < 100 && frames.length; i++) frames.shift()!(performance.now());
        });
    };

    function selectedClient(events: JournalEvent[]): MatronJournalClient {
        const client = new MatronJournalClient();
        internals(client).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("c1", 100)],
            selectedConversationId: "c1",
            events,
            connection: "online",
        };
        return client;
    }

    const patch = (client: MatronJournalClient, update: Partial<ClientState>): void =>
        (client as unknown as { patch(update: Partial<ClientState>): void }).patch(update);

    it("scrolls the target row into view, flashes it and hands the target back", async () => {
        const client = selectedClient(range(1, 30));
        const container = await render(client);
        const panel = container.querySelector<HTMLDivElement>(".mj_ChatView_messagePanel")!;
        Object.defineProperties(panel, {
            clientHeight: { configurable: true, value: 400 },
            scrollHeight: { configurable: true, value: 5000 },
            scrollTop: { configurable: true, value: 4600, writable: true },
        });
        panel.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        const row = container.querySelector<HTMLElement>('[data-event-id="12"]')!;
        row.getBoundingClientRect = () => ({ top: -3000, height: 100 }) as DOMRect;

        await act(async () => patch(client, { focusTarget: { conversationId: "c1", seq: 12, token: 7 } }));

        expect(panel.scrollTop).toBe(4600 - 3000 - 150);
        expect(row.classList.contains("mj_EventTile_focused")).toBe(true);
        expect(client.getSnapshot().focusTarget).toBeUndefined();
        // The reader is no longer at the tail, so the jump pill shows.
        expect(container.querySelector(".mj_JumpToLastOwn")).not.toBeNull();

        await act(async () => jest.advanceTimersByTime(2_000));
        expect(row.classList.contains("mj_EventTile_focused")).toBe(false);
    });

    it("re-checks the position after layout moves the row", async () => {
        const client = selectedClient(range(1, 30));
        const container = await render(client);
        const panel = container.querySelector<HTMLDivElement>(".mj_ChatView_messagePanel")!;
        let scrollTop = 4600;
        Object.defineProperties(panel, {
            clientHeight: { configurable: true, value: 400 },
            scrollHeight: { configurable: true, value: 5000 },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => (scrollTop = value),
            },
        });
        panel.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        const row = container.querySelector<HTMLElement>('[data-event-id="12"]')!;
        // The row's document position: estimated at 1600 before rows above it are sized, 1900 after.
        let rowY = 1600;
        row.getBoundingClientRect = () => ({ top: rowY - scrollTop, height: 100 }) as DOMRect;

        await act(async () => patch(client, { focusTarget: { conversationId: "c1", seq: 12, token: 1 } }));
        expect(scrollTop).toBe(1600 - 150);

        rowY = 1900; // rows above came into view and took their real height
        await runFrames();
        expect(scrollTop).toBe(1900 - 150);
    });

    it("lands on the nearest earlier row when the target itself is not rendered", async () => {
        const events = [event(10), event(11, { type: "read_marker", payload: {} }), event(12)];
        const client = selectedClient(events);
        const container = await render(client);
        await act(async () => patch(client, { focusTarget: { conversationId: "c1", seq: 11, token: 1 } }));
        expect(container.querySelector('[data-event-id="10"]')!.classList.contains("mj_EventTile_focused")).toBe(true);
    });

    it("ignores a target for another conversation", async () => {
        const client = selectedClient(range(1, 5));
        const container = await render(client);
        await act(async () => patch(client, { focusTarget: { conversationId: "c2", seq: 3, token: 1 } }));
        expect(container.querySelector(".mj_EventTile_focused")).toBeNull();
    });

    it("jumps to my last message from the pill and from Ctrl+Shift+U", async () => {
        const client = selectedClient([own(3), event(4), event(5)]);
        const jump = jest.spyOn(client, "jumpToLastOwnMessage").mockResolvedValue(true);
        const container = await render(client);
        // At the tail the pill is hidden, but the shortcut still works.
        expect(container.querySelector(".mj_JumpToLastOwn")).toBeNull();
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "U", ctrlKey: true, shiftKey: true }));
        });
        expect(jump).toHaveBeenCalledTimes(1);
    });

    it("leaves Ctrl+Shift+U alone while a modal dialog is up or an IME is composing", async () => {
        const client = selectedClient([own(3), event(4), event(5)]);
        const jump = jest.spyOn(client, "jumpToLastOwnMessage").mockResolvedValue(true);
        await render(client);
        await act(async () => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "U", ctrlKey: true, shiftKey: true, isComposing: true }),
            );
        });
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        document.body.appendChild(dialog);
        try {
            const press = new KeyboardEvent("keydown", { key: "U", ctrlKey: true, shiftKey: true, cancelable: true });
            await act(async () => {
                document.dispatchEvent(press);
            });
            expect(press.defaultPrevented).toBe(false);
        } finally {
            dialog.remove();
        }
        expect(jump).not.toHaveBeenCalled();
    });
});
