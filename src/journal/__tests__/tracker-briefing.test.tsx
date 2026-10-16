/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import { parseMatronHref } from "../markdown";
import { BriefingDetail, briefingPreviewLines, LatestBriefingCard } from "../tracker/BriefingCard";
import { TrackerPane } from "../tracker/TrackerPane";
import { trackerProject, trackerProjectDetail } from "./tracker-fixtures";
import type { Briefing, BriefingLatest, BriefingState, ClientState } from "../types";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const MIN = 60_000;

function briefing(over: Partial<Briefing> = {}): Briefing {
    return {
        id: "br_1",
        body: "# Morning sweep\n\n**Three** sessions are running; see [the deploy](matron://convo/c_deploy).\n\nThird line.",
        created_at: NOW - 5 * MIN,
        convo_id: "c_coord",
        seq: 42,
        ...over,
    };
}

function latest(over: Partial<BriefingLatest> = {}): BriefingLatest {
    return { briefing: briefing(), refresh: null, next_refresh_at: null, has_coordinator: true, ...over };
}

function state(over: Partial<BriefingState> = {}, latestOver: Partial<BriefingLatest> = {}): BriefingState {
    return { loading: false, unsupported: false, latest: latest(latestOver), ...over };
}

interface FakeClient {
    openBriefing: jest.Mock;
    closeBriefing: jest.Mock;
    openBriefingInChat: jest.Mock;
    requestBriefingRefresh: jest.Mock;
    openTrackerLink: jest.Mock;
    loadBriefing: jest.Mock;
    loadMissions: jest.Mock;
    loadProjects: jest.Mock;
    loadProject: jest.Mock;
    openTrackerProject: jest.Mock;
    loadInbox: jest.Mock;
    loadMission: jest.Mock;
    loadItem: jest.Mock;
    openTrackerView: jest.Mock;
    openTrackerMission: jest.Mock;
    closeTrackerView: jest.Mock;
    getSnapshot: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        openBriefing: jest.fn(),
        closeBriefing: jest.fn(),
        openBriefingInChat: jest.fn(),
        requestBriefingRefresh: jest.fn().mockResolvedValue(true),
        openTrackerLink: jest.fn(),
        loadBriefing: jest.fn().mockResolvedValue(undefined),
        loadMissions: jest.fn().mockResolvedValue(undefined),
        loadProjects: jest.fn().mockResolvedValue(undefined),
        loadProject: jest.fn().mockResolvedValue(undefined),
        openTrackerProject: jest.fn(),
        loadInbox: jest.fn().mockResolvedValue(undefined),
        loadMission: jest.fn().mockResolvedValue(undefined),
        loadItem: jest.fn().mockResolvedValue(undefined),
        openTrackerView: jest.fn(),
        openTrackerMission: jest.fn(),
        closeTrackerView: jest.fn(),
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
    };
}

const asClient = (client: FakeClient): MatronJournalClient => client as unknown as MatronJournalClient;

let mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(element);
    });
    mounted.push({ root, container });
    return { container, root };
}

const refreshButton = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Ask the Coordinator for a new briefing"]');

