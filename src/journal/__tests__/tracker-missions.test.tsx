/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import type { AgentRosterEntry, Milestone, MissionConversation, MissionItemRef } from "../types";
import { MILESTONE_PAGE, MissionConvoRow, MissionDetail, missionConvoTopic } from "../tracker/MissionDetail";
import { MissionsList } from "../tracker/MissionsList";
import { trackerItem, trackerMission, trackerMissionDetail, trackerProject } from "./tracker-fixtures";

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

function milestone(over: Partial<Milestone> = {}): Milestone {
    return {
        id: "ml_1",
        mission_id: "ms_1",
        num: 1,
        kind: "progress",
        title: "Landed the schema",
        body: "",
        convo_id: "c1",
        seq: 4,
        device_id: 1,
        created_by: "agent",
        created_at: 3,
        ...over,
    };
}

describe("MissionsList", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("splits missions into an Open section and a collapsible Closed section", async () => {
        const { container } = await mount(
            <MissionsList
                missions={[
                    trackerMission({ id: "ms_1", num: 1, state: "open" }),
                    trackerMission({ id: "ms_2", num: 2, state: "closed", closed_at: 9 }),
                ]}
                onOpenMission={jest.fn()}
            />,
        );

        const headers = Array.from(container.querySelectorAll(".mj_TrackerSection_header")).map((n) => n.textContent);
        expect(headers).toContain("Open");
        // The closed section is a toggle, collapsed by default → its row is not mounted.
        expect(container.querySelector(".mj_TrackerSection_toggle")?.textContent).toContain("Closed (1)");
        expect(container.querySelectorAll(".mj_TrackerMissionRow")).toHaveLength(1);
    });

    it("expands the closed section when the toggle is clicked", async () => {
        const { container } = await mount(
            <MissionsList
                missions={[
                    trackerMission({ id: "ms_1", num: 1, state: "open" }),
                    trackerMission({ id: "ms_2", num: 2, state: "closed", closed_at: 9 }),
                ]}
                onOpenMission={jest.fn()}
            />,
        );

        await act(async () => {
            container.querySelector<HTMLButtonElement>(".mj_TrackerSection_toggle")!.click();
        });

        expect(container.querySelectorAll(".mj_TrackerMissionRow")).toHaveLength(2);
    });

    it("shows the NeedsYou badge for a mission with items awaiting the user and hides it at zero", async () => {
        const withBadge = await mount(
            <MissionsList missions={[trackerMission({ needs_you: 3 })]} onOpenMission={jest.fn()} />,
        );
        const badge = withBadge.container.querySelector(".mj_TrackerNeedsYouBadge");
        expect(badge).not.toBeNull();
        expect(badge?.querySelector(".mj_TrackerNeedsYouBadge_count")?.textContent).toBe("3");

        const noBadge = await mount(
            <MissionsList missions={[trackerMission({ needs_you: 0 })]} onOpenMission={jest.fn()} />,
        );
        expect(noBadge.container.querySelector(".mj_TrackerNeedsYouBadge")).toBeNull();
    });

    it("shows the last milestone title, or a placeholder when there are none", async () => {
        const withMilestone = await mount(
            <MissionsList
                missions={[
                    trackerMission({
                        last_milestone: { num: 4, title: "Shipped the pane", kind: "progress", created_at: 5 },
                        last_milestone_at: 5,
                    }),
                ]}
                onOpenMission={jest.fn()}
            />,
        );
        expect(withMilestone.container.querySelector(".mj_TrackerMissionRow_milestone")?.textContent).toBe(
            "Shipped the pane",
        );

        const none = await mount(
            <MissionsList missions={[trackerMission({ last_milestone: null })]} onOpenMission={jest.fn()} />,
        );
        expect(none.container.querySelector(".mj_TrackerMissionRow_milestone")?.textContent).toBe("No milestones yet");
    });

    it("calls onOpenMission with the mission number when a row is clicked", async () => {
        const onOpenMission = jest.fn();
        const { container } = await mount(
            <MissionsList missions={[trackerMission({ num: 5, state: "open" })]} onOpenMission={onOpenMission} />,
        );

        await act(async () => {
            container.querySelector<HTMLButtonElement>(".mj_TrackerMissionRow")!.click();
        });

        expect(onOpenMission).toHaveBeenCalledWith(5);
    });

    it("renders an empty state when there are no missions", async () => {
        const { container } = await mount(<MissionsList missions={[]} onOpenMission={jest.fn()} />);
        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("No missions yet");
    });
});

