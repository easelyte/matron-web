/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../../../src/journal/client";
import { type ClientState, type Conversation, type PendingMessage } from "../../../src/journal/types";

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
    title: "Agent",
    parent_convo_id: PARENT.id,
    created_at: 2,
};

interface FakeDatabase {
    outbox: jest.MockedFunction<(conversationId?: string) => Promise<PendingMessage[]>>;
    addToOutbox: jest.MockedFunction<(message: PendingMessage) => Promise<void>>;
    deleteOutboxRow: jest.MockedFunction<(localId: string) => Promise<void>>;
    events: jest.MockedFunction<(conversationId: string) => Promise<[]>>;
    cursor: jest.MockedFunction<() => Promise<number | undefined>>;
}

interface ClientInternals {
    state: ClientState;
    api?: object;
    database?: FakeDatabase;
    connection?: { send: jest.Mock };
    sessionGen: number;
    pendingFiles: Map<string, File>;
    sendPendingMessage(message: PendingMessage, connection?: { send: jest.Mock }): void;
    emitPendingAttachment(
        message: PendingMessage,
        owner: { gen: number; api: object; db: FakeDatabase },
    ): Promise<void>;
    handleReady(): Promise<void>;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function childState(client: MatronJournalClient): ClientState {
    return {
        ...client.getSnapshot(),
        phase: "signed-in",
        conversations: [PARENT, CHILD],
        selectedConversationId: CHILD.id,
        connection: "online",
    };
}

function fakeDatabase(initial: PendingMessage[] = []): { database: FakeDatabase; rows: Map<string, PendingMessage> } {
    const rows = new Map(initial.map((message) => [message.localId, structuredClone(message)]));
    const database: FakeDatabase = {
        outbox: jest.fn(async (conversationId?: string) =>
            [...rows.values()].filter((message) => !conversationId || message.convoId === conversationId),
        ),
        addToOutbox: jest.fn(async (message: PendingMessage) => {
            rows.set(message.localId, structuredClone(message));
        }),
        deleteOutboxRow: jest.fn(async (localId: string) => {
            rows.delete(localId);
        }),
        events: jest.fn().mockResolvedValue([]),
        cursor: jest.fn().mockResolvedValue(undefined),
    };
    return { database, rows };
}

describe("read-only subagent transcript egress", () => {
    it("blocks prompt replies for the selected child conversation", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const send = jest.fn().mockReturnValue(true);
        state.state = childState(client);
        state.connection = { send };

        expect(client.sendPromptReply(42, "approve")).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it("blocks new and appended staging for a child conversation", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const first = { name: "first.txt" } as File;
        const second = { name: "second.txt" } as File;
        state.state = childState(client);

        client.stageFiles([first]);
        expect(state.state.stagedUploads).toBeUndefined();

        state.state = {
            ...state.state,
            stagedUploads: {
                convoId: CHILD.id,
                items: [{ id: "staged-child", file: first }],
                total: 1,
                confirming: false,
            },
        };
        client.stageFiles([second]);

        expect(state.state.stagedUploads).toEqual({
            convoId: CHILD.id,
            items: [{ id: "staged-child", file: first }],
            total: 1,
            confirming: false,
        });
    });

    it("blocks confirmation when the staged conversation is a child", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database } = fakeDatabase();
        const file = { name: "notes.txt", type: "text/plain", size: 1 } as File;
        state.state = {
            ...childState(client),
            stagedUploads: {
                convoId: CHILD.id,
                items: [{ id: "staged-child", file }],
                total: 1,
                confirming: false,
            },
        };
        state.api = { uploadMedia: jest.fn() };
        state.database = database;

        await client.confirmStagedFile("staged-child");

        expect(database.addToOutbox).not.toHaveBeenCalled();
        expect(state.state.stagedUploads?.confirming).toBe(false);
    });

