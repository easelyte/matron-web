/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../../../src/journal/client";
import { JournalApi, JournalApiError } from "../../../src/journal/api";
import { JournalConnection } from "../../../src/journal/connection";
import { JournalDatabase } from "../../../src/journal/database";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import {
    type ClientState,
    type Conversation,
    type JournalEphemeralFrame,
    type JournalEvent,
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
    close: () => void;
    expireToolLogs: () => Promise<void>;
    events: (conversationId: string) => Promise<[]>;
    outbox: (conversationId?: string) => Promise<PendingMessage[]>;
    putHistory: (events: []) => Promise<void>;
    replaceWithSnapshot: (snapshot: { seq: number; conversations: Conversation[] }) => Promise<void>;
    markLocallyRead: (conversationId: string, upToSeq: number) => Promise<void>;
    conversations: () => Promise<Conversation[]>;
    addToOutbox: (message: PendingMessage) => Promise<void>;
    deleteOutboxRow: (localId: string) => Promise<void>;
    cursor: () => Promise<number | undefined>;
    applyJournal: (event: JournalEvent) => Promise<boolean>;
    reconcileOwnMessage: (event: JournalEvent) => Promise<string | null>;
}

interface ClientInternals {
    state: ClientState;
    database?: FakeDatabase;
    api?: {
        messages: () => Promise<{ events: [] }>;
        snapshot?: () => Promise<{ seq: number; conversations: Conversation[] }>;
        uploadMedia?: (bytes: ArrayBuffer, contentType: string, signal?: AbortSignal) => Promise<{ media_id: string }>;
    };
    connection?: { send: ReturnType<typeof jest.fn>; stop?: ReturnType<typeof jest.fn> };
    history: Map<string, { initialized: boolean; hasMore: boolean; oldestSeq?: number }>;
    activities: Map<string, unknown>;
    statuses: Map<string, unknown>;
    textStreams: Map<string, Record<string, string>>;
    toolStreams: Map<string, Record<string, unknown>>;
    retiredStreamRefs: Set<string>;
    readHighWater: Map<string, number>;
    readTimers: Map<string, number>;
    pendingFiles: Map<string, File>;
    transientAttachmentErrors: Map<string, PendingMessage>;
    dismissedAttachments: Set<string>;
    pendingAck: number;
    sessionGen: number;
    startSession(session: Session): Promise<void>;
    scheduleRead(conversationId: string, upToSeq: number, delay?: number): void;
    flushRead(conversationId: string): Promise<void>;
    replaceSnapshot(): Promise<void>;
    handleReady(): Promise<void>;
    refreshSelectedConversation(conversationId: string, database?: FakeDatabase, generation?: number): Promise<void>;
    handleEphemeral(frame: JournalEphemeralFrame): void;
    handleJournal(event: JournalEvent): Promise<void>;
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
        close: jest.fn(),
        expireToolLogs: jest.fn().mockResolvedValue(undefined),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
        putHistory: jest.fn().mockResolvedValue(undefined),
        replaceWithSnapshot: jest.fn().mockResolvedValue(undefined),
        markLocallyRead: jest.fn().mockResolvedValue(undefined),
        conversations: jest.fn().mockResolvedValue(CONVERSATIONS),
        addToOutbox: jest.fn().mockResolvedValue(undefined),
        deleteOutboxRow: jest.fn().mockResolvedValue(undefined),
        cursor: jest.fn().mockResolvedValue(10),
        applyJournal: jest.fn().mockResolvedValue(true),
        reconcileOwnMessage: jest.fn().mockResolvedValue(null),
        ...overrides,
    };
}

function attachmentDatabase(): {
    database: FakeDatabase;
    rows: Map<string, PendingMessage>;
    writes: PendingMessage[];
} {
    const rows = new Map<string, PendingMessage>();
    const writes: PendingMessage[] = [];
    const database = fakeDatabase({
        addToOutbox: jest.fn(async (message: PendingMessage) => {
            const stored = structuredClone(message);
            rows.set(message.localId, stored);
            writes.push(stored);
        }),
        deleteOutboxRow: jest.fn(async (localId: string) => {
            rows.delete(localId);
        }),
        outbox: jest.fn(async (conversationId?: string) =>
            [...rows.values()].filter((message) => !conversationId || message.convoId === conversationId),
        ),
        reconcileOwnMessage: jest.fn(async (event: JournalEvent) => {
            const localId = typeof event.payload.local_id === "string" ? event.payload.local_id : undefined;
            if (!localId || event.sender !== "user:2" || !rows.has(localId)) return null;
            rows.delete(localId);
            return localId;
        }),
    });
    return { database, rows, writes };
}

