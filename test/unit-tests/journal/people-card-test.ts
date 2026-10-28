/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
    archiveStore,
    favoriteStore,
    MatronJournalClient,
    pinnedStore,
    unreadStore,
} from "../../../src/journal/client";
import { EventContent } from "../../../src/journal/components";
import { isPeopleCardPayload, parsePeopleCard } from "../../../src/journal/people-card";
import { eventSnippet } from "../../../src/journal/types";
import type { ClientState, Conversation, JournalEvent, Session, TrackerItem } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const CONVERSATION: Conversation = {
    id: "c1",
    title: "People",
    session_state: "idle",
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

function signedInClient(): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

function trackerItem(over: Partial<TrackerItem> = {}): TrackerItem {
    return {
        id: "it_1",
        num: 12,
        kind: "question",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        title: "Consent",
        body: "",
        labels: ["consent"],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
        ...over,
    };
}

// Payloads shaped as the journal writes them for each card.
const contactOut = {
    kind: "contact_request",
    direction: "out",
    contact_id: "ct_1",
    peer: { name: "bob", address: "bob" },
    from_device_id: 7,
    from_name: "box-a",
    from_convo_id: "c1",
};
const contactIn = {
    kind: "contact_request",
    direction: "in",
    contact_id: "ct_2",
    peer: { name: "alice", address: "alice" },
};
const shareOut = {
    kind: "mission_share",
    direction: "out",
    grant_id: "gr_1",
    level: "read",
    owner: { user_id: 2, name: "alice" },
    grantee: { name: "bob", address: "bob" },
    mission: { id: "ms_1", num: 4, title: "Cover editor" },
    preview: { milestones: 1, items: 2, comments: 0, attachments: 0 },
};
const shareIn = { ...shareOut, direction: "in", grant_id: "gr_2", owner: { user_id: 3, name: "alice" } };
const sessionShareOut = {
    kind: "session_share",
    direction: "out",
    session_share_id: "ss_1",
    person: { name: "bob" },
    session_title: "Cover editor work",
    from_device_id: 7,
    from_name: "box-a",
};
const roomOut = {
    kind: "person_room",
    direction: "out",
    room_link_id: "rl_1",
    person: { name: "bob" },
    session_title: "Cover editor work",
    topic: "Cover editor colours",
    justification: "bob owns the palette",
    mission: null,
    from_device_id: 7,
    from_name: "box-a",
};
const roomIn = { ...roomOut, direction: "in", room_link_id: "rl_2", person: { name: "alice" } };
const talkOut = {
    ...roomOut,
    room_link_id: "rl_3",
    talk: true,
    contact_pending: true,
    choices: ["Send", "Cancel"],
    session_title: null,
};
const talkIn = {
    ...roomOut,
    direction: "in",
    room_link_id: "rl_4",
    person: { name: "alice" },
    talk: true,
    contact_pending: false,
    choices: ["New session", "My Coordinator", "Pick a session", "Decline"],
    session_title: null,
};

const cardEvent = (payload: Record<string, unknown>, seq = 40): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: 1700000000,
    sender: "journal",
    type: "permission_request",
    payload,
});

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => window.localStorage.clear());

describe("parsePeopleCard", () => {
    it("recognises the four person-to-person kinds and nothing else", () => {
        for (const payload of [contactOut, shareOut, sessionShareOut, roomOut, talkIn]) {
            expect(isPeopleCardPayload(payload)).toBe(true);
        }
        expect(isPeopleCardPayload({ kind: "agent_chat" })).toBe(false);
        expect(isPeopleCardPayload({ kind: "agent_spawn" })).toBe(false);
        expect(isPeopleCardPayload({ description: "Run rm" })).toBe(false);
    });

    it.each([
        ["contact out", contactOut, "bob", "out", "matron://consent/contact/ct_1"],
        ["contact in", contactIn, "alice", "in", "matron://consent/contact/ct_2"],
        ["mission share out", shareOut, "bob", "out", "matron://consent/share/gr_1"],
        ["mission share in", shareIn, "alice", "in", "matron://consent/share/gr_2"],
        ["session share out", sessionShareOut, "bob", "out", "matron://consent/session/ss_1"],
        ["room out", roomOut, "bob", "out", "matron://consent/room/rl_1"],
        ["room in", roomIn, "alice", "in", "matron://consent/room/rl_2"],
        ["talk in", talkIn, "alice", "in", "matron://consent/room/rl_4"],
    ])("%s: person, direction and mirror link", (_name, payload, person, direction, link) => {
        const card = parsePeopleCard(payload)!;
        expect(card.person).toBe(person);
        expect(card.direction).toBe(direction);
        expect(card.consentUrl).toBe(link);
    });

    it("words each direction so the reader knows who is asking", () => {
        expect(parsePeopleCard(contactOut)!.headline).toBe("Your agent asks to add bob as a contact");
        expect(parsePeopleCard(contactIn)!.headline).toBe("alice wants to add you as a contact");
        expect(parsePeopleCard(shareOut)!.headline).toBe("Your agent asks to share a mission with bob");
        expect(parsePeopleCard(shareIn)!.headline).toBe("alice wants to share a mission with you");
        expect(parsePeopleCard(sessionShareOut)!.headline).toBe(
            "Your agent asks to let bob's agents reach this session",
        );
        expect(parsePeopleCard(roomOut)!.headline).toBe("Your agent asks to talk with bob's agent");
        expect(parsePeopleCard(roomIn)!.headline).toBe("alice's agent wants to talk with your session");
        expect(parsePeopleCard(talkOut)!.headline).toBe("Your agent asks to talk with bob");
        expect(parsePeopleCard(talkIn)!.headline).toBe("alice's agent wants to talk");
    });

    it("carries the topic: the room's topic, the mission title or the session title", () => {
        expect(parsePeopleCard(roomOut)!.topic).toBe("Cover editor colours");
        expect(parsePeopleCard(talkIn)!.topic).toBe("Cover editor colours");
        expect(parsePeopleCard(shareOut)!.topic).toBe("Cover editor");
        expect(parsePeopleCard(sessionShareOut)!.topic).toBe("Cover editor work");
        expect(parsePeopleCard(contactOut)!.topic).toBe("");
    });

    it("has no mirror link when the payload lacks its id", () => {
        expect(parsePeopleCard({ ...roomOut, room_link_id: undefined })!.consentUrl).toBeNull();
        expect(parsePeopleCard({ ...contactOut, contact_id: "a/b" })!.consentUrl).toBeNull();
    });
});

