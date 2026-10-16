/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
    agentChatAnswersScope,
    agentChatFromLabel,
    agentChatHeadline,
    agentChatSessionLabel,
    agentChatToLabel,
    parseAgentChatRequest,
    readAgentChatResolutions,
    rememberAgentChatAnswer,
    rememberedAgentChatAnswer,
} from "../../../src/journal/agent-chat";
import { JournalApiError } from "../../../src/journal/api";
import {
    archiveStore,
    favoriteStore,
    MatronJournalClient,
    pinnedStore,
    unreadStore,
} from "../../../src/journal/client";
import { EventContent, MatronApp } from "../../../src/journal/components";
import { eventSnippet } from "../../../src/journal/types";
import type { ClientState, Conversation, JournalEvent, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const CONVERSATION: Conversation = {
    id: "c1",
    title: "One",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

function signedInClient(options: { events?: JournalEvent[] } = {}): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: options.events ?? [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

const chatPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: "agent_chat",
    request: "invite",
    room_id: "room-1",
    from_device_id: 7,
    from_name: "box-a",
    from_convo_id: "ab12",
    from_convo_title: "Fix the flaky tests",
    target_device_id: 12,
    to_name: "box-b",
    to_convo_id: "cd34",
    to_convo_title: "box-b:cd release notes",
    topic: "Compare test logs",
    justification: "box-b ran the same suite yesterday",
    ...over,
});

const chatCardEvent = (over: Record<string, unknown> = {}, seq = 40): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: 1700000000,
    sender: "agent:box-a",
    type: "permission_request",
    payload: chatPayload(over),
});

const consentMarker = (
    action: "created" | "closed",
    extra: Record<string, unknown> = {},
    seq = 41,
    itemId = "it_1",
): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: 1700000100,
    sender: "agent:box-a",
    type: "item",
    payload: {
        item_id: itemId,
        num: 3,
        kind: "question",
        title: "Agent chat request",
        action,
        by: action === "closed" ? "user" : "agent",
        consent: "chat",
        ...extra,
    },
});

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => window.localStorage.clear());

describe("parseAgentChatRequest", () => {
    it("parses an invite with its display fields", () => {
        const request = parseAgentChatRequest(chatPayload());
        expect(request).toMatchObject({
            ask: "invite",
            roomId: "room-1",
            fromDeviceId: 7,
            targetDeviceId: 12,
            topic: "Compare test logs",
            justification: "box-b ran the same suite yesterday",
        });
    });

    it.each([
        ["room_id", { room_id: "" }],
        ["request", { request: "summon" }],
        ["from_device_id", { from_device_id: "7" }],
        ["target_device_id", { target_device_id: undefined }],
    ])("rejects a payload with a bad %s", (_field, over) => {
        expect(parseAgentChatRequest(chatPayload(over))).toBeNull();
    });

    it("rejects other kinds", () => {
        expect(parseAgentChatRequest(chatPayload({ kind: "agent_spawn" }))).toBeNull();
    });

    it("collapses empty or blank topic and justification", () => {
        const request = parseAgentChatRequest(chatPayload({ topic: "", justification: "  " }));
        expect(request?.topic).toBeUndefined();
        expect(request?.justification).toBeUndefined();
    });
});

describe("agent chat labels", () => {
    it("names both ends of an invite with their sessions", () => {
        const request = parseAgentChatRequest(chatPayload())!;
        expect(agentChatHeadline(request)).toBe("box-a wants to start a chat with box-b.");
        expect(agentChatFromLabel(request)).toBe("box-a — ab · Fix the flaky tests");
        // The title already opens with the short id: never stutter it.
        expect(agentChatToLabel(request)).toBe("box-b — box-b:cd release notes");
    });

    it("words a join, and never labels the far end with the joiner's own id", () => {
        const request = parseAgentChatRequest(
            chatPayload({ request: "join", target_device_id: 7, to_name: "", to_convo_id: "", to_convo_title: "" }),
        )!;
        expect(agentChatHeadline(request)).toBe("box-a wants to join this chat.");
        expect(agentChatToLabel(request)).toBe("the room's owner");
    });

    it("falls back to device ids and drops unnamed sessions", () => {
        const request = parseAgentChatRequest(
            chatPayload({ from_name: "", to_name: "", from_convo_id: "", from_convo_title: "", to_convo_id: "" }),
        )!;
        expect(agentChatHeadline(request)).toBe("Device 7 wants to start a chat with Device 12.");
        expect(agentChatFromLabel(request)).toBe("Device 7");
        expect(agentChatSessionLabel("", "")).toBeUndefined();
        expect(agentChatSessionLabel("ef56", "")).toBe("ef");
    });
});

