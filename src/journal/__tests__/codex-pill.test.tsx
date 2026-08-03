/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient, workerKind } from "../client";
import { MatronApp, SubagentStrip } from "../components";
import type { ClientState, Conversation, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "tester",
};

function conversation(id: string, extra: Partial<Conversation> = {}): Conversation {
    return {
        id,
        title: id,
        session_state: "running",
        session_outcome: null,
        last_seq: 0,
        unread_count: 0,
        snippet: "",
        created_at: 0,
        parent_convo_id: null,
        read_up_to_seq: 0,
        ...extra,
    };
}

function signedInClient(conversations: Conversation[], selectedConversationId: string): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        selectedConversationId,
        events: [],
        pendingMessages: [],
        connection: "online",
    };
    return client;
}

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    return { container, root };
}

describe("Codex and Claude worker pills", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("classifies workers from child links and id infixes", () => {
        expect(workerKind(conversation("room"))).toBeNull();
        expect(workerKind(conversation("room:codex:review-1", { parent_convo_id: "room" }))).toBe("codex");
        expect(workerKind(conversation("room:sub:agent-1", { parent_convo_id: "room" }))).toBe("claude");
        expect(workerKind(conversation("room:future:agent-1", { parent_convo_id: "room" }))).toBeNull();
    });

    it("renders the worker mark and outcome glyph for every supported state", async () => {
        const conversations = [
            conversation("room"),
            conversation("room:codex:running", { parent_convo_id: "room" }),
            conversation("room:sub:completed", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "completed",
            }),
            conversation("room:codex:interrupted", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "interrupted",
            }),
            conversation("room:sub:failed", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "failed",
            }),
            conversation("room:codex:legacy", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: null,
            }),
            conversation("room:codex:waiting", { parent_convo_id: "room", session_state: "waiting" }),
            conversation("room:sub:archived", { parent_convo_id: "room", session_state: "archived" }),
            conversation("room:codex:unknown", { parent_convo_id: "room", session_state: "future-state" }),
            conversation("room:sub:unknown-outcome", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "cancelled",
            }),
        ];
        const client = signedInClient(conversations, "room");

        rendered = await render(<SubagentStrip client={client} state={client.getSnapshot()} mode="parent" />);

        const pills = new Map(
            [...rendered.container.querySelectorAll<HTMLButtonElement>(".mj_SubagentPill")].map((pill) => [
                pill.textContent,
                pill,
            ]),
        );
        expect(pills.get("room:codex:running")?.querySelector(".mj_OpenAIMark")).not.toBeNull();
        expect(pills.get("room:codex:running")?.querySelector(".mj_Spinner")).not.toBeNull();
        expect(pills.get("room:sub:completed")?.querySelector(".mj_AnthropicMark")).not.toBeNull();
        expect(pills.get("room:sub:completed")?.querySelector(".mj_CompletedGlyph")).not.toBeNull();
        expect(pills.get("room:codex:interrupted")?.querySelector(".mj_InterruptedGlyph")).not.toBeNull();
        expect(pills.get("room:sub:failed")?.querySelector(".mj_FailedGlyph")).not.toBeNull();
        expect(pills.get("room:codex:legacy")?.querySelector(".mj_CompletedGlyph")).not.toBeNull();
        for (const name of [
            "room:codex:waiting",
            "room:sub:archived",
            "room:codex:unknown",
            "room:sub:unknown-outcome",
        ]) {
            expect(pills.get(name)?.querySelector(".mj_InactiveOutcomeGlyph")).not.toBeNull();
            expect(pills.get(name)?.querySelector(".mj_CompletedGlyph")).toBeNull();
            expect(pills.get(name)?.getAttribute("aria-label")).toBe(`Open subagent ${name}, status unknown`);
        }
        expect(pills.get("room:codex:running")?.getAttribute("aria-label")).toContain(", running");
        expect(pills.get("room:sub:completed")?.getAttribute("aria-label")).toContain(", completed");
        expect(pills.get("room:codex:interrupted")?.getAttribute("aria-label")).toContain(", interrupted");
        expect(pills.get("room:sub:failed")?.getAttribute("aria-label")).toContain(", failed");
        for (const mark of rendered.container.querySelectorAll<SVGSVGElement>(".mj_WorkerMark")) {
            expect(mark.getAttribute("fill")).toBe("currentColor");
        }
    });

    it("labels sidebar state and announces a terminal transition after its row leaves", async () => {
        const runningConversations = [
            conversation("room"),
            conversation("room:codex:review-1", {
                parent_convo_id: "room",
            }),
            conversation("room:sub:review-2", {
                parent_convo_id: "room",
            }),
        ];
        const client = signedInClient(runningConversations, "room");

        rendered = await render(<MatronApp client={client} />);

        const row = rendered.container.querySelector(".mj_RoomListItem_sub");
        expect(row?.querySelector(".mj_OpenAIMark")).not.toBeNull();
        expect(row?.querySelector(".mj_Spinner")).not.toBeNull();
        expect(row?.getAttribute("aria-label")).toContain(", running,");

        const finishedClient = signedInClient(
            [
                conversation("room"),
                conversation("room:codex:review-1", {
                    parent_convo_id: "room",
                    session_state: "done",
                    session_outcome: "interrupted",
                }),
                conversation("room:sub:review-2", {
                    parent_convo_id: "room",
                    session_state: "done",
                    session_outcome: "failed",
                }),
            ],
            "room",
        );
        await act(async () => rendered?.root.render(<MatronApp client={finishedClient} />));

        expect(rendered.container.querySelector(".mj_RoomListItem_sub")).toBeNull();
        const liveRegions = rendered.container.querySelectorAll(".mj_SubagentOutcomeStatus");
        expect(liveRegions).toHaveLength(1);
        expect(liveRegions[0]?.textContent).toBe("room:codex:review-1, interrupted; room:sub:review-2, failed");
        expect(rendered.container.querySelector(".mj_SubagentPill")?.getAttribute("aria-label")).toBe(
            "Open subagent room:codex:review-1, interrupted",
        );
    });
});
