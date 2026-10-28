/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Another person's writes in one of the user's missions (a `contribute` share) and the rows a
 * hand-over copies in: each says who wrote it in words, and a handed-over mission says who has it.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import type { EventPayload, JournalEvent, Milestone } from "../types";
import { MilestoneCard, MissionNotice, ItemInlineNote } from "../tracker/cards";
import { commentAttribution, contributorWords, statusByline, statusRowText } from "../tracker/format";
import { commentAuthor } from "../tracker/item-context";
import { ItemDetail } from "../tracker/ItemDetail";
import { ItemRow } from "../tracker/ItemRow";
import { MissionDetail } from "../tracker/MissionDetail";
import { fakeSeen, trackerComment, trackerItem, trackerMission, trackerMissionDetail } from "./tracker-fixtures";

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(element);
    });
    return { container, root };
}

function event(type: string, payload: EventPayload): JournalEvent {
    return { kind: "journal", seq: 1, convo_id: "c1", ts: 1, sender: "journal", type, payload };
}

function milestone(over: Partial<Milestone> = {}): Milestone {
    return {
        id: "ml_1",
        mission_id: "ms_1",
        num: 1,
        kind: "progress",
        title: "Checked the export",
        body: "",
        convo_id: "c1",
        seq: 4,
        device_id: 0,
        created_by: "agent",
        created_at: 3,
        ...over,
    };
}

const markerClient = {
    openTrackerItem: jest.fn(),
    openTrackerLink: jest.fn(),
    openTrackerMission: jest.fn(),
} as unknown as MatronJournalClient;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("contributor wording", () => {
    it("names the person, or their agent", () => {
        expect(contributorWords({ name: "bob", via: "user" })).toBe("bob");
        expect(contributorWords({ name: "bob", via: "agent" })).toBe("bob's agent");
        expect(contributorWords({ name: "  ", via: "agent" })).toBeNull();
        expect(contributorWords(undefined)).toBeNull();
    });

    it("prefers a comment's attribution to its contributor", () => {
        expect(commentAttribution({ attribution: "alice's agent" })).toBe("alice's agent");
        expect(commentAttribution({ contributor: { name: "bob", via: "user" } })).toBe("bob");
        expect(commentAttribution({ attribution: "bob", contributor: { name: "bob", via: "agent" } })).toBe("bob");
        expect(commentAttribution({})).toBeNull();
    });

    it("words a contributor's close in the thread", () => {
        expect(
            statusRowText({
                author: "agent",
                attribution: "bob's agent",
                meta: { to: { state: "closed", resolution: "done", awaiting: null } },
            }),
        ).toBe("bob's agent closed this as done");
    });

    it("says who set the status when a contributor did", () => {
        const now = 10_000_000;
        expect(statusByline(now - 12 * 60_000, "agent", now, "bob")).toBe("Status by bob · updated 12m ago");
        expect(statusByline(null, "agent", now, "bob")).toBe("Status by bob");
        expect(statusByline(now - 12 * 60_000, "agent", now)).toBe("Updated 12m ago by an agent");
    });

    it("heads a copied or contributed comment with its attribution, never a box", () => {
        const author = commentAuthor(
            trackerComment({ author: "agent", device_id: 0, device_name: null, attribution: "alice's agent" }),
            [],
            [{ device_id: 0, name: "box-b" } as never],
        );
        expect(author).toEqual({ box: "alice's agent", conversation: null, convoId: null });
        expect(commentAuthor(trackerComment({ author: "user" }), [], [])).toBeNull();
    });
});

describe("contributor rows", () => {
    it("an item row says who filed it", async () => {
        const { container } = await mount(
            <ItemRow
                item={trackerItem({ num: 21, title: "Check the bleed", contributor: { name: "bob", via: "agent" } })}
                onOpen={jest.fn()}
            />,
        );
        expect(container.querySelector(".mj_TrackerContributor")?.textContent).toBe("by bob's agent");
        expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("by bob's agent");
    });

    it("an item row of the user's own carries no attribution", async () => {
        const { container } = await mount(<ItemRow item={trackerItem()} onOpen={jest.fn()} />);
        expect(container.querySelector(".mj_TrackerContributor")).toBeNull();
    });

    it("an item detail says who filed it and heads their comments with their name", async () => {
        const client = {
            seen: fakeSeen(),
            getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
            loadMissions: jest.fn().mockResolvedValue(undefined),
            spawnConsentRows: jest.fn().mockResolvedValue({ request: null, outcome: null }),
        };
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ title: "Check the bleed", contributor: { name: "bob", via: "user" } })}
                comments={[
                    trackerComment({
                        id: "cm_1",
                        author: "agent",
                        device_id: 0,
                        body: "Bleed is 3 mm on every page.",
                        contributor: { name: "bob", via: "agent" },
                        attribution: "bob's agent",
                    }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        expect(container.querySelector(".mj_TrackerContext .mj_TrackerContributor")?.textContent).toBe("Filed by bob");
        expect(container.querySelector(".mj_TrackerComment_author")?.textContent).toBe("bob's agent");
    });

    it("a mission page names a contributor's milestone and status, and a hand-over", async () => {
        const client = { getSnapshot: jest.fn().mockReturnValue({ trackerView: {} }) };
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({
                    mission: trackerMission({
                        num: 5,
                        title: "Cover editor",
                        state: "closed",
                        closed_at: 9,
                        status: "Export works.",
                        status_by: "agent",
                        status_updated_at: Date.now() - 60_000,
                        status_contributor: "bob",
                        handed_over: { to: "bob" },
                    }),
                    milestones: [milestone({ contributor: { name: "bob", via: "agent" } })],
                })}
                client={client as unknown as MatronJournalClient}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        expect(container.querySelector(".mj_TrackerMilestoneRow .mj_TrackerContributor")?.textContent).toBe(
            "by bob's agent",
        );
        expect(container.textContent).toContain("Status by bob");
        expect(container.querySelector(".mj_TrackerStateLabel")?.textContent).toBe("Handed to bob");
    });
});

describe("timeline markers", () => {
    it("a closed mission marker says who it was handed to", async () => {
        const { container } = await mount(
            <MissionNotice
                client={markerClient}
                event={event("mission", {
                    num: 4,
                    title: "Cover editor",
                    action: "closed",
                    handed_over: { to: "bob" },
                })}
            />,
        );
        expect(container.textContent).toContain("Mission #4 handed to bob · Cover editor");
    });

    it("a plain closed mission marker is unchanged", async () => {
        const { container } = await mount(
            <MissionNotice client={markerClient} event={event("mission", { num: 4, action: "closed" })} />,
        );
        expect(container.textContent).toContain("Mission #4 closed");
    });

    it("a contributor's milestone and reply name them", async () => {
        const milestoneCard = await mount(
            <MilestoneCard
                client={markerClient}
                event={event("milestone", {
                    num: 3,
                    mission_num: 4,
                    kind: "progress",
                    title: "Checked the export",
                    person: { name: "bob", via: "agent" },
                })}
            />,
        );
        expect(milestoneCard.container.querySelector(".mj_TrackerContributor")?.textContent).toBe(" · by bob's agent");

        const note = await mount(
            <ItemInlineNote
                client={markerClient}
                event={event("item", {
                    num: 12,
                    kind: "question",
                    title: "Which paper?",
                    action: "commented",
                    by: "agent",
                    person: { name: "bob", via: "user" },
                    comment: { body: "The matte one." },
                })}
            />,
        );
        expect(note.container.textContent).toContain("bob replied on #12");
    });
});
