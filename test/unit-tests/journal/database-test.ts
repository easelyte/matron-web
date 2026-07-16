/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { JournalDatabase } from "../../../src/journal/database";
import { type JournalEvent } from "../../../src/journal/types";

function event(
    seq: number,
    sender: string,
    type = "text",
    payload: Record<string, unknown> = { body: `m${seq}` },
): JournalEvent {
    return { kind: "journal", seq, convo_id: "c1", ts: seq * 1_000, sender, type, payload };
}

describe("JournalDatabase", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
    });

    it("applies ordered frames atomically and ignores replay duplicates", async () => {
        const database = await JournalDatabase.open("https://journal.example", 1, "dan");
        await database.replaceWithSnapshot({
            seq: 0,
            conversations: [
                {
                    id: "c1",
                    title: "Agent",
                    session_state: "running",
                    last_seq: 0,
                    unread_count: 0,
                    snippet: "",
                    created_at: 1,
                },
            ],
        });

        expect(await database.applyJournal(event(1, "agent:dev"))).toBe(true);
        expect(await database.applyJournal(event(1, "agent:dev"))).toBe(false);
        expect(await database.cursor()).toBe(1);
        expect(await database.events("c1")).toHaveLength(1);
        expect((await database.conversations())[0]).toMatchObject({ last_seq: 1, unread_count: 1, snippet: "m1" });
        database.close();
    });

    it("keeps own messages unread-free and converges read markers", async () => {
        const database = await JournalDatabase.open("https://journal.example", 2, "dan");
        await database.replaceWithSnapshot({
            seq: 0,
            conversations: [
                {
                    id: "c1",
                    title: "Agent",
                    session_state: "running",
                    last_seq: 0,
                    unread_count: 0,
                    snippet: "",
                    created_at: 1,
                },
            ],
        });
        await database.applyJournal(event(1, "user:dan"));
        await database.applyJournal(event(2, "agent:dev"));
        await database.applyJournal(event(3, "user:dan", "read_marker", { convo_id: "c1", up_to_seq: 2 }));
        expect((await database.conversations())[0]).toMatchObject({ unread_count: 0, read_up_to_seq: 2 });
        database.close();
    });

    it("persists and reconciles the idempotent send outbox", async () => {
        const database = await JournalDatabase.open("https://journal.example", 3, "dan");
        await database.replaceWithSnapshot({ seq: 0, conversations: [] });
        await database.addToOutbox({ localId: "local-1", convoId: "c1", body: "ship it", createdAt: 10 });
        expect(await database.outbox("c1")).toHaveLength(1);
        await database.reconcileOwnMessage(event(1, "user:dan", "text", { body: "ship it", local_id: "local-1" }));
        expect(await database.outbox("c1")).toHaveLength(0);
        database.close();
    });

    it("reconciles repeated messages by their exact mirrored local id", async () => {
        const database = await JournalDatabase.open("https://journal.example", 4, "dan");
        await database.replaceWithSnapshot({ seq: 0, conversations: [] });
        await database.addToOutbox({ localId: "local-1", convoId: "c1", body: "same", createdAt: 10 });
        await database.addToOutbox({ localId: "local-2", convoId: "c1", body: "same", createdAt: 11 });

        await database.reconcileOwnMessage(event(1, "user:dan", "text", { body: "same" }));
        expect((await database.outbox("c1")).map((message) => message.localId)).toEqual(["local-1", "local-2"]);

        await database.reconcileOwnMessage(event(1, "user:dan", "text", { body: "same", local_id: "local-2" }));
        expect((await database.outbox("c1")).map((message) => message.localId)).toEqual(["local-1"]);

        await database.reconcileOwnMessage(event(2, "user:dan", "text", { body: "same", local_id: "local-1" }));
        expect(await database.outbox("c1")).toHaveLength(0);
        database.close();
    });

    it("reconciles only the authenticated user's matching conversation and pending kind", async () => {
        const database = await JournalDatabase.open("https://journal.example", 6, "dan");
        await database.replaceWithSnapshot({ seq: 0, conversations: [] });
        await database.addToOutbox({ localId: "text-1", convoId: "c1", body: "same", createdAt: 10 });
        await database.addToOutbox({
            localId: "image-1",
            convoId: "c1",
            body: "",
            createdAt: 11,
            kind: "image",
            attachState: "sending",
            blobRef: "media-1",
        });

        await database.reconcileOwnMessage(event(1, "user:pat", "text", { body: "same", local_id: "text-1" }));
        await database.reconcileOwnMessage({
            ...event(2, "user:dan", "text", { body: "same", local_id: "text-1" }),
            convo_id: "c2",
        });
        await database.reconcileOwnMessage(event(3, "user:dan", "file", { local_id: "image-1" }));
        expect((await database.outbox()).map((message) => message.localId)).toEqual(["text-1", "image-1"]);

        expect(await database.reconcileOwnMessage(event(4, "user:dan", "image", { local_id: "image-1" }))).toBe(
            "image-1",
        );
        expect((await database.outbox()).map((message) => message.localId)).toEqual(["text-1"]);
        database.close();
    });

    it("drops pending messages for conversations removed by a replacement snapshot", async () => {
        const database = await JournalDatabase.open("https://journal.example", 5, "dan");
        const conversation = {
            title: "Agent",
            session_state: "running",
            last_seq: 0,
            unread_count: 0,
            snippet: "",
            created_at: 1,
        };
        await database.replaceWithSnapshot({
            seq: 0,
            conversations: [
                { ...conversation, id: "c1" },
                { ...conversation, id: "removed" },
            ],
        });
        await database.addToOutbox({ localId: "keep", convoId: "c1", body: "valid", createdAt: 10 });
        await database.addToOutbox({ localId: "drop", convoId: "removed", body: "orphan", createdAt: 11 });

        await database.replaceWithSnapshot({ seq: 20, conversations: [{ ...conversation, id: "c1" }] });

        expect((await database.outbox()).map((message) => message.localId)).toEqual(["keep"]);
        database.close();
    });
});
