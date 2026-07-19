/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import type { ClientState, Conversation, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "tester",
};

const conversation = (
    id: string,
    title: string,
    session_state: Conversation["session_state"],
    parent_convo_id?: string,
): Conversation => ({
    id,
    title,
    session_state,
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    parent_convo_id,
    read_up_to_seq: 0,
});

interface ClientInternals {
    state: ClientState;
}

function signedInClient(conversations: Conversation[], selectedConversationId: string): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as ClientInternals).state = {
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

async function renderClient(client: MatronJournalClient): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(MatronApp, { client })));
    return { container, root };
}

describe("running subagent strip", () => {
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
        jest.restoreAllMocks();
    });

    it("renders one pill per running child and opens the clicked child", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("running-a", "Research", "running", "parent"),
            conversation("finished", "Finished", "done", "parent"),
            conversation("running-b", "Draft", "running", "parent"),
        ];
        const client = signedInClient(conversations, "parent");
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue();

        rendered = await renderClient(client);

        const pills = rendered.container.querySelectorAll(".mj_SubagentPill");
        expect(pills).toHaveLength(2);
        expect([...pills].map((pill) => pill.textContent)).toEqual(["Research", "Draft"]);

        await act(async () => (pills[1] as HTMLButtonElement).click());
        expect(selectConversation).toHaveBeenCalledWith("running-b");
    });

    it("renders nothing when the selected conversation has no running children", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("finished", "Finished", "done", "parent"),
        ];
        rendered = await renderClient(signedInClient(conversations, "parent"));

        expect(rendered.container.querySelector(".mj_SubagentStrip")).toBeNull();
    });

    it("shows running grandchildren when viewing a child", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("child", "Child", "running", "parent"),
            conversation("grandchild", "Grandchild", "running", "child"),
        ];
        rendered = await renderClient(signedInClient(conversations, "child"));

        const pills = rendered.container.querySelectorAll(".mj_SubagentPill");
        expect(pills).toHaveLength(1);
        expect(pills[0].textContent).toBe("Grandchild");
    });
});
