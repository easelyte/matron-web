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
import { trackerComment, trackerItem, trackerMission } from "./tracker-fixtures";

interface FakeClient {
    getSnapshot: jest.Mock;
    commentItem: jest.Mock;
    closeTrackerItem: jest.Mock;
    reopenTrackerItem: jest.Mock;
    setItemLabels: jest.Mock;
    closeTrackerView: jest.Mock;
    selectConversation: jest.Mock;
    openTrackerLink: jest.Mock;
    openTrackerMission: jest.Mock;
    loadMissions: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
        commentItem: jest.fn().mockResolvedValue(true),
        closeTrackerItem: jest.fn().mockResolvedValue(true),
        reopenTrackerItem: jest.fn().mockResolvedValue(true),
        setItemLabels: jest.fn().mockResolvedValue(true),
        closeTrackerView: jest.fn(),
        selectConversation: jest.fn().mockResolvedValue(undefined),
        openTrackerLink: jest.fn(),
        openTrackerMission: jest.fn(),
        loadMissions: jest.fn().mockResolvedValue(undefined),
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
        expect(menuLabels(container)).toEqual(["Mark done", "Dismiss", "Route elsewhere"]);
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
        expect(menuLabels(container)).toEqual(["Dismiss", "Route elsewhere"]);
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
        expect(menuLabels(container)).toEqual(["Mark answered", "Dismiss", "Route elsewhere"]);
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
        expect(menuLabels(container)).toEqual(["Reverse", "Mark decided", "Dismiss", "Route elsewhere"]);
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
        expect(menuLabels(container)).toEqual(["Reopen", "Route elsewhere"]);
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