describe("eventSnippet for person-to-person cards", () => {
    it("matches the journal's minted snippets", () => {
        expect(eventSnippet("permission_request", contactOut)).toBe("🤝 Contact request");
        expect(eventSnippet("permission_request", shareOut)).toBe("🤝 Mission share request");
        expect(eventSnippet("permission_request", roomOut)).toBe("🤝 Room with another person");
        expect(eventSnippet("permission_request", sessionShareOut)).toBe("🤝 Session share request");
    });
});

describe("MatronJournalClient.findConsentItem", () => {
    function withItems(pages: { items: TrackerItem[]; next_cursor: string | null }[]): {
        client: MatronJournalClient;
        items: jest.Mock;
    } {
        const client = signedInClient();
        const items = jest.fn();
        for (const page of pages) items.mockResolvedValueOnce(page);
        (client as unknown as { api: unknown }).api = { items };
        return { client, items };
    }

    it("finds the mirror item by its exact consent link in the card's conversation", async () => {
        const { client, items } = withItems([
            {
                items: [
                    trackerItem({ num: 11, links: [{ url: "matron://consent/room/rl_10" }] }),
                    trackerItem({ num: 12, links: [{ url: "matron://consent/room/rl_1", title: "Room" }] }),
                ],
                next_cursor: null,
            },
        ]);
        await expect(client.findConsentItem("c1", "matron://consent/room/rl_1")).resolves.toBe(12);
        expect(items).toHaveBeenCalledWith(expect.objectContaining({ convo: "c1", label: "consent" }));
    });

    it("follows the next page, and answers null when nothing matches", async () => {
        const { client } = withItems([
            { items: [trackerItem({ num: 1, links: [{ url: "matron://consent/room/rl_9" }] })], next_cursor: "p2" },
            { items: [trackerItem({ num: 2, links: [{ url: "matron://consent/contact/ct_1" }] })], next_cursor: null },
        ]);
        await expect(client.findConsentItem("c1", "matron://consent/contact/ct_1")).resolves.toBe(2);

        const miss = withItems([{ items: [], next_cursor: null }]);
        await expect(miss.client.findConsentItem("c1", "matron://consent/contact/ct_1")).resolves.toBeNull();
    });

    it("answers null when the lookup fails", async () => {
        const client = signedInClient();
        (client as unknown as { api: unknown }).api = { items: jest.fn().mockRejectedValue(new Error("offline")) };
        await expect(client.findConsentItem("c1", "matron://consent/room/rl_1")).resolves.toBeNull();
    });
});

