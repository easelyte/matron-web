/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../../../src/journal/client";
import {
    type ClientState,
    type Conversation,
    type JournalEphemeralFrame,
    type PendingMessage,
    type Session,
} from "../../../src/journal/types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

const CONVERSATIONS: Conversation[] = [
    {
        id: "c1",
        title: "One",
        session_state: "running",
        last_seq: 10,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        read_up_to_seq: 0,
    },
    {
        id: "c2",
        title: "Two",
        session_state: "running",
        last_seq: 20,
        unread_count: 0,
        snippet: "",
        created_at: 2,
        read_up_to_seq: 0,
    },
];

interface FakeDatabase {
    reset?: () => Promise<void>;
    events: (conversationId: string) => Promise<[]>;
    outbox: (conversationId?: string) => Promise<PendingMessage[]>;
    putHistory: (events: []) => Promise<void>;
    replaceWithSnapshot: (snapshot: { seq: number; conversations: Conversation[] }) => Promise<void>;
    markLocallyRead: (conversationId: string, upToSeq: number) => Promise<void>;
    conversations: () => Promise<Conversation[]>;
    addToOutbox: (message: PendingMessage) => Promise<void>;
}

interface ClientInternals {
    state: ClientState;
    database?: FakeDatabase;
    api?: {
        messages: () => Promise<{ events: [] }>;
        snapshot?: () => Promise<{ seq: number; conversations: Conversation[] }>;
    };
    connection?: { send: ReturnType<typeof jest.fn> };
    history: Map<string, { initialized: boolean; hasMore: boolean; oldestSeq?: number }>;
    activities: Map<string, unknown>;
    statuses: Map<string, unknown>;
    textStreams: Map<string, Record<string, string>>;
    toolStreams: Map<string, Record<string, unknown>>;
    retiredStreamRefs: Set<string>;
    readHighWater: Map<string, number>;
    readTimers: Map<string, number>;
    pendingAck: number;
    scheduleRead(conversationId: string, upToSeq: number, delay?: number): void;
    flushRead(conversationId: string): Promise<void>;
    replaceSnapshot(): Promise<void>;
    handleEphemeral(frame: JournalEphemeralFrame): void;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInState(client: MatronJournalClient, selectedConversationId = "c1"): ClientState {
    return {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: CONVERSATIONS,
        selectedConversationId,
        connection: "online",
    };
}

function fakeDatabase(overrides: Partial<FakeDatabase> = {}): FakeDatabase {
    return {
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
        putHistory: jest.fn().mockResolvedValue(undefined),
        replaceWithSnapshot: jest.fn().mockResolvedValue(undefined),
        markLocallyRead: jest.fn().mockResolvedValue(undefined),
        conversations: jest.fn().mockResolvedValue(CONVERSATIONS),
        addToOutbox: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe("MatronJournalClient state handling", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("clears pending acknowledgements and every conversation read timer on logout", async () => {
        jest.useFakeTimers();
        const client = new MatronJournalClient();
        const state = internals(client);
        state.pendingAck = 91;
        state.scheduleRead("c1", 10);
        state.scheduleRead("c2", 20);
        expect(state.readTimers.size).toBe(2);

        await client.logout();

        expect(state.pendingAck).toBe(0);
        expect(state.readHighWater.size).toBe(0);
        expect(state.readTimers.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it("flushes a read marker even after another conversation is selected", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const database = fakeDatabase();
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client, "c2");
        state.database = database;
        state.connection = { send };
        state.readHighWater.set("c1", 10);

        await state.flushRead("c1");

        expect(send).toHaveBeenCalledWith({ op: "read_marker", convo_id: "c1", up_to_seq: 10 });
        expect(database.markLocallyRead).toHaveBeenCalledWith("c1", 10);
        expect(state.readHighWater.has("c1")).toBe(false);
    });

    it("marks an unread conversation as read from the conversation list", async () => {
        jest.useFakeTimers();
        const client = new MatronJournalClient();
        const state = internals(client);
        const database = fakeDatabase();
        const send = jest.fn().mockReturnValue(true);
        state.state = {
            ...signedInState(client),
            conversations: CONVERSATIONS.map((conversation) =>
                conversation.id === "c1" ? { ...conversation, unread_count: 3 } : conversation,
            ),
        };
        state.database = database;
        state.connection = { send };

        client.markConversationRead("c1");
        await jest.runAllTimersAsync();

        expect(send).toHaveBeenCalledWith({ op: "read_marker", convo_id: "c1", up_to_seq: 10 });
        expect(database.markLocallyRead).toHaveBeenCalledWith("c1", 10);
    });

    it("marks every active unread conversation read and skips archived or already-read conversations", async () => {
        jest.useFakeTimers();
        const client = new MatronJournalClient();
        const state = internals(client);
        const conversations: Conversation[] = [
            { ...CONVERSATIONS[0], unread_count: 3 },
            { ...CONVERSATIONS[1], unread_count: 2 },
            { ...CONVERSATIONS[0], id: "c3", last_seq: 30, unread_count: 1 },
            { ...CONVERSATIONS[0], id: "c4", last_seq: 40, unread_count: 0 },
        ];
        const database = fakeDatabase({ conversations: jest.fn().mockResolvedValue(conversations) });
        const send = jest.fn().mockReturnValue(true);
        state.state = {
            ...signedInState(client),
            conversations,
            archivedIds: new Set(["c2"]),
        };
        state.database = database;
        state.connection = { send };

        client.markAllRead();
        await jest.runAllTimersAsync();

        const readMarkers = send.mock.calls
            .map(([operation]) => operation)
            .filter((operation) => operation.op === "read_marker");
        expect(readMarkers).toEqual([
            { op: "read_marker", convo_id: "c1", up_to_seq: 10 },
            { op: "read_marker", convo_id: "c3", up_to_seq: 30 },
        ]);
        expect(database.markLocallyRead).toHaveBeenCalledTimes(2);
    });

    it("advances the read marker when an unread conversation is selected", async () => {
        jest.useFakeTimers();
        const client = new MatronJournalClient();
        const state = internals(client);
        const database = fakeDatabase();
        const send = jest.fn().mockReturnValue(true);
        state.state = {
            ...signedInState(client, "c2"),
            conversations: CONVERSATIONS.map((conversation) =>
                conversation.id === "c1" ? { ...conversation, unread_count: 3 } : conversation,
            ),
        };
        state.database = database;
        state.connection = { send };

        await client.selectConversation("c1");
        await jest.runAllTimersAsync();

        expect(send).toHaveBeenCalledWith({ op: "read_marker", convo_id: "c1", up_to_seq: 10 });
        expect(database.markLocallyRead).toHaveBeenCalledWith("c1", 10);
    });

    it("stores the open conversation and clears it when returning to the list", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client);
        state.database = fakeDatabase();

        await client.selectConversation("c2");

        const selectionKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).find(
            (key) => key?.startsWith("matron_journal_selected_conversation_v1:"),
        );
        expect(selectionKey).toBeDefined();
        expect(localStorage.getItem(selectionKey!)).toBe("c2");

        client.clearSelection();
        expect(localStorage.getItem(selectionKey!)).toBeNull();
    });

    it("clears a history error after a successful retry", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const messages = jest
            .fn()
            .mockRejectedValueOnce(new Error("History unavailable"))
            .mockResolvedValueOnce({ events: [] });
        state.state = signedInState(client);
        state.database = fakeDatabase();
        state.api = { messages };

        await client.loadOlderHistory();
        expect(client.getSnapshot().connectionError).toBe("History unavailable");

        await client.loadOlderHistory();
        expect(client.getSnapshot().connectionError).toBeUndefined();
    });

