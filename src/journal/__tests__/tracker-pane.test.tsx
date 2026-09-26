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
import { trackerItem } from "./tracker-fixtures";

interface FakeClient {
    loadInbox: jest.Mock;
    loadItem: jest.Mock;
    closeTrackerView: jest.Mock;
    openTrackerView: jest.Mock;
    openTrackerItem: jest.Mock;
    getSnapshot: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        loadInbox: jest.fn().mockResolvedValue(undefined),
        loadItem: jest.fn().mockResolvedValue(undefined),
        closeTrackerView: jest.fn(),
        openTrackerView: jest.fn(),
        openTrackerItem: jest.fn(),
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

describe("TrackerPane selection/detail matching (F1)", () => {
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
                        trackerItem({ id: "it_d", num: 4, updated_at: 1, origin_convo_id: "c-gone" }),
                    ],
                })}
            />,
        );

        const origins = Array.from(container.querySelectorAll(".mj_TrackerItemRow")).map(
            (row) => row.querySelector(".mj_TrackerItemRow_origin")?.textContent ?? null,
        );
        expect(origins).toEqual([null, "from Listed chat", "from Auth refactor", "from Another chat"]);
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