    it("renders a status comment as a centered derived line with its note beneath as a comment card", async () => {
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
                        body: "Shipped in the **morning** build.",
                        meta: { to },
                    }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const thread = container.querySelector(".mj_TrackerThread")!;
        const statusRow = thread.querySelector(".mj_TrackerStatusRow");
        expect(statusRow?.textContent).toBe("Agent closed this as done");
        // The line stays the bare transition; the note is NOT folded into it.
        expect(statusRow?.textContent).not.toContain("Shipped");

        const card = thread.querySelector(".mj_TrackerComment");
        expect(card).not.toBeNull();
        expect(card?.classList.contains("mj_TrackerComment_agent")).toBe(true);
        expect(card?.querySelector(".mj_TrackerComment_author")?.textContent).toBe("Agent");
        expect(card?.querySelector(".mj_TrackerComment_time")?.textContent).toBeTruthy();
        expect(card?.querySelector(".mj_TrackerProse strong")?.textContent).toBe("morning");
        // Line first, card second.
        expect(Array.from(thread.children).map((node) => node.className)).toEqual([
            "mj_TrackerStatusRow",
            "mj_TrackerComment mj_TrackerComment_agent",
        ]);
    });

    it("styles a user's closing note card with the user class", async () => {
        const client = fakeClient();
        const from: StatusSnapshot = { state: "closed", resolution: "done", awaiting: null };
        const to: StatusSnapshot = { state: "open", resolution: null, awaiting: "agent" };
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ state: "open", awaiting: "agent" })}
                comments={[
                    trackerComment({
                        id: "cm_reopen",
                        kind: "status",
                        author: "user",
                        body: "Not fixed",
                        meta: { from, to },
                    }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        expect(container.querySelector(".mj_TrackerStatusRow")?.textContent).toBe("You reopened this");
        const card = container.querySelector(".mj_TrackerComment_user");
        expect(card?.querySelector(".mj_TrackerComment_author")?.textContent).toBe("You");
        expect(card?.querySelector(".mj_TrackerProse")?.textContent).toBe("Not fixed");
    });

    it("makes links in a closing note clickable: bare matron://item opens the item, https opens a tab", async () => {
        const client = fakeClient();
        const to: StatusSnapshot = { state: "closed", resolution: "cancelled", awaiting: null };
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ state: "closed", awaiting: null, resolution: "cancelled" })}
                comments={[
                    trackerComment({
                        id: "cm_status",
                        kind: "status",
                        author: "agent",
                        body: "Duplicate: the steps are on #68 (matron://item/68). See https://example.com/run",
                        meta: { to },
                    }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const card = container.querySelector(".mj_TrackerComment")!;
        const itemLink = card.querySelector<HTMLAnchorElement>("a.mj_TrackerLink");
        expect(itemLink?.textContent).toBe("matron://item/68");
        expect(itemLink?.getAttribute("href")).toBe("matron://item/68");
        await act(async () => {
            itemLink!.click();
        });
        expect(client.openTrackerLink).toHaveBeenCalledWith("item", 68);

        const external = card.querySelector<HTMLAnchorElement>('a[href="https://example.com/run"]');
        expect(external?.getAttribute("target")).toBe("_blank");
    });

    it("renders only the centered line for a status comment with an empty body", async () => {
        const client = fakeClient();
        const to: StatusSnapshot = { state: "closed", resolution: "done", awaiting: null };
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ state: "closed", awaiting: null, resolution: "done" })}
                comments={[
                    trackerComment({ id: "cm_status", kind: "status", author: "agent", body: "  \n", meta: { to } }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const thread = container.querySelector(".mj_TrackerThread")!;
        expect(thread.children).toHaveLength(1);
        expect(thread.querySelector(".mj_TrackerStatusRow")?.textContent).toBe("Agent closed this as done");
        expect(thread.querySelector(".mj_TrackerComment")).toBeNull();
    });

    it("renders a status comment with no displayable transition but a note as just the card", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem()}
                comments={[
                    trackerComment({
                        id: "cm_status",
                        kind: "status",
                        author: "agent",
                        body: "Context note",
                        meta: null,
                    }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const thread = container.querySelector(".mj_TrackerThread")!;
        expect(thread.querySelector(".mj_TrackerStatusRow")).toBeNull();
        expect(thread.querySelector(".mj_TrackerComment .mj_TrackerProse")?.textContent).toBe("Context note");
    });

    describe("comment author", () => {
        const heads = (container: HTMLElement): string[][] =>
            Array.from(container.querySelectorAll(".mj_TrackerComment_head")).map((head) =>
                Array.from(head.querySelectorAll(".mj_TrackerComment_author, .mj_TrackerComment_convo")).map(
                    (node) => node.textContent ?? "",
                ),
            );

        it("heads each agent comment with the box and conversation that wrote it", async () => {
            const client = fakeClient();
            client.getSnapshot.mockReturnValue({
                selectedConversationId: "c1",
                conversations: [{ id: "c-b", title: "Renamed chat" }],
                agents: [{ device_id: 7, name: "box-c" }],
            });
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({})}
                    comments={[
                        trackerComment({
                            author: "agent",
                            id: "1",
                            device_name: "box-a",
                            convo_id: "c-a",
                            convo_title: "Audit",
                        }),
                        // The loaded conversation's title wins over the one on the comment.
                        trackerComment({
                            author: "agent",
                            id: "2",
                            device_name: "box-b",
                            convo_id: "c-b",
                            convo_title: "Old name",
                        }),
                        // No session named: the box alone.
                        trackerComment({ author: "agent", id: "3", device_name: "box-b" }),
                        // A journal from before the fields: the roster names the writing device.
                        trackerComment({ author: "agent", id: "4", device_id: 7 }),
                        // Nothing names it.
                        trackerComment({ author: "agent", id: "5", device_id: 99 }),
                        trackerComment({ id: "6", author: "user", device_name: "box-a", convo_id: "c-a" }),
                    ]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            expect(heads(container)).toEqual([
                ["box-a", "Audit"],
                ["box-b", "Renamed chat"],
                ["box-b"],
                ["box-c"],
                ["Agent"],
                ["You"],
            ]);
        });

        it("opens the writing conversation from the header", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({})}
                    comments={[
                        trackerComment({
                            author: "agent",
                            device_name: "box-a",
                            convo_id: "c-a",
                            convo_title: "Audit",
                        }),
                    ]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            await act(async () => {
                container.querySelector<HTMLButtonElement>(".mj_TrackerComment_convo")!.click();
            });
            expect(client.closeTrackerView).toHaveBeenCalled();
            expect(client.selectConversation).toHaveBeenCalledWith("c-a");
        });
    });

    describe("route-elsewhere label", () => {
        it("sets the route-elsewhere label from the menu when unset", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ num: 12, labels: [] })}
                    comments={[]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            await openMenu(container);
            expect(menuLabels(container)).toContain("Route elsewhere");
            await act(async () => {
                Array.from(container.querySelectorAll<HTMLButtonElement>(".mj_TrackerMenu_item"))
                    .find((node) => node.textContent === "Route elsewhere")!
                    .click();
            });
            expect(client.setItemLabels).toHaveBeenCalledWith(12, ["route-elsewhere"]);
        });

        it("clears the label via a Handle-here toggle and renders the actionable chip, not a raw label", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ num: 12, labels: ["urgent", "route-elsewhere"] })}
                    comments={[]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            // The reserved label renders as its own accented chip, and the raw "route-elsewhere"
            // string never appears as a plain label.
            const chip = container.querySelector(".mj_TrackerLabel_routeElsewhere");
            expect(chip?.textContent).toContain("Handle elsewhere");
            const rawLabels = Array.from(container.querySelectorAll(".mj_TrackerLabel"))
                .filter((n) => !n.classList.contains("mj_TrackerLabel_routeElsewhere"))
                .map((n) => n.textContent);
            expect(rawLabels).toEqual(["urgent"]);
            // The toggle now reads "Handle here" and removes the label, preserving the others.
            await openMenu(container);
            expect(menuLabels(container)).toContain("Handle here");
            await act(async () => {
                Array.from(container.querySelectorAll<HTMLButtonElement>(".mj_TrackerMenu_item"))
                    .find((node) => node.textContent === "Handle here")!
                    .click();
            });
            expect(client.setItemLabels).toHaveBeenCalledWith(12, ["urgent"]);
        });
    });
    it("opens a Files deep-link chip in-app and keeps other link chips as new tabs", async () => {
        const client = fakeClient();
        const filesUrl = `${window.location.origin}/#files=${encodeURIComponent("/root/a/plan.md")}`;
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({
                    links: [
                        { url: filesUrl, title: "plan" },
                        { url: "https://github.com/easelyte/matron-web/pull/1", title: "PR" },
                    ],
                })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        const [filesChip, prChip] = Array.from(container.querySelectorAll<HTMLAnchorElement>(".mj_TrackerLinkChip"));
        const hashes: string[] = [];
        const onHashChange = (): void => void hashes.push(window.location.hash);
        window.addEventListener("hashchange", onHashChange);
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });

        await act(async () => {
            filesChip.dispatchEvent(click);
        });
        window.removeEventListener("hashchange", onHashChange);
        window.history.replaceState(null, "", "/");

        expect(filesChip.hasAttribute("target")).toBe(false);
        expect(click.defaultPrevented).toBe(true);
        expect(hashes).toEqual([`#files=${encodeURIComponent("/root/a/plan.md")}`]);
        expect(prChip.getAttribute("target")).toBe("_blank");
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

        it("reads 'Conversation' when neither source has a title (an older journal)", async () => {
            const client = fakeClient();
            client.getSnapshot.mockReturnValue({ selectedConversationId: "c-here", conversations: [] });
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ origin_convo_id: "c-old", origin_convo_title: null })}
                    comments={[]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from Conversation");
        });
    });
});

