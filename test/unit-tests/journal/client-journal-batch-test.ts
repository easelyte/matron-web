/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../../../src/journal/client";
import { JournalConnection } from "../../../src/journal/connection";
import { JournalDatabase } from "../../../src/journal/database";
import { type ClientState, type Conversation, type JournalEvent, type Session } from "../../../src/journal/types";

const SESSION: Session = { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 2, username: "dan" };

const CONVERSATIONS: Conversation[] = ["c1", "c2"].map((id, index) => ({
    id,
    title: id,
    session_state: "running",
    last_seq: 10,
    unread_count: 0,
    snippet: "",
    created_at: index + 1,
    read_up_to_seq: 0,
}));

function text(convo: string, seq: number, sender = "agent:test"): JournalEvent {
    return {
        kind: "journal",
        seq,
        convo_id: convo,
        ts: seq * 1_000,
        sender,
        type: "text",
        payload: { body: `m${seq}` },
    };
}

interface Internals {
    state: ClientState;
    database?: Record<string, jest.Mock>;
    connection?: { send: jest.Mock; forceResync?: jest.Mock };
    history: Map<string, { initialized: boolean; hasMore: boolean; newestSeq?: number; hasMoreNewer?: boolean }>;
    handleJournalBatch(events: JournalEvent[]): Promise<void>;
}

function setup(withBatch = true) {
    const client = new MatronJournalClient();
    const internal = client as unknown as Internals;
    const database: Record<string, jest.Mock> = {
        close: jest.fn(),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
        conversations: jest.fn().mockResolvedValue(CONVERSATIONS),
        cursor: jest.fn().mockResolvedValue(10),
        applyJournal: jest.fn().mockResolvedValue(true),
        reconcileOwnMessage: jest.fn().mockResolvedValue(null),
        markLocallyRead: jest.fn().mockResolvedValue(undefined),
    };
    if (withBatch) {
        database.applyJournalBatch = jest.fn(async (events: JournalEvent[]) => events.map(() => true));
    }
    internal.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: CONVERSATIONS,
        selectedConversationId: "c1",
        connection: "online",
    };
    internal.database = database;
    internal.connection = {
        send: jest.fn().mockReturnValue(true),
        forceResync: jest.fn().mockResolvedValue(undefined),
    };
    internal.history.set("c1", { initialized: true, hasMore: false, newestSeq: 10, hasMoreNewer: false });
    return { client, internal, database };
}

