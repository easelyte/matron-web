/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import type { ClientState } from "../types";
import { TrackerPane } from "../tracker/TrackerPane";
import {
    fakeSeen,
    type FakeSeen,
    trackerItem,
    trackerMission,
    trackerMissionDetail,
    trackerProject,
    trackerProjectDetail,
} from "./tracker-fixtures";

interface FakeClient {
    seen: FakeSeen;
    loadMissions: jest.Mock;
    loadInbox: jest.Mock;
    loadItem: jest.Mock;
    loadMission: jest.Mock;
    loadBriefing: jest.Mock;
    closeTrackerView: jest.Mock;
    openTrackerView: jest.Mock;
    openTrackerItem: jest.Mock;
    openTrackerMission: jest.Mock;
    openTrackerLoop: jest.Mock;
    openTrackerLink: jest.Mock;
    work: jest.Mock;
    loadProjects: jest.Mock;
    loadProject: jest.Mock;
    openTrackerProject: jest.Mock;
    getSnapshot: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        seen: fakeSeen(),
        loadMissions: jest.fn().mockResolvedValue(undefined),
        loadInbox: jest.fn().mockResolvedValue(undefined),
        loadItem: jest.fn().mockResolvedValue(undefined),
        loadMission: jest.fn().mockResolvedValue(undefined),
        loadBriefing: jest.fn().mockResolvedValue(undefined),
        closeTrackerView: jest.fn(),
        openTrackerView: jest.fn(),
        openTrackerItem: jest.fn(),
        openTrackerMission: jest.fn(),
        openTrackerLoop: jest.fn(),
        openTrackerLink: jest.fn(),
        work: jest.fn().mockResolvedValue({
            schema_version: 1,
            status: "empty",
            group_by: "repo",
            groups: [],
        }),
        loadProjects: jest.fn().mockResolvedValue(undefined),
        loadProject: jest.fn().mockResolvedValue(undefined),
        openTrackerProject: jest.fn(),
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
    };
}

function paneState(over: Partial<ClientState>): ClientState {
    return over as unknown as ClientState;
}

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

describe("TrackerPane", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("does NOT render a cached item detail whose num differs from the current selection", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                // Selection moved to #9 but the store still holds #7's detail (mid-load). The stale
                // record must not drive ItemDetail — its reply/close handlers would target #7.
                state={paneState({
                    trackerView: { open: true, view: "inbox", selectedItemId: 9 },
                    trackerItem: { item: trackerItem({ num: 7 }), comments: [] },
                    inboxItems: [],
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerComposer")).toBeNull();
        expect(container.querySelector(".mj_TrackerInboxToggle")).not.toBeNull();
    });

    it("renders the item detail once the cached record matches the current selection", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox", selectedItemId: 7 },
                    trackerItem: { item: trackerItem({ num: 7 }), comments: [] },
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerComposer")).not.toBeNull();
    });

    it("does NOT render a cached mission detail whose num differs from the current selection", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    // Selection moved to #8 but the store still holds #5's mission detail.
                    trackerView: { open: true, view: "missions", selectedMissionId: 8 },
                    trackerMission: trackerMissionDetail(),
                })}
            />,
        );

        // Falls through to the missions list, not the (stale #5) mission detail head.
        expect(container.querySelector(".mj_TrackerMissionHead")).toBeNull();
    });

    it("renders Work as a third tracker surface", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "work" } })}
            />,
        );

        const workTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".mj_TrackerViewSwitch_tab")).find(
            (button) => button.textContent === "Work",
        );
        expect(workTab?.getAttribute("aria-selected")).toBe("true");
        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("No open work");
        expect(client.work).toHaveBeenCalledWith("repo", expect.any(AbortSignal));
    });
});