describe("ItemDetail reply box (operator call T3: the chat composer's shape)", () => {});

describe("ItemDetail reply box keyboard (the chat composer's send key)", () => {
    async function mountReply(): Promise<{ client: FakeClient; textarea: HTMLTextAreaElement }> {
        const client = fakeClient();
        const { container } = await mount(
            <ItemDetail
                item={trackerItem({ num: 9 })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        const textarea = container.querySelector<HTMLTextAreaElement>(".mj_TrackerComposer_input")!;
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
        await act(async () => {
            setValue.call(textarea, "ship it");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        return { client, textarea };
    }

    async function keydown(target: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
        const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
        await act(async () => {
            target.dispatchEvent(event);
        });
        return event;
    }

    it("leaves Shift+Enter to insert a newline", async () => {
        const { client, textarea } = await mountReply();
        const event = await keydown(textarea, { shiftKey: true });
        expect(event.defaultPrevented).toBe(false);
        expect(client.commentItem).not.toHaveBeenCalled();
    });

    it.each([{ metaKey: true }, { ctrlKey: true }])("still sends on %o + Enter", async (modifier) => {
        const { client, textarea } = await mountReply();
        const event = await keydown(textarea, modifier);
        expect(event.defaultPrevented).toBe(true);
        expect(client.commentItem).toHaveBeenCalledTimes(1);
    });

    it("does not send an Enter that commits an IME composition", async () => {
        const { client, textarea } = await mountReply();
        const composing = await keydown(textarea, { isComposing: true });
        const legacyComposing = await keydown(textarea, { keyCode: 229 } as KeyboardEventInit);
        expect(composing.defaultPrevented).toBe(false);
        expect(legacyComposing.defaultPrevented).toBe(false);
        expect(client.commentItem).not.toHaveBeenCalled();
    });

    it("leaves the focus where the operator moved it while the reply was posting", async () => {
        const { client, textarea } = await mountReply();
        let settle!: (ok: boolean) => void;
        client.commentItem.mockReturnValueOnce(new Promise<boolean>((resolve) => (settle = resolve)));
        textarea.focus();
        await keydown(textarea, {});
        const elsewhere = document.createElement("button");
        document.body.append(elsewhere);
        elsewhere.focus();
        await act(async () => settle(true));
        expect(document.activeElement).toBe(elsewhere);
        elsewhere.remove();
    });

    it("does not pull the focus into the box after a reply sent with the button", async () => {
        const { client, textarea } = await mountReply();
        const button = textarea.parentElement!.querySelector<HTMLButtonElement>(".mj_TrackerComposer_send")!;
        button.focus();
        await act(async () => button.click());
        expect(client.commentItem).toHaveBeenCalledTimes(1);
        expect(document.activeElement).not.toBe(textarea);
    });
});

describe("ItemDetail origin line", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

        // The client replaces its conversation list on a rename and re-renders the pane.
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c-here",
            conversations: [{ id: "c-old", title: "New name" }],
        });
        await act(async () => {
            root.render(detail());
        });
        expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from New name");
    });

    describe("buttons on a follow-up comment", () => {
        const question = trackerComment({
            id: "ic_q",
            author: "agent",
            body: "Merge it?",
            actions: ["Merge", "Screenshot first"],
            chosen_action: null,
        });
        const buttons = (container: HTMLElement): HTMLButtonElement[] =>
            Array.from(container.querySelectorAll<HTMLButtonElement>(".mj_TrackerAction"));

        it("draws a comment's buttons under that comment, and none on a comment that offers none", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ state: "open", awaiting: "user" })}
                    comments={[trackerComment({ id: "ic_plain", author: "agent", body: "FYI", actions: [] }), question]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );

            const cards = Array.from(container.querySelectorAll(".mj_TrackerComment"));
            expect(cards[0].querySelector(".mj_TrackerActions")).toBeNull();
            expect(buttons(cards[1] as HTMLElement).map((b) => b.textContent)).toEqual(["Merge", "Screenshot first"]);
            expect(buttons(container).every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
        });

        it("draws nothing for a comment from a journal that predates comment actions", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem()}
                    comments={[trackerComment({ author: "agent", body: "Merge it?" })]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerActions")).toBeNull();
        });

        it("a tap posts the label as the answer to that comment", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ num: 12, state: "open", awaiting: "user" })}
                    comments={[question]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );

            await act(async () => {
                buttons(container)[1].click();
            });

            expect(client.commentItem).toHaveBeenCalledTimes(1);
            const [num, body, key] = client.commentItem.mock.calls[0];
            expect(num).toBe(12);
            expect(body).toEqual({ action: "Screenshot first", reply_to: "ic_q" });
            expect(typeof key).toBe("string");
        });

        it("a failed tap reuses its idempotency key on the retry; a sent one does not", async () => {
            const client = fakeClient();
            client.commentItem.mockResolvedValueOnce(false);
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ state: "open", awaiting: "user" })}
                    comments={[question]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );

            for (let i = 0; i < 3; i += 1) {
                await act(async () => {
                    buttons(container)[0].click();
                });
            }

            const keys = client.commentItem.mock.calls.map((call) => call[2]);
            expect(keys[1]).toBe(keys[0]);
            expect(keys[2]).not.toBe(keys[1]);
        });

        it("does not replay a failed tap's key once another answer has been sent", async () => {
            const client = fakeClient();
            client.commentItem.mockResolvedValueOnce(false);
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ state: "open", awaiting: "user" })}
                    comments={[question]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );

            // "Merge" fails, "Screenshot first" is sent, then "Merge" again: a new answer, a new key.
            for (const index of [0, 1, 0]) {
                await act(async () => {
                    buttons(container)[index].click();
                });
            }

            const keys = client.commentItem.mock.calls.map((call) => call[2]);
            expect(client.commentItem.mock.calls.map((call) => call[1].action)).toEqual([
                "Merge",
                "Screenshot first",
                "Merge",
            ]);
            expect(new Set(keys).size).toBe(3);
        });

        it("marks the chosen button, and only on the comment it answers", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ state: "open", awaiting: "agent" })}
                    comments={[
                        { ...question, chosen_action: "Merge" },
                        trackerComment({
                            id: "ic_tap",
                            author: "user",
                            body: "Merge",
                            action: "Merge",
                            reply_to: "ic_q",
                        }),
                        trackerComment({ id: "ic_q2", author: "agent", body: "Now?", actions: ["Merge", "Later"] }),
                    ]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );

            const pressed = buttons(container).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
            expect(pressed).toEqual([
                ["Merge", "true"],
                ["Screenshot first", "false"],
                ["Merge", "false"],
                ["Later", "false"],
            ]);
            expect(container.querySelectorAll(".mj_TrackerAction_chosen")).toHaveLength(1);
            // Still open, so the answer can be changed.
            expect(buttons(container).every((b) => !b.disabled)).toBe(true);
        });

        it("keeps the buttons as a record on a closed item, without letting them be tapped", async () => {
            const client = fakeClient();
            const { container } = await mount(
                <ItemDetail
                    item={trackerItem({ state: "closed", resolution: "done", awaiting: null })}
                    comments={[{ ...question, chosen_action: "Merge" }]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );

            expect(buttons(container).every((b) => b.disabled)).toBe(true);
            expect(container.querySelector(".mj_TrackerAction_chosen")?.textContent).toBe("Merge");
            await act(async () => {
                buttons(container)[1].click();
            });
            expect(client.commentItem).not.toHaveBeenCalled();
        });
    });
});