describe("readAgentChatResolutions", () => {
    it("settles a card from its consent item's closing outcome", () => {
        const resolutions = readAgentChatResolutions([
            chatCardEvent(),
            consentMarker("created", { consent_ask: "room-1/12" }),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "denied" }, 42),
        ]);
        expect(resolutions.get("c1:40")).toEqual({ kind: "answered", approved: false });
    });

    it("reads an older journal's closing note when the marker names no ask", () => {
        const resolutions = readAgentChatResolutions([
            chatCardEvent(),
            consentMarker("created"),
            consentMarker("closed", { comment: { id: "cm1", body: "Approved — the invitation is on its way." } }, 42),
        ]);
        expect(resolutions.get("c1:40")).toEqual({ kind: "answered", approved: true });
    });

    it("treats any other outcome as no longer waiting", () => {
        const resolutions = readAgentChatResolutions([
            chatCardEvent(),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "expired" }),
        ]);
        expect(resolutions.get("c1:40")).toEqual({ kind: "expired" });
    });

    it("ignores a hand close of an item that names its ask", () => {
        const resolutions = readAgentChatResolutions([
            chatCardEvent(),
            consentMarker("created", { consent_ask: "room-1/12" }),
            consentMarker("closed", { comment: { id: "cm1", body: "Approved" } }, 42),
        ]);
        expect(resolutions.has("c1:40")).toBe(false);
    });

    it("does not let a later lapse undo a decision", () => {
        const resolutions = readAgentChatResolutions([
            chatCardEvent(),
            consentMarker("created", { consent_ask: "room-1/12" }),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "approved" }, 42),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "gone" }, 43),
        ]);
        expect(resolutions.get("c1:40")).toEqual({ kind: "answered", approved: true });
    });

    it("lands a renewed ask's decision on the newest card only", () => {
        const resolutions = readAgentChatResolutions([
            chatCardEvent({}, 40),
            consentMarker("created", { consent_ask: "room-1/12" }, 41, "it_1"),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "expired" }, 42, "it_1"),
            chatCardEvent({}, 50),
            consentMarker("created", { consent_ask: "room-1/12" }, 51, "it_2"),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "approved" }, 52, "it_2"),
        ]);
        expect(resolutions.get("c1:40")).toEqual({ kind: "expired" });
        expect(resolutions.get("c1:50")).toEqual({ kind: "answered", approved: true });
    });
});

describe("eventSnippet for agent_chat", () => {
    it("matches the server's snapshot snippet", () => {
        expect(eventSnippet("permission_request", chatPayload())).toBe("🤝 Agent chat request");
    });
});