describe("TrackerPane — Work loop selection", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    const payload = {
        schema_version: 1,
        status: "ok",
        group_by: "repo",
        groups: [
            {
                key: "matron-web",
                loops: [
                    {
                        id: 31,
                        title: "Loop detail",
                        repo: "matron-web",
                        domain: "infra",
                        priority: 3,
                        description: "Lead.",
                        status: "active",
                        claim: null,
                    },
                ],
            },
        ],
    };

    it("routes a row tap through the client and renders the selected loop's detail from the store", async () => {
        const client = fakeClient();
        client.work.mockResolvedValue(payload);
        const { container, root } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "work" } })}
            />,
        );
        await act(async () => container.querySelector<HTMLButtonElement>('[data-loop-id="31"]')!.click());
        expect(client.openTrackerLoop).toHaveBeenCalledWith(31);

        await act(async () =>
            root.render(
                <TrackerPane
                    client={client as unknown as MatronJournalClient}
                    state={paneState({ trackerView: { open: true, view: "work", selectedLoopId: 31 } })}
                />,
            ),
        );
        expect(container.querySelector("h1.mj_TrackerItemTitle")?.textContent).toBe("Loop detail");
        // Same mounted Work view: the selection change did not refetch.
        expect(client.work).toHaveBeenCalledTimes(1);

        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Back to work"]')!.click());
        expect(client.openTrackerLoop).toHaveBeenCalledWith(null);
        await act(async () => root.unmount());
    });
});

describe("TrackerPane — Work tab isolation", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("does not prime missions or the paginated inbox while Work is the active tab", async () => {
        // Work is served by a different endpoint and shares none of this state.
        // Priming would fetch /missions and walk /items (up to 20 pages / 10,000
        // items) purely as a side effect of opening a tab that never reads them.
        const client = fakeClient();
        await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "work" } })}
            />,
        );

        expect(client.loadMissions).not.toHaveBeenCalled();
        expect(client.loadInbox).not.toHaveBeenCalled();
        expect(client.work).toHaveBeenCalled();
    });

    it("still primes both list views on the tabs that actually use them", async () => {
        // The backpressure above must not cost the inbox/missions tabs their
        // warm badges.
        const client = fakeClient();
        await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "inbox" } })}
            />,
        );

        expect(client.loadMissions).toHaveBeenCalled();
        expect(client.loadInbox).toHaveBeenCalled();
    });

    it("does not show a missions/inbox error banner over a healthy Work view", async () => {
        // trackerError belongs to missions/inbox. Work fails loud inline, so this
        // banner would attribute an unrelated tab's failure to Work and make a
        // working pane look degraded.
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "work" },
                    trackerError: "Could not load the inbox.",
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerErrorBanner")).toBeNull();
    });

    it("still shows the error banner on the tabs the error belongs to", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox" },
                    trackerError: "Could not load the inbox.",
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerErrorBanner")).not.toBeNull();
    });
});