describe("MissionDetail (smoke)", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("renders the header, milestones and the close-mission affordance for an open mission", async () => {
        const client = { getSnapshot: jest.fn().mockReturnValue({ trackerView: {} }) };
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({
                    mission: trackerMission({ num: 5, title: "Ship the tracker", state: "open" }),
                    milestones: [milestone({ title: "Landed the schema" })],
                })}
                client={client as unknown as MatronJournalClient}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );

        expect(container.querySelector(".mj_TrackerMissionHead_name")?.textContent).toBe("Ship the tracker");
        const headers = Array.from(container.querySelectorAll(".mj_TrackerSection_header")).map((n) => n.textContent);
        expect(headers).toContain("Milestones");
        expect(headers).toContain("Close mission");
        expect(container.querySelector(".mj_TrackerMilestoneRow_title")?.textContent).toContain("Landed the schema");
    });
});

describe("Mission conversation rows", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    const convo = (over: Partial<MissionConversation> = {}): MissionConversation => ({
        id: "c1",
        title: "[ab] Ship the tracker",
        state: "running",
        box: "maple",
        ...over,
    });
    const roster: AgentRosterEntry[] = [
        { device_id: 1, name: "maple", tag_char: "M" },
        { device_id: 2, name: "dev-z", tag_char: null },
    ];

    it("shows the [xx] short as the session tag, not as raw text", async () => {
        const { container } = await mount(<MissionConvoRow convo={convo()} agents={roster} />);
        const title = container.querySelector(".mj_TrackerConvoRow_title");
        expect(title?.textContent).toBe("M:ab Ship the tracker");
        expect(title?.querySelector(".mj_SessionTag_short")?.textContent).toBe("ab");
        expect(container.textContent).not.toContain("[ab]");
    });

    it("drops the raw short with a single box (no tag to show)", async () => {
        const { container } = await mount(<MissionConvoRow convo={convo()} agents={[roster[0]]} />);
        expect(container.querySelector(".mj_TrackerConvoRow_title")?.textContent).toBe("Ship the tracker");
        expect(container.querySelector(".mj_SessionTag")).toBeNull();
    });

    it("shows the generated topic as the main line, peeled of its [xx] short, with no second line", async () => {
        const { container } = await mount(
            <MissionConvoRow convo={convo({ auto_title: "[ab] fix the login redirect" })} agents={roster} />,
        );
        const title = container.querySelector(".mj_TrackerConvoRow_title");
        expect(title?.textContent).toBe("M:ab fix the login redirect");
        expect(title?.querySelector(".mj_SessionTag_short")?.textContent).toBe("ab");
        expect(container.textContent).not.toContain("Ship the tracker");
        expect(container.querySelector(".mj_TrackerConvoRow_subtitle")).toBeNull();
        // Box label and state stay.
        expect(container.querySelector(".mj_TrackerConvoRow_box")?.textContent).toBe("maple");
        expect(container.querySelector(".mj_TrackerConvoRow_state")?.textContent).toBe("running");
    });

    it("falls back to the title when auto_title is absent, null or blank", async () => {
        for (const auto_title of [undefined, null, "", "   "]) {
            const { container } = await mount(<MissionConvoRow convo={convo({ auto_title })} agents={roster} />);
            expect(container.querySelector(".mj_TrackerConvoRow_title")?.textContent).toBe("M:ab Ship the tracker");
            expect(container.querySelector(".mj_TrackerConvoRow_subtitle")).toBeNull();
        }
    });

    it("missionConvoTopic prefers the display form of auto_title, keeping a room marker", () => {
        expect(missionConvoTopic({ id: "c1", title: "[ab] Mission", auto_title: "🐣 [ab] child topic" })).toBe(
            "🐣 child topic",
        );
        expect(missionConvoTopic({ id: "c1", title: "[ab] Mission", auto_title: null })).toBe("Mission");
        expect(missionConvoTopic({ id: "c1", title: "plain" })).toBe("plain");
        expect(missionConvoTopic({ id: "c1", title: "" })).toBe("c1");
    });

    it("falls back to the id for an untitled conversation", async () => {
        const { container } = await mount(<MissionConvoRow convo={convo({ title: "" })} agents={roster} />);
        expect(container.querySelector(".mj_TrackerConvoRow_title")?.textContent).toBe("c1");
    });

    it("MissionDetail lists its conversations through the tagged row", async () => {
        const client = { getSnapshot: jest.fn().mockReturnValue({ trackerView: {} }) };
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({
                    conversations: [convo({ auto_title: "[ab] the topic" }), convo({ id: "c2", box: "dev-z" })],
                })}
                client={client as unknown as MatronJournalClient}
                agents={roster}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        const rows = container.querySelectorAll(".mj_TrackerConvoRow");
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector(".mj_TrackerConvoRow_title")?.textContent).toBe("M:ab the topic");
        expect(rows[0].querySelector(".mj_TrackerConvoRow_subtitle")).toBeNull();
        expect(rows[1].querySelector(".mj_TrackerConvoRow_title")?.textContent).toBe("D:ab Ship the tracker");
    });
});

