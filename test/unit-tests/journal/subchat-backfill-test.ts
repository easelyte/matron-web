/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { JournalApi } from "../../../src/journal/api";
import { MatronJournalClient } from "../../../src/journal/client";
import { JournalConnection } from "../../../src/journal/connection";
import { JournalDatabase } from "../../../src/journal/database";
import { type Conversation, type JournalEvent, type Session, type SnapshotResponse } from "../../../src/journal/types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

function conversation(id: string, extra: Partial<Conversation> = {}): Omit<Conversation, "read_up_to_seq"> {
    return {
        id,
        title: "Agent",
        session_state: "running",
        session_outcome: null,
        last_seq: 5,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        ...extra,
    };
}

function event(): JournalEvent {
    return {
        kind: "journal",
        seq: 5,
        convo_id: "c1",
        ts: 5_000,
        sender: "agent:dev",
        type: "text",
        payload: { body: "preserve me" },
    };
}

interface ClientInternals {
    startSession(session: Session): Promise<void>;
    database?: JournalDatabase;
    connection?: JournalConnection;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

async function seedExistingClient(extra: Partial<Conversation> = {}): Promise<JournalDatabase> {
    const database = await JournalDatabase.open(SESSION.serverUrl, SESSION.userId, SESSION.username);
    await database.replaceWithSnapshot({ seq: 5, conversations: [conversation("c1", extra)] });
    await database.putHistory([event()]);
    return database;
}

async function sealLegacyBackfill(): Promise<void> {
    const name = `matron-journal:${SESSION.serverUrl}:${SESSION.userId}`;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not open legacy cache"));
    });
    const transaction = database.transaction("meta", "readwrite");
    transaction.objectStore("meta").put(true, "subchat_backfill_v1");
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Could not seal legacy backfill"));
        transaction.onabort = () => reject(transaction.error ?? new Error("Legacy backfill transaction aborted"));
    });
    database.close();
}

