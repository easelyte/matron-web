/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ItemRow } from "../tracker/ItemRow";
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

describe("ItemRow", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("renders the #number and title", async () => {
        const { container } = await mount(
            <ItemRow item={trackerItem({ num: 42, title: "Pick a colour" })} onOpen={jest.fn()} />,
        );

        expect(container.querySelector(".mj_TrackerItemRow_num")?.textContent).toBe("#42");
        expect(container.querySelector(".mj_TrackerItemRow_title")?.textContent).toContain("Pick a colour");
    });

    it("shows the orange needs-you token for an open item awaiting the user", async () => {
        const { container } = await mount(
            <ItemRow item={trackerItem({ state: "open", awaiting: "user" })} onOpen={jest.fn()} />,
        );

        const token = container.querySelector(".mj_TrackerItemRow_status_needsyou");
        expect(token?.textContent).toBe("Needs you");
        expect(container.querySelector(".mj_TrackerItemRow_needsyou")).not.toBeNull();
    });

    it("shows a muted With the agent token for an open agent-side item", async () => {
        const { container } = await mount(
            <ItemRow item={trackerItem({ state: "open", awaiting: "agent" })} onOpen={jest.fn()} />,
        );

        const token = container.querySelector(".mj_TrackerItemRow_status_muted");
        expect(token?.textContent).toBe("With the agent");
        expect(container.querySelector(".mj_TrackerItemRow_status_needsyou")).toBeNull();
    });

    it("shows the resolution label for a closed item", async () => {
        const { container } = await mount(
            <ItemRow
                item={trackerItem({ state: "closed", awaiting: null, resolution: "done", kind: "task" })}
                onOpen={jest.fn()}
            />,
        );

        expect(container.querySelector(".mj_TrackerItemRow_status_muted")?.textContent).toBe("Done");
    });

    it("shows exactly one status token", async () => {
        const { container } = await mount(
            <ItemRow item={trackerItem({ state: "open", awaiting: "user" })} onOpen={jest.fn()} />,
        );

        expect(container.querySelectorAll(".mj_TrackerItemRow_status")).toHaveLength(1);
    });

    it("renders the comment count only when there are comments", async () => {
        const withComments = await mount(<ItemRow item={trackerItem({ comment_count: 3 })} onOpen={jest.fn()} />);
        expect(withComments.container.querySelector(".mj_TrackerItemRow_comments")?.textContent).toContain("3");

        const none = await mount(<ItemRow item={trackerItem({ comment_count: 0 })} onOpen={jest.fn()} />);
        expect(none.container.querySelector(".mj_TrackerItemRow_comments")).toBeNull();
    });

    it("calls onOpen with the item number when clicked", async () => {
        const onOpen = jest.fn();
        const { container } = await mount(<ItemRow item={trackerItem({ num: 77 })} onOpen={onOpen} />);

        await act(async () => {
            container.querySelector<HTMLButtonElement>(".mj_TrackerItemRow")!.click();
        });

        expect(onOpen).toHaveBeenCalledWith(77);
    });

    describe("origin note", () => {
        it("names the origin conversation for a row from another conversation", async () => {
            const { container } = await mount(
                <ItemRow
                    item={trackerItem({ origin_convo_id: "c-other" })}
                    scope="all"
                    originTitle="Auth refactor"
                    currentConvoId="c-here"
                    onOpen={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerItemRow_origin")?.textContent).toBe("from Auth refactor");
            expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("from Auth refactor");
        });

        it("adds no origin note to a row filed from the conversation being viewed", async () => {
            const { container } = await mount(
                <ItemRow
                    item={trackerItem({ origin_convo_id: "c-here" })}
                    scope="all"
                    originTitle="This chat"
                    currentConvoId="c-here"
                    onOpen={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerItemRow_origin")).toBeNull();
            expect(container.querySelector("button")?.getAttribute("aria-label")).not.toContain("This chat");
        });

        it("still names the origin when the viewer is unknown", async () => {
            const { container } = await mount(
                <ItemRow
                    item={trackerItem({ origin_convo_id: "c1" })}
                    scope="all"
                    originTitle="Brand chat"
                    onOpen={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerItemRow_origin")?.textContent).toBe("from Brand chat");
        });

        it("adds no origin note in the chat scope", async () => {
            const { container } = await mount(
                <ItemRow
                    item={trackerItem({ origin_convo_id: "c-other" })}
                    originTitle="Auth refactor"
                    currentConvoId="c-here"
                    onOpen={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerItemRow_origin")).toBeNull();
        });
    });
});