    it("confirms a staged parent file after selection changes to a child", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database } = fakeDatabase();
        const file = {
            name: "notes.txt",
            type: "text/plain",
            size: 1,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1)),
        } as unknown as File;
        state.state = {
            ...childState(client),
            stagedUploads: {
                convoId: PARENT.id,
                items: [{ id: "staged-parent", file }],
                total: 1,
                confirming: false,
            },
        };
        state.api = { uploadMedia: jest.fn().mockResolvedValue({ media_id: "media-1" }) };
        state.database = database;
        state.connection = { send: jest.fn().mockReturnValue(true) };

        await client.confirmStagedFile("staged-parent");

        expect(database.addToOutbox).toHaveBeenCalledWith(expect.objectContaining({ convoId: PARENT.id }));
        expect(state.state.stagedUploads).toBeUndefined();
    });

    it("blocks a fresh child attachment before upload or outbox staging", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = fakeDatabase();
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "media-1" });
        const file = {
            name: "notes.txt",
            type: "text/plain",
            size: 8,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
        } as unknown as File;
        state.state = childState(client);
        state.api = { uploadMedia };
        state.database = database;

        await client.sendAttachment(file, CHILD.id);

        expect(uploadMedia).not.toHaveBeenCalled();
        expect(database.addToOutbox).not.toHaveBeenCalled();
        expect(rows.size).toBe(0);
    });

    it("blocks a child attachment retry before upload and retains it as errored", async () => {
        const message: PendingMessage = {
            localId: "attachment-retry-1",
            convoId: CHILD.id,
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
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = fakeDatabase([message]);
        const uploadMedia = jest.fn().mockResolvedValue({ media_id: "media-1" });
        const file = {
            name: "notes.txt",
            type: "text/plain",
            size: 8,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
        } as unknown as File;
        state.state = childState(client);
        state.api = { uploadMedia };
        state.database = database;
        state.pendingFiles.set(message.localId, file);

        await client.retryAttachment(message.localId);

        expect(uploadMedia).not.toHaveBeenCalled();
        expect(rows.get(message.localId)).toMatchObject({
            attachState: "error",
            errorKind: "send_failed",
            errorMessage: "Can't send to a read-only subagent transcript.",
        });
    });

    it.each([undefined, "text" as const])(
        "blocks a child-targeted %s message while retaining it and surfacing an error",
        (kind) => {
            const message: PendingMessage = {
                localId: `text-${kind ?? "implicit"}`,
                convoId: CHILD.id,
                body: "do not send",
                createdAt: 1,
                kind,
            };
            const client = new MatronJournalClient();
            const state = internals(client);
            const { rows } = fakeDatabase([message]);
            const send = jest.fn().mockReturnValue(true);
            state.state = childState(client);

            state.sendPendingMessage(message, { send });

            expect(send).not.toHaveBeenCalled();
            expect(rows.get(message.localId)).toEqual(message);
            expect(state.state.controlError).toBe("Couldn't send to a read-only subagent transcript.");
        },
    );

    it("marks a blocked child attachment errored and keeps it visible after refresh", async () => {
        const message: PendingMessage = {
            localId: "attachment-1",
            convoId: CHILD.id,
            body: "",
            createdAt: 1,
            kind: "image",
            blobRef: "media-1",
            attachState: "sending",
        };
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = fakeDatabase([message]);
        const api = {};
        const send = jest.fn().mockReturnValue(true);
        state.state = childState(client);
        state.api = api;
        state.database = database;
        state.connection = { send };

        await state.emitPendingAttachment(message, { gen: state.sessionGen, api, db: database });

        expect(send).not.toHaveBeenCalled();
        expect(rows.get(message.localId)).toMatchObject({
            attachState: "error",
            errorKind: "send_failed",
            errorMessage: "Can't send to a read-only subagent transcript.",
        });
        expect(state.state.pendingMessages).toEqual([
            expect.objectContaining({ localId: message.localId, attachState: "error", errorKind: "send_failed" }),
        ]);
    });

    it("purges blocked text once on reconnect after surfacing the read-only notice", async () => {
        const text: PendingMessage = {
            localId: "text-1",
            convoId: CHILD.id,
            body: "do not replay",
            createdAt: 1,
        };
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = fakeDatabase([text]);
        const api = {};
        const send = jest.fn().mockReturnValue(true);
        state.state = childState(client);
        state.api = api;
        state.database = database;
        state.connection = { send };

        await state.handleReady();

        expect(database.deleteOutboxRow).toHaveBeenCalledTimes(1);
        expect(database.deleteOutboxRow).toHaveBeenCalledWith(text.localId);
        expect(rows.has(text.localId)).toBe(false);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ op: "send" }));
        expect(state.state.controlError).toBe("Couldn't send to a read-only subagent transcript.");
    });
});