describe("LatestBriefingCard", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
    });

    afterEach(async () => {
        for (const { root, container } of mounted) {
            await act(async () => root.unmount());
            container.remove();
        }
        mounted = [];
        jest.useRealTimers();
    });

    it("shows the title with the relative time and a two-line plain-text preview", async () => {
        const { container } = await mount(<LatestBriefingCard client={asClient(fakeClient())} briefing={state()} />);

        expect(container.querySelector(".mj_BriefingCard_title")?.textContent).toBe("Latest briefing · 5m ago");
        const preview = Array.from(container.querySelectorAll(".mj_BriefingCard_preview")).map((n) => n.textContent);
        expect(preview).toEqual(["Morning sweep", "Three sessions are running; see the deploy."]);
        const button = refreshButton(container);
        expect(button).not.toBeNull();
        expect(button!.disabled).toBe(false);
    });

    it("ticks the relative time every minute", async () => {
        const { container } = await mount(<LatestBriefingCard client={asClient(fakeClient())} briefing={state()} />);

        // One minute per act: each tick re-arms the next timer after React re-renders.
        for (let i = 0; i < 2; i += 1) {
            await act(async () => {
                jest.advanceTimersByTime(MIN);
            });
        }
        expect(container.querySelector(".mj_BriefingCard_title")?.textContent).toBe("Latest briefing · 7m ago");
    });

    it("opens the full briefing on click and asks for a refresh from the ↻ button", async () => {
        const client = fakeClient();
        const { container } = await mount(<LatestBriefingCard client={asClient(client)} briefing={state()} />);

        await act(async () => container.querySelector<HTMLButtonElement>(".mj_BriefingCard_open")!.click());
        expect(client.openBriefing).toHaveBeenCalledTimes(1);
        expect(client.requestBriefingRefresh).not.toHaveBeenCalled();

        await act(async () => refreshButton(container)!.click());
        expect(client.requestBriefingRefresh).toHaveBeenCalledTimes(1);
        expect(client.openBriefing).toHaveBeenCalledTimes(1);
    });

    it("is hidden on a journal without briefings, without a Coordinator, and before the first load", async () => {
        for (const hidden of [
            undefined,
            { loading: true, unsupported: false },
            state({ unsupported: true }),
            state({}, { has_coordinator: false }),
        ] as Array<BriefingState | undefined>) {
            const { container } = await mount(<LatestBriefingCard client={asClient(fakeClient())} briefing={hidden} />);
            expect(container.innerHTML).toBe("");
        }
    });

    it("says a failed first load failed and retries it, instead of vanishing", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <LatestBriefingCard
                client={asClient(client)}
                briefing={{ loading: false, unsupported: false, error: "offline" }}
            />,
        );
        expect(container.textContent).toContain("Couldn't load the latest briefing.");
        const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Try again")!;
        await act(async () => retry.click());
        expect(client.loadBriefing).toHaveBeenCalledTimes(1);
    });

    it("keeps the load error up, its retry disabled, while the retry is in flight", async () => {
        const { container } = await mount(
            <LatestBriefingCard
                client={asClient(fakeClient())}
                briefing={{ loading: true, unsupported: false, error: "offline" }}
            />,
        );
        expect(container.textContent).toContain("Couldn't load the latest briefing.");
        const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Trying…");
        expect(retry?.disabled).toBe(true);
    });

    it("shows a spinner and disables the button while a refresh is pending", async () => {
        const { container } = await mount(
            <LatestBriefingCard
                client={asClient(fakeClient())}
                briefing={state(
                    {},
                    {
                        refresh: { requested_at: NOW - MIN, state: "pending", expires_at: NOW + 9 * MIN },
                        next_refresh_at: NOW + 9 * MIN,
                    },
                )}
            />,
        );

        expect(container.querySelector(".mj_BriefingCard_spinner")).not.toBeNull();
        expect(container.querySelector(".mj_BriefingCard_status")?.textContent).toBe("Refreshing…");
        expect(refreshButton(container)!.disabled).toBe(true);
    });

    it("stops saying Refreshing… once a pending refresh's expires_at passes", async () => {
        const { container } = await mount(
            <LatestBriefingCard
                client={asClient(fakeClient())}
                briefing={state(
                    {},
                    {
                        refresh: { requested_at: NOW - 9 * MIN, state: "pending", expires_at: NOW + 10_000 },
                        next_refresh_at: NOW + 10_000,
                    },
                )}
            />,
        );
        expect(container.textContent).toContain("Refreshing…");

        await act(async () => {
            jest.advanceTimersByTime(11_000);
        });
        expect(container.textContent).not.toContain("Refreshing…");
        expect(container.textContent).toContain("The Coordinator hasn't answered. Try again.");
        expect(refreshButton(container)!.disabled).toBe(false);
    });

    it.each(["failed", "timed_out"] as const)("says the Coordinator hasn't answered when the refresh %s", async (s) => {
        const { container } = await mount(
            <LatestBriefingCard
                client={asClient(fakeClient())}
                briefing={state({}, { refresh: { requested_at: NOW - 20 * MIN, state: s } })}
            />,
        );

        expect(container.querySelector("[role=alert]")?.textContent).toBe(
            "The Coordinator hasn't answered. Try again.",
        );
        expect(refreshButton(container)!.disabled).toBe(false);
    });

    it("disables the button with a tooltip while next_refresh_at is in the future", async () => {
        const { container } = await mount(
            <LatestBriefingCard
                client={asClient(fakeClient())}
                briefing={state({}, { next_refresh_at: NOW + 90_000 })}
            />,
        );

        const button = refreshButton(container)!;
        expect(button.disabled).toBe(true);
        expect(button.title).toBe("You can ask again in 2 min");

        await act(async () => {
            jest.advanceTimersByTime(MIN);
        });
        expect(refreshButton(container)!.disabled).toBe(true);
        await act(async () => {
            jest.advanceTimersByTime(31_000);
        });
        expect(refreshButton(container)!.disabled).toBe(false);
    });

    it("says when to try again after a 429", async () => {
        const { container } = await mount(
            <LatestBriefingCard client={asClient(fakeClient())} briefing={state({ retryAt: NOW + 3 * MIN - 1_000 })} />,
        );

        expect(container.querySelector(".mj_BriefingCard_status")?.textContent).toBe("Try again in 3 min");
        expect(refreshButton(container)!.disabled).toBe(true);
    });

    it("shows a refused ask's message", async () => {
        const { container } = await mount(
            <LatestBriefingCard
                client={asClient(fakeClient())}
                briefing={state({ refreshError: "The Coordinator is busy. Try again in a moment." })}
            />,
        );

        expect(container.querySelector("[role=alert]")?.textContent).toBe(
            "The Coordinator is busy. Try again in a moment.",
        );
    });

    it("offers to ask for one when there is no briefing yet", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <LatestBriefingCard client={asClient(client)} briefing={state({}, { briefing: null })} />,
        );

        expect(container.textContent).toContain("No briefing yet");
        const ask = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Ask for one");
        expect(ask).toBeDefined();
        await act(async () => ask!.click());
        expect(client.requestBriefingRefresh).toHaveBeenCalledTimes(1);
    });
});