describe("ItemDetail context block", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    const onMission = { mission_id: "ms_1", mission_num: 5 };

    function detail(client: FakeClient, item = trackerItem(onMission)): React.ReactElement {
        return (
            <ItemDetail
                item={item}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />
        );
    }

    it("names the mission by its short name from the missions list, and opens it on a tap", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c1",
            conversations: [],
            missions: [trackerMission({ id: "ms_1", num: 5, title: "Ship the tracker", name: "Tracker" })],
        });
        const { container } = await mount(detail(client));

        const row = container.querySelector<HTMLButtonElement>(".mj_TrackerContext_mission")!;
        expect(row.textContent).toBe("#5 Tracker");
        await act(async () => row.click());
        expect(client.openTrackerMission).toHaveBeenCalledWith(5);
        // Listed, so no refresh of the list.
        expect(client.loadMissions).not.toHaveBeenCalled();
    });

    it("falls back to the title when the mission has no short name", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c1",
            conversations: [],
            missions: [trackerMission({ id: "ms_1", num: 5, title: "Ship the tracker", name: null })],
        });
        const { container } = await mount(detail(client));
        expect(container.querySelector(".mj_TrackerContext_mission")?.textContent).toBe("#5 Ship the tracker");
    });

    it("reads 'Mission #N' for a mission not in the loaded list, and refreshes the list once", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({ selectedConversationId: "c1", conversations: [], missions: [] });
        const { container, root } = await mount(detail(client));

        expect(container.querySelector(".mj_TrackerContext_mission")?.textContent).toBe("Mission #5");
        expect(client.loadMissions).toHaveBeenCalledTimes(1);

        // The refreshed list still lacks it (closed, or hidden): no second refresh.
        client.getSnapshot.mockReturnValue({ selectedConversationId: "c1", conversations: [], missions: [] });
        await act(async () => root.render(detail(client)));
        expect(client.loadMissions).toHaveBeenCalledTimes(1);
    });

    it("does not refresh the missions list before it has loaded at all", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({ selectedConversationId: "c1", conversations: [] });
        await mount(detail(client));
        expect(client.loadMissions).not.toHaveBeenCalled();
    });

    it("draws no mission row, and refreshes nothing, for an item on no mission", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({ selectedConversationId: "c1", conversations: [], missions: [] });
        const { container } = await mount(detail(client, trackerItem()));
        expect(container.querySelector(".mj_TrackerContext_mission")).toBeNull();
        expect(client.loadMissions).not.toHaveBeenCalled();
    });

    it("keeps the mission row when the origin is the conversation being viewed", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({ selectedConversationId: "c1", conversations: [] });
        const { container } = await mount(detail(client, trackerItem({ ...onMission, origin_convo_id: "c1" })));
        expect(container.querySelector(".mj_TrackerOrigin")).toBeNull();
        expect(container.querySelector(".mj_TrackerContext_mission")?.textContent).toBe("Mission #5");
    });

    it("draws no conversation row for a granted item, which has no origin", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({ selectedConversationId: undefined, conversations: [] });
        const { container } = await mount(detail(client, trackerItem({ origin_convo_id: "" })));
        expect(container.querySelector(".mj_TrackerOrigin")).toBeNull();
        expect(container.querySelector(".mj_TrackerContext")).toBeNull();
    });

    it("labels the origin with its box and the bridge's topic", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c-here",
            conversations: [
                { id: "c-old", title: "Ship the tracker", auto_title: "[ab] auth refactor", agent_device_id: 7 },
            ],
            agents: [{ device_id: 7, name: "birch" }],
        });
        const { container } = await mount(detail(client, trackerItem({ origin_convo_id: "c-old" })));
        expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from birch · auth refactor");
    });

    it("names the box of an origin outside the loaded list from the item's origin device", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c-here",
            conversations: [],
            agents: [{ device_id: 7, name: "birch" }],
        });
        const { container } = await mount(
            detail(
                client,
                trackerItem({ origin_convo_id: "c-old", origin_convo_title: "Auth refactor", origin_device_id: 7 }),
            ),
        );
        expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from birch · Auth refactor");
    });

    it("names the box of a loaded legacy origin with no device from the item's origin device", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({
            selectedConversationId: "c-here",
            conversations: [{ id: "c-old", title: "Auth refactor", agent_device_id: null }],
            agents: [{ device_id: 7, name: "birch" }],
        });
        const { container } = await mount(
            detail(client, trackerItem({ origin_convo_id: "c-old", origin_device_id: 7 })),
        );
        expect(container.querySelector(".mj_TrackerOrigin")?.textContent).toBe("Opened from birch · Auth refactor");
    });

    it("opens the origin conversation on a tap", async () => {
        const client = fakeClient();
        client.getSnapshot.mockReturnValue({ selectedConversationId: "c-here", conversations: [] });
        const { container } = await mount(detail(client, trackerItem({ origin_convo_id: "c-old" })));

        await act(async () => container.querySelector<HTMLButtonElement>(".mj_TrackerOrigin")!.click());
        expect(client.closeTrackerView).toHaveBeenCalled();
        expect(client.selectConversation).toHaveBeenCalledWith("c-old");
    });
});
