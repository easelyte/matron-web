/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { JournalDatabase } from "../database";
import type { JournalEvent, PendingMessage } from "../types";

const SERVER = "https://journal.example";

function own(seq: number, convo: string, localId: string): JournalEvent {
    return {
        kind: "journal",
        seq,
        convo_id: convo,
        ts: seq * 1_000,
        sender: "user:tester",
        type: "text",
        payload: { body: `hello ${localId}`, local_id: localId },
    };
}

function pending(localId: string, convoId: string, extra: Partial<PendingMessage> = {}): PendingMessage {
    return { localId, convoId, body: `hello ${localId}`, createdAt: 1, attachState: "sending", ...extra };
}

describe("reconcilePersistedOwnMessages", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
    });

    async function open(): Promise<JournalDatabase> {
        const database = await JournalDatabase.open(SERVER, 1, "tester");
        await database.replaceWithSnapshot({
            seq: 0,
            conversations: ["a", "b", "c"].map((id) => ({
                id,
                title: id,
                session_state: "running",
                session_outcome: null,
                last_seq: 0,
                unread_count: 0,
                snippet: "",
                created_at: 1,
                parent_convo_id: null,
            })),
        });
        return database;
    }

    it("drops a pending message once its own row has arrived, and keeps the rest", async () => {
        const database = await open();
        await database.putHistory([own(1, "a", "l1"), own(2, "b", "l3")]);
        await database.addToOutbox(pending("l1", "a")); // its row is in conversation a
        await database.addToOutbox(pending("l2", "a")); // no row yet
        await database.addToOutbox(pending("l3", "a")); // a row with that id exists, but in conversation b
        await database.addToOutbox(pending("l4", "c", { attachState: "uploading" })); // not a candidate

        expect(await database.reconcilePersistedOwnMessages()).toEqual(["l1"]);
        const left = (await database.outbox()).map((message) => message.localId).sort();
        expect(left).toEqual(["l2", "l3", "l4"]);
    });

    // Every read of the events store, whether directly or through one of its indexes.
    function spyOnEventReads(): { reads: () => Array<{ via: string; args: unknown[] }>; restore: () => void } {
        const log: Array<{ via: string; args: unknown[] }> = [];
        const spies: jest.SpyInstance[] = [];
        for (const method of ["getAll", "getAllKeys", "openCursor", "openKeyCursor", "get", "count"] as const) {
            for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype] as const) {
                const original = proto[method] as (...args: unknown[]) => unknown;
                spies.push(
                    jest.spyOn(proto, method as never).mockImplementation(function (
                        this: IDBObjectStore | IDBIndex,
                        ...args: unknown[]
                    ) {
                        const store = "objectStore" in this ? this.objectStore : this;
                        if (store.name === "events")
                            log.push({ via: proto === IDBIndex.prototype ? "index" : "store", args });
                        return original.apply(this, args);
                    } as never),
                );
            }
        }
        return { reads: () => log, restore: () => spies.forEach((spy) => spy.mockRestore()) };
    }

    it("reads only the conversations that have a candidate, through the index", async () => {
        const database = await open();
        await database.putHistory([own(1, "a", "l1"), own(2, "b", "x")]);
        await database.addToOutbox(pending("l1", "a"));
        await database.addToOutbox(pending("l2", "a"));
        await database.addToOutbox(pending("l9", "c", { attachState: "uploading" }));

        const spy = spyOnEventReads();
        try {
            expect(await database.reconcilePersistedOwnMessages()).toEqual(["l1"]);
            expect(spy.reads()).toEqual([{ via: "index", args: ["a"] }]);
        } finally {
            spy.restore();
        }
    });

    it("reads no events at all when no outbox message is a candidate", async () => {
        const database = await open();
        await database.putHistory([own(1, "a", "l1")]);
        await database.addToOutbox(pending("l9", "c", { attachState: "uploading" }));

        const spy = spyOnEventReads();
        try {
            expect(await database.reconcilePersistedOwnMessages()).toEqual([]);
            expect(spy.reads()).toEqual([]);
        } finally {
            spy.restore();
        }
    });
});
