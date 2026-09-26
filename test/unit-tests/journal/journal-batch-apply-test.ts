/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { JournalDatabase } from "../../../src/journal/database";
import { type Conversation, type JournalEvent } from "../../../src/journal/types";

function ev(
    seq: number,
    convo: string,
    sender: string,
    type = "text",
    payload: Record<string, unknown> = { body: `m${seq}` },
): JournalEvent {
    return { kind: "journal", seq, convo_id: convo, ts: seq * 1_000, sender, type, payload };
}

const SNAPSHOT_ROWS: Conversation[] = ["c1", "c2"].map((id, index) => ({
    id,
    title: id,
    session_state: "running",
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: index + 1,
    read_up_to_seq: 0,
}));

// A replay-shaped run: messages in two conversations, a rename, a session end, a read marker
// that must count unread against rows applied EARLIER IN THE SAME RUN, and a brand-new convo.
const RUN: JournalEvent[] = [
    ev(1, "c1", "agent:dev"),
    ev(2, "c2", "agent:dev"),
    ev(3, "c1", "user:dan"),
    ev(4, "c1", "agent:dev"),
    ev(5, "c1", "agent:dev", "convo_meta", { title: "Renamed", summary: "digest", summary_updated_at: 42 }),
    ev(6, "c2", "agent:dev"),
    ev(7, "c1", "user:dan", "read_marker", { up_to_seq: 3 }),
    ev(8, "c2", "agent:dev", "session_status", { state: "idle", session_outcome: "done" }),
    ev(9, "c3", "agent:dev"),
    ev(10, "c1", "agent:dev", "tool_output", { text: "ok" }),
];

async function freshDatabase(name: string): Promise<JournalDatabase> {
    const database = await JournalDatabase.open(`https://${name}.example`, 1, "dan");
    await database.replaceWithSnapshot({ seq: 0, conversations: SNAPSHOT_ROWS });
    return database;
}

async function dump(database: JournalDatabase): Promise<unknown> {
    const conversations = await database.conversations();
    const events: Record<string, JournalEvent[]> = {};
    for (const conversation of conversations) events[conversation.id] = await database.events(conversation.id);
    return { cursor: await database.cursor(), conversations, events };
}

describe("JournalDatabase.applyJournalBatch", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
    });

    it("leaves the store exactly as applying the same rows one by one", async () => {
        const oneByOne = await freshDatabase("one");
        const perRow: boolean[] = [];
        for (const event of RUN) perRow.push(await oneByOne.applyJournal(event));

        const batched = await freshDatabase("batch");
        const results = await batched.applyJournalBatch(RUN);

        expect(results).toEqual(perRow);
        expect(await dump(batched)).toEqual(await dump(oneByOne));
        const c1 = (await batched.conversations()).find((conversation) => conversation.id === "c1");
        // The read marker saw rows 1 and 4 from this same run: only 4 (> up_to_seq 3) is unread,
        // then row 10 (tool_output, a message type) lands after it.
        expect(c1).toMatchObject({ title: "Renamed", summary: "digest", read_up_to_seq: 3, unread_count: 2 });
        oneByOne.close();
        batched.close();
    });

    it("reports duplicates at or below the cursor as not applied and never moves the cursor back", async () => {
        const database = await freshDatabase("dups");
        await database.applyJournalBatch(RUN.slice(0, 6));
        expect(await database.cursor()).toBe(6);

        const results = await database.applyJournalBatch(RUN.slice(3));
        expect(results).toEqual([false, false, false, true, true, true, true]);
        expect(await database.cursor()).toBe(10);
        expect(await database.events("c1")).toHaveLength(6);
        database.close();
    });

    it("commits nothing when every row is a duplicate", async () => {
        const database = await freshDatabase("all-dups");
        await database.applyJournalBatch(RUN);
        const before = await dump(database);

        expect(await database.applyJournalBatch(RUN.slice(0, 4))).toEqual([false, false, false, false]);
        expect(await dump(database)).toEqual(before);
        database.close();
    });

    it("treats an empty run as a no-op", async () => {
        const database = await freshDatabase("empty");
        expect(await database.applyJournalBatch([])).toEqual([]);
        expect(await database.cursor()).toBe(0);
        database.close();
    });
});