describe("MatronJournalClient.handleJournalBatch", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("applies a run in one store call and refreshes the sidebar and timeline once", async () => {
        const { internal, database } = setup();
        const run = [text("c1", 11), text("c2", 12), text("c1", 13), text("c1", 14, "user:dan")];

        await internal.handleJournalBatch(run);
        await jest.runAllTimersAsync();

        expect(database.applyJournalBatch).toHaveBeenCalledTimes(1);
        expect(database.applyJournalBatch).toHaveBeenCalledWith(run);
        expect(database.applyJournal).not.toHaveBeenCalled();
        expect(database.conversations.mock.calls.length).toBeLessThanOrEqual(2); // run + read flush
        expect(database.events).toHaveBeenCalledTimes(1);
        expect(database.events).toHaveBeenCalledWith("c1");
        expect(database.reconcileOwnMessage).toHaveBeenCalledTimes(run.length);
        const sent = internal.connection!.send.mock.calls.map(([operation]) => operation);
        expect(sent).toContainEqual({ op: "ack", cursor: 14 });
        // Read position follows the newest non-own message in the open conversation (13, not 14).
        expect(sent).toContainEqual({ op: "read_marker", convo_id: "c1", up_to_seq: 13 });
        expect(internal.history.get("c1")?.newestSeq).toBe(14);
    });

    it("acks only the applied rows of a run that overlaps the cursor", async () => {
        const { internal, database } = setup();
        database.applyJournalBatch.mockResolvedValue([false, false, true]);

        await internal.handleJournalBatch([text("c2", 9), text("c2", 10), text("c2", 11)]);
        await jest.runAllTimersAsync();

        const acks = internal.connection!.send.mock.calls.filter(([operation]) => operation.op === "ack");
        expect(acks).toEqual([[{ op: "ack", cursor: 11 }]]);
        expect(database.events).not.toHaveBeenCalled(); // nothing landed in the open conversation
    });

    it("sends a single frame through the per-frame path", async () => {
        const { internal, database } = setup();
        await internal.handleJournalBatch([text("c1", 11)]);
        expect(database.applyJournal).toHaveBeenCalledTimes(1);
        expect(database.applyJournalBatch).not.toHaveBeenCalled();
    });

    it("falls back to per-row applies against a store without applyJournalBatch", async () => {
        const { internal, database } = setup(false);
        await internal.handleJournalBatch([text("c1", 11), text("c1", 12)]);
        expect(database.applyJournal).toHaveBeenCalledTimes(2);
        expect(database.events).toHaveBeenCalledTimes(1);
    });

    it("batches only the prefix before a malformed seq and never applies the rows after it", async () => {
        const { internal, database } = setup();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const bad = { ...text("c1", 13), seq: Number.NaN };

        await internal.handleJournalBatch([text("c1", 11), text("c1", 12), bad, text("c1", 14)]);

        expect(database.applyJournalBatch).toHaveBeenCalledTimes(1);
        expect(database.applyJournalBatch).toHaveBeenCalledWith([text("c1", 11), text("c1", 12)]);
        expect(internal.connection!.forceResync).toHaveBeenCalledTimes(1);
        // Committing 14 would move the durable cursor past the unrecovered row 13.
        expect(database.applyJournal).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
    });

    it("finishes every committed row's side effects when one row's outbox reconcile fails, then rethrows", async () => {
        const { internal, database } = setup();
        const failure = new Error("outbox transaction aborted");
        database.reconcileOwnMessage.mockImplementation(async (event: JournalEvent) => {
            if (event.seq === 12) throw failure;
            return null;
        });

        await expect(
            internal.handleJournalBatch([text("c1", 11), text("c1", 12), text("c1", 13), text("c1", 14)]),
        ).rejects.toBe(failure);
        await jest.runAllTimersAsync();

        expect(database.reconcileOwnMessage).toHaveBeenCalledTimes(4);
        expect(database.events).toHaveBeenCalledWith("c1");
        const sent = internal.connection!.send.mock.calls.map(([operation]) => operation);
        expect(sent).toContainEqual({ op: "ack", cursor: 14 });
        expect(sent).toContainEqual({ op: "read_marker", convo_id: "c1", up_to_seq: 14 });
        expect(internal.history.get("c1")?.newestSeq).toBe(14);
    });
});

describe("MatronJournalClient startup", () => {
    afterEach(() => jest.restoreAllMocks());

    it("paints the sidebar without waiting for the tool-log expiry pass", async () => {
        const client = new MatronJournalClient();
        const expire = jest.fn(() => new Promise<void>(() => undefined)); // never settles
        const database = {
            close: jest.fn(),
            expireToolLogs: expire,
            cursor: jest.fn().mockResolvedValue(10),
            reconcilePersistedOwnMessages: jest.fn().mockResolvedValue([]),
            outbox: jest.fn().mockResolvedValue([]),
            addToOutbox: jest.fn().mockResolvedValue(undefined),
            conversations: jest.fn().mockResolvedValue(CONVERSATIONS),
            events: jest.fn().mockResolvedValue([]),
        };
        jest.spyOn(JournalDatabase, "open").mockResolvedValue(database as unknown as JournalDatabase);
        jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);

        await (client as unknown as { startSession(session: Session): Promise<void> }).startSession(SESSION);

        expect(expire).toHaveBeenCalledTimes(1);
        expect(client.getSnapshot().phase).toBe("signed-in");
        expect(client.getSnapshot().conversations.map((conversation) => conversation.id)).toEqual(["c1", "c2"]);
    });
});
