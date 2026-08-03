/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { MatronJournalClient } from "../client";
import { MatronApp } from "../components";
import { JournalDatabase } from "../database";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

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

function sessionStatus(seq: number, outcome: string): JournalEvent {
    return {
        kind: "journal",
        seq,
        convo_id: "room:codex:review-1",
        ts: seq * 1_000,
        sender: "agent:bridge",
        type: "session_status",
        payload: { state: "done", session_outcome: outcome },
    };
}

describe("Codex outcome live apply and cache", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
    });

    it("round-trips an unknown live session_status outcome and renders it as unknown", async () => {
        const database = await JournalDatabase.open(SESSION.serverUrl, SESSION.userId, SESSION.username);
        await database.replaceWithSnapshot({
            seq: 0,
            conversations: [conversation("room"), conversation("room:codex:review-1", { parent_convo_id: "room" })],
        });

        const client = new MatronJournalClient();
        (client as unknown as { state: ClientState; database: JournalDatabase }).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: await database.conversations(),
            selectedConversationId: "room",
            events: [],
            pendingMessages: [],
            connection: "online",
        };
        (client as unknown as { database: JournalDatabase }).database = database;
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => root.render(React.createElement(MatronApp, { client })));
        expect(container.querySelector(".mj_SubagentPill .mj_Spinner")).not.toBeNull();

        await act(async () => {
            await (client as unknown as { handleJournal(event: JournalEvent): Promise<void> }).handleJournal(
                sessionStatus(1, "cancelled"),
            );
        });
        const pill = container.querySelector<HTMLButtonElement>(".mj_SubagentPill");
        expect(pill?.getAttribute("aria-label")).toContain("status unknown");
        expect(pill?.querySelector(".mj_InactiveOutcomeGlyph")).not.toBeNull();
        expect(pill?.querySelector(".mj_CompletedGlyph")).toBeNull();
        expect((await database.conversations())[0]).toMatchObject({
            id: "room:codex:review-1",
            session_state: "done",
            session_outcome: "cancelled",
        });
        await act(async () => root.unmount());
        container.remove();
        database.close();

        const reopened = await JournalDatabase.open(SESSION.serverUrl, SESSION.userId, SESSION.username);
        expect(await reopened.conversations()).toContainEqual(
            expect.objectContaining({ id: "room:codex:review-1", session_outcome: "cancelled" }),
        );
        reopened.close();
    });

    it("does not let an older backfill snapshot clobber a locally-newer outcome", async () => {
        const database = await JournalDatabase.open("https://journal.example", 2, "tester");
        await database.replaceWithSnapshot({
            seq: 10,
            conversations: [
                conversation("room:codex:review-1", {
                    parent_convo_id: "room",
                    last_seq: 10,
                    session_state: "done",
                    session_outcome: "interrupted",
                }),
            ],
        });

        await database.backfillParentLinks({
            seq: 11,
            conversations: [
                conversation("room:codex:review-1", {
                    parent_convo_id: "room",
                    last_seq: 5,
                    session_state: "done",
                    session_outcome: "failed",
                }),
            ],
        });

        expect((await database.conversations())[0]).toMatchObject({ session_outcome: "interrupted" });
        database.close();
    });

    it("stores a snapshot outcome and lets an equally fresh backfill update it", async () => {
        const database = await JournalDatabase.open("https://journal.example", 3, "tester");
        await database.replaceWithSnapshot({
            seq: 5,
            conversations: [conversation("room:codex:review-1", { last_seq: 5, session_outcome: "completed" })],
        });

        await database.backfillParentLinks({
            seq: 5,
            conversations: [conversation("room:codex:review-1", { last_seq: 5, session_outcome: "failed" })],
        });

        expect((await database.conversations())[0]).toMatchObject({ session_outcome: "failed" });
        database.close();
    });
});
