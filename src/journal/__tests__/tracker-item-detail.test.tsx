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
    openTrackerLink: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
        commentItem: jest.fn().mockResolvedValue(true),
        closeTrackerItem: jest.fn().mockResolvedValue(true),
        reopenTrackerItem: jest.fn().mockResolvedValue(true),
        closeTrackerView: jest.fn(),
        selectConversation: jest.fn().mockResolvedValue(undefined),
        openTrackerLink: jest.fn(),
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

        expect(client.commentItem).toHaveBeenCalledWith(12, { body: "on it, deploying now" }, expect.any(String));
    });

    // F1: a failed send keeps the draft; retrying the SAME text must reuse the idempotency key so the
    // server can dedupe a comment that committed before its response was lost. New text → new key.
    it("reuses the idempotency key across retries of the same draft, mints a new one when it changes", async () => {
        const client = fakeClient();
        client.commentItem.mockResolvedValue(false); // every send fails → draft (and key) persist
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
        const type = async (text: string): Promise<void> => {
            await act(async () => {
                setValue.call(textarea, text);
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
            });
        };
        const clickSend = async (): Promise<void> => {
            await act(async () => {
                container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_send")!.click();
            });
        };

        await type("please retry cleanly");
        await clickSend();
        await clickSend(); // retry of identical text
        const key1a = client.commentItem.mock.calls[0][2];
        const key1b = client.commentItem.mock.calls[1][2];
        expect(key1a).toBe(key1b);

        await type("actually a different comment");
        await clickSend();
        const key2 = client.commentItem.mock.calls[2][2];
        expect(key2).not.toBe(key1a);
    });

    // F2: a failed send (mutator resolves false) must NOT clear the composer — the typed text is the
    // user's only copy, and destroying it on offline/auth/5xx is silent data loss.
    it("keeps the reply draft intact when the send fails", async () => {
        const client = fakeClient();
        client.commentItem.mockResolvedValue(false);
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
            setValue.call(textarea, "important context I do not want to lose");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
            container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_send")!.click();
        });

        expect(client.commentItem).toHaveBeenCalledWith(
            12,
            { body: "important context I do not want to lose" },
            expect.any(String),
        );
        expect(container.querySelector<HTMLTextAreaElement>(".mj_TrackerComposer_input")!.value).toBe(
            "important context I do not want to lose",
        );
    });

    // F6: a matron://item deep link inside the item body must render as an activatable in-app link
    // (tap → openTrackerLink), not be stripped/inert as it was before the handler was threaded in.
    it("renders a matron://item link in the body as an activatable in-app link", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ num: 12, body: "follow up on [item thirty-four](matron://item/34)" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const link = container.querySelector<HTMLAnchorElement>(".mj_TrackerItemBody a.mj_TrackerLink");
        expect(link).not.toBeNull();
        expect(link?.textContent).toBe("item thirty-four");

        await act(async () => {
            link!.click();
        });
        expect(client.openTrackerLink).toHaveBeenCalledWith("item", 34);
    });

    // F4: a malformed tracker URL the renderer rejects (num 0 / out-of-range) must NOT leak a live
    // custom-scheme href to the browser. The URL transform and the anchor parser share one predicate,
    // so a rejected link is sanitized to an inert anchor, never emitted as `matron://…`.
    it("renders an invalid matron:// link inert, not as a live custom-scheme href", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ num: 12, body: "bad [zero](matron://item/0)" })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        expect(container.querySelector(".mj_TrackerItemBody a.mj_TrackerLink")).toBeNull();
        const anchor = container.querySelector<HTMLAnchorElement>(".mj_TrackerItemBody a");
        // Either no anchor, or an anchor whose href was stripped — never a live matron:// URL.
        expect(anchor?.getAttribute("href") ?? "").not.toContain("matron:");
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

    describe("origin line", () => {
        it("falls back to the journal-supplied origin title for a conversation not in the loaded list", async () => {
            const client = fakeClient();
            client.getSnapshot.mockReturnValue({ selectedConversationId: "c-here", conversations: [] });
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ origin_convo_id: "c-old", origin_convo_title: "Auth refactor" })}
                    comments={[]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from Auth refactor");
        });

        it("prefers the live conversation title over the one on the item", async () => {
            const client = fakeClient();
            client.getSnapshot.mockReturnValue({
                selectedConversationId: "c-here",
                conversations: [{ id: "c-old", title: "Renamed chat" }],
            });
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ origin_convo_id: "c-old", origin_convo_title: "Auth refactor" })}
                    comments={[]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from Renamed chat");
        });

        it("follows a rename of the origin conversation without remounting", async () => {
            const client = fakeClient();
            client.getSnapshot.mockReturnValue({
                selectedConversationId: "c-here",
                conversations: [{ id: "c-old", title: "Old name" }],
            });
            const item = trackerItem({ origin_convo_id: "c-old" });
            const detail = (): React.ReactElement => (
                <ItemDetail
                    item={item}
                    comments={[]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />
            );
            const { container, root } = await mount(detail());
            expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from Old name");

            client.getSnapshot.mockReturnValue({
                selectedConversationId: "c-here",
                conversations: [{ id: "c-old", title: "New name" }],
            });
            await act(async () => {
                root.render(detail());
            });
            expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from New name");
        });

        it("reads 'another chat' when neither source has a title (an older journal)", async () => {
            const client = fakeClient();
            client.getSnapshot.mockReturnValue({ selectedConversationId: "c-here", conversations: [] });
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ origin_convo_id: "c-old" })}
                    comments={[]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from another chat");
        });
    });
});
