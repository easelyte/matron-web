/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { MALFORMED_SEQ_HALTED_ERROR, MatronJournalClient } from "../client";
import { JournalDatabase } from "../database";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";

// #766: a live journal frame whose `seq` cannot serve as a cursor (NaN / non-integer / negative)
// must never be applied, acked, or allowed to advance the durable cursor. Instead the client halts
// and re-snapshots through the connection's resync flow, and a reconnect-loop guard bounds a
// pathological server that keeps pushing malformed frames.

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 1,
    username: "tester",
};

function conversation(id: string, extra: Partial<Conversation> = {}): Omit<Conversation, "read_up_to_seq"> {
    return {
        id,
        title: id,
        session_state: "running",
        session_outcome: null,
        last_seq: 0,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        parent_convo_id: null,
        ...extra,
    };
}

function journalEvent(seq: unknown, extra: Partial<JournalEvent> = {}): JournalEvent {
    return {
        kind: "journal",
        seq: seq as number,
        convo_id: "room",
        ts: 1_000,
        sender: "agent:bridge",
        type: "text",
        payload: { body: "hello" },
        ...extra,
    } as JournalEvent;
}

interface FakeConnection {
    sent: Record<string, unknown>[];
    send: jest.Mock<boolean, [Record<string, unknown>]>;
    forceResync: jest.Mock<Promise<void>, []>;
    stop: jest.Mock;
}

function fakeConnection(): FakeConnection {
    const sent: Record<string, unknown>[] = [];
    return {
        sent,
        send: jest.fn((op: Record<string, unknown>) => {
            sent.push(op);
            return true;
        }),
        forceResync: jest.fn(async () => undefined),
        stop: jest.fn(),
    };
}

type ClientInternals = {
    state: ClientState;
    database: JournalDatabase;
    connection: FakeConnection;
    handleJournal(event: JournalEvent): Promise<void>;
    handleReady(): Promise<void>;
};

async function makeClient(seedCursor: number): Promise<{
    client: MatronJournalClient;
    internal: ClientInternals;
    database: JournalDatabase;
    conn: FakeConnection;
}> {
    const database = await JournalDatabase.open(SESSION.serverUrl, SESSION.userId, SESSION.username);
    await database.replaceWithSnapshot({
        seq: seedCursor,
        conversations: [conversation("room", { last_seq: seedCursor })],
    });
    const client = new MatronJournalClient();
    const conn = fakeConnection();
    const internal = client as unknown as ClientInternals;
    internal.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: await database.conversations(),
        selectedConversationId: undefined,
        connection: "online",
    };
    internal.database = database;
    internal.connection = conn;
    return { client, internal, database, conn };
}