describe("TrackerPane inbox", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    // Before the first load lands, an empty list would read as a false "Nothing needs you".
    it("shows a loading status, not an empty inbox, before the first inbox load lands", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "inbox" }, trackerLoading: true })}
            />,
        );

        expect(container.querySelector(".mj_TrackerPane_body [role=status]")?.textContent).toBe("Loading…");
        expect(container.textContent).not.toContain("Nothing needs you");
    });

    it("says the inbox failed and offers a retry when its first load fails", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "inbox" }, inboxError: "offline" })}
            />,
        );

        const status = container.querySelector(".mj_TrackerPane_body [role=status]");
        expect(status?.textContent).toContain("Couldn't load the inbox");
        expect(container.textContent).not.toContain("Nothing needs you");

        client.loadInbox.mockClear();
        await act(async () => {
            status!.querySelector<HTMLButtonElement>("button")!.click();
        });
        expect(client.loadInbox).toHaveBeenCalledTimes(1);
    });

    // A failed REFRESH keeps the loaded list; its own error outlives the shared banner (which any
    // other tracker load clears), so the pane must not present the retained list as current.
    it("marks a loaded inbox whose refresh failed as possibly out of date, with a retry", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "inbox" }, inboxItems: [], inboxError: "offline" })}
            />,
        );

        const notice = container.querySelector(".mj_TrackerStaleNotice");
        expect(notice?.textContent).toContain("Couldn't refresh the inbox, so it may be out of date.");
        client.loadInbox.mockClear();
        await act(async () => {
            notice!.querySelector<HTMLButtonElement>("button")!.click();
        });
        expect(client.loadInbox).toHaveBeenCalledTimes(1);
    });

    it("shows no stale notice for a loaded inbox without an inbox error", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox" },
                    inboxItems: [],
                    trackerError: "item gone",
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerStaleNotice")).toBeNull();
    });

    // The shared banner error can come from (and be cleared by) an item load; it must not stand in
    // for the inbox's own state.
    it("keeps showing loading when only another tracker load has failed", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "inbox" }, trackerError: "item gone" })}
            />,
        );

        expect(container.querySelector("[role=alert]")?.textContent).toBe("item gone");
        expect(container.querySelector(".mj_TrackerPane_body [role=status]")?.textContent).toBe("Loading…");
    });

    it("shows a loading status, not an empty projects dashboard, before the first projects load lands", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "missions" }, inboxItems: [] })}
            />,
        );

        expect(container.querySelector(".mj_TrackerPane_body [role=status]")?.textContent).toBe("Loading…");
        expect(container.textContent).not.toContain("No projects yet");
    });

    it("says the projects dashboard failed and offers a retry when its first load fails", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "missions" }, projectsError: "offline" })}
            />,
        );

        const status = container.querySelector(".mj_TrackerPane_body [role=status]");
        expect(status?.textContent).toContain("Couldn't load projects");
        client.loadProjects.mockClear();
        await act(async () => {
            status!.querySelector<HTMLButtonElement>("button")!.click();
        });
        expect(client.loadProjects).toHaveBeenCalledTimes(1);
    });

    it("labels the first tab Projects, shows the dashboard and opens a project page", async () => {
        const client = fakeClient();
        const { container, root } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions" },
                    projects: [trackerProject()],
                    missions: [],
                })}
            />,
        );
        expect(container.querySelector(".mj_TrackerViewSwitch_tab")?.textContent).toBe("Projects");
        expect(client.loadProjects).toHaveBeenCalled();
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_ProjectCard")!.click());
        expect(client.openTrackerProject).toHaveBeenCalledWith(2645);
        await act(async () =>
            root.render(
                <TrackerPane
                    client={client as unknown as MatronJournalClient}
                    state={paneState({
                        trackerView: { open: true, view: "missions", selectedProjectId: 2645 },
                        projects: [trackerProject()],
                        trackerProject: trackerProjectDetail(),
                    })}
                />,
            ),
        );
        expect(client.loadProject).toHaveBeenCalledWith(2645);
        expect(container.querySelector(".mj_ProjectPage_title")?.textContent).toBe("Web/Mac design unification");
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_ProjectMission")!.click());
        expect(client.openTrackerView).toHaveBeenCalledWith({ view: "missions", missionId: 1706 });
    });

    it("falls back to the missions list on a journal without projects", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions" },
                    projectsUnsupported: true,
                    missions: [],
                })}
            />,
        );
        expect(container.querySelector(".mj_ProjectsDashboard")).toBeNull();
        expect(container.querySelector(".mj_TrackerViewSwitch_tab")?.textContent).toBe("Missions");
    });

    it("offers a retry when the selected project fails to load, independent of the list", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645 },
                    projects: [trackerProject()],
                    projectLoadError: { id: "2645", message: "boom" },
                })}
            />,
        );
        expect(container.textContent).toContain("Couldn't load this project");
    });

    it("reloads the project list when returning to the dashboard", async () => {
        const client = fakeClient();
        const { root } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645 },
                    projects: [trackerProject()],
                })}
            />,
        );
        client.loadProjects.mockClear();
        await act(async () =>
            root.render(
                <TrackerPane
                    client={client as unknown as MatronJournalClient}
                    state={paneState({ trackerView: { open: true, view: "missions" }, projects: [trackerProject()] })}
                />,
            ),
        );
        expect(client.loadProjects).toHaveBeenCalledTimes(1);
    });

    it("returns from a mission to its project", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645, selectedMissionId: 5 },
                    projects: [trackerProject()],
                    trackerMission: trackerMissionDetail(),
                })}
            />,
        );
        // The breadcrumb's project crumb.
        const back = [...container.querySelectorAll<HTMLButtonElement>(".mj_TrackerCrumb")].find(
            (button) => button.textContent === trackerProject().title,
        )!;
        client.loadProject.mockClear();
        await act(async () => back.click());
        expect(client.openTrackerProject).toHaveBeenCalledWith(2645);
        // Same project id, so the pane's selection effect cannot reload it: back reloads explicitly,
        // or a mission just closed would still read as open on the project page.
        expect(client.loadProject).toHaveBeenLastCalledWith(2645);
    });

    it("names the mission's own project in the breadcrumb and opens it", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedMissionId: 5 },
                    projects: [trackerProject({ num: 31, title: "Docs site" }), trackerProject()],
                    trackerMission: trackerMissionDetail({ mission: trackerMission({ project_num: 31 }) }),
                })}
            />,
        );
        const crumbs = [...container.querySelectorAll<HTMLButtonElement>("button.mj_TrackerCrumb")];
        expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["‹ Projects", "Docs site"]);
        await act(async () => crumbs[1].click());
        expect(client.openTrackerProject).toHaveBeenCalledWith(31);
        expect(client.loadProject).toHaveBeenLastCalledWith(31);
    });

    it("opens the Projects dashboard from the first crumb", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645, selectedMissionId: 5 },
                    projects: [trackerProject()],
                    trackerMission: trackerMissionDetail(),
                })}
            />,
        );
        await act(async () => container.querySelector<HTMLButtonElement>("button.mj_TrackerCrumb")!.click());
        expect(client.openTrackerView).toHaveBeenCalledWith({
            view: "missions",
            itemId: null,
            missionId: null,
            loopId: null,
            memoryName: null,
            projectId: null,
        });
    });

    it("loads the projects when the mission's project is not known yet", async () => {
        const client = fakeClient();
        // Opened from another project's page, so the dashboard's own load does not run.
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645, selectedMissionId: 5 },
                    trackerMission: trackerMissionDetail({ mission: trackerMission({ project_num: 31 }) }),
                })}
            />,
        );
        expect(client.loadProjects).toHaveBeenCalledTimes(1);
        const crumbs = [...container.querySelectorAll(".mj_TrackerCrumb")].map((crumb) => crumb.textContent);
        expect(crumbs).toEqual(["‹ Projects", "#5"]);
    });

    it("leaves the project page while a mission opened from it is still loading", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645, selectedMissionId: 5 },
                    projects: [trackerProject()],
                    trackerProject: trackerProjectDetail(),
                    trackerMission: null,
                })}
            />,
        );
        expect(container.querySelector(".mj_ProjectPage")).toBeNull();
        expect(container.querySelector(".mj_TrackerPane_body [role=status]")?.textContent).toContain("Loading");
    });

    it("opens a needs-you item from a project and comes back to that project", async () => {
        const client = fakeClient();
        const { container, root } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645 },
                    projects: [trackerProject()],
                    trackerProject: trackerProjectDetail(),
                })}
            />,
        );
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_ProjectNeedsYou_row")!.click());
        expect(client.openTrackerItem).toHaveBeenCalledWith(3939, { keepProject: true });
        await act(async () =>
            root.render(
                <TrackerPane
                    client={client as unknown as MatronJournalClient}
                    state={paneState({
                        trackerView: { open: true, view: "inbox", selectedItemId: 3939, selectedProjectId: 2645 },
                        trackerItem: { item: trackerItem({ num: 3939 }), comments: [] },
                        inboxItems: [],
                    })}
                />,
            ),
        );
        const back = container.querySelector<HTMLButtonElement>(".mj_TrackerBack")!;
        client.loadProject.mockClear();
        await act(async () => back.click());
        expect(client.openTrackerProject).toHaveBeenCalledWith(2645);
        expect(client.loadProject).toHaveBeenCalledWith(2645);
    });

    it("keeps the project page on a failed refresh but says so and offers a retry", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions", selectedProjectId: 2645 },
                    projects: [trackerProject()],
                    trackerProject: trackerProjectDetail(),
                    projectLoadError: { id: "2645", message: "boom" },
                })}
            />,
        );
        expect(container.querySelector(".mj_ProjectPage")).not.toBeNull();
        const notice = container.querySelector(".mj_TrackerStaleNotice");
        expect(notice?.textContent).toContain("Couldn't refresh this project");
        client.loadProject.mockClear();
        await act(async () => notice!.querySelector<HTMLButtonElement>("button")!.click());
        expect(client.loadProject).toHaveBeenCalledWith(2645);
    });

    it("keeps the dashboard on a failed refresh but says so and offers a retry", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions" },
                    projects: [trackerProject()],
                    missions: [],
                    projectsError: "offline",
                })}
            />,
        );
        expect(container.querySelector(".mj_ProjectsDashboard")).not.toBeNull();
        const notice = container.querySelector(".mj_TrackerStaleNotice");
        expect(notice?.textContent).toContain("Couldn't refresh projects");
        client.loadProjects.mockClear();
        await act(async () => notice!.querySelector<HTMLButtonElement>("button")!.click());
        expect(client.loadProjects).toHaveBeenCalledTimes(1);
    });

    it("shows project cards without waiting for the missions list", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions" },
                    projects: [trackerProject()],
                    projectsError: "offline",
                })}
            />,
        );
        expect(container.querySelector(".mj_ProjectCard")).not.toBeNull();
        expect(container.querySelector(".mj_TrackerStaleNotice")?.textContent).toContain("Couldn't refresh projects");
    });

    it("waits for the missions list before saying there are no projects", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "missions" }, projects: [] })}
            />,
        );
        expect(container.textContent).not.toContain("No projects yet");
        expect(container.querySelector(".mj_TrackerPane_body [role=status]")?.textContent).toContain("Loading");
    });

    it("says the selected item failed to load and offers a retry", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox", selectedItemId: 9 },
                    trackerItem: null,
                    inboxItems: [],
                    itemLoadError: { id: "9", message: "gone away" },
                })}
            />,
        );

        const status = container.querySelector(".mj_TrackerPane_body [role=status]");
        expect(status?.textContent).toContain("Couldn't load this item");
        const [retry, back] = Array.from(status!.querySelectorAll<HTMLButtonElement>("button"));

        client.loadItem.mockClear();
        await act(async () => {
            retry.click();
        });
        expect(client.loadItem).toHaveBeenCalledTimes(1);
        expect(client.loadItem).toHaveBeenCalledWith(9);

        await act(async () => {
            back.click();
        });
        expect(client.openTrackerView).toHaveBeenCalledWith({
            view: "inbox",
            itemId: null,
            missionId: null,
            loopId: null,
            memoryName: null,
            projectId: null,
        });
    });

    // A failure recorded for an earlier selection must not stand in for the current one.
    it("does not offer the item retry when the load error belongs to another item", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox", selectedItemId: 9 },
                    trackerItem: null,
                    inboxItems: [],
                    itemLoadError: { id: "7", message: "gone away" },
                })}
            />,
        );

        expect(container.textContent).not.toContain("Couldn't load this item");
        expect(container.querySelector(".mj_TrackerInboxToggle")).not.toBeNull();
    });

    // A failed refresh keeps the loaded record but must not leave it looking current with no way
    // to retry once another load clears the shared banner.
    it("keeps a loaded item on a failed refresh, marks it possibly stale and offers a retry", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox", selectedItemId: 9 },
                    trackerItem: { item: trackerItem({ num: 9 }), comments: [] },
                    inboxItems: [],
                    itemLoadError: { id: "9", message: "gone away" },
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerComposer")).not.toBeNull();
        const notice = container.querySelector(".mj_TrackerStaleNotice");
        expect(notice?.textContent).toContain("may be out of date");

        client.loadItem.mockClear();
        await act(async () => {
            notice!.querySelector<HTMLButtonElement>("button")!.click();
        });
        expect(client.loadItem).toHaveBeenCalledWith(9);
    });

    it("shows the empty inbox once a load has landed with no items", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "inbox" }, inboxItems: [] })}
            />,
        );

        expect(container.textContent).toContain("Nothing needs you");
    });

    it("goes back to the inbox by clearing the selection in one view update", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox", selectedItemId: 7 },
                    trackerItem: { item: trackerItem({ num: 7 }), comments: [] },
                    inboxItems: [],
                })}
            />,
        );

        await act(async () => {
            container.querySelector<HTMLButtonElement>(".mj_TrackerBack")!.click();
        });
        expect(client.openTrackerView).toHaveBeenCalledWith({
            view: "inbox",
            itemId: null,
            missionId: null,
            loopId: null,
            memoryName: null,
            projectId: null,
        });
        expect(client.closeTrackerView).not.toHaveBeenCalled();
    });

    it("follows a conversation rename without remounting", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c-here",
            conversations: [{ id: "c-listed", title: "Listed chat" }],
        });
        const state = paneState({
            trackerView: { open: true, view: "inbox" },
            inboxItems: [trackerItem({ id: "it_b", num: 2, origin_convo_id: "c-listed" })],
        });
        const { container, root } = await mount(
            <TrackerPane client={client as unknown as MatronJournalClient} state={state} />,
        );
        expect(container.querySelector(".mj_TrackerItemRow_origin")?.textContent).toBe("from Listed chat");

        // The client replaces its conversation list on a rename and re-renders the pane.
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c-here",
            conversations: [{ id: "c-listed", title: "Renamed chat" }],
        });
        await act(async () => {
            root.render(<TrackerPane client={client as unknown as MatronJournalClient} state={{ ...state }} />);
        });
        expect(container.querySelector(".mj_TrackerItemRow_origin")?.textContent).toBe("from Renamed chat");
    });
});

