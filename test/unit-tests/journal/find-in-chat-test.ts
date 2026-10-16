/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { conversationMatchSeqs, MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import { findPositionLabel, isFindInChatShortcut } from "../../../src/journal/find-in-chat";
import type { ChatSearchState, ClientState, Conversation, JournalEvent, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

const conversation = (id: string): Conversation => ({
    id,
    title: id,
    session_state: "idle",
    last_seq: 1000,
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

const range = (from: number, to: number, make: (seq: number) => JournalEvent = event): JournalEvent[] =>
    Array.from({ length: to - from + 1 }, (_, index) => make(from + index));

interface ClientInternals {
    state: ClientState;
    database?: unknown;
    api?: unknown;
    patch(update: Partial<ClientState>): void;
}

const internals = (client: MatronJournalClient): ClientInternals => client as unknown as ClientInternals;

/** A signed-in client over a journal holding `server`, whose conversation search answers `hits`. */
function searchClient(
    server: JournalEvent[] = range(1, 50),
    searchConversation: jest.Mock = jest.fn().mockResolvedValue({ hits: [] }),
    selected: string | null = "c1",
): { client: MatronJournalClient; searchConversation: jest.Mock; messages: jest.Mock } {
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
    const messages = jest.fn(async (id: string, beforeSeq: number | undefined, limit: number) => ({
        events: server
            .filter((row) => row.convo_id === id && (beforeSeq === undefined || row.seq < beforeSeq))
            .sort((a, b) => b.seq - a.seq)
            .slice(0, limit),
    }));
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [conversation("c1"), conversation("c2")],
        selectedConversationId: selected ?? undefined,
        connection: "online",
    };
    internals(client).database = database;
    internals(client).api = { messages, searchConversation };
    return { client, searchConversation, messages };
}

const hits = (...seqs: number[]): { hits: { convo_id: string; seq: number; ts: number; sender: string }[] } => ({
    hits: seqs.map((seq) => ({ convo_id: "c1", seq, ts: seq, sender: "agent:box-a" })),
});

const searchState = (over: Partial<ChatSearchState> = {}): ChatSearchState => ({
    conversationId: "c1",
    query: "deploy",
    matchSeqs: [30, 20, 10],
    index: 0,
    loading: false,
    failed: false,
    focusTick: 0,
    ...over,
});

describe("find-in-chat helpers", () => {
    it("binds ⌘F on a Mac and Ctrl+F elsewhere, nothing with Shift or Alt", () => {
        const key = { key: "f", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };
        expect(isFindInChatShortcut({ ...key, metaKey: true }, true)).toBe(true);
        expect(isFindInChatShortcut({ ...key, ctrlKey: true }, true)).toBe(false);
        expect(isFindInChatShortcut({ ...key, ctrlKey: true }, false)).toBe(true);
        expect(isFindInChatShortcut({ ...key, ctrlKey: true, shiftKey: true }, false)).toBe(false);
        expect(isFindInChatShortcut({ ...key, ctrlKey: true, altKey: true }, false)).toBe(false);
    });

    it("labels the bar's position", () => {
        expect(findPositionLabel(searchState({ query: "" }))).toBe("");
        expect(findPositionLabel(searchState({ loading: true }))).toBe("Searching…");
        expect(findPositionLabel(searchState({ matchSeqs: [] }))).toBe("No matches");
        expect(findPositionLabel(searchState({ matchSeqs: [], failed: true }))).toBe("Search unavailable");
        expect(findPositionLabel(searchState({ index: 1 }))).toBe("2 of 3");
    });

    it("reads match seqs newest first, without repeats or other conversations' hits", () => {
        expect(
            conversationMatchSeqs(
                {
                    hits: [
                        { convo_id: "c1", seq: 5 },
                        { convo_id: "c1", seq: 40 },
                        { convo_id: "c2", seq: 99 },
                        { convo_id: "c1", seq: 5 },
                        { convo_id: "c1", seq: "7" },
                        null,
                    ],
                },
                "c1",
            ),
        ).toEqual([40, 5]);
        expect(conversationMatchSeqs({ hits: "nope" }, "c1")).toEqual([]);
    });
});

describe("client find in chat", () => {
    it("opens an empty bar on the open conversation, and asks for focus again when already up", () => {
        const { client } = searchClient();
        client.openChatSearch();
        expect(client.getSnapshot().chatSearch).toEqual(
            expect.objectContaining({ conversationId: "c1", query: "", matchSeqs: [], focusTick: 1 }),
        );
        client.openChatSearch();
        expect(client.getSnapshot().chatSearch?.focusTick).toBe(2);
    });

    it("does nothing with no conversation open", () => {
        const { client } = searchClient(undefined, undefined, null);
        client.openChatSearch();
        expect(client.getSnapshot().chatSearch).toBeUndefined();
    });

    it("searches the whole conversation and jumps to the newest match", async () => {
        const search = jest.fn().mockResolvedValue(hits(12, 40, 3));
        const { client } = searchClient(range(1, 50), search);
        const focus = jest.spyOn(client, "focusMessage");

        await client.beginChatSearch("  deploy ");

        // Only leading whitespace goes: the trailing space marks the last word as finished.
        expect(search).toHaveBeenCalledWith("c1", "deploy ", 500, expect.any(AbortSignal));
        expect(client.getSnapshot().chatSearch).toEqual(
            expect.objectContaining({ query: "deploy ", matchSeqs: [40, 12, 3], index: 0, loading: false }),
        );
        expect(focus).toHaveBeenCalledWith("c1", 40, "search");
    });

    it("steps older and newer through the matches, stopping at either end", async () => {
        const { client } = searchClient(range(1, 50), jest.fn().mockResolvedValue(hits(40, 12, 3)));
        await client.beginChatSearch("deploy");
        const focus = jest.spyOn(client, "focusMessage").mockResolvedValue(true);

        await client.stepChatSearch(true);
        await client.stepChatSearch(true);
        await client.stepChatSearch(true); // already at the oldest
        expect(client.getSnapshot().chatSearch?.index).toBe(2);
        await client.stepChatSearch(false);
        expect(client.getSnapshot().chatSearch?.index).toBe(1);
        expect(focus.mock.calls.map((call) => call[1])).toEqual([12, 3, 12]);
    });

    it("reports no matches without jumping", async () => {
        const { client } = searchClient(range(1, 50), jest.fn().mockResolvedValue({ hits: [] }));
        const focus = jest.spyOn(client, "focusMessage");
        await client.beginChatSearch("nothing");
        expect(client.getSnapshot().chatSearch).toEqual(expect.objectContaining({ matchSeqs: [], failed: false }));
        expect(focus).not.toHaveBeenCalled();
    });

    it("reports a failed search", async () => {
        const { client } = searchClient(range(1, 50), jest.fn().mockRejectedValue(new Error("offline")));
        await client.beginChatSearch("deploy");
        expect(client.getSnapshot().chatSearch).toEqual(
            expect.objectContaining({ matchSeqs: [], failed: true, loading: false }),
        );
    });

    it("ignores an earlier query's answer that arrives after a newer one", async () => {
        let answerFirst!: (value: unknown) => void;
        const search = jest
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
            .mockResolvedValueOnce(hits(20));
        const { client } = searchClient(range(1, 50), search);
        const first = client.beginChatSearch("old");
        await client.beginChatSearch("new");
        answerFirst(hits(5));
        await first;
        expect(client.getSnapshot().chatSearch).toEqual(expect.objectContaining({ query: "new", matchSeqs: [20] }));
    });

    it("closing the bar cancels search's own jump still paging history", async () => {
        const { client } = searchClient(range(1, 2000), jest.fn().mockResolvedValue(hits(5)));
        await client.selectConversation("c1");
        // The user closes the bar while the jump to the deep match is on its third page.
        const load = client.loadOlderHistory.bind(client);
        let pages = 0;
        jest.spyOn(client, "loadOlderHistory").mockImplementation(async (opts) => {
            if (++pages === 3) client.endChatSearch();
            await load(opts);
        });
        await client.beginChatSearch("deploy");
        expect(pages).toBe(3);
        expect(client.getSnapshot().chatSearch).toBeUndefined();
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });

    it("closing the bar leaves a jump to my last message running", async () => {
        const server = range(1, 400, (seq) => (seq === 30 ? event(seq, { sender: "user:alice" }) : event(seq)));
        const { client } = searchClient(server);
        await client.selectConversation("c1");
        client.openChatSearch();
        const jumping = client.jumpToLastOwnMessage();
        client.endChatSearch();
        await expect(jumping).resolves.toBe(true);
        expect(client.getSnapshot().focusTarget?.seq).toBe(30);
    });

    it("opens a sidebar result's conversation with the bar up, on the result's message", async () => {
        // The sidebar's matching is broader, so its hit may not be among the in-chat matches.
        const search = jest.fn().mockResolvedValue({
            hits: [
                { convo_id: "c2", seq: 90, ts: 1, sender: "agent:box-a" },
                { convo_id: "c2", seq: 10, ts: 1, sender: "agent:box-a" },
            ],
        });
        const { client } = searchClient(
            range(1, 100, (seq) => event(seq, { convo_id: "c2" })),
            search,
        );
        internals(client).patch({ messageSearch: { query: "rollout", hits: [], loading: false, failed: false } });
        const focus = jest.spyOn(client, "focusMessage");

        client.openSearchHit({
            convo_id: "c2",
            title: "c2",
            seq: 42,
            ts: 1,
            sender: "agent:box-a",
            snippet: "",
            live: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(client.getSnapshot().selectedConversationId).toBe("c2");
        expect(search).toHaveBeenCalledWith("c2", "rollout", 500, expect.any(AbortSignal));
        expect(client.getSnapshot().chatSearch).toEqual(
            expect.objectContaining({ conversationId: "c2", query: "rollout", matchSeqs: [90, 42, 10], index: 1 }),
        );
        expect(focus).toHaveBeenCalledWith("c2", 42, "search");
    });

    it("leaving the conversation drops a search still in flight, which then reopens nothing", async () => {
        let answer!: (value: unknown) => void;
        const search = jest.fn().mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const { client } = searchClient(range(1, 50), search);
        await client.selectConversation("c1");
        const focus = jest.spyOn(client, "focusMessage");
        const searching = client.beginChatSearch("deploy");
        client.clearSelection();
        answer(hits(20));
        await searching;
        expect(client.getSnapshot().selectedConversationId).toBeUndefined();
        expect(client.getSnapshot().chatSearch).toBeUndefined();
        expect(focus).not.toHaveBeenCalled();
    });

    it("a search answered after the tracker opened leaves the tracker up", async () => {
        let answer!: (value: unknown) => void;
        const search = jest.fn().mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const { client } = searchClient(range(1, 50), search);
        await client.selectConversation("c1");
        const focus = jest.spyOn(client, "focusMessage");
        const searching = client.beginChatSearch("deploy");
        client.openTrackerView({ view: "inbox" });
        answer(hits(20));
        await searching;
        expect(client.getSnapshot().trackerView).toBeDefined();
        expect(focus).not.toHaveBeenCalled();
    });

    it("a bar opened later on the same conversation ignores an abandoned search's answer", async () => {
        let answer!: (value: unknown) => void;
        const search = jest.fn().mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const { client } = searchClient(range(1, 50), search);
        await client.selectConversation("c1");
        const searching = client.beginChatSearch("deploy");
        client.clearSelection();
        await client.selectConversation("c1");
        client.openChatSearch();
        answer(hits(20));
        await searching;
        expect(client.getSnapshot().chatSearch).toEqual(expect.objectContaining({ query: "", matchSeqs: [] }));
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });

    it("switching to another conversation and back ignores the abandoned search's answer", async () => {
        let answer!: (value: unknown) => void;
        const search = jest.fn().mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const { client } = searchClient(range(1, 50), search);
        await client.selectConversation("c1");
        const searching = client.beginChatSearch("deploy");
        await client.selectConversation("c2");
        await client.selectConversation("c1");
        client.openChatSearch();
        answer(hits(20));
        await searching;
        expect(client.getSnapshot().chatSearch).toEqual(expect.objectContaining({ query: "", matchSeqs: [] }));
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });

    it("a new query cancels the previous query's jump still paging history", async () => {
        let answerSecond!: (value: unknown) => void;
        const search = jest
            .fn()
            .mockResolvedValueOnce(hits(5))
            .mockImplementationOnce(() => new Promise((resolve) => (answerSecond = resolve)));
        const { client } = searchClient(range(1, 2000), search);
        await client.selectConversation("c1");
        // A new query is typed while the jump to the first query's deep match is on its third page.
        const load = client.loadOlderHistory.bind(client);
        let pages = 0;
        let second: Promise<void> | undefined;
        jest.spyOn(client, "loadOlderHistory").mockImplementation(async (opts) => {
            if (++pages === 3) second = client.beginChatSearch("rollback");
            await load(opts);
        });
        await client.beginChatSearch("deploy");
        expect(pages).toBe(3);
        expect(client.getSnapshot().focusTarget).toBeUndefined();
        expect(client.getSnapshot().chatSearch).toEqual(expect.objectContaining({ query: "rollback", loading: true }));
        answerSecond({ hits: [] });
        await second;
        expect(client.getSnapshot().focusTarget).toBeUndefined();
    });

    it("closes the bar when another conversation is opened", async () => {
        const { client } = searchClient();
        client.openChatSearch();
        await client.selectConversation("c2");
        expect(client.getSnapshot().chatSearch).toBeUndefined();
    });
});

describe("find bar", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) await act(async () => rendered!.root.unmount());
        rendered?.container.remove();
        rendered = undefined;
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

    function openClient(selected: string | null = "c1"): MatronJournalClient {
        const client = new MatronJournalClient();
        internals(client).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("c1")],
            selectedConversationId: selected ?? undefined,
            events: range(1, 5),
            connection: "online",
        };
        return client;
    }

    const press = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
        const keydown = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(keydown);
        return keydown;
    };

    const type = (input: HTMLInputElement, value: string): void => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    it("Ctrl+F opens the bar with its field focused while a conversation is open", async () => {
        const client = openClient();
        const container = await render(client);
        let keydown!: KeyboardEvent;
        await act(async () => {
            keydown = press(document, { key: "f", ctrlKey: true });
        });
        expect(keydown.defaultPrevented).toBe(true);
        const input = container.querySelector<HTMLInputElement>(".mj_FindInChat_input");
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
    });

    it("leaves Ctrl+F to the browser with no conversation open", async () => {
        const client = openClient(null);
        const container = await render(client);
        let keydown!: KeyboardEvent;
        await act(async () => {
            keydown = press(document, { key: "f", ctrlKey: true });
        });
        expect(keydown.defaultPrevented).toBe(false);
        expect(container.querySelector(".mj_FindInChat")).toBeNull();
    });

    it("leaves Ctrl+F to the browser while a modal dialog is up", async () => {
        const client = openClient();
        const container = await render(client);
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        document.body.appendChild(dialog);
        let keydown!: KeyboardEvent;
        try {
            await act(async () => {
                keydown = press(document, { key: "f", ctrlKey: true });
            });
        } finally {
            dialog.remove();
        }
        expect(keydown.defaultPrevented).toBe(false);
        expect(container.querySelector(".mj_FindInChat")).toBeNull();
    });

    it("Enter searches, Enter again steps older, Shift+Enter newer, Escape closes", async () => {
        const client = openClient();
        const begin = jest.spyOn(client, "beginChatSearch").mockImplementation(async (query) => {
            internals(client).patch({ chatSearch: searchState({ query, focusTick: 1 }) });
        });
        const step = jest.spyOn(client, "stepChatSearch").mockResolvedValue(undefined);
        const container = await render(client);
        await act(async () => client.openChatSearch());
        const input = container.querySelector<HTMLInputElement>(".mj_FindInChat_input")!;

        await act(async () => type(input, "deploy"));
        await act(async () => {
            press(input, { key: "Enter" });
        });
        expect(begin).toHaveBeenCalledWith("deploy");
        expect(container.querySelector(".mj_FindInChat_position")?.textContent).toBe("1 of 3");

        await act(async () => {
            press(input, { key: "Enter" });
        });
        await act(async () => {
            press(input, { key: "Enter", shiftKey: true });
        });
        expect(step.mock.calls).toEqual([[true], [false]]);

        // An edited query searches again rather than stepping.
        await act(async () => type(input, "deploy prod"));
        await act(async () => {
            press(input, { key: "Enter" });
        });
        expect(begin).toHaveBeenLastCalledWith("deploy prod");

        await act(async () => {
            press(input, { key: "Escape" });
        });
        expect(container.querySelector(".mj_FindInChat")).toBeNull();
    });

    it("disables the chevrons at the ends of the match list", async () => {
        const client = openClient();
        const container = await render(client);
        await act(async () => internals(client).patch({ chatSearch: searchState({ index: 0 }) }));
        const older = container.querySelector<HTMLButtonElement>('[aria-label="Older match"]')!;
        const newer = container.querySelector<HTMLButtonElement>('[aria-label="Newer match"]')!;
        expect(older.disabled).toBe(false);
        expect(newer.disabled).toBe(true);
        await act(async () => internals(client).patch({ chatSearch: searchState({ index: 2 }) }));
        expect(older.disabled).toBe(true);
        expect(newer.disabled).toBe(false);
    });
});
