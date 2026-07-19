import { MatronJournalClient } from "../../../src/journal/client";
import {
    type ClientState,
    type Conversation,
    isNearBottom,
    type PendingMessage,
    type StagedUploads,
} from "../../../src/journal/types";

const PARENT: Conversation = {
    id: "parent",
    title: "Parent",
    session_state: "running",
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

const CHILD: Conversation = {
    ...PARENT,
    id: "parent:sub:agent",
    parent_convo_id: PARENT.id,
};

interface FakeDatabase {
    addToOutbox: jest.MockedFunction<(message: PendingMessage) => Promise<void>>;
    events: jest.MockedFunction<(conversationId: string) => Promise<[]>>;
    outbox: jest.MockedFunction<(conversationId?: string) => Promise<PendingMessage[]>>;
}

interface ClientInternals {
    state: ClientState;
    api?: { uploadMedia: jest.Mock };
    database?: FakeDatabase;
    connection?: { send: jest.Mock };
    pendingFiles: Map<string, File>;
    refreshSelectedConversation(conversationId: string): Promise<void>;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function fakeDatabase(rows: PendingMessage[] = []): FakeDatabase {
    return {
        addToOutbox: jest.fn().mockResolvedValue(undefined),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn(async (conversationId?: string) =>
            rows.filter((message) => !conversationId || message.convoId === conversationId),
        ),
    };
}

function readyClient(options: { selectedId?: string; stagedUploads?: StagedUploads } = {}): {
    client: MatronJournalClient;
    state: ClientInternals;
    database: FakeDatabase;
} {
    const client = new MatronJournalClient();
    const state = internals(client);
    const database = fakeDatabase();
    state.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        conversations: [PARENT, CHILD],
        selectedConversationId: options.selectedId ?? PARENT.id,
        stagedUploads: options.stagedUploads,
    };
    state.api = { uploadMedia: jest.fn().mockResolvedValue({ media_id: "media-1" }) };
    state.database = database;
    state.connection = { send: jest.fn().mockReturnValue(true) };
    return { client, state, database };
}

describe("isNearBottom", () => {
    it("uses an inclusive 80px threshold by default", () => {
        expect(isNearBottom(821, 1000, 100)).toBe(true);
        expect(isNearBottom(820, 1000, 100)).toBe(true);
        expect(isNearBottom(819, 1000, 100)).toBe(false);
    });
});

describe("sendTick", () => {
    it("starts at zero and increments for a successful text send", async () => {
        const { client } = readyClient();

        expect(client.getSnapshot().sendTick).toBe(0);
        await expect(client.sendMessage("hello")).resolves.toBe(true);
        expect(client.getSnapshot().sendTick).toBe(1);
    });

    it("increments when a valid staged head is confirmed", async () => {
        const file = new File([], "empty.txt", { type: "text/plain" });
        const stagedUploads: StagedUploads = {
            convoId: PARENT.id,
            items: [{ id: "head", file }],
            total: 1,
            confirming: false,
        };
        const { client } = readyClient({ stagedUploads });

        await client.confirmStagedFile("head");

        expect(client.getSnapshot().sendTick).toBe(1);
    });

    it("increments when an attachment retry finds a parent-conversation record", async () => {
        const message: PendingMessage = {
            localId: "retry-1",
            convoId: PARENT.id,
            body: "",
            createdAt: 1,
            kind: "file",
            blobRef: "media-1",
            attachState: "error",
            errorKind: "send_failed",
        };
        const { client, state } = readyClient();
        state.database = fakeDatabase([message]);

        await client.retryAttachment(message.localId);

        expect(client.getSnapshot().sendTick).toBe(1);
    });

    it("does not increment for empty or child-blocked text sends", async () => {
        const { client, state, database } = readyClient();

        await expect(client.sendMessage("   ")).resolves.toBe(false);
        expect(client.getSnapshot().sendTick).toBe(0);

        state.state = { ...state.state, selectedConversationId: CHILD.id };
        await expect(client.sendMessage("blocked")).resolves.toBe(false);
        expect(client.getSnapshot().sendTick).toBe(0);
        expect(database.addToOutbox).not.toHaveBeenCalled();
    });

    it("does not increment when staged confirmation has no matching valid head", async () => {
        const file = new File([], "empty.txt", { type: "text/plain" });
        const stagedUploads: StagedUploads = {
            convoId: PARENT.id,
            items: [{ id: "head", file }],
            total: 1,
            confirming: false,
        };
        const { client, state } = readyClient({ stagedUploads });

        await client.confirmStagedFile("not-head");
        expect(client.getSnapshot().sendTick).toBe(0);

        state.state = { ...state.state, stagedUploads: undefined };
        await client.confirmStagedFile("head");
        expect(client.getSnapshot().sendTick).toBe(0);

        state.state = {
            ...state.state,
            stagedUploads: { ...stagedUploads, convoId: "missing-conversation" },
        };
        await client.confirmStagedFile("head");
        expect(client.getSnapshot().sendTick).toBe(0);
    });

    it("does not increment when an attachment retry has no matching record", async () => {
        const { client } = readyClient();

        await client.retryAttachment("missing");

        expect(client.getSnapshot().sendTick).toBe(0);
    });

    it("does not increment when an attachment retry is blocked for a child conversation", async () => {
        const message: PendingMessage = {
            localId: "child-retry",
            convoId: CHILD.id,
            body: "",
            createdAt: 1,
            kind: "file",
            attachState: "error",
            errorKind: "upload_failed",
        };
        const { client, state } = readyClient({ selectedId: CHILD.id });
        state.database = fakeDatabase([message]);

        await client.retryAttachment(message.localId);

        expect(client.getSnapshot().sendTick).toBe(0);
    });

    it("does not increment when selected-conversation journal data refreshes", async () => {
        const { client, state } = readyClient();

        await state.refreshSelectedConversation(PARENT.id);

        expect(client.getSnapshot().sendTick).toBe(0);
    });
});