function fileFixture(
    name: string,
    type: string,
    contents: number[],
    arrayBuffer: jest.MockedFunction<() => Promise<ArrayBuffer>> = jest.fn(),
): File {
    const bytes = new Uint8Array(contents);
    const file = new File([new Blob([bytes], { type })], name, { type });
    if (arrayBuffer.getMockImplementation() === undefined) arrayBuffer.mockResolvedValue(bytes.buffer);
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
    return file;
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

    it("does not patch a refresh that completes after the database session changes", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        let resolveEvents!: (events: []) => void;
        let resolveOutbox!: (messages: PendingMessage[]) => void;
        const oldDatabase = fakeDatabase({
            events: jest.fn().mockReturnValue(new Promise<[]>((resolve) => (resolveEvents = resolve))),
            outbox: jest.fn().mockReturnValue(new Promise<PendingMessage[]>((resolve) => (resolveOutbox = resolve))),
        });
        const retained = { localId: "new-session", convoId: "c1", body: "keep", createdAt: 1 };
        state.state = { ...signedInState(client), pendingMessages: [retained] };
        state.database = oldDatabase;
        const refresh = state.refreshSelectedConversation("c1", oldDatabase, state.sessionGen);

        state.database = fakeDatabase();
        state.sessionGen += 1;
        resolveEvents([]);
        resolveOutbox([{ localId: "old-session", convoId: "c1", body: "leak", createdAt: 2 }]);
        await refresh;

        expect(client.getSnapshot().pendingMessages).toEqual([retained]);
    });

    it("surfaces an attachment storage failure per item and retains retry bytes", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client);
        state.database = fakeDatabase({ addToOutbox: jest.fn().mockRejectedValue(new Error("quota")) });
        state.api = {
            messages: jest.fn().mockResolvedValue({ events: [] }),
            uploadMedia: jest.fn().mockResolvedValue({ media_id: "unused" }),
        };

        const file = {
            name: "notes.txt",
            type: "text/plain",
            size: 8,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
        } as unknown as File;
        await client.sendAttachment(file, "c1");

        expect(client.getSnapshot().pendingMessages).toEqual([
            expect.objectContaining({
                convoId: "c1",
                filename: "notes.txt",
                attachState: "error",
                errorKind: "storage_failed",
                canRetry: true,
            }),
        ]);
    });

    it("persists and resumes an attachment after a transient storage failure", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const addToOutbox = jest.fn().mockRejectedValueOnce(new Error("quota")).mockResolvedValue(undefined);
        const database = fakeDatabase({ addToOutbox });
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "media-1" });
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send };

        const file = {
            name: "notes.txt",
            type: "text/plain",
            size: 8,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
        } as unknown as File;
        await client.sendAttachment(file, "c1");
        const failed = client.getSnapshot().pendingMessages[0];
        await client.retryAttachment(failed.localId);

        expect(addToOutbox).toHaveBeenCalledWith(
            expect.objectContaining({ localId: failed.localId, attachState: "uploading" }),
        );
        expect(uploadMedia).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ local_id: failed.localId, blob_ref: "media-1" }));
        expect(state.transientAttachmentErrors.has(failed.localId)).toBe(false);
    });

    it("claims an attachment retry before reading the outbox", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const message: PendingMessage = {
            localId: "attachment-1",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 8,
            blobRef: null,
            attachState: "error",
            errorKind: "upload_failed",
        };
        const database = fakeDatabase({ outbox: jest.fn().mockResolvedValue([message]) });
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "media-1" });
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn().mockReturnValue(true) };
        state.pendingFiles.set(message.localId, {
            name: "notes.txt",
            type: "text/plain",
            size: 8,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
        } as unknown as File);

        const first = client.retryAttachment(message.localId);
        const second = client.retryAttachment(message.localId);
        expect(database.outbox).toHaveBeenCalledTimes(1);
        await Promise.all([first, second]);

        expect(uploadMedia).toHaveBeenCalledTimes(1);
    });

    it("tombstones a dismissed attachment before an in-flight retry can replay it", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        let resolveOutbox!: (messages: PendingMessage[]) => void;
        const message: PendingMessage = {
            localId: "attachment-1",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 8,
            blobRef: "media-1",
            attachState: "error",
            errorKind: "send_failed",
        };
        const database = fakeDatabase({
            outbox: jest.fn().mockReturnValue(
                new Promise<PendingMessage[]>((resolve) => {
                    resolveOutbox = resolve;
                }),
            ),
        });
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }) };
        state.connection = { send };

        const retry = client.retryAttachment(message.localId);
        const dismiss = client.dismissAttachment(message.localId);
        expect(state.dismissedAttachments.has(message.localId)).toBe(true);
        resolveOutbox([message]);
        await Promise.all([retry, dismiss]);

        expect(send).not.toHaveBeenCalled();
        expect(database.addToOutbox).not.toHaveBeenCalled();
        expect(database.deleteOutboxRow).toHaveBeenCalledWith(message.localId);
    });

    it("aborts only the dismissed attachment's in-flight upload and never persists its failure", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const database = fakeDatabase();
        let uploadStarted!: () => void;
        const started = new Promise<void>((resolve) => (uploadStarted = resolve));
        const uploadMedia = jest.fn(
            (_bytes: ArrayBuffer, _contentType: string, signal?: AbortSignal) =>
                new Promise<{ media_id: string }>((_resolve, reject) => {
                    uploadStarted();
                    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                        once: true,
                    });
                }),
        );
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send };
        const file = {
            name: "notes.txt",
            type: "text/plain",
            size: 8,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
        } as unknown as File;

        const upload = client.sendAttachment(file, "c1");
        await started;
        const localId = (database.addToOutbox as jest.Mock).mock.calls[0][0].localId as string;
        await client.dismissAttachment(localId);
        await upload;

        expect(database.deleteOutboxRow).toHaveBeenCalledWith(localId);
        expect(database.addToOutbox).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
    });

    it("does not reconnect-replay a stale row after it has been dismissed", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        let resolveOutbox!: (messages: PendingMessage[]) => void;
        const database = fakeDatabase({
            outbox: jest.fn().mockReturnValue(
                new Promise<PendingMessage[]>((resolve) => {
                    resolveOutbox = resolve;
                }),
            ),
        });
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = database;
        state.connection = { send };

        const ready = state.handleReady();
        const dismiss = client.dismissAttachment("attachment-1");
        resolveOutbox([
            {
                localId: "attachment-1",
                convoId: "c1",
                body: "",
                createdAt: 1,
                kind: "file",
                blobRef: "media-1",
                attachState: "sending",
            },
        ]);
        await dismiss;
        await ready;

        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ op: "send" }));
    });

    it("does not replay an outbox after its session owner changes", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        let resolveOutbox!: (messages: PendingMessage[]) => void;
        const oldDatabase = fakeDatabase({
            outbox: jest.fn().mockReturnValue(
                new Promise<PendingMessage[]>((resolve) => {
                    resolveOutbox = resolve;
                }),
            ),
        });
        const oldSend = jest.fn().mockReturnValue(true);
        const newSend = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = oldDatabase;
        state.connection = { send: oldSend };

        const ready = state.handleReady();
        state.sessionGen += 1;
        state.database = fakeDatabase();
        state.connection = { send: newSend };
        resolveOutbox([
            {
                localId: "old-attachment",
                convoId: "c1",
                body: "",
                createdAt: 1,
                kind: "file",
                blobRef: "old-media",
                attachState: "sending",
            },
        ]);
        await ready;

        expect(oldSend).not.toHaveBeenCalled();
        expect(newSend).not.toHaveBeenCalled();
    });

    it("does not acknowledge a cursor after the replay connection changes", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        let resolveCursor!: (cursor: number | undefined) => void;
        const database = fakeDatabase({
            cursor: jest.fn().mockReturnValue(
                new Promise<number | undefined>((resolve) => {
                    resolveCursor = resolve;
                }),
            ),
        });
        const oldSend = jest.fn().mockReturnValue(true);
        const newSend = jest.fn().mockReturnValue(true);
        state.state = signedInState(client, "");
        state.database = database;
        state.connection = { send: oldSend };

        const ready = state.handleReady();
        await Promise.resolve();
        state.connection = { send: newSend };
        resolveCursor(10);
        await ready;

        expect(oldSend).not.toHaveBeenCalled();
        expect(newSend).not.toHaveBeenCalled();
    });
});

