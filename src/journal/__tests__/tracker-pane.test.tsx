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
import { trackerItem, trackerMissionDetail } from "./tracker-fixtures";

interface FakeClient {
    loadMissions: jest.Mock;
    loadInbox: jest.Mock;
    loadItem: jest.Mock;
    loadMission: jest.Mock;
    closeTrackerView: jest.Mock;
    openTrackerView: jest.Mock;
    openTrackerItem: jest.Mock;
    openTrackerMission: jest.Mock;
    openTrackerLoop: jest.Mock;
    openTrackerLink: jest.Mock;
    work: jest.Mock;
    getSnapshot: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        loadMissions: jest.fn().mockResolvedValue(undefined),
        loadInbox: jest.fn().mockResolvedValue(undefined),
        loadItem: jest.fn().mockResolvedValue(undefined),
        loadMission: jest.fn().mockResolvedValue(undefined),
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
