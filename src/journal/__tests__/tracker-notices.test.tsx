/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";

import { MatronJournalClient } from "../client";
import { ItemDetail } from "../tracker/ItemDetail";
import { ItemRow } from "../tracker/ItemRow";
import { ItemsInbox } from "../tracker/ItemsInbox";
import type { ClientState, TrackerItem } from "../types";
import { trackerItem } from "./tracker-fixtures";

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

const notice = (over: Partial<TrackerItem> = {}): TrackerItem =>
    trackerItem({ id: "it_9", num: 9, kind: "notice", title: "Deploy notes", actions: ["Seen"], ...over });

const closedNotice = (): TrackerItem => notice({ state: "closed", resolution: "done", awaiting: null });

/** A real client whose journal api is a mock: the Seen tap goes through the client's own write. */
function clientWith(state: Partial<ClientState>, api: Record<string, jest.Mock>): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = client as unknown as { state: ClientState; api: Record<string, jest.Mock> };
    internals.state = { ...client.getSnapshot(), phase: "signed-in", conversations: [], ...state };
    internals.api = api;
    return client;
}

describe("Notice items", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        if (typeof globalThis.crypto?.randomUUID !== "function") {
            Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
        }
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("draws a notice row lighter than a question, with the eye glyph and a muted To read token", async () => {
        const { container } = await mount(<ItemRow item={notice()} onOpen={jest.fn()} />);
        const row = container.querySelector(".mj_TrackerItemRow")!;
        expect(row.classList.contains("mj_TrackerItemRow_notice")).toBe(true);
        expect(row.classList.contains("mj_TrackerItemRow_needsyou")).toBe(false);
        expect(container.querySelector(".mj_TrackerGlyph_notice")).not.toBeNull();
        expect(container.querySelector(".mj_TrackerItemRow_status_needsyou")).toBeNull();
        expect(container.querySelector(".mj_TrackerItemRow_status_muted")?.textContent).toBe("To read");
        expect(row.getAttribute("aria-label")).toContain("To read");
        // Without onSeen there is no button.
        expect(container.querySelector(".mj_TrackerItemRow_seen")).toBeNull();
    });

    it("puts the Seen button beside the row, not inside the row's button", async () => {
        const onSeen = jest.fn();
        const onOpen = jest.fn();
        const { container } = await mount(<ItemRow item={notice()} onOpen={onOpen} onSeen={onSeen} />);
        const seen = container.querySelector<HTMLButtonElement>(".mj_TrackerItemRow_seen")!;
        expect(seen.textContent).toBe("Seen");
        expect(seen.closest(".mj_TrackerItemRow")).toBeNull();
        await act(async () => seen.click());
        expect(onSeen).toHaveBeenCalledWith(9);
        expect(onOpen).not.toHaveBeenCalled();
    });

    it("offers no Seen button on a question or a closed notice", async () => {
        const { container } = await mount(
            <>
                <ItemRow item={trackerItem({ kind: "question" })} onOpen={jest.fn()} onSeen={jest.fn()} />
                <ItemRow item={closedNotice()} onOpen={jest.fn()} onSeen={jest.fn()} />
            </>,
        );
        expect(container.querySelector(".mj_TrackerItemRow_seen")).toBeNull();
    });

    it("a Seen tap in the inbox posts the item action and the notice leaves Needs you", async () => {
        const question = trackerItem({ id: "it_1", num: 1, title: "Pick a colour" });
        const postItemComment = jest.fn().mockResolvedValue({ item: closedNotice(), comment: {} });
        const items = jest.fn().mockResolvedValue({ items: [question], next_cursor: null });
        const client = clientWith({ inboxItems: [notice(), question] }, { postItemComment, items });
        const render = (root: Root): void =>
            root.render(
                <ItemsInbox items={client.getSnapshot().inboxItems ?? []} client={client} onOpenItem={jest.fn()} />,
            );
        const { container, root } = await mount(<div />);
        await act(async () => render(root));
        const unsubscribe = client.subscribe(() => render(root));

        await act(async () => container.querySelector<HTMLButtonElement>(".mj_TrackerItemRow_seen")!.click());

        expect(postItemComment).toHaveBeenCalledWith(9, { action: "Seen", body: "Seen" }, expect.any(String));
        expect(container.textContent).not.toContain("Deploy notes");
        expect(container.textContent).toContain("Pick a colour");
        unsubscribe();
    });

    describe("the Done tab", () => {
        const seenNotice = (): TrackerItem => ({ ...closedNotice(), chosen_action: "Seen", updated_at: 30 });
        const answered = (): TrackerItem =>
            trackerItem({ id: "it_1", num: 1, title: "Pick a colour", state: "closed", resolution: "answered" });
        const openDone = async (container: HTMLElement): Promise<void> => {
            const tab = [...container.querySelectorAll<HTMLButtonElement>(".mj_TrackerToggleTab")].find(
                (button) => button.textContent === "Done",
            )!;
            await act(async () => tab.click());
        };
        const mountInbox = async (client: MatronJournalClient): Promise<HTMLElement> => {
            const render = (root: Root): void =>
                root.render(
                    <ItemsInbox
                        items={client.getSnapshot().inboxItems ?? []}
                        done={client.getSnapshot().inboxDone}
                        client={client}
                        onOpenItem={jest.fn()}
                    />,
                );
            const { container, root } = await mount(<div />);
            await act(async () => render(root));
            client.subscribe(() => render(root));
            return container;
        };

        it("lists closed notices with closed questions, a seen notice reading Seen", async () => {
            const items = jest.fn().mockResolvedValue({ items: [seenNotice(), answered()], next_cursor: null });
            const client = clientWith({ inboxItems: [] }, { items });
            const container = await mountInbox(client);
            expect(items).not.toHaveBeenCalled();

            await openDone(container);

            expect(items).toHaveBeenCalledWith({
                state: "done",
                kind: ["question", "decision", "notice"],
                sort: "acted",
                limit: 50,
            });
            const rows = [...container.querySelectorAll(".mj_TrackerItemRow")];
            expect(rows.map((row) => row.querySelector(".mj_TrackerItemRow_title")?.textContent)).toEqual([
                "#9Deploy notes",
                "#1Pick a colour",
            ]);
            expect(rows[0].querySelector(".mj_TrackerItemRow_status")?.textContent).toBe("Seen");
            expect(rows[1].querySelector(".mj_TrackerItemRow_status")?.textContent).toBe("Answered");
            expect(container.querySelector(".mj_TrackerItemRow_seen")).toBeNull();
            expect(container.querySelector(".mj_TrackerShowMore")).toBeNull();
        });

        it("Show more appends the next page", async () => {
            const items = jest
                .fn()
                .mockResolvedValueOnce({ items: [seenNotice()], next_cursor: "c1" })
                .mockResolvedValueOnce({ items: [answered()], next_cursor: null });
            const client = clientWith({ inboxItems: [] }, { items });
            const container = await mountInbox(client);
            await openDone(container);
            expect(container.querySelectorAll(".mj_TrackerItemRow")).toHaveLength(1);

            await act(async () => container.querySelector<HTMLButtonElement>(".mj_TrackerShowMore")!.click());

            expect(items).toHaveBeenLastCalledWith(expect.objectContaining({ state: "done", cursor: "c1" }));
            expect(container.querySelectorAll(".mj_TrackerItemRow")).toHaveLength(2);
            expect(container.querySelector(".mj_TrackerShowMore")).toBeNull();
        });

        it("says what it collects when it is empty, and says so when it cannot load", async () => {
            const items = jest.fn().mockResolvedValueOnce({ items: [], next_cursor: null });
            const client = clientWith({ inboxItems: [] }, { items });
            const container = await mountInbox(client);
            await openDone(container);
            expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("Nothing done yet");

            items.mockRejectedValueOnce(new Error("offline"));
            await act(async () => client.loadInboxDone());
            expect(container.querySelector("[role='alert']")?.textContent).toBe("Couldn't load the Done list: offline");
            expect(container.querySelector(".mj_TrackerEmpty_title")).toBeNull();
        });
    });

    it("says what For you collects when nothing needs the user", async () => {
        const client = clientWith({ inboxItems: [] }, {});
        const { container } = await mount(<ItemsInbox items={[]} client={client} onOpenItem={jest.fn()} />);
        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("Nothing needs you");
        expect(container.querySelector(".mj_TrackerEmpty_hint")?.textContent).toBe(
            "Questions, things to read and secret requests from every conversation appear here.",
        );
    });

    it("the item detail labels a notice To read and its Seen button closes it", async () => {
        const postItemComment = jest.fn().mockResolvedValue({ item: closedNotice(), comment: {} });
        const item = jest.fn().mockResolvedValue({ item: closedNotice(), comments: [] });
        const client = clientWith(
            {
                trackerView: { open: true, view: "inbox", selectedItemId: 9 },
                trackerItem: { item: notice(), comments: [] },
            },
            { postItemComment, item },
        );
        const render = (root: Root): void => {
            const detail = client.getSnapshot().trackerItem!;
            root.render(
                <ItemDetail item={detail.item} comments={detail.comments} client={client} onBack={jest.fn()} />,
            );
        };
        const { container, root } = await mount(<div />);
        await act(async () => render(root));
        const unsubscribe = client.subscribe(() => render(root));

        expect(container.querySelector(".mj_TrackerItemHead_kind")?.textContent).toContain("To read");
        const seen = container.querySelector<HTMLButtonElement>(".mj_TrackerItemActions .mj_TrackerAction")!;
        expect(seen.textContent).toBe("Seen");
        await act(async () => seen.click());

        expect(postItemComment).toHaveBeenCalledWith(9, { action: "Seen", body: "Seen" }, expect.any(String));
        expect(container.querySelector(".mj_TrackerStatusPill")?.textContent).toBe("Closed · Done");
        expect(container.querySelector(".mj_TrackerItemActions")).toBeNull();
        unsubscribe();
    });
});
