/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { JournalDatabase } from "../../../src/journal/database";
import { type Conversation, type JournalEvent } from "../../../src/journal/types";

function conversation(id: string, parentConvoId?: string | null): Omit<Conversation, "read_up_to_seq"> {
    return {
        id,
        title: "Agent",
        session_state: "running",
        last_seq: 0,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        ...(parentConvoId !== undefined ? { parent_convo_id: parentConvoId } : {}),
    };
}

function event(seq: number, convoId: string, type: string, payload: Record<string, unknown>): JournalEvent {
    return {
        kind: "journal",
        seq,
        convo_id: convoId,
        ts: seq * 1_000,
        sender: "agent:dev",
        type,
        payload,
    };
}

describe("subchat ingestion", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
    });

    it("defaults new conversations to a null parent", async () => {
        const database = await JournalDatabase.open("https://journal.example", 1, "dan");

        await database.applyJournal(event(1, "p1", "text", { body: "hello" }));

        expect((await database.conversations())[0].parent_convo_id).toBeNull();
        database.close();
    });

    it("sets a parent from titleless convo_meta once and never clears or moves it", async () => {
        const database = await JournalDatabase.open("https://journal.example", 2, "dan");

        await database.applyJournal(event(1, "c1", "convo_meta", { parent_convo_id: "p1" }));
        expect((await database.conversations())[0].parent_convo_id).toBe("p1");

        await database.applyJournal(event(2, "c1", "convo_meta", {}));
        await database.applyJournal(event(3, "c1", "convo_meta", { parent_convo_id: "p2" }));

        expect((await database.conversations())[0].parent_convo_id).toBe("p1");
        database.close();
    });

    it("preserves an established parent when a replacement snapshot omits or changes it", async () => {
        const database = await JournalDatabase.open("https://journal.example", 3, "dan");
        await database.applyJournal(event(1, "c1", "convo_meta", { parent_convo_id: "p1" }));

        await database.replaceWithSnapshot({ seq: 2, conversations: [conversation("c1")] });
        expect((await database.conversations())[0].parent_convo_id).toBe("p1");

        await database.replaceWithSnapshot({ seq: 3, conversations: [conversation("c1", "p2")] });
        expect((await database.conversations())[0].parent_convo_id).toBe("p1");
        database.close();
    });

    it("rejects self-parent links from convo_meta and snapshots", async () => {
        const database = await JournalDatabase.open("https://journal.example", 4, "dan");

        await database.applyJournal(event(1, "c1", "convo_meta", { parent_convo_id: "c1" }));
        expect((await database.conversations())[0].parent_convo_id).toBeNull();

        await database.replaceWithSnapshot({ seq: 2, conversations: [conversation("c2", "c2")] });
        expect((await database.conversations())[0].parent_convo_id).toBeNull();
        database.close();
    });
});