describe("MatronJournalClient attachment send state machine", () => {
    beforeEach(() => {
        localStorage.clear();
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete (globalThis as { fetch?: typeof fetch }).fetch;
    });

    it("moves uploading to sending and removes the pending row on its own echo", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows, writes } = attachmentDatabase();
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = database;
        state.api = {
            messages: jest.fn().mockResolvedValue({ events: [] }),
            uploadMedia: jest.fn().mockResolvedValue({ media_id: "media-1" }),
        };
        state.connection = { send };

        await client.sendAttachment(fileFixture("photo.png", "image/png", [1, 2, 3]), "c1");

        const pending = [...rows.values()][0];
        expect(writes.map((message) => message.attachState)).toEqual(["uploading", "sending"]);
        expect(pending).toMatchObject({
            convoId: "c1",
            kind: "image",
            filename: "photo.png",
            blobRef: "media-1",
            attachState: "sending",
        });
        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({
                op: "send",
                convo_id: "c1",
                type: "image",
                blob_ref: "media-1",
                local_id: pending.localId,
                payload: expect.objectContaining({
                    blob_ref: "media-1",
                    name: "photo.png",
                    filename: "photo.png",
                    local_id: pending.localId,
                }),
            }),
        );
        expect(state.pendingFiles.has(pending.localId)).toBe(false);

        await state.handleJournal({
            kind: "journal",
            seq: 11,
            convo_id: "c1",
            ts: Date.now(),
            sender: "user:2",
            type: "image",
            payload: { local_id: pending.localId, blob_ref: "media-1" },
        });

        expect(rows.size).toBe(0);
        expect(state.pendingFiles.has(pending.localId)).toBe(false);
        expect(client.getSnapshot().pendingMessages).toEqual([]);
    });

    it("retains the uploaded blob reference when the websocket send returns false", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        state.state = signedInState(client);
        state.database = database;
        state.api = {
            messages: jest.fn().mockResolvedValue({ events: [] }),
            uploadMedia: jest.fn().mockResolvedValue({ media_id: "media-1" }),
        };
        state.connection = { send: jest.fn().mockReturnValue(false) };

        await client.sendAttachment(fileFixture("notes.txt", "text/plain", [1]), "c1");

        expect([...rows.values()][0]).toMatchObject({
            blobRef: "media-1",
            attachState: "error",
            errorKind: "send_failed",
        });
        expect(state.pendingFiles.size).toBe(0);
    });

    it.each(["logout", "startSession"] as const)(
        "guards cross-session egress after %s with no HTTP, database write, or websocket send",
        async (transition) => {
            const client = new MatronJournalClient();
            const state = internals(client);
            const { database: oldDatabase } = attachmentDatabase();
            const newDatabase = fakeDatabase();
            const oldSend = jest.fn().mockReturnValue(true);
            const oldStop = jest.fn();
            let uploadStarted!: () => void;
            let uploadSignal: AbortSignal | undefined;
            const started = new Promise<void>((resolve) => (uploadStarted = resolve));
            const oldUpload = jest.fn(
                (_bytes: ArrayBuffer, _contentType: string, signal?: AbortSignal) =>
                    new Promise<{ media_id: string }>((_resolve, reject) => {
                        uploadSignal = signal;
                        uploadStarted();
                        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                            once: true,
                        });
                    }),
            );
            const newUpload = jest.spyOn(JournalApi.prototype, "uploadMedia");
            const newSend = jest.spyOn(JournalConnection.prototype, "send").mockReturnValue(true);
            jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
            jest.spyOn(JournalDatabase, "open").mockResolvedValue(newDatabase as unknown as JournalDatabase);
            state.state = signedInState(client);
            state.database = oldDatabase;
            state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia: oldUpload };
            state.connection = { send: oldSend, stop: oldStop };

            const upload = client.sendAttachment(fileFixture("held.bin", "application/octet-stream", [1]), "c1");
            await started;
            expect(uploadSignal?.aborted).toBe(false);
            expect(oldDatabase.addToOutbox).toHaveBeenCalledTimes(1);

            if (transition === "logout") {
                await client.logout();
            } else {
                await state.startSession({ ...SESSION, token: "token-b", userId: 3, username: "pat" });
            }
            await upload;

            expect(uploadSignal?.aborted).toBe(true);
            expect(oldUpload).toHaveBeenCalledTimes(1);
            expect(newUpload).not.toHaveBeenCalled();
            expect(oldDatabase.addToOutbox).toHaveBeenCalledTimes(1);
            expect(newDatabase.addToOutbox).not.toHaveBeenCalled();
            expect(oldSend).not.toHaveBeenCalledWith(expect.objectContaining({ op: "send" }));
            expect(newSend).not.toHaveBeenCalledWith(expect.objectContaining({ op: "send" }));
            expect(state.pendingFiles.size).toBe(0);
        },
    );

    it("keeps the captured conversation for every file when selection changes mid-batch", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database } = attachmentDatabase();
        const send = jest.fn().mockReturnValue(true);
        let firstUploadStarted!: () => void;
        let releaseFirstUpload!: (value: { media_id: string }) => void;
        const started = new Promise<void>((resolve) => (firstUploadStarted = resolve));
        const uploadMedia = jest
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<{ media_id: string }>((resolve) => {
                        releaseFirstUpload = resolve;
                        firstUploadStarted();
                    }),
            )
            .mockResolvedValueOnce({ media_id: "media-2" });
        const secondRead = jest.fn<Promise<ArrayBuffer>, []>().mockResolvedValue(new Uint8Array([2]).buffer);
        state.state = signedInState(client, "c1");
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send };

        const batch = client.attachFiles([
            fileFixture("first.bin", "application/octet-stream", [1]),
            fileFixture("second.bin", "application/octet-stream", [2], secondRead),
        ]);
        await started;
        state.state = { ...state.state, selectedConversationId: "c2" };
        expect(secondRead).not.toHaveBeenCalled();
        releaseFirstUpload({ media_id: "media-1" });
        await batch;

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls.map(([operation]) => operation.convo_id)).toEqual(["c1", "c1"]);
    });

    it("removes pending bytes on reconcile and dismiss", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const database = fakeDatabase({ reconcileOwnMessage: jest.fn().mockResolvedValue("reconciled") });
        state.state = signedInState(client);
        state.database = database;
        state.pendingFiles.set("reconciled", fileFixture("echo.bin", "application/octet-stream", [1]));
        state.pendingFiles.set("dismissed", fileFixture("dismiss.bin", "application/octet-stream", [2]));

        await state.handleJournal({
            kind: "journal",
            seq: 11,
            convo_id: "c1",
            ts: Date.now(),
            sender: "user:2",
            type: "file",
            payload: { local_id: "reconciled", blob_ref: "media-1" },
        });
        await client.dismissAttachment("dismissed");

        expect(state.pendingFiles.size).toBe(0);
        expect(database.deleteOutboxRow).toHaveBeenCalledWith("dismissed");
    });

    it("keeps retry bytes for a foreign attachment echo with a colliding local id", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        const message: PendingMessage = {
            localId: "collision",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "retry.bin",
            blobRef: null,
            attachState: "error",
            errorKind: "upload_failed",
        };
        rows.set(message.localId, message);
        state.state = signedInState(client);
        state.database = database;
        state.pendingFiles.set(message.localId, fileFixture("retry.bin", "application/octet-stream", [1]));

        await state.handleJournal({
            kind: "journal",
            seq: 11,
            convo_id: "c1",
            ts: Date.now(),
            sender: "user:99",
            type: "file",
            payload: { local_id: message.localId, blob_ref: "foreign-media" },
        });

        expect(rows.has(message.localId)).toBe(true);
        expect(state.pendingFiles.has(message.localId)).toBe(true);

        await state.handleJournal({
            kind: "journal",
            seq: 12,
            convo_id: "c1",
            ts: Date.now(),
            sender: "user:2",
            type: "file",
            payload: { local_id: message.localId, blob_ref: "own-media" },
        });

        expect(rows.has(message.localId)).toBe(false);
        expect(state.pendingFiles.has(message.localId)).toBe(false);
    });

    it("replays only uploaded attachment rows as media events on reconnect", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const rows: PendingMessage[] = [
            {
                localId: "sending-file",
                convoId: "c1",
                body: "",
                createdAt: 1,
                kind: "file",
                filename: "notes.txt",
                blobRef: "media-1",
                attachState: "sending",
            },
            {
                localId: "failed-image",
                convoId: "c1",
                body: "",
                createdAt: 2,
                kind: "image",
                filename: "photo.png",
                blobRef: "media-2",
                attachState: "error",
                errorKind: "send_failed",
            },
            {
                localId: "uploading-file",
                convoId: "c1",
                body: "",
                createdAt: 3,
                kind: "file",
                filename: "waiting.bin",
                blobRef: null,
                attachState: "uploading",
            },
        ];
        const uploadMedia = jest.fn();
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = fakeDatabase({ outbox: jest.fn().mockResolvedValue(rows) });
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send };

        await state.handleReady();

        const sends = send.mock.calls.map(([operation]) => operation).filter((operation) => operation.op === "send");
        expect(sends).toEqual([
            expect.objectContaining({ local_id: "sending-file", type: "file", blob_ref: "media-1" }),
            expect.objectContaining({ local_id: "failed-image", type: "image", blob_ref: "media-2" }),
        ]);
        expect(sends).not.toContainEqual(expect.objectContaining({ type: "text", payload: { body: "" } }));
        expect(uploadMedia).not.toHaveBeenCalled();
    });

    it("reaps persisted uploads before starting the connection", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        rows.set("orphaned-upload", {
            localId: "orphaned-upload",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "orphan.bin",
            blobRef: null,
            attachState: "uploading",
        });
        jest.spyOn(JournalDatabase, "open").mockResolvedValue(database as unknown as JournalDatabase);
        const start = jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);

        await state.startSession(SESSION);

        expect(rows.get("orphaned-upload")).toMatchObject({
            attachState: "error",
            errorKind: "upload_failed",
        });
        expect((database.addToOutbox as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
            start.mock.invocationCallOrder[0],
        );
        expect(client.getSnapshot().pendingMessages).toContainEqual(
            expect.objectContaining({ localId: "orphaned-upload", attachState: "error", canRetry: false }),
        );
    });

    it("retries an upload in place with the original identity", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        const message: PendingMessage = {
            localId: "retry-upload",
            convoId: "c1",
            body: "",
            createdAt: 123,
            kind: "file",
            filename: "retry.bin",
            contentType: "application/octet-stream",
            size: 1,
            blobRef: null,
            attachState: "error",
            errorKind: "upload_failed",
        };
        rows.set(message.localId, message);
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "media-retry" });
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send };
        state.pendingFiles.set(message.localId, fileFixture("retry.bin", "application/octet-stream", [1]));

        await client.retryAttachment(message.localId);

        expect(rows.size).toBe(1);
        expect(rows.get(message.localId)).toMatchObject({
            localId: message.localId,
            convoId: message.convoId,
            createdAt: message.createdAt,
            blobRef: "media-retry",
            attachState: "sending",
        });
        expect(uploadMedia).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ local_id: message.localId }));
        expect(state.pendingFiles.has(message.localId)).toBe(false);
    });

    it("offers dismiss only when upload bytes are gone or an error is permanent", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const messages: PendingMessage[] = (["upload_failed", "too_large", "empty"] as const).map(
            (errorKind, index) => ({
                localId: errorKind,
                convoId: "c1",
                body: "",
                createdAt: index,
                kind: "file",
                blobRef: null,
                attachState: "error",
                errorKind,
            }),
        );
        const database = fakeDatabase({ outbox: jest.fn().mockResolvedValue(messages) });
        const uploadMedia = jest.fn();
        const send = jest.fn();
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send };

        await state.refreshSelectedConversation("c1");
        await Promise.all(messages.map((message) => client.retryAttachment(message.localId)));

        expect(client.getSnapshot().pendingMessages).toEqual(
            messages.map((message) => expect.objectContaining({ localId: message.localId, canRetry: false })),
        );
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(database.addToOutbox).not.toHaveBeenCalled();
    });

    it("retries send_failed without re-uploading and clears it on its own echo", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        const message: PendingMessage = {
            localId: "retry-send",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "image",
            filename: "photo.png",
            contentType: "image/png",
            size: 1,
            blobRef: "media-1",
            attachState: "error",
            errorKind: "send_failed",
        };
        rows.set(message.localId, message);
        const uploadMedia = jest.fn();
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send };

        await client.retryAttachment(message.localId);

        expect(uploadMedia).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({ local_id: message.localId, type: "image", blob_ref: message.blobRef }),
        );
        expect(rows.get(message.localId)).toMatchObject({ attachState: "sending", blobRef: "media-1" });

        await state.handleJournal({
            kind: "journal",
            seq: 11,
            convo_id: "c1",
            ts: Date.now(),
            sender: "user:2",
            type: "image",
            payload: { local_id: message.localId, blob_ref: "media-1" },
        });

        expect(rows.has(message.localId)).toBe(false);
        expect(client.getSnapshot().pendingMessages).toEqual([]);
    });

    it("times out a held file read and advances to the next file in the batch", async () => {
        jest.useFakeTimers();
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "media-2" });
        const heldRead = jest.fn(() => new Promise<ArrayBuffer>(() => undefined));
        const nextRead = jest.fn<Promise<ArrayBuffer>, []>().mockResolvedValue(new Uint8Array([2]).buffer);
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        const batch = client.attachFiles([
            fileFixture("held.bin", "application/octet-stream", [1], heldRead),
            fileFixture("next.bin", "application/octet-stream", [2], nextRead),
        ]);
        await jest.advanceTimersByTimeAsync(0);
        expect(heldRead).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(60_000);
        await batch;

        expect([...rows.values()].find((row) => row.filename === "held.bin")).toMatchObject({
            attachState: "error",
            errorKind: "upload_failed",
        });
        expect([...rows.values()].find((row) => row.filename === "next.bin")).toMatchObject({
            blobRef: "media-2",
            attachState: "sending",
        });
        expect(nextRead).toHaveBeenCalledTimes(1);
        expect(uploadMedia).toHaveBeenCalledTimes(1);
    });

    it("aborts a never-settling fetch at the deadline and advances the batch", async () => {
        jest.useFakeTimers();
        const fetchMock = jest
            .fn()
            .mockImplementationOnce(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener(
                            "abort",
                            () => reject(new DOMException("The operation was aborted.", "AbortError")),
                            { once: true },
                        );
                    }),
            )
            .mockResolvedValueOnce({
                status: 200,
                headers: new Headers({ "Content-Type": "application/json" }),
                arrayBuffer: async () =>
                    new NodeTextEncoder().encode(
                        JSON.stringify({ media_id: "media-2", size: 1, content_type: "application/octet-stream" }),
                    ).buffer,
            });
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        state.state = signedInState(client);
        state.database = database;
        state.api = new JournalApi("https://journal.example", "token") as unknown as ClientInternals["api"];
        state.connection = { send: jest.fn().mockReturnValue(true) };

        const batch = client.attachFiles([
            fileFixture("stalled.bin", "application/octet-stream", [1]),
            fileFixture("next.bin", "application/octet-stream", [2]),
        ]);
        await jest.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(60_000);
        await batch;

        expect([...rows.values()].find((row) => row.filename === "stalled.bin")).toMatchObject({
            attachState: "error",
            errorKind: "upload_failed",
        });
        expect([...rows.values()].find((row) => row.filename === "next.bin")).toMatchObject({
            blobRef: "media-2",
            attachState: "sending",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects an oversized file before reading it", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        const arrayBuffer = jest.fn();
        const uploadMedia = jest.fn();
        state.state = signedInState(client);
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn() };
        const file = {
            name: "oversized.bin",
            type: "application/octet-stream",
            size: 50 * 1024 * 1024 + 1,
            arrayBuffer,
        } as unknown as File;

        await client.sendAttachment(file, "c1");

        expect([...rows.values()][0]).toMatchObject({ attachState: "error", errorKind: "too_large" });
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(state.pendingFiles.size).toBe(0);
    });

    it("preserves a structured upload error code in the attachment state", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        state.state = signedInState(client);
        state.database = database;
        state.api = {
            messages: jest.fn().mockResolvedValue({ events: [] }),
            uploadMedia: jest.fn().mockRejectedValue(new JournalApiError("File too large.", 413, "too_large")),
        };
        state.connection = { send: jest.fn() };

        await client.sendAttachment(fileFixture("server-rejected.bin", "application/octet-stream", [1]), "c1");

        expect([...rows.values()][0]).toMatchObject({ attachState: "error", errorKind: "too_large" });
        expect(state.pendingFiles.size).toBe(0);
    });

    it("does not retain pending bytes for an empty-file terminal error", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        const file = fileFixture("empty.txt", "text/plain", []);
        state.state = signedInState(client);
        state.database = database;
        state.api = {
            messages: jest.fn().mockResolvedValue({ events: [] }),
            uploadMedia: jest.fn(),
        };

        await client.sendAttachment(file, "c1");

        expect([...rows.values()][0]).toMatchObject({ attachState: "error", errorKind: "empty" });
        expect(state.pendingFiles.size).toBe(0);
    });
});
