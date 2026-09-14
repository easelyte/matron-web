/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import type { StatusSnapshot } from "../types";
import { ItemDetail } from "../tracker/ItemDetail";
import { trackerComment, trackerItem } from "./tracker-fixtures";

interface FakeClient {
    getSnapshot: jest.Mock;
    commentItem: jest.Mock;
    closeTrackerItem: jest.Mock;
    reopenTrackerItem: jest.Mock;
    closeTrackerView: jest.Mock;
    selectConversation: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
        commentItem: jest.fn().mockResolvedValue(undefined),
        closeTrackerItem: jest.fn().mockResolvedValue(undefined),
        reopenTrackerItem: jest.fn().mockResolvedValue(undefined),
        closeTrackerView: jest.fn(),
        selectConversation: jest.fn().mockResolvedValue(undefined),
    };
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

function menuLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll(".mj_TrackerMenu_item")).map((node) => node.textContent ?? "");
}

async function openMenu(container: HTMLElement): Promise<void> {
    await act(async () => {
        container.querySelector<HTMLButtonElement>(".mj_TrackerMenu_button")!.click();
    });
}

describe("ItemDetail", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("shows the needs-you status pill for an open awaiting-user item", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ state: "open", awaiting: "user" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const pill = container.querySelector(".mj_TrackerStatusPill");
        expect(pill?.textContent).toBe("Needs you");
        expect(pill?.classList.contains("mj_TrackerStatusPill_needsyou")).toBe(true);
    });

    it("shows the closed resolution pill for a closed item", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ state: "closed", awaiting: null, resolution: "done", kind: "task" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        expect(container.querySelector(".mj_TrackerStatusPill")?.textContent).toBe("Closed · Done");
    });

    it("offers Mark done and Dismiss for a task", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ kind: "task", awaiting: "agent" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        await openMenu(container);
        expect(menuLabels(container)).toEqual(["Mark done", "Dismiss"]);
    });

    it("offers only Dismiss for a question until the user has replied", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ kind: "question", awaiting: "user" })}
                comments={[trackerComment({ author: "agent" })]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        await openMenu(container);
        expect(menuLabels(container)).toEqual(["Dismiss"]);
    });

    it("unlocks Mark answered for a question once a user comment exists", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ kind: "question", awaiting: "user" })}
                comments={[trackerComment({ author: "user" })]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        await openMenu(container);
        expect(menuLabels(container)).toEqual(["Mark answered", "Dismiss"]);
    });

    it("offers Reverse, Mark decided and Dismiss for a decision", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ kind: "decision", awaiting: "user" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        await openMenu(container);
        expect(menuLabels(container)).toEqual(["Reverse", "Mark decided", "Dismiss"]);
    });

    it("offers Reopen for a closed item", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ state: "closed", awaiting: null, resolution: "done", kind: "task" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        await openMenu(container);
        expect(menuLabels(container)).toEqual(["Reopen"]);
    });

    it("routes a resolve click through client.closeTrackerItem", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ num: 12, kind: "task", awaiting: "agent" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        await openMenu(container);
        await act(async () => {
            Array.from(container.querySelectorAll<HTMLButtonElement>(".mj_TrackerMenu_item"))
                .find((node) => node.textContent === "Mark done")!
                .click();
        });

        expect(client.closeTrackerItem).toHaveBeenCalledWith(12, "done");
    });

    it("sends a reply through client.commentItem", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ num: 12 })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const textarea = container.querySelector<HTMLTextAreaElement>(".mj_TrackerComposer_input")!;
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
        await act(async () => {
            setValue.call(textarea, "on it, deploying now");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
            container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_send")!.click();
        });

        expect(client.commentItem).toHaveBeenCalledWith(12, { body: "on it, deploying now" });
    });

    it("renders a status comment as a centered derived line, never its raw body", async () => {
        const client = fakeClient();
        const to: StatusSnapshot = { state: "closed", resolution: "done", awaiting: null };
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ state: "closed", awaiting: null, resolution: "done" })}
                comments={[
                    trackerComment({
                        id: "cm_status",
                        kind: "status",
                        author: "agent",
                        body: "PRIVATE-ELIDED-BODY",
                        meta: { to },
                    }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const statusRow = container.querySelector(".mj_TrackerStatusRow");
        expect(statusRow?.textContent).toBe("Agent closed this as done");
        expect(container.textContent).not.toContain("PRIVATE-ELIDED-BODY");
    });
});
