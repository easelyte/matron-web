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

const conversation = (id: string, session_state: string, parent_convo_id?: string): Conversation => ({
    id,
    title: id === "child" ? "Research child" : "Parent",
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

function signedInClient(
    conversations: Conversation[],
    selectedConversationId: string,
    stateOverrides: Partial<ClientState> = {},
): MatronJournalClient {
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
        sessionStatus: {
            model: "claude-sonnet",
            context: { tokens: 12_000, window: 200_000, pct: 6 },
        },
        ...stateOverrides,
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

describe("read-only subchat viewer", () => {
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

    it.each([
        ["running", "Running"],
        ["done", "Finished"],
    ])("renders child chrome and read-only controls for a %s child", async (sessionState, stateLabel) => {
        const client = signedInClient(
            [conversation("parent", "running"), conversation("child", sessionState, "parent")],
            "child",
        );
        const stageFiles = jest.spyOn(client, "stageFiles");
        rendered = await renderClient(client);

        const header = rendered.container.querySelector(".mj_SubChatHeader");
        expect(header?.textContent).toContain("Research child");
        expect(header?.textContent).toContain(stateLabel);
        expect(header?.textContent).toContain("claude-sonnet");
        expect(header?.textContent).toContain("Context: 12k/200k");
        expect(rendered.container.querySelector(".mx_MessageComposer")).toBeNull();
        expect(rendered.container.querySelector(".mj_ReadOnlyHint")?.textContent).toContain(
            "Read-only — subagent transcript",
        );

        const room = rendered.container.querySelector(".mx_RoomView")!;
        const file = new File(["content"], "notes.txt", { type: "text/plain" });
        const drop = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file] } });
        await act(async () => room.dispatchEvent(drop));
        expect(drop.defaultPrevented).toBe(false);
        expect(stageFiles).not.toHaveBeenCalled();
    });

    it("returns to a present parent", async () => {
        const client = signedInClient(
            [conversation("parent", "running"), conversation("child", "running", "parent")],
            "child",
        );
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue();
        const clearSelection = jest.spyOn(client, "clearSelection");
        rendered = await renderClient(client);

        await act(async () =>
            rendered?.container.querySelector<HTMLButtonElement>('[aria-label="Back to parent"]')?.click(),
        );

        expect(selectConversation).toHaveBeenCalledWith("parent");
        expect(clearSelection).not.toHaveBeenCalled();
    });

    it.each(["missing", "child"])("falls back to the conversation list for parent %s", async (parentId) => {
        const client = signedInClient([conversation("child", "done", parentId)], "child");
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue();
        const clearSelection = jest.spyOn(client, "clearSelection");
        rendered = await renderClient(client);

        await act(async () =>
            rendered?.container.querySelector<HTMLButtonElement>('[aria-label="Back to parent"]')?.click(),
        );

        expect(selectConversation).not.toHaveBeenCalled();
        expect(clearSelection).toHaveBeenCalledTimes(1);
    });

    it("suppresses prompt replies and attachment retry while retaining dismiss", async () => {
        const client = signedInClient(
            [conversation("parent", "running"), conversation("child", "running", "parent")],
            "child",
            {
                events: [
                    {
                        seq: 1,
                        convo_id: "child",
                        ts: 1,
                        sender: "agent:test",
                        type: "prompt",
                        payload: {
                            question: "Choose a direction",
                            options: ["North", "South"],
                            allows_free_text: true,
                        },
                    },
                ],
                pendingMessages: [
                    {
                        localId: "attachment-1",
                        convoId: "child",
                        body: "",
                        createdAt: 2,
                        kind: "file",
                        filename: "notes.txt",
                        attachState: "error",
                        errorKind: "upload_failed",
                        canRetry: true,
                    },
                ],
            },
        );
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_PromptCard")?.textContent).toContain("Choose a direction");
        expect(rendered.container.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_PromptText")).toBeNull();

        const attachmentActions = rendered.container.querySelector(".mj_AttachmentChip_actions");
        const actionLabels = [...(attachmentActions?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent,
        );
        expect(actionLabels).not.toContain("Retry");
        expect(actionLabels).toContain("Dismiss");
    });
});