describe("agent_chat card", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    async function renderEvent(
        client: MatronJournalClient,
        event: JournalEvent,
        props: Record<string, unknown> = {},
    ): Promise<{ container: HTMLDivElement; root: Root }> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                    ...props,
                }),
            );
        });
        return { container, root };
    }

    function button(container: Element, label: string): HTMLButtonElement | undefined {
        return [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
    }

    it("renders who asks whom, about what and why, with Decline and Approve", async () => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(MatronApp, { client: signedInClient({ events: [chatCardEvent()] }) }));
        });
        rendered = { container, root };

        const card = container.querySelector(".mj_PromptCard_chat")!;
        expect(card).not.toBeNull();
        expect(container.querySelector(".mj_PromptCard_permission")).toBeNull();
        expect(card.querySelector(".mj_PromptLabel")?.textContent).toBe("Agent chat request");
        expect(card.querySelector(".mj_PromptQuestion")?.textContent).toBe("box-a wants to start a chat with box-b.");
        const rows = [...card.querySelectorAll(".mj_SpawnDetail")].map((row) => [
            row.querySelector(".mj_SpawnDetail_label")?.textContent,
            row.querySelector(".mj_SpawnDetail_value")?.textContent,
        ]);
        expect(rows).toEqual([
            ["From", "box-a — ab · Fix the flaky tests"],
            ["To", "box-b — box-b:cd release notes"],
            ["About", "Compare test logs"],
            ["Why", "box-b ran the same suite yesterday"],
        ]);
        expect([...card.querySelectorAll(".mj_PromptOptions button")].map((b) => b.textContent)).toEqual([
            "Decline",
            "Approve",
        ]);
    });

    it("drops the About and Why rows when the ask gave none", async () => {
        rendered = await renderEvent(signedInClient(), chatCardEvent({ topic: "", justification: "" }));
        const labels = [...rendered.container.querySelectorAll(".mj_SpawnDetail_label")].map((l) => l.textContent);
        expect(labels).toEqual(["From", "To"]);
    });

    it.each([
        ["Approve", "approve", "Approved"],
        ["Decline", "deny", "Declined"],
    ])("tapping %s answers over /agent-chat/answer and settles the card", async (label, decision, outcome) => {
        const client = signedInClient();
        const sendPromptReply = jest.spyOn(client, "sendPromptReply");
        let settle!: () => void;
        const answerAgentChat = jest
            .spyOn(client, "answerAgentChat")
            .mockReturnValue(new Promise<boolean>((resolve) => (settle = () => resolve(true))));
        rendered = await renderEvent(client, chatCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_chat")!;

        await act(async () => button(card, label)?.click());

        expect(answerAgentChat).toHaveBeenCalledWith("room-1", 12, decision);
        expect(sendPromptReply).not.toHaveBeenCalled();
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        expect([...card.querySelectorAll<HTMLButtonElement>(".mj_PromptOptions button")].every((b) => b.disabled)).toBe(
            true,
        );

        await act(async () => settle());

        expect(card.querySelector(".mj_PromptOptions")).toBeNull();
        expect(card.querySelector(".mj_Answered")?.textContent).toBe(outcome);
    });

    it("remembers a tap's answer across a remount", async () => {
        const client = signedInClient();
        jest.spyOn(client, "answerAgentChat").mockResolvedValue(true);
        rendered = await renderEvent(client, chatCardEvent());
        await act(async () => button(rendered!.container, "Approve")?.click());
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        rendered = await renderEvent(client, chatCardEvent());

        expect(rendered.container.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_Answered")?.textContent).toBe("Approved");
    });

    it("keeps an answer that settles after the card unmounted, and never aborts it", async () => {
        const client = signedInClient();
        let settle!: () => void;
        const answerAgentChat = jest
            .spyOn(client, "answerAgentChat")
            .mockReturnValue(new Promise<boolean>((resolve) => (settle = () => resolve(true))));
        rendered = await renderEvent(client, chatCardEvent());
        await act(async () => button(rendered!.container, "Decline")?.click());
        expect(answerAgentChat.mock.calls[0]).toHaveLength(3); // no abort signal handed over
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        await act(async () => settle());
        rendered = await renderEvent(client, chatCardEvent());

        expect(rendered.container.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_Answered")?.textContent).toBe("Declined");
    });

    it("follows an answer still in flight when the card remounts, instead of offering the buttons again", async () => {
        const client = signedInClient();
        let settle!: () => void;
        const answerAgentChat = jest
            .spyOn(client, "answerAgentChat")
            .mockReturnValue(new Promise<boolean>((resolve) => (settle = () => resolve(true))));
        rendered = await renderEvent(client, chatCardEvent());
        await act(async () => button(rendered!.container, "Approve")?.click());
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        rendered = await renderEvent(client, chatCardEvent());

        expect(rendered.container.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        const buttons = [...rendered.container.querySelectorAll<HTMLButtonElement>(".mj_PromptOptions button")];
        expect(buttons.every((b) => b.disabled)).toBe(true);
        await act(async () => buttons[0]?.click());
        expect(answerAgentChat).toHaveBeenCalledTimes(1);

        await act(async () => settle());

        expect(rendered.container.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_Answered")?.textContent).toBe("Approved");
    });

    it("never lets a later 'no longer waiting' overwrite a remembered decision", () => {
        const scope = agentChatAnswersScope(SESSION);
        rememberAgentChatAnswer(scope, "c1:40", "deny");
        rememberAgentChatAnswer(scope, "c1:40", "expired");
        expect(rememberedAgentChatAnswer(scope, "c1:40")).toBe("deny");
        rememberAgentChatAnswer(scope, "c1:41", "expired");
        expect(rememberedAgentChatAnswer(scope, "c1:41")).toBe("expired");
    });

    it("does not show one account's remembered answer to another", async () => {
        const client = signedInClient();
        jest.spyOn(client, "answerAgentChat").mockResolvedValue(true);
        rendered = await renderEvent(client, chatCardEvent());
        await act(async () => button(rendered!.container, "Approve")?.click());
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        const other = signedInClient();
        const state = (other as unknown as { state: ClientState }).state;
        (other as unknown as { state: ClientState }).state = { ...state, session: { ...SESSION, userId: 99 } };
        rendered = await renderEvent(other, chatCardEvent());

        expect([...rendered.container.querySelectorAll(".mj_PromptOptions button")].map((b) => b.textContent)).toEqual([
            "Decline",
            "Approve",
        ]);
    });

    it("settles as no longer waiting on a 409", async () => {
        const client = signedInClient();
        jest.spyOn(client, "answerAgentChat").mockRejectedValue(new JournalApiError("conflict", 409));
        rendered = await renderEvent(client, chatCardEvent());

        await act(async () => button(rendered!.container, "Approve")?.click());

        expect(rendered.container.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_PromptResolved_expired")?.textContent).toBe(
            "This request is no longer waiting for an answer.",
        );
    });

    it.each([
        [new JournalApiError("offline", 0), "Couldn't reach the server — check your connection and try again."],
        [new JournalApiError("not found", 404), "That request is no longer on the server."],
        [new JournalApiError("bad", 400), "The server refused that answer."],
    ])("shows a failure and stays answerable after %p", async (error, message) => {
        const client = signedInClient();
        const answerAgentChat = jest.spyOn(client, "answerAgentChat").mockRejectedValueOnce(error);
        rendered = await renderEvent(client, chatCardEvent());

        await act(async () => button(rendered!.container, "Approve")?.click());

        expect(rendered.container.querySelector(".mj_PromptResolved_failed")?.textContent).toBe(message);
        const approve = button(rendered.container, "Approve")!;
        expect(approve.disabled).toBe(false);

        answerAgentChat.mockResolvedValueOnce(true);
        await act(async () => approve.click());
        expect(answerAgentChat).toHaveBeenCalledTimes(2);
        expect(rendered.container.querySelector(".mj_PromptResolved_failed")).toBeNull();
        expect(rendered.container.querySelector(".mj_Answered")?.textContent).toBe("Approved");
    });

    it("shows a decision made elsewhere, read from the timeline, without buttons", async () => {
        const client = signedInClient();
        rendered = await renderEvent(client, chatCardEvent(), {
            agentChatResolutions: new Map([["c1:40", { kind: "answered", approved: false }]]),
        });

        expect(rendered.container.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_Answered")?.textContent).toBe("Declined");
    });

    it("settles from the consent item's closing marker in the live timeline", async () => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const events = [
            chatCardEvent(),
            consentMarker("created", { consent_ask: "room-1/12" }),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "expired" }, 42),
        ];
        await act(async () => {
            root.render(React.createElement(MatronApp, { client: signedInClient({ events }) }));
        });
        rendered = { container, root };

        const card = container.querySelector(".mj_PromptCard_chat")!;
        expect(card.querySelector(".mj_PromptOptions")).toBeNull();
        expect(card.querySelector(".mj_PromptResolved_expired")).not.toBeNull();
    });

    it("hides the buttons in a read-only transcript", async () => {
        rendered = await renderEvent(signedInClient(), chatCardEvent(), { isReadOnly: true });
        expect(rendered.container.querySelector(".mj_PromptCard_chat")).not.toBeNull();
        expect(rendered.container.querySelector(".mj_PromptOptions")).toBeNull();
    });

    it.each([
        [{ room_id: "" }, "Agent request that can't be answered here: Compare test logs"],
        [{ target_device_id: undefined, topic: "" }, "Agent request that can't be answered here"],
    ])("renders a malformed request as an inert notice", async (over, text) => {
        rendered = await renderEvent(signedInClient(), chatCardEvent(over));

        expect(rendered.container.querySelector(".mj_AgentRequestNotice")?.textContent).toBe(text);
        expect(rendered.container.querySelector("button")).toBeNull();
        expect(rendered.container.querySelector(".mj_PromptCard")).toBeNull();
    });
});

describe("agent_chat card answered by the Coordinator", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    const decisionEvent = (decision: string, seq: number): JournalEvent => ({
        seq,
        convo_id: "c1",
        ts: 1700000200,
        sender: "journal",
        type: "consent_decision",
        payload: {
            kind: "chat",
            room_id: "room-1",
            target_device_id: 12,
            decision,
            by: "coordinator",
            convo_id: "c1",
            reason: "Both boxes work on the same project",
        },
    });

    async function renderTimeline(events: JournalEvent[]): Promise<Element> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(MatronApp, { client: signedInClient({ events }) }));
        });
        rendered = { container, root };
        return container.querySelector(".mj_PromptCard_chat")!;
    }

    it("settles the card with the Coordinator's decision and reason", async () => {
        const card = await renderTimeline([chatCardEvent(), decisionEvent("approve", 41)]);

        expect(card.querySelector(".mj_PromptOptions")).toBeNull();
        expect(card.querySelector(".mj_PromptResolved_allowed .mj_Answered")?.textContent).toBe(
            "Approved by the Coordinator — Both boxes work on the same project",
        );
    });

    it("keeps the Coordinator's decision over a later close saying the ask lapsed", async () => {
        const card = await renderTimeline([
            chatCardEvent(),
            consentMarker("created", { consent_ask: "room-1/12" }),
            decisionEvent("decline", 42),
            consentMarker("closed", { consent_ask: "room-1/12", consent_outcome: "expired" }, 43),
        ]);

        expect(card.querySelector(".mj_PromptResolved_denied .mj_Answered")?.textContent).toBe(
            "Declined by the Coordinator — Both boxes work on the same project",
        );
    });

    it("says the Coordinator decided from the closing marker alone, without a reason", async () => {
        const card = await renderTimeline([
            chatCardEvent(),
            consentMarker("created", { consent_ask: "room-1/12" }),
            consentMarker(
                "closed",
                { consent_ask: "room-1/12", consent_outcome: "approved", decided_by: "coordinator" },
                42,
            ),
        ]);

        expect(card.querySelector(".mj_Answered")?.textContent).toBe("Approved by the Coordinator");
    });

    it("reads an older journal's Coordinator closing note", () => {
        const resolutions = readAgentChatResolutions([
            chatCardEvent(),
            consentMarker("created"),
            consentMarker("closed", { comment: { body: "Declined by the Coordinator — not this week." } }, 42),
        ]);
        expect(resolutions.get("c1:40")).toEqual({ kind: "answered", approved: false, byCoordinator: true });
    });
});