describe("briefing preview + links", () => {
    it("reduces the markdown to its first two non-blank plain-text lines", () => {
        expect(briefingPreviewLines("## Status\n\n- one_two **bold**\n- [x](https://x.example)\n\nmore")).toEqual([
            "Status",
            "one_two bold",
        ]);
    });

    it("parses conversation and project deep links, and rejects malformed ones", () => {
        expect(parseMatronHref("matron://convo/room:codex:review-1")).toEqual({
            kind: "convo",
            target: "room:codex:review-1",
        });
        expect(parseMatronHref("matron://convo/c%5F1")).toEqual({ kind: "convo", target: "c_1" });
        expect(parseMatronHref("matron://project/3")).toEqual({ kind: "project", target: 3 });
        expect(parseMatronHref("matron://item/7")).toEqual({ kind: "item", target: 7 });
        expect(parseMatronHref("matron://convo/")).toBeNull();
        expect(parseMatronHref("matron://convo/a/b")).toBeNull();
        expect(parseMatronHref("matron://convo/a?x=1")).toBeNull();
        expect(parseMatronHref("matron://convo/a%2Fb")).toBeNull();
        expect(parseMatronHref("matron://project/0")).toBeNull();
    });
});

describe("BriefingDetail and the Projects dashboard", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        for (const { root, container } of mounted) {
            await act(async () => root.unmount());
            container.remove();
        }
        mounted = [];
    });

    it("renders the markdown with working matron:// links and opens the conversation on the briefing", async () => {
        const client = fakeClient();
        const body =
            "See [the deploy](matron://convo/c_deploy), [#5](matron://mission/5), " +
            "[the project](matron://project/2) and [#7](matron://item/7).";
        const { container } = await mount(
            <BriefingDetail briefing={briefing({ body })} client={asClient(client)} onBack={jest.fn()} />,
        );

        const links = Array.from(container.querySelectorAll<HTMLAnchorElement>(".mj_TrackerProse a"));
        expect(links.map((a) => a.getAttribute("href"))).toEqual([
            "matron://convo/c_deploy",
            "matron://mission/5",
            "matron://project/2",
            "matron://item/7",
        ]);
        for (const link of links) {
            await act(async () => link.click());
        }
        expect(client.openTrackerLink.mock.calls).toEqual([
            ["convo", "c_deploy"],
            ["mission", 5],
            ["project", 2],
            ["item", 7],
        ]);

        expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(NOW - 5 * MIN).toISOString());
        const open = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Open in chat");
        await act(async () => open!.click());
        expect(client.openBriefingInChat).toHaveBeenCalledWith("c_coord", 42);
    });

    it("heads the projects dashboard with the card and loads the briefing when the tab shows", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={asClient(client)}
                state={
                    {
                        trackerView: { open: true, view: "missions" },
                        projects: [trackerProject({ num: 6, title: "Launch" })],
                        missions: [],
                        briefing: state(),
                    } as unknown as ClientState
                }
            />,
        );

        expect(client.loadBriefing).toHaveBeenCalledTimes(1);
        expect(client.loadProjects).toHaveBeenCalledTimes(1);
        const dashboard = container.querySelector(".mj_ProjectsDashboard")!;
        expect(dashboard).not.toBeNull();
        // The card is the dashboard's first child, above the grid of project cards.
        expect(dashboard.firstElementChild?.querySelector(".mj_BriefingCard")).not.toBeNull();
        expect(dashboard.querySelector(".mj_ProjectsGrid .mj_ProjectCard")?.textContent).toContain("Launch");
        const cards = Array.from(dashboard.querySelectorAll(".mj_BriefingCard, .mj_ProjectCard"));
        expect(cards[0]?.classList.contains("mj_BriefingCard")).toBe(true);
    });

    it("heads an empty projects dashboard, and a dashboard still loading, with the card", async () => {
        const client = fakeClient();
        const { container, root } = await mount(
            <TrackerPane
                client={asClient(client)}
                state={
                    {
                        trackerView: { open: true, view: "missions" },
                        projects: [],
                        missions: [],
                        briefing: state(),
                    } as unknown as ClientState
                }
            />,
        );
        expect(container.querySelector(".mj_ProjectsDashboard .mj_BriefingCard")).not.toBeNull();
        expect(container.textContent).toContain("No projects yet");

        await act(async () =>
            root.render(
                <TrackerPane
                    client={asClient(client)}
                    state={
                        {
                            trackerView: { open: true, view: "missions" },
                            briefing: state(),
                        } as unknown as ClientState
                    }
                />,
            ),
        );
        const body = container.querySelector(".mj_TrackerPane_body")!;
        expect(body.firstElementChild?.querySelector(".mj_BriefingCard")).not.toBeNull();
        expect(body.textContent).toContain("Loading…");
    });

    it("leaves the card off a project page, and reloads the briefing on returning to the dashboard", async () => {
        const client = fakeClient();
        const pane = (selectedProjectId?: number): React.ReactElement => (
            <TrackerPane
                client={asClient(client)}
                state={
                    {
                        trackerView: { open: true, view: "missions", selectedProjectId },
                        projects: [trackerProject({ num: 6 })],
                        trackerProject: trackerProjectDetail({ project: trackerProject({ num: 6, title: "Launch" }) }),
                        missions: [],
                        briefing: state(),
                    } as unknown as ClientState
                }
            />
        );
        const { container, root } = await mount(pane(6));
        expect(container.querySelector(".mj_ProjectPage")).not.toBeNull();
        expect(container.querySelector(".mj_BriefingCard")).toBeNull();
        expect(client.loadBriefing).not.toHaveBeenCalled();

        await act(async () => root.render(pane(undefined)));
        expect(container.querySelector(".mj_ProjectsDashboard .mj_BriefingCard")).not.toBeNull();
        expect(client.loadBriefing).toHaveBeenCalledTimes(1);
    });

    it("does not load the briefing on the inbox tab", async () => {
        const client = fakeClient();
        await mount(
            <TrackerPane
                client={asClient(client)}
                state={{ trackerView: { open: true, view: "inbox" }, inboxItems: [] } as unknown as ClientState}
            />,
        );
        expect(client.loadBriefing).not.toHaveBeenCalled();
    });

    it("shows the open briefing in full in place of the list, and goes back with closeBriefing", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={asClient(client)}
                state={
                    {
                        trackerView: { open: true, view: "missions", briefingOpen: true },
                        missions: [],
                        briefing: state(),
                    } as unknown as ClientState
                }
            />,
        );

        expect(container.querySelector(".mj_BriefingCard")).toBeNull();
        expect(container.querySelector(".mj_ProjectsDashboard")).toBeNull();
        expect(container.querySelector(".mj_TrackerMissionHead_name")?.textContent).toBe("Briefing");
        const back = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "‹ Projects");
        await act(async () => back!.click());
        expect(client.closeBriefing).toHaveBeenCalledTimes(1);
    });

    it("a matron://project link in the open briefing opens that project's page", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={asClient(client)}
                state={
                    {
                        trackerView: { open: true, view: "missions", briefingOpen: true },
                        projects: [],
                        missions: [],
                        briefing: state({}, { briefing: briefing({ body: "See [Launch](matron://project/6)." }) }),
                    } as unknown as ClientState
                }
            />,
        );
        const link = container.querySelector<HTMLAnchorElement>('a[href="matron://project/6"]')!;
        await act(async () => link.click());
        expect(client.openTrackerLink).toHaveBeenCalledWith("project", 6);
    });
});