describe("MissionDetail page (Mac parity)", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
    const ref = (over: Partial<MissionItemRef> = {}): MissionItemRef => ({
        id: "it_1",
        num: 1,
        kind: "task",
        state: "open",
        awaiting: "agent",
        title: "Write the docs",
        origin_convo_id: "c1",
        updated_at: 1,
        ...over,
    });
    const fakeClient = (over: Record<string, unknown> = {}): MatronJournalClient =>
        ({
            getSnapshot: jest.fn().mockReturnValue({ trackerView: {} }),
            openTrackerLink: jest.fn(),
            fetchMissionClosedItems: jest.fn().mockResolvedValue({ items: [], cursor: null }),
            ...over,
        }) as unknown as MatronJournalClient;
    const sectionHeaders = (container: HTMLElement): string[] =>
        Array.from(container.querySelectorAll(".mj_TrackerSection_header")).map((n) => n.textContent ?? "");

    it("shows the status card with its byline", async () => {
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({
                    mission: trackerMission({
                        status: "Waiting on **review**.",
                        status_by: "agent",
                        status_updated_at: NOW - 12 * 60_000,
                    }),
                })}
                client={fakeClient()}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
                now={NOW}
            />,
        );
        const card = container.querySelector(".mj_TrackerMissionStatus")!;
        expect(card.querySelector(".mj_TrackerMissionStatus_label")?.textContent).toBe("Status");
        expect(card.querySelector(".mj_TrackerMissionStatus_by")?.textContent).toBe("Updated 12m ago by an agent");
        expect(card.querySelector(".mj_TrackerMissionStatus_text")?.textContent).toContain("Waiting on review.");
        expect(card.querySelector("strong")?.textContent).toBe("review");
    });

    it("hides the status card when the mission has no status", async () => {
        for (const status of [undefined, null, "", "  "]) {
            const { container } = await mount(
                <MissionDetail
                    detail={trackerMissionDetail({ mission: trackerMission({ status }) })}
                    client={fakeClient()}
                    onOpenItem={jest.fn()}
                    onBack={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerMissionStatus")).toBeNull();
        }
    });

    it("reads Projects › project › #N, each ancestor crumb navigating", async () => {
        const onOpenRoot = jest.fn();
        const onOpenProject = jest.fn();
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({ mission: trackerMission({ num: 5, project_num: 7 }) })}
                client={fakeClient()}
                project={{ num: 7, title: "Docs site" }}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
                onOpenRoot={onOpenRoot}
                onOpenProject={onOpenProject}
            />,
        );
        const crumbs = Array.from(container.querySelectorAll(".mj_TrackerCrumbs .mj_TrackerCrumb"));
        expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["‹ Projects", "Docs site", "#5"]);
        expect(crumbs[2].getAttribute("aria-current")).toBe("page");
        expect(crumbs[2].tagName).not.toBe("BUTTON");
        await act(async () => (crumbs[0] as HTMLButtonElement).click());
        expect(onOpenRoot).toHaveBeenCalledTimes(1);
        await act(async () => (crumbs[1] as HTMLButtonElement).click());
        expect(onOpenProject).toHaveBeenCalledWith(7);
    });

    it("leaves the project crumb out when the project is not known", async () => {
        const onBack = jest.fn();
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail()}
                client={fakeClient()}
                rootLabel="Missions"
                onOpenItem={jest.fn()}
                onBack={onBack}
            />,
        );
        const crumbs = Array.from(container.querySelectorAll(".mj_TrackerCrumbs .mj_TrackerCrumb"));
        expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["‹ Missions", "#5"]);
        // Without its own target the first crumb goes back.
        await act(async () => (crumbs[0] as HTMLButtonElement).click());
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("splits open items into Needs you, then Open tasks & decisions", async () => {
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({
                    items: [
                        ref({ id: "a", num: 11, kind: "question", awaiting: "user", title: "Pick a name" }),
                        ref({ id: "b", num: 12, title: "Write the docs" }),
                        ref({ id: "c", num: 13, kind: "decision", awaiting: null, title: "Use the new API" }),
                    ],
                })}
                client={fakeClient()}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        const headers = sectionHeaders(container);
        expect(headers.indexOf("Needs you")).toBeGreaterThan(-1);
        expect(headers.indexOf("Needs you")).toBeLessThan(headers.indexOf("Open tasks & decisions"));
        const needs = container.querySelector(".mj_TrackerMissionNeedsYou")!;
        expect(Array.from(needs.querySelectorAll(".mj_TrackerMiniItem_title")).map((n) => n.textContent)).toEqual([
            "Pick a name",
        ]);
        const open = Array.from(container.querySelectorAll(".mj_TrackerSection")).find(
            (section) => section.querySelector("h2")?.textContent === "Open tasks & decisions",
        )!;
        expect(Array.from(open.querySelectorAll(".mj_TrackerMiniItem_title")).map((n) => n.textContent)).toEqual([
            "Write the docs",
            "Use the new API",
        ]);
    });

    it("drops Needs you when nothing waits on the user and says when nothing is open", async () => {
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail()}
                client={fakeClient()}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        expect(sectionHeaders(container)).not.toContain("Needs you");
        expect(container.textContent).toContain("Nothing open.");
    });

    it("pages milestones 20 at a time", async () => {
        const many = Array.from({ length: MILESTONE_PAGE * 2 + 5 }, (_, index) =>
            milestone({ id: `ml_${index}`, num: index + 1, title: `Step ${index + 1}` }),
        );
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({ milestones: many })}
                client={fakeClient()}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        const rows = (): number => container.querySelectorAll(".mj_TrackerMilestoneRow").length;
        const more = (): HTMLButtonElement | undefined =>
            Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
                button.textContent?.startsWith("Show more ("),
            );
        expect(rows()).toBe(MILESTONE_PAGE);
        expect(more()?.textContent).toBe(`Show more (${MILESTONE_PAGE + 5})`);
        await act(async () => more()!.click());
        expect(rows()).toBe(MILESTONE_PAGE * 2);
        await act(async () => more()!.click());
        expect(rows()).toBe(MILESTONE_PAGE * 2 + 5);
        expect(more()).toBeUndefined();
    });

    it("loads closed items on demand, a page at a time", async () => {
        const fetchMissionClosedItems = jest
            .fn()
            .mockResolvedValueOnce({
                items: [trackerItem({ id: "it_8", num: 8, kind: "task", state: "closed", resolution: "done" })],
                cursor: "k1",
            })
            .mockResolvedValueOnce({
                items: [
                    trackerItem({
                        id: "it_9",
                        num: 9,
                        kind: "question",
                        state: "closed",
                        resolution: "answered",
                        title: "Which colour?",
                    }),
                ],
                cursor: null,
            });
        const onOpenItem = jest.fn();
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail()}
                client={fakeClient({ fetchMissionClosedItems })}
                onOpenItem={onOpenItem}
                onBack={jest.fn()}
            />,
        );
        const closed = container.querySelector('[aria-label="Closed items"]')!;
        const button = (): HTMLButtonElement | null => closed.querySelector(".mj_TrackerShowMore");
        // Nothing is fetched until asked for.
        expect(fetchMissionClosedItems).not.toHaveBeenCalled();
        expect(button()?.textContent).toBe("Show closed items");

        await act(async () => button()!.click());
        expect(fetchMissionClosedItems).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ms_1" }), null, 50);
        expect(closed.querySelectorAll(".mj_TrackerMiniItem_closed")).toHaveLength(1);
        expect(closed.querySelector(".mj_TrackerMiniItem_status")?.textContent).toBe("Done");
        expect(button()?.textContent).toBe("Show more");

        await act(async () => button()!.click());
        expect(fetchMissionClosedItems).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ms_1" }), "k1", 50);
        const rows = closed.querySelectorAll<HTMLButtonElement>(".mj_TrackerMiniItem_closed");
        expect(rows).toHaveLength(2);
        expect(rows[1].querySelector(".mj_TrackerMiniItem_status")?.textContent).toBe("Answered");
        expect(button()).toBeNull();

        await act(async () => rows[1].click());
        expect(onOpenItem).toHaveBeenCalledWith(9);
    });

    it("says so when the mission has no closed items, and offers a retry on failure", async () => {
        const fetchMissionClosedItems = jest
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ items: [], cursor: null });
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail()}
                client={fakeClient({ fetchMissionClosedItems })}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        const closed = container.querySelector('[aria-label="Closed items"]')!;
        await act(async () => closed.querySelector<HTMLButtonElement>(".mj_TrackerShowMore")!.click());
        expect(closed.textContent).toContain("Couldn't load closed items.");
        expect(closed.querySelector(".mj_TrackerShowMore")?.textContent).toBe("Try again");
        await act(async () => closed.querySelector<HTMLButtonElement>(".mj_TrackerShowMore")!.click());
        expect(fetchMissionClosedItems).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ms_1" }), null, 50);
        expect(closed.textContent).toContain("No closed items.");
        expect(closed.querySelector(".mj_TrackerShowMore")).toBeNull();
    });

    it("keeps Show more when a bounded walk found nothing yet", async () => {
        const fetchMissionClosedItems = jest.fn().mockResolvedValue({ items: [], cursor: "more" });
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail()}
                client={fakeClient({ fetchMissionClosedItems })}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        const closed = container.querySelector('[aria-label="Closed items"]')!;
        await act(async () => closed.querySelector<HTMLButtonElement>(".mj_TrackerShowMore")!.click());
        expect(closed.textContent).toContain("None found yet.");
        expect(closed.querySelector(".mj_TrackerShowMore")?.textContent).toBe("Show more");
    });
});