describe("#766 malformed-seq resync", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it.each([
        ["NaN", Number.NaN],
        ["a non-numeric string", "12" as unknown as number],
        ["a non-integer", 5.5],
        ["a negative integer", -1],
    ])("does not apply, ack, or poison the cursor for %s seq — and triggers a resync", async (_label, badSeq) => {
        const { internal, database, conn } = await makeClient(5);

        await internal.handleJournal(journalEvent(badSeq));

        // Cursor is untouched (never NaN / poisoned), and applyJournal never ran.
        expect(await database.cursor()).toBe(5);
        const room = (await database.conversations()).find((c) => c.id === "room");
        expect(room?.last_seq).toBe(5);
        // No ack was scheduled/sent for the poison seq.
        expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ op: "ack" }));
        // A resync was triggered through the connection's socket-resetting flow.
        expect(conn.forceResync).toHaveBeenCalledTimes(1);
    });

    it("acks the CLEAN snapshot cursor after a resync, never the poison value", async () => {
        const { internal, database, conn } = await makeClient(5);

        // A malformed live frame arrives; the cursor stays clean and a resync is triggered.
        await internal.handleJournal(journalEvent(Number.NaN));
        expect(await database.cursor()).toBe(5);
        expect(conn.forceResync).toHaveBeenCalledTimes(1);

        // The resync completes: the server snapshot at seq 8 resets the durable cursor (exactly what
        // replaceSnapshot -> database.replaceWithSnapshot does).
        await database.replaceWithSnapshot({ seq: 8, conversations: [conversation("room", { last_seq: 8 })] });
        expect(await database.cursor()).toBe(8);

        // On reconnect, handleReady acks db.cursor() — the CLEAN 8, not a poisoned NaN.
        await internal.handleReady();
        expect(conn.sent).toContainEqual({ op: "ack", cursor: 8 });
        for (const op of conn.sent) {
            if (op.op === "ack") expect(Number.isNaN(op.cursor as number)).toBe(false);
        }
    });

    it("applies a well-formed frame normally and advances the cursor", async () => {
        const { internal, database, conn } = await makeClient(5);

        await internal.handleJournal(journalEvent(6));

        expect(await database.cursor()).toBe(6);
        expect(conn.forceResync).not.toHaveBeenCalled();
        // A normal applied frame schedules an ack for its seq (flushed on a timer, but pendingAck set).
        expect((internal as unknown as { pendingAck: number }).pendingAck).toBe(6);
    });

    it("halts and stops the connection after more than the limit of rapid malformed frames", async () => {
        const { internal, conn } = await makeClient(5);

        // Three malformed frames inside the window each resync (a single one always recovers).
        for (let i = 0; i < 3; i++) await internal.handleJournal(journalEvent(Number.NaN));
        expect(conn.forceResync).toHaveBeenCalledTimes(3);
        expect(internal.state.connectionError).toBeUndefined();
        expect(conn.stop).not.toHaveBeenCalled();

        // The fourth trips the guard: no further resync, the connection is stopped, and the halt
        // error is surfaced.
        await internal.handleJournal(journalEvent(Number.NaN));
        expect(conn.forceResync).toHaveBeenCalledTimes(3);
        expect(conn.stop).toHaveBeenCalledTimes(1);
        expect(internal.state.connectionError).toBe(MALFORMED_SEQ_HALTED_ERROR);
    });

    it("ignores every later frame once halted — no apply, no ack, no cursor advance", async () => {
        const { internal, database, conn } = await makeClient(5);

        for (let i = 0; i < 4; i++) await internal.handleJournal(journalEvent(Number.NaN));
        expect(internal.state.connectionError).toBe(MALFORMED_SEQ_HALTED_ERROR);
        expect(conn.forceResync).toHaveBeenCalledTimes(3);

        // A later WELL-FORMED frame must NOT resume processing: applying it would advance the cursor
        // past the unrecovered malformed row (silent gap) and re-arming the guard would let an
        // alternating good/malformed server evade the bound. It is dropped: cursor stays clean, no
        // ack, no further resync.
        await internal.handleJournal(journalEvent(6));
        expect(await database.cursor()).toBe(5);
        expect(conn.forceResync).toHaveBeenCalledTimes(3);
        expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ op: "ack" }));

        // A later malformed frame is likewise ignored (no additional resync).
        await internal.handleJournal(journalEvent(Number.NaN));
        expect(conn.forceResync).toHaveBeenCalledTimes(3);
    });

    it("preserves the budget across a REAL resync so the guard still trips (F1 composition)", async () => {
        // The crux of terminal-round F1: forceResync -> onSnapshotRequired -> replaceSnapshot ->
        // resetTransientSyncState. If the budget were cleared there, a server emitting one malformed
        // frame per reconnect would reset the budget on every resync and NEVER halt (unbounded
        // loop). Here forceResync runs the REAL client resync callback, so resetTransientSyncState
        // actually executes between malformed frames; the guard must still trip.
        let snapSeq = 5;
        const api = {
            snapshot: jest.fn(async () => ({ seq: ++snapSeq, conversations: [] })),
        };
        const { client, internal, conn } = await makeClient(5);
        (client as unknown as { api: typeof api }).api = api;
        const resyncs: Promise<void>[] = [];
        conn.forceResync.mockImplementation(async () => {
            const resync = (client as unknown as { replaceSnapshot(): Promise<void> }).replaceSnapshot();
            resyncs.push(resync);
            await resync;
        });

        // Four malformed frames, each triggering a real resync that runs resetTransientSyncState.
        // Let the async resync fully complete between frames to maximally exercise the reset race.
        for (let i = 0; i < 4; i++) {
            await internal.handleJournal(journalEvent(Number.NaN));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        // Drain any in-flight resync so it cannot log after the test completes.
        await Promise.allSettled(resyncs);

        // Budget survived the resyncs, so the guard tripped and halted.
        expect(api.snapshot).toHaveBeenCalledTimes(3);
        expect(conn.stop).toHaveBeenCalledTimes(1);
        expect(internal.state.connectionError).toBe(MALFORMED_SEQ_HALTED_ERROR);
    });

    it("does NOT reset the budget or lift the halt on a resync (resetTransientSyncState)", async () => {
        const { client, internal } = await makeClient(5);

        for (let i = 0; i < 4; i++) await internal.handleJournal(journalEvent(Number.NaN));
        expect((internal as unknown as { journalHalted: boolean }).journalHalted).toBe(true);
        expect((internal as unknown as { malformedSeqResyncs: number[] }).malformedSeqResyncs.length).toBeGreaterThan(
            0,
        );

        // A resync's resetTransientSyncState must NOT clear the reconnect-loop guard — only a genuine
        // new session (startSession) does. The halt survives.
        (client as unknown as { resetTransientSyncState(): void }).resetTransientSyncState();
        expect((internal as unknown as { journalHalted: boolean }).journalHalted).toBe(true);
        expect((internal as unknown as { malformedSeqResyncs: number[] }).malformedSeqResyncs.length).toBeGreaterThan(
            0,
        );
    });
});