describe("subchat existing-client backfill", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
        localStorage.clear();
        jest.spyOn(JournalApi.prototype, "messages").mockResolvedValue({ events: [] });
        jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
        jest.spyOn(JournalConnection.prototype, "stop").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("marks a fresh snapshot complete so the next startup does not backfill", async () => {
        const snapshotRequest = jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue({
            seq: 5,
            capabilities: ["session_outcome"],
            conversations: [conversation("c1")],
        });
        const client = new MatronJournalClient();

        await internals(client).startSession(SESSION);
        expect(await internals(client).database?.backfillDone()).toBe(true);

        await internals(client).startSession(SESSION);
        expect(snapshotRequest).toHaveBeenCalledTimes(1);

        internals(client).connection?.stop();
        internals(client).database?.close();
    });

    it("reconciles an existing client once without touching events or its cursor", async () => {
        const database = await seedExistingClient();
        const snapshot = {
            seq: 99,
            capabilities: ["session_outcome"],
            conversations: [conversation("c1", { parent_convo_id: "p1", session_state: "done" })],
        };
        const snapshotRequest = jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue(snapshot);
        const client = new MatronJournalClient();

        await internals(client).startSession(SESSION);

        expect((await database.conversations())[0]).toMatchObject({ parent_convo_id: "p1", session_state: "done" });
        expect(await database.events("c1")).toEqual([event()]);
        expect(await database.cursor()).toBe(5);
        expect(await database.backfillDone()).toBe(true);

        await internals(client).startSession(SESSION);
        expect(snapshotRequest).toHaveBeenCalledTimes(1);

        internals(client).connection?.stop();
        internals(client).database?.close();
        database.close();
    });

    it("reconciles outcomes once when only the legacy parent-link backfill is sealed", async () => {
        const database = await seedExistingClient({ session_state: "done" });
        await sealLegacyBackfill();
        const snapshotRequest = jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue({
            seq: 5,
            conversations: [conversation("c1", { session_state: "done", session_outcome: "interrupted" })],
        });
        const client = new MatronJournalClient();

        await internals(client).startSession(SESSION);

        expect((await database.conversations())[0]).toMatchObject({ session_outcome: "interrupted" });
        expect(await database.backfillDone()).toBe(true);

        await internals(client).startSession(SESSION);
        expect(snapshotRequest).toHaveBeenCalledTimes(1);

        internals(client).connection?.stop();
        internals(client).database?.close();
        database.close();
    });

    it("defers a transient snapshot failure and continues incremental startup", async () => {
        const database = await seedExistingClient();
        jest.spyOn(JournalApi.prototype, "snapshot").mockRejectedValue(new Error("offline"));
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MatronJournalClient();

        await expect(internals(client).startSession(SESSION)).resolves.toBeUndefined();

        expect(client.getSnapshot().phase).toBe("signed-in");
        expect(await database.backfillDone()).toBe(false);
        internals(client).connection?.stop();
        internals(client).database?.close();
        database.close();
    });

    it("seals outcome reconciliation from capability with mixed null and terminal outcomes", async () => {
        const database = await seedExistingClient({ session_state: "done", session_outcome: null });
        const nullOutcome = conversation("c2", { session_state: "done" });
        delete nullOutcome.session_outcome;

        await database.backfillParentLinks({
            seq: 7,
            capabilities: ["session_outcome"],
            conversations: [
                conversation("c1", { last_seq: 6, session_state: "done", session_outcome: "interrupted" }),
                nullOutcome,
            ],
        });
        expect(await database.backfillDone()).toBe(true);
        expect((await database.conversations())[0]).toMatchObject({ session_outcome: "interrupted" });
        database.close();
    });

    it("does not permanently seal an incapable response and later reconciles capability support", async () => {
        const database = await seedExistingClient({ session_state: "done", session_outcome: null });
        const rowWithoutOutcome = conversation("c1", { session_state: "done" });
        delete rowWithoutOutcome.session_outcome;
        const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
        const snapshotRequest = jest
            .spyOn(JournalApi.prototype, "snapshot")
            .mockResolvedValue({ seq: 6, conversations: [rowWithoutOutcome] });
        const client = new MatronJournalClient();

        await expect(internals(client).startSession(SESSION)).resolves.toBeUndefined();

        expect(client.getSnapshot().phase).toBe("signed-in");
        expect(await database.backfillDone()).toBe(false);

        // The durable attempt marker suppresses repeated legacy snapshots during the retry window.
        await expect(internals(client).startSession(SESSION)).resolves.toBeUndefined();
        expect(snapshotRequest).toHaveBeenCalledTimes(1);

        now.mockReturnValue(24 * 60 * 60 * 1_000 + 1_001);
        snapshotRequest.mockResolvedValue({
            seq: 7,
            capabilities: ["session_outcome"],
            conversations: [conversation("c1", { last_seq: 6, session_state: "done", session_outcome: "interrupted" })],
        });
        await expect(internals(client).startSession(SESSION)).resolves.toBeUndefined();

        expect(snapshotRequest).toHaveBeenCalledTimes(2);
        expect((await database.conversations())[0]).toMatchObject({ session_outcome: "interrupted" });
        expect(await database.backfillDone()).toBe(true);
        internals(client).connection?.stop();
        internals(client).database?.close();
        database.close();
    });

    it("does not seal when a capability list explicitly omits session outcomes", async () => {
        const database = await seedExistingClient();
        const rowWithoutOutcome = conversation("c2");
        delete rowWithoutOutcome.session_outcome;

        await database.backfillParentLinks({
            seq: 6,
            capabilities: ["some_other_capability"],
            conversations: [conversation("c1", { session_outcome: null }), rowWithoutOutcome],
        });

        expect(await database.backfillDone()).toBe(false);
        database.close();
    });

    it("times out a stalled migration snapshot without wedging startup or sealing", async () => {
        const database = await seedExistingClient();
        jest.spyOn(JournalApi.prototype, "snapshot").mockReturnValue(new Promise(() => undefined));
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const realSetTimeout = window.setTimeout.bind(window);
        const timeoutSpy = jest.spyOn(window, "setTimeout").mockImplementation((handler, timeout, ...args) => {
            if (timeout === 10_000) {
                queueMicrotask(() => {
                    if (typeof handler === "function") handler(...args);
                });
                return 1 as unknown as ReturnType<typeof setTimeout>;
            }
            return realSetTimeout(handler, timeout, ...args) as unknown as ReturnType<typeof setTimeout>;
        });
        const client = new MatronJournalClient();

        await expect(internals(client).startSession(SESSION)).resolves.toBeUndefined();

        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
        expect(client.getSnapshot().phase).toBe("signed-in");
        expect(await database.backfillDone()).toBe(false);
        internals(client).connection?.stop();
        internals(client).database?.close();
        database.close();
    });

    it("retains a restored session when the backfill completion probe fails", async () => {
        const database = await seedExistingClient();
        localStorage.setItem("matron_journal_session_v1", JSON.stringify(SESSION));
        jest.spyOn(JournalDatabase.prototype, "backfillDone").mockRejectedValue(new Error("IndexedDB aborted"));
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MatronJournalClient();

        await expect(client.initialise()).resolves.toBeUndefined();

        expect(client.getSnapshot()).toMatchObject({ phase: "signed-in", session: SESSION });
        expect(localStorage.getItem("matron_journal_session_v1")).toBe(JSON.stringify(SESSION));
        internals(client).connection?.stop();
        internals(client).database?.close();
        database.close();
    });

    it("defers a malformed snapshot, leaves the key unset, and does not wedge startup", async () => {
        const database = await seedExistingClient();
        jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue({ seq: 6 } as SnapshotResponse);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MatronJournalClient();

        await expect(internals(client).startSession(SESSION)).resolves.toBeUndefined();

        expect(await database.backfillDone()).toBe(false);
        internals(client).connection?.stop();
        internals(client).database?.close();
        database.close();
    });

    it("validates every summary before writing any record", async () => {
        const database = await seedExistingClient();
        const malformed = {
            seq: 6,
            conversations: [conversation("c1", { parent_convo_id: "p1", session_state: "done" }), null],
        } as unknown as SnapshotResponse;

        await expect(database.backfillParentLinks(malformed)).rejects.toThrow("malformed snapshot element");

        expect((await database.conversations())[0]).toMatchObject({ parent_convo_id: null, session_state: "running" });
        expect(await database.backfillDone()).toBe(false);
        database.close();
    });

    it("accepts an unknown outcome and seals a fresh-install backfill", async () => {
        const snapshot = {
            seq: 6,
            capabilities: ["session_outcome"],
            conversations: [conversation("c1", { session_state: "done", session_outcome: "cancelled" })],
        };
        jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue(snapshot);
        const client = new MatronJournalClient();

        await expect(internals(client).startSession(SESSION)).resolves.toBeUndefined();

        const database = internals(client).database!;
        expect(client.getSnapshot().phase).toBe("signed-in");
        expect((await database.conversations())[0]).toMatchObject({ session_outcome: "cancelled" });
        expect(await database.backfillDone()).toBe(true);
        internals(client).connection?.stop();
        database.close();
    });

    it("accepts an unknown outcome while applying and sealing the backfill", async () => {
        const database = await seedExistingClient();
        const snapshot = {
            seq: 6,
            capabilities: ["session_outcome"],
            conversations: [
                conversation("c1", {
                    parent_convo_id: "p1",
                    session_outcome: "cancelled",
                }),
            ],
        };

        await database.backfillParentLinks(snapshot);

        expect((await database.conversations())[0]).toMatchObject({
            parent_convo_id: "p1",
            session_outcome: "cancelled",
        });
        expect(await database.backfillDone()).toBe(true);
        database.close();
    });

    it("rejects a malformed outcome before replacing a fresh snapshot", async () => {
        const database = await JournalDatabase.open(SESSION.serverUrl, SESSION.userId, SESSION.username);
        const malformed = {
            seq: 6,
            conversations: [conversation("c1", { session_outcome: 1 as unknown as null })],
        };

        await expect(database.replaceWithSnapshot(malformed)).rejects.toThrow(
            "malformed session_outcome in snapshot element",
        );

        expect(await database.conversations()).toEqual([]);
        expect(await database.backfillDone()).toBe(false);
        database.close();
    });

    it("preserves an existing immutable parent when the snapshot reports a different one", async () => {
        const database = await seedExistingClient({ parent_convo_id: "p1" });

        await database.backfillParentLinks({
            seq: 6,
            capabilities: ["session_outcome"],
            conversations: [conversation("c1", { parent_convo_id: "p2", session_state: "done" })],
        });

        expect((await database.conversations())[0]).toMatchObject({ parent_convo_id: "p1", session_state: "done" });
        expect(await database.backfillDone()).toBe(true);
        database.close();
    });

    it("preserves a newer local session state while still backfilling the parent link", async () => {
        const database = await seedExistingClient({ last_seq: 10, session_state: "done", parent_convo_id: null });

        await database.backfillParentLinks({
            seq: 11,
            conversations: [conversation("c1", { last_seq: 5, session_state: "running", parent_convo_id: "p1" })],
        });

        expect((await database.conversations())[0]).toMatchObject({
            parent_convo_id: "p1",
            session_state: "done",
        });
        database.close();
    });

    it("updates the session state from a fresher snapshot", async () => {
        const database = await seedExistingClient({ last_seq: 5, session_state: "running" });

        await database.backfillParentLinks({
            seq: 11,
            conversations: [conversation("c1", { last_seq: 10, session_state: "done" })],
        });

        expect((await database.conversations())[0]).toMatchObject({ session_state: "done" });
        database.close();
    });

    it("lets the snapshot session state win when sequence numbers are equal", async () => {
        const database = await seedExistingClient({ last_seq: 10, session_state: "done" });

        await database.backfillParentLinks({
            seq: 11,
            conversations: [conversation("c1", { last_seq: 10, session_state: "running" })],
        });

        expect((await database.conversations())[0]).toMatchObject({ session_state: "running" });
        database.close();
    });

    it.each([
        ["null", null],
        ["NaN", Number.NaN],
    ])("backfills the parent link but defers sealing on a malformed %s last_seq", async (_label, lastSeq) => {
        const database = await seedExistingClient({ last_seq: 10, session_state: "done", parent_convo_id: null });

        // A non-finite last_seq makes the session_state merge unassessable for that row: the parent
        // link is STILL repaired (one bad freshness field must not block valid link repair), the
        // session_state is left untouched, and BACKFILL_KEY stays unset so the reconcile retries
        // (rather than sealing a possibly-stale state). No throw.
        await database.backfillParentLinks({
            seq: 11,
            conversations: [
                conversation("c1", {
                    last_seq: lastSeq as unknown as number,
                    session_state: "running",
                    parent_convo_id: "p1",
                }),
            ],
        });

        expect((await database.conversations())[0]).toMatchObject({
            parent_convo_id: "p1", // link repaired despite the malformed freshness field
            session_state: "done", // unassessable freshness → local state preserved
        });
        expect(await database.backfillDone()).toBe(false); // deferred for retry
        database.close();
    });

    it("rejects a self-parent link during backfill (stores null, stays top-level)", async () => {
        const database = await seedExistingClient({ parent_convo_id: null });

        await database.backfillParentLinks({
            seq: 6,
            conversations: [conversation("c1", { parent_convo_id: "c1", session_state: "done" })],
        });

        expect((await database.conversations())[0]).toMatchObject({ parent_convo_id: null });
        database.close();
    });
});