describe("MissionDetail move to project", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
        document.body.innerHTML = "";
    });

    const project = (id: string, title: string, state: "open" | "closed" = "open") =>
        trackerProject({ id, num: Number(id.slice(3)), title, state });

    it("moves an open mission to another open project from its header", async () => {
        const moveTrackerMission = jest.fn().mockResolvedValue(null);
        const client = { getSnapshot: jest.fn().mockReturnValue({ trackerView: {} }), moveTrackerMission };
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({ mission: trackerMission({ id: "ms_1", project_id: "pj_1" }) })}
                client={client as unknown as MatronJournalClient}
                projects={[project("pj_1", "Home"), project("pj_2", "Away"), project("pj_3", "Gone", "closed")]}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        const move = container.querySelector<HTMLButtonElement>(".mj_TrackerMissionHead_move")!;
        expect(move.textContent).toBe("Move to project…");
        await act(async () => move.click());
        const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="listitem"]'));
        expect(rows.map((row) => row.textContent)).toEqual(["Home", "Away"]);
        expect(rows[0].disabled).toBe(true);
        await act(async () => rows[1].click());
        expect(moveTrackerMission).toHaveBeenCalledWith("ms_1", "pj_2");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("offers no move on a closed mission or with nowhere else to go", async () => {
        const client = { getSnapshot: jest.fn().mockReturnValue({ trackerView: {} }) };
        const { container } = await mount(
            <MissionDetail
                detail={trackerMissionDetail({
                    mission: trackerMission({ state: "closed", project_id: "pj_1" }),
                })}
                client={client as unknown as MatronJournalClient}
                projects={[project("pj_1", "Home"), project("pj_2", "Away")]}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        expect(container.querySelector(".mj_TrackerMissionHead_move")).toBeNull();
        document.body.innerHTML = "";
        const second = await mount(
            <MissionDetail
                detail={trackerMissionDetail({ mission: trackerMission({ project_id: "pj_1" }) })}
                client={client as unknown as MatronJournalClient}
                projects={[project("pj_1", "Home")]}
                onOpenItem={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        expect(second.container.querySelector(".mj_TrackerMissionHead_move")).toBeNull();
    });
});
