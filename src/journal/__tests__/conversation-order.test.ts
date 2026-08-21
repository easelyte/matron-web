/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { JournalDatabase } from "../database";
import { type JournalEvent } from "../types";

function evt(overrides: Partial<JournalEvent> & Pick<JournalEvent, "seq" | "convo_id" | "ts" | "type">): JournalEvent {
    return {
        sender: "agent:box",
        payload: {},
        ...overrides,
    } as JournalEvent;
}

async function openDb(): Promise<JournalDatabase> {
    return JournalDatabase.open("wss://test", 1, "dan");
}

describe("conversation list ordering by last message time", () => {
    beforeEach(() => {
        // Fresh IndexedDB per test — the DB name is fixed for (serverUrl, userId).
        (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    });

    it("does not resurface a conversation on a non-message frame and keeps its snippet in sync", async () => {
        const db = await openDb();
        // c-old gets an older message; c-new a newer one (global seq is strictly ascending).
        await db.applyJournal(evt({ seq: 1, convo_id: "c-old", ts: 1000, type: "text", payload: { body: "old" } }));
        await db.applyJournal(evt({ seq: 2, convo_id: "c-new", ts: 2000, type: "text", payload: { body: "new" } }));
        // A later, newer-ts, non-message frame on the OLDER conversation.
        await db.applyJournal(
            evt({ seq: 3, convo_id: "c-old", ts: 3000, type: "session_status", payload: { state: "waiting" } }),
        );

        let order = (await db.conversations()).map((c) => c.id);
        expect(order).toEqual(["c-new", "c-old"]);

        const cOld = (await db.conversations()).find((c) => c.id === "c-old")!;
        // last_ts was NOT bumped by the status frame (would be 3000 under the bug).
        expect(cOld.last_ts).toBe(1000);
        // Snippet still reflects the last MESSAGE — never a dangling stale line
        // sitting above a freshly-bumped timestamp.
        expect(cOld.snippet).toBe("old");

        // A real new message DOES refresh the snippet and lift the row to the top.
        await db.applyJournal(evt({ seq: 4, convo_id: "c-old", ts: 4000, type: "text", payload: { body: "newer" } }));
        order = (await db.conversations()).map((c) => c.id);
        expect(order).toEqual(["c-old", "c-new"]);
        const cOldAfter = (await db.conversations()).find((c) => c.id === "c-old")!;
        expect(cOldAfter.snippet).toBe("newer");
        expect(cOldAfter.last_ts).toBe(4000);
    });

    it("does not resurface a conversation on a convo_meta rename frame", async () => {
        const db = await openDb();
        await db.applyJournal(evt({ seq: 1, convo_id: "c-a", ts: 1000, type: "text", payload: { body: "a" } }));
        await db.applyJournal(evt({ seq: 2, convo_id: "c-b", ts: 2000, type: "text", payload: { body: "b" } }));
        // Rename c-a well after c-b's message: a meta event, must not reorder.
        await db.applyJournal(
            evt({ seq: 3, convo_id: "c-a", ts: 3000, type: "convo_meta", payload: { title: "renamed" } }),
        );

        const rows = await db.conversations();
        expect(rows.map((c) => c.id)).toEqual(["c-b", "c-a"]);
        const cA = rows.find((c) => c.id === "c-a")!;
        expect(cA.title).toBe("renamed"); // rename applied
        expect(cA.last_ts).toBe(1000); // but position/time unchanged
    });

    it("keeps ordering stable when a non-message frame hits a conversation tied on last_ts", async () => {
        const db = await openDb();
        // Two conversations whose newest messages share a millisecond (last_ts tie).
        await db.applyJournal(evt({ seq: 1, convo_id: "c-x", ts: 5000, type: "text", payload: { body: "x" } }));
        await db.applyJournal(evt({ seq: 2, convo_id: "c-y", ts: 5000, type: "text", payload: { body: "y" } }));

        const before = (await db.conversations()).map((c) => c.id);
        // A status frame on whichever sorts LAST — under a last_seq tie-break it
        // would jump to the top; under the id tie-break it must not move.
        const laggard = before[before.length - 1];
        await db.applyJournal(
            evt({ seq: 3, convo_id: laggard, ts: 6000, type: "session_status", payload: { state: "waiting" } }),
        );

        const after = (await db.conversations()).map((c) => c.id);
        expect(after).toEqual(before);
    });

    it("orders identical-timestamp conversations deterministically by id", async () => {
        const db = await openDb();
        // Both rows minted by a same-ms non-message frame: equal last_ts/created_at.
        await db.applyJournal(
            evt({ seq: 1, convo_id: "c-aaa", ts: 7000, type: "session_status", payload: { state: "running" } }),
        );
        await db.applyJournal(
            evt({ seq: 2, convo_id: "c-bbb", ts: 7000, type: "session_status", payload: { state: "running" } }),
        );

        const ids = (await db.conversations()).map((c) => c.id);
        // id DESC → 'c-bbb' before 'c-aaa', stable across repeated reads.
        expect(ids).toEqual(["c-bbb", "c-aaa"]);
        expect((await db.conversations()).map((c) => c.id)).toEqual(ids);
    });
});
