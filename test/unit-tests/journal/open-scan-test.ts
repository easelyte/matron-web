/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { JournalDatabase } from "../../../src/journal/database";
import { type Conversation, type JournalEvent, type PendingMessage, TOOL_LOG_TTL_MS } from "../../../src/journal/types";

const ROWS: Conversation[] = ["c1", "c2"].map((id, index) => ({
    id,
    title: id,
    session_state: "running",
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: index + 1,
    read_up_to_seq: 0,
}));

function ev(seq: number, convo: string, extra: Partial<JournalEvent> = {}): JournalEvent {
    return {
        kind: "journal",
        seq,
        convo_id: convo,
        ts: seq,
        sender: "agent:x",
        type: "text",
        payload: { body: `m${seq}` },
        ...extra,
    };
}

async function open(name: string): Promise<JournalDatabase> {
    const database = await JournalDatabase.open(`https://${name}.example`, 1, "dan");
    await database.replaceWithSnapshot({ seq: 0, conversations: ROWS });
    return database;
}

describe("startup scans stay off the whole events store", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
    });
    afterEach(() => jest.restoreAllMocks());

    it("reconcilePersistedOwnMessages reads no events when nothing in the outbox is awaiting its echo", async () => {
        const database = await open("idle");
        await database.putHistory([ev(1, "c1"), ev(2, "c2")]);
        const storeGetAll = jest.spyOn(IDBObjectStore.prototype, "getAll");
        const indexGetAll = jest.spyOn(IDBIndex.prototype, "getAll");

        expect(await database.reconcilePersistedOwnMessages()).toEqual([]);

        const eventReads = [...storeGetAll.mock.contexts, ...indexGetAll.mock.contexts].filter(
            (context) => (context as IDBObjectStore | IDBIndex).name !== "outbox",
        );
        expect(eventReads).toHaveLength(0);
        database.close();
    });

    it("reconcilePersistedOwnMessages only reads the conversations that have a pending echo, and still reconciles", async () => {
        const database = await open("pending");
        const pending: PendingMessage = {
            localId: "L1",
            convoId: "c1",
            body: "hi",
            createdAt: 1,
            attachState: "sending",
        } as PendingMessage;
        await database.addToOutbox(pending);
        const echo = ev(5, "c1", { sender: "user:dan", payload: { body: "hi", local_id: "L1" } });
        await database.putHistory([echo, ev(6, "c2"), ev(7, "c2")]);
        const storeGetAll = jest.spyOn(IDBObjectStore.prototype, "getAll");
        const indexGetAll = jest.spyOn(IDBIndex.prototype, "getAll");

        expect(await database.reconcilePersistedOwnMessages()).toEqual(["L1"]);

        expect(storeGetAll.mock.contexts.filter((c) => (c as IDBObjectStore).name === "events")).toHaveLength(0);
        expect(indexGetAll.mock.calls).toEqual([["c1"]]);
        expect(await database.outbox()).toEqual([]);
        database.close();
    });

    it("expireToolLogs still expires stale live logs and leaves everything else untouched", async () => {
        const database = await open("expire");
        // Written while fresh (putHistory enforces the TTL on write), expired by a later `now`.
        const written = Date.now();
        const now = written + TOOL_LOG_TTL_MS + 60_000;
        const stale = ev(1, "c1", {
            type: "tool_output",
            ts: written,
            payload: { live_log: true, snippet: "secret", blob_ref: "b1" },
        });
        const fresh = ev(2, "c1", { type: "tool_output", ts: now - 1_000, payload: { live_log: true, snippet: "s2" } });
        const plain = ev(3, "c1");
        await database.putHistory([stale, fresh, plain]);

        await database.expireToolLogs(now);

        const stored = await (async () => {
            const request = indexedDB.open("matron-journal:https://expire.example:1");
            const db = await new Promise<IDBDatabase>((resolve) => (request.onsuccess = () => resolve(request.result)));
            const all = await new Promise<JournalEvent[]>((resolve) => {
                const get = db.transaction("events").objectStore("events").getAll();
                get.onsuccess = () => resolve(get.result as JournalEvent[]);
            });
            db.close();
            return all;
        })();
        const bySeq = new Map(stored.map((event) => [event.seq, event]));
        expect(bySeq.get(1)?.payload).toEqual({ live_log: true, expired: true, blob_ref: null });
        expect(bySeq.get(2)).toEqual(fresh);
        expect(bySeq.get(3)).toEqual(plain);
        database.close();
    });

    it("expireToolLogs works in bounded transactions and lets other work run between them", async () => {
        const database = await open("chunks");
        const written = Date.now();
        const now = written + TOOL_LOG_TTL_MS + 60_000;
        const rows: JournalEvent[] = [];
        for (let seq = 1; seq <= 25; seq++) {
            rows.push(
                ev(seq, seq % 2 ? "c1" : "c2", {
                    type: "tool_output",
                    ts: written,
                    payload: { live_log: true, snippet: `s${seq}` },
                }),
            );
        }
        await database.putHistory(rows);
        const transaction = jest.spyOn(IDBDatabase.prototype, "transaction");

        const order: string[] = [];
        const expiring = database.expireToolLogs(now, 10).then(() => order.push("purge"));
        // A read issued while the purge is running completes before the purge does.
        const read = database.events("c1").then(() => order.push("read"));
        await Promise.all([expiring, read]);

        const purgeTransactions = transaction.mock.calls.filter(
            ([scope, mode]) => scope === "events" && mode === "readwrite",
        );
        expect(purgeTransactions).toHaveLength(3); // 10 + 10 + 5 rows
        expect(order).toEqual(["read", "purge"]);
        const expiredCount = (await database.events("c1"))
            .concat(await database.events("c2"))
            .filter((event) => event.payload.expired === true).length;
        expect(expiredCount).toBe(25);
        database.close();
    });
});