    it("keeps initial pagination retryable when the summary says history exists", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const messages = jest.fn().mockResolvedValue({ events: [] });
        state.state = signedInState(client);
        state.database = fakeDatabase();
        state.api = { messages };

        await client.loadOlderHistory();
        await client.loadOlderHistory();

        expect(messages).toHaveBeenCalledTimes(2);
        expect(state.history.get("c1")).toEqual({ initialized: false, hasMore: true, oldestSeq: undefined });
        expect(client.getSnapshot().hasOlderHistory).toBe(true);
    });

    it("clears transient sync state before replacing a required snapshot", async () => {
        jest.useFakeTimers();
        const client = new MatronJournalClient();
        const state = internals(client);
        const database = fakeDatabase();
        const snapshot = { seq: 30, conversations: CONVERSATIONS };
        state.state = {
            ...signedInState(client),
            activity: { state: "thinking" },
            sessionStatus: { model: "stale-model" },
            textStreams: { stale: "partial" },
            toolStreams: {},
            loadingHistory: true,
            hasOlderHistory: false,
        };
        state.database = database;
        state.api = {
            messages: jest.fn().mockResolvedValue({ events: [] }),
            snapshot: jest.fn().mockResolvedValue(snapshot),
        };
        state.history.set("c1", { initialized: true, hasMore: false, oldestSeq: 3 });
        state.activities.set("c1", { state: "thinking" });
        state.statuses.set("c1", { model: "stale-model" });
        state.textStreams.set("c1", { stale: "partial" });
        state.toolStreams.set("c1", { stale: {} });
        state.retiredStreamRefs.add("c1:stale");
        state.pendingAck = 29;
        state.scheduleRead("removed-conversation", 999);

        await state.replaceSnapshot();

        expect(database.replaceWithSnapshot).toHaveBeenCalledWith(snapshot);
        expect(state.pendingAck).toBe(0);
        expect(state.readHighWater.size).toBe(0);
        expect(state.readTimers.size).toBe(0);
        expect(state.history.get("removed-conversation")).toBeUndefined();
        expect(state.activities.size).toBe(0);
        expect(state.statuses.size).toBe(0);
        expect(state.textStreams.size).toBe(0);
        expect(state.toolStreams.size).toBe(0);
        expect(state.retiredStreamRefs.size).toBe(0);
        expect(client.getSnapshot()).toMatchObject({
            selectedConversationId: "c1",
            activity: undefined,
            sessionStatus: undefined,
            textStreams: {},
            toolStreams: {},
        });
    });

    it("applies every field from a combined ephemeral frame", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client);

        state.handleEphemeral({
            kind: "ephemeral",
            convo_id: "c1",
            message_ref: "stream-1",
            text: "partial answer",
            activity: { state: "thinking", detail: "Planning" },
            status: { model: "claude-sonnet", email: "dan@example.com" },
        });

        expect(client.getSnapshot()).toMatchObject({
            activity: { state: "thinking", detail: "Planning" },
            sessionStatus: { model: "claude-sonnet", email: "dan@example.com" },
            textStreams: { "stream-1": "partial answer" },
        });
    });

    it("mirrors the local id into the outgoing payload for exact reconciliation", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = fakeDatabase();
        state.connection = { send };

        await client.sendMessage("same message");

        const operation = send.mock.calls[0][0] as {
            local_id: string;
            payload: { body: string; local_id: string };
        };
        expect(operation.payload).toEqual({ body: "same message", local_id: operation.local_id });
    });
});
