/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient, storeArchivedIds } from "../../../src/journal/client";
import { JournalConnection } from "../../../src/journal/connection";
import { JournalDatabase } from "../../../src/journal/database";
import type { ClientState, Conversation, JournalEvent, PendingMessage, Session } from "../../../src/journal/types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "user",
};

const conversation = (id: string, parent_convo_id?: string): Conversation => ({
    id,
    title: id,
    session_state: "done",
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    parent_convo_id,
    read_up_to_seq: 0,
});

const CONVERSATIONS = [
    conversation("root"),
    conversation("root:sub:linked", "root"),
    conversation("missing:sub:orphan", "missing"),
];

interface ClientInternals {
    state: ClientState;
    database?: JournalDatabase;
    connection?: { send: jest.Mock };
    startSession(session: Session): Promise<void>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function event(convoId: string, seq: number): JournalEvent {
    return {
        seq,
        convo_id: convoId,
        ts: seq,
        sender: "agent:test",
        type: "message",
        payload: { body: convoId },
    };
}

function database(conversations: Conversation[]): JournalDatabase {
    return {
        close: jest.fn(),
        expireToolLogs: jest.fn().mockResolvedValue(undefined),
        cursor: jest.fn().mockResolvedValue(1),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
        conversations: jest.fn().mockResolvedValue(conversations),
        reconcilePersistedOwnMessages: jest.fn().mockResolvedValue([]),
    } as unknown as JournalDatabase;
}

describe("subchat automatic selection", () => {
    beforeEach(() => {
        localStorage.clear();
        jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    it("rejects a linked child stored as the preferred conversation", async () => {
        const client = new MatronJournalClient();
        const internals = client as unknown as ClientInternals;
        internals.state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: CONVERSATIONS,
            selectedConversationId: "root:sub:linked",
        };
        internals.database = database(CONVERSATIONS);
        await client.selectConversation("root:sub:linked");
        jest.spyOn(JournalDatabase, "open").mockResolvedValue(database(CONVERSATIONS));

        await internals.startSession(SESSION);

        expect(client.getSnapshot().selectedConversationId).toBe("root");
    });

    it("skips a linked child in fallback selection but permits an orphan", async () => {
        const conversations = [CONVERSATIONS[1], CONVERSATIONS[2], CONVERSATIONS[0]];
        const client = new MatronJournalClient();
        jest.spyOn(JournalDatabase, "open").mockResolvedValue(database(conversations));

        await (client as unknown as ClientInternals).startSession(SESSION);

        expect(client.getSnapshot().selectedConversationId).toBe("missing:sub:orphan");
    });

    it("selects a child as a top-level fallback when its parent is archived", async () => {
        const conversations = [CONVERSATIONS[0], CONVERSATIONS[1]];
        const client = new MatronJournalClient();
        storeArchivedIds(SESSION, new Set(["root"]));
        jest.spyOn(JournalDatabase, "open").mockResolvedValue(database(conversations));

        await (client as unknown as ClientInternals).startSession(SESSION);

        expect(client.getSnapshot().selectedConversationId).toBe("root:sub:linked");
    });

    it("does not apply stale events or send stale viewing after a rapid sibling switch", async () => {
        const client = new MatronJournalClient();
        const internals = client as unknown as ClientInternals;
        const eventsA = deferred<JournalEvent[]>();
        const eventsB = deferred<JournalEvent[]>();
        const eventA = event("sibling-a", 1);
        const eventB = event("sibling-b", 2);
        const send = jest.fn().mockReturnValue(true);
        const conversations = [conversation("sibling-a"), conversation("sibling-b")];
        internals.state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations,
        };
        internals.database = {
            events: jest.fn((id: string) => (id === "sibling-a" ? eventsA.promise : eventsB.promise)),
            outbox: jest.fn().mockResolvedValue([] as PendingMessage[]),
        } as unknown as JournalDatabase;
        internals.connection = { send };

        const selectA = client.selectConversation("sibling-a");
        const selectB = client.selectConversation("sibling-b");
        eventsB.resolve([eventB]);
        await selectB;
        eventsA.resolve([eventA]);
        await selectA;

        expect(client.getSnapshot().selectedConversationId).toBe("sibling-b");
        expect(client.getSnapshot().events).toEqual([eventB]);
        expect(send).toHaveBeenCalledWith({ op: "viewing", convo_id: "sibling-b" });
        expect(send).not.toHaveBeenCalledWith({ op: "viewing", convo_id: "sibling-a" });
    });
});
