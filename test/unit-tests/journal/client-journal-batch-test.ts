/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../../../src/journal/client";
import {
    type ClientState,
    type Conversation,
    type JournalEvent,
    type ServerFrame,
    type Session,
} from "../../../src/journal/types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

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
    connection?: { send: jest.Mock };
    history: Map<string, { initialized: boolean; hasMore: boolean }>;
    textStreams: Map<string, Record<string, string>>;
    handleJournalBatch(events: JournalEvent[]): Promise<void>;
}

function setup() {
    const client = new MatronJournalClient();
    const internal = client as unknown as Internals;
    const database: Record<string, jest.Mock> = {
        close: jest.fn(),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
        conversations: jest.fn().mockResolvedValue(CONVERSATIONS),
        cursor: jest.fn().mockResolvedValue(10),
        applyJournal: jest.fn().mockResolvedValue(true),
        applyJournalBatch: jest.fn(async (events: JournalEvent[]) => events.map(() => true)),
        reconcileOwnMessage: jest.fn().mockResolvedValue(null),
        markLocallyRead: jest.fn().mockResolvedValue(undefined),
    };
    internal.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: CONVERSATIONS,
        selectedConversationId: "c1",
        connection: "online",
    };
    internal.database = database;
    internal.connection = { send: jest.fn().mockReturnValue(true) };
    internal.history.set("c1", { initialized: true, hasMore: false });
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
        const run = [text("c1", 11), text("c2", 12), text("c1", 13), text("c1", 14, "user:2")];

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
    });

    it("tells live listeners about every frame and every applied row, in order", async () => {
        const { client, internal, database } = setup();
        database.applyJournalBatch.mockResolvedValue([false, true, true]);
        const seen: string[] = [];
        client.addLiveListener({
            frame: (frame: ServerFrame) => seen.push(`frame:${(frame as JournalEvent).seq}`),
            journalEvent: (event, previous) => seen.push(`event:${event.seq}:${previous?.id}`),
        });

        await internal.handleJournalBatch([text("c2", 9), text("c2", 11), text("c1", 12)]);
        await jest.runAllTimersAsync();

        expect(seen).toEqual(["frame:9", "frame:11", "frame:12", "event:11:c2", "event:12:c1"]);
    });

    it("rolls `previous` forward for later rows of a conversation in the run", async () => {
        const { client, internal, database } = setup();
        const grown: Conversation[] = [
            CONVERSATIONS[0],
            { ...CONVERSATIONS[1], parent_convo_id: "c1" } as Conversation,
        ];
        database.conversations.mockResolvedValue(grown);
        const seen: string[] = [];
        client.addLiveListener({
            journalEvent: (event, previous) => seen.push(`${event.seq}:${previous?.parent_convo_id ?? "none"}`),
        });

        // c2's first row sees the pre-run list; its second row sees the post-apply row.
        await internal.handleJournalBatch([text("c2", 11), text("c2", 12)]);
        await jest.runAllTimersAsync();

        expect(seen).toEqual(["11:none", "12:c1"]);
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

    it("reconciles from the shared store when a run is all duplicates a peer tab already applied", async () => {
        const { internal, database } = setup();
        database.applyJournalBatch.mockResolvedValue([false, false, false]);
        const status: JournalEvent = { ...text("c2", 11), type: "session_status", payload: { state: "done" } };
        const meta: JournalEvent = { ...text("c2", 12), type: "convo_meta", payload: { title: "Renamed" } };
        internal.textStreams = new Map([["c1", { ref1: "partial" }]]);
        const dupMessage: JournalEvent = { ...text("c1", 13), payload: { body: "dup", message_ref: "ref1" } };

        await internal.handleJournalBatch([status, meta, dupMessage]);
        await jest.runAllTimersAsync();

        // The sidebar is re-read once for the run (duplicate session_status / convo_meta), the open
        // timeline once (duplicate message in the selected conversation), the stream is finished,
        // and nothing is acked because no row was applied here.
        expect(database.conversations).toHaveBeenCalledTimes(1);
        expect(database.events).toHaveBeenCalledTimes(1);
        expect(database.events).toHaveBeenCalledWith("c1");
        expect(internal.textStreams.get("c1")?.ref1).toBeUndefined();
        expect(internal.connection!.send.mock.calls.filter(([operation]) => operation.op === "ack")).toEqual([]);
    });

    it("does not rescan the sidebar for a run of duplicate plain messages in another conversation", async () => {
        const { internal, database } = setup();
        database.applyJournalBatch.mockResolvedValue([false, false]);

        await internal.handleJournalBatch([text("c2", 11), text("c2", 12)]);
        await jest.runAllTimersAsync();

        expect(database.conversations).not.toHaveBeenCalled();
        expect(database.events).not.toHaveBeenCalled();
    });

    it("sends a single frame through the per-frame path", async () => {
        const { internal, database } = setup();
        await internal.handleJournalBatch([text("c1", 11)]);
        expect(database.applyJournal).toHaveBeenCalledTimes(1);
        expect(database.applyJournalBatch).not.toHaveBeenCalled();
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
    });
});