describe("For you inbox origin notes", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("labels rows from other conversations and leaves the viewed conversation's rows bare", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c-here",
            conversations: [
                { id: "c-here", title: "This chat" },
                { id: "c-listed", title: "Listed chat" },
            ],
        });
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "inbox" },
                    inboxItems: [
                        trackerItem({
                            id: "it_a",
                            num: 1,
                            updated_at: 4,
                            origin_convo_id: "c-here",
                            origin_convo_title: "This chat",
                        }),
                        trackerItem({ id: "it_b", num: 2, updated_at: 3, origin_convo_id: "c-listed" }),
                        trackerItem({
                            id: "it_c",
                            num: 3,
                            updated_at: 2,
                            origin_convo_id: "c-old",
                            origin_convo_title: "Auth refactor",
                        }),
                        trackerItem({
                            id: "it_d",
                            num: 4,
                            updated_at: 1,
                            origin_convo_id: "c-gone",
                            origin_convo_title: null,
                        }),
                    ],
                })}
            />,
        );

        const origins = Array.from(container.querySelectorAll(".mj_TrackerItemRow")).map(
            (row) => row.querySelector(".mj_TrackerItemRow_origin")?.textContent ?? null,
        );
        expect(origins).toEqual([null, "from Listed chat", "from Auth refactor", "from Another chat"]);
    });
});

describe("TrackerPane project filing", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("creates a project from the Projects home through the client", async () => {
        const client = {
            ...fakeClient(),
            createTrackerProject: jest.fn().mockResolvedValue({ project: trackerProject({ num: 7 }) }),
        };
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "missions" }, projects: [trackerProject()] })}
            />,
        );
        const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
            (node) => node.textContent === "New project",
        )!;
        await act(async () => button.click());
        const input = document.querySelector<HTMLInputElement>("#mj-new-project-name")!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Launch");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit());
        expect(client.createTrackerProject).toHaveBeenCalledWith("Launch", "");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("loads the projects for a project page opened straight from a link", async () => {
        const client = fakeClient();
        await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "missions", selectedProjectId: 2645 } })}
            />,
        );
        expect(client.loadProjects).toHaveBeenCalledTimes(1);
    });
});
