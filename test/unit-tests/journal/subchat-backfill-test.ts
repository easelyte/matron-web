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

describe("subchat existing-client backfill", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
        localStorage.clear();
        jest.spyOn(JournalApi.prototype, "messages").mockResolvedValue({ events: [] });
        jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
        jest.spyOn(JournalConnection.prototype, "stop").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("marks a fresh snapshot complete so the next startup does not backfill", async () => {
        const snapshotRequest = jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue({
            seq: 5,
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

    it("preserves an existing immutable parent when the snapshot reports a different one", async () => {
        const database = await seedExistingClient({ parent_convo_id: "p1" });

        await database.backfillParentLinks({
            seq: 6,
            conversations: [conversation("c1", { parent_convo_id: "p2", session_state: "done" })],
        });

        expect((await database.conversations())[0]).toMatchObject({ parent_convo_id: "p1", session_state: "done" });
        expect(await database.backfillDone()).toBe(true);
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
