/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot } from "react-dom/client";

import { MatronJournalClient } from "../client";
import { SubagentStrip } from "../components";
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
        last_seq: 0,
        unread_count: 0,
        snippet: "",
        created_at: 0,
        parent_convo_id: null,
        read_up_to_seq: 0,
        ...extra,
    };
}

describe("legacy rollout outcome compatibility", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("renders the plain completion check for an old done child without session_outcome", async () => {
        const conversations = [
            conversation("room"),
            conversation("room:codex:legacy", {
                parent_convo_id: "room",
                session_state: "done",
            }),
        ];
        const client = new MatronJournalClient();
        (client as unknown as { state: ClientState }).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations,
            selectedConversationId: "room",
            events: [],
            pendingMessages: [],
            connection: "online",
        };
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);

        await act(async () =>
            root.render(<SubagentStrip client={client} state={client.getSnapshot()} mode="parent" />),
        );

        const pill = container.querySelector(".mj_SubagentPill");
        expect(pill?.querySelector(".mj_CompletedGlyph")).not.toBeNull();
        expect(
            pill?.querySelector(".mj_InterruptedGlyph, .mj_FailedGlyph, .mj_InactiveOutcomeGlyph, .mj_Spinner"),
        ).toBeNull();
        expect(pill?.getAttribute("aria-label")).toBe("Open subagent room:codex:legacy, completed");

        await act(async () => root.unmount());
        container.remove();
    });
});
