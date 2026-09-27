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

    it("marks loaded missions whose refresh failed as possibly out of date", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({
                    trackerView: { open: true, view: "missions" },
                    missions: [],
                    missionsError: "offline",
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerStaleNotice")?.textContent).toContain(
            "Couldn't refresh missions, so they may be out of date.",
        );
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

    it("shows a loading status, not an empty missions list, before the first missions load lands", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "missions" }, inboxItems: [] })}
            />,
        );

        expect(container.querySelector(".mj_TrackerPane_body [role=status]")?.textContent).toBe("Loading…");
        expect(container.textContent).not.toContain("No missions yet");
    });

    it("says the missions list failed and offers a retry when its first load fails", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <TrackerPane
                client={client as unknown as MatronJournalClient}
                state={paneState({ trackerView: { open: true, view: "missions" }, missionsError: "offline" })}
            />,
        );

        const status = container.querySelector(".mj_TrackerPane_body [role=status]");
        expect(status?.textContent).toContain("Couldn't load missions");
        client.loadMissions.mockClear();
        await act(async () => {
            status!.querySelector<HTMLButtonElement>("button")!.click();
        });
        expect(client.loadMissions).toHaveBeenCalledTimes(1);
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

describe("Decisions inbox origin notes", () => {
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