describe("person-to-person card in the timeline", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(() => {
        if (rendered) {
            act(() => rendered!.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    async function render(
        client: MatronJournalClient,
        event: JournalEvent,
        isReadOnly = false,
    ): Promise<HTMLDivElement> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                    isReadOnly,
                }),
            );
        });
        rendered = { container, root };
        return container;
    }

    const buttonLabels = (el: Element): string[] =>
        [...el.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());

    it.each([
        ["contact_request", contactOut],
        ["mission_share", shareIn],
        ["session_share", sessionShareOut],
        ["person_room", roomOut],
        ["person_room talk", talkIn],
    ])("%s never draws Allow/Deny buttons", async (_name, payload) => {
        const client = signedInClient();
        jest.spyOn(client, "findConsentItem").mockResolvedValue(null);
        const container = await render(client, cardEvent(payload));

        expect(container.querySelector(".mj_PeopleCard")).not.toBeNull();
        expect(buttonLabels(container)).toEqual([]);
        expect(container.textContent).not.toMatch(/Allow|Deny/);
    });

    it("shows who asks, which way and the topic on an incoming talk card", async () => {
        const client = signedInClient();
        jest.spyOn(client, "findConsentItem").mockResolvedValue(null);
        const container = await render(client, cardEvent(talkIn));
        const card = container.querySelector(".mj_PeopleCard")!;

        expect(card.textContent).toContain("alice's agent wants to talk");
        expect(card.textContent).toContain("Cover editor colours");
        expect(card.textContent).toContain("bob owns the palette");
        expect(card.querySelector(".mj_PromptLabel")?.textContent).toBe("Talk request");
    });

    it("offers Answer in the tracker when the mirror item is found, and opens it", async () => {
        const client = signedInClient();
        const find = jest.spyOn(client, "findConsentItem").mockResolvedValue(12);
        const open = jest.spyOn(client, "openTrackerItem").mockImplementation(() => {});
        const container = await render(client, cardEvent(roomOut));

        expect(find).toHaveBeenCalledWith("c1", "matron://consent/room/rl_1");
        const button = [...container.querySelectorAll("button")].find((b) =>
            b.textContent?.includes("Answer in the tracker"),
        );
        expect(button).toBeDefined();
        await act(async () => button!.click());
        expect(open).toHaveBeenCalledWith(12);
    });

    it("shows an inert hint when the mirror item can't be found", async () => {
        const client = signedInClient();
        jest.spyOn(client, "findConsentItem").mockResolvedValue(null);
        const container = await render(client, cardEvent(contactIn));

        expect(buttonLabels(container)).toEqual([]);
        expect(container.querySelector(".mj_PeopleCard_hint")?.textContent).toBe("Answer in your tracker (For you)");
    });

    it("does not look anything up when the payload has no mirror link", async () => {
        const client = signedInClient();
        const find = jest.spyOn(client, "findConsentItem");
        const container = await render(client, cardEvent({ ...roomOut, room_link_id: "" }));

        expect(find).not.toHaveBeenCalled();
        expect(container.querySelector(".mj_PeopleCard_hint")?.textContent).toBe("Answer in your tracker (For you)");
    });

    it("draws a hand-over with its own buttons, answered through the client", async () => {
        const client = signedInClient();
        jest.spyOn(client, "findConsentItem").mockResolvedValue(null);
        const load = jest.spyOn(client, "loadGrant").mockResolvedValue({
            id: "gr_7",
            direction: "out",
            subject_kind: "mission",
            level: "owner",
            state: "awaiting_owner",
        });
        const answer = jest.spyOn(client, "answerGrant").mockResolvedValue({
            id: "gr_7",
            direction: "out",
            subject_kind: "mission",
            level: "owner",
            state: "pending",
        });
        const container = await render(
            client,
            cardEvent({
                kind: "mission_handover",
                direction: "out",
                grant_id: "gr_7",
                grantee: { name: "bob" },
                subject: { kind: "mission", title: "Cover editor" },
                brief: "Where things stand.",
                preview: { missions: 1, milestones: 0, items: 0, comments: 0, attachments: [] },
            }),
        );

        expect(load).toHaveBeenCalledWith("gr_7");
        expect(buttonLabels(container)).toEqual(["Decline", "Approve"]);
        const approve = [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
        await act(async () => approve.click());
        expect(answer).toHaveBeenCalledWith("gr_7", { decision: "approve", exclude_media: [], keep_level: "read" });
    });

    it("draws no hand-over buttons in a read-only transcript, and never answers there", async () => {
        const client = signedInClient();
        jest.spyOn(client, "findConsentItem").mockResolvedValue(null);
        jest.spyOn(client, "loadGrant").mockResolvedValue({
            id: "gr_7",
            direction: "out",
            subject_kind: "mission",
            level: "owner",
            state: "awaiting_owner",
        });
        const answer = jest.spyOn(client, "answerGrant");
        const container = await render(
            client,
            cardEvent({
                kind: "mission_handover",
                direction: "out",
                grant_id: "gr_7",
                grantee: { name: "bob" },
                subject: { kind: "mission", title: "Cover editor" },
                brief: "Where things stand.",
                preview: { attachments: [{ media_id: "md_1", name: "palette.png" }] },
            }),
            true,
        );

        expect(container.querySelector(".mj_HandoverBrief")).not.toBeNull();
        expect(buttonLabels(container)).toEqual([]);
        expect(container.querySelector<HTMLFieldSetElement>(".mj_HandoverFiles")?.disabled).toBe(true);
        expect(container.querySelector(".mj_HandoverHint")).toBeNull();
        expect(answer).not.toHaveBeenCalled();
    });
});
