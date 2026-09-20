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

    it("renders a mission chip only when the item is attached to a mission", async () => {
        const withMission = await mount(<ItemRow item={trackerItem({ mission_num: 8 })} onOpen={jest.fn()} />);
        expect(withMission.container.querySelector(".mj_TrackerItemRow_missionChip")?.textContent).toContain("#8");

        const without = await mount(<ItemRow item={trackerItem({ mission_num: null })} onOpen={jest.fn()} />);
        expect(without.container.querySelector(".mj_TrackerItemRow_missionChip")).toBeNull();
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

    describe("provenance chip (#213)", () => {
        it("names the origin session for a cross-session row in the all scope", async () => {
            const { container } = await mount(
                <ItemRow
                    item={trackerItem({ origin_convo_id: "c-other", origin_convo_title: "MATRON wave" })}
                    scope="all"
                    currentConvoId="c-here"
                    onOpen={jest.fn()}
                />,
            );
            const origin = container.querySelector(".mj_TrackerItemRow_origin");
            expect(origin?.textContent).toBe("from MATRON wave");
            expect(container.querySelector(".mj_TrackerItemRow_routeElsewhere")).toBeNull();
        });

        it("shows no origin chip when the row is from the viewing session", async () => {
            const { container } = await mount(
                <ItemRow
                    item={trackerItem({ origin_convo_id: "c-here", origin_convo_title: "here" })}
                    scope="all"
                    currentConvoId="c-here"
                    onOpen={jest.fn()}
                />,
            );
            expect(container.querySelector(".mj_TrackerItemRow_origin")).toBeNull();
        });

        it("renders the actionable Handle-elsewhere chip in any scope, even from the origin session", async () => {
            const { container } = await mount(
                <ItemRow
                    item={trackerItem({
                        origin_convo_id: "c-here",
                        origin_convo_title: "here",
                        labels: ["route-elsewhere"],
                    })}
                    currentConvoId="c-here"
                    onOpen={jest.fn()}
                />,
            );
            const chip = container.querySelector(".mj_TrackerItemRow_routeElsewhere");
            expect(chip?.textContent).toContain("Handle elsewhere");
        });

        it("adds no origin chip in the default (chat) scope without a viewer id", async () => {
            const { container } = await mount(
                <ItemRow item={trackerItem({ origin_convo_id: "c-other" })} onOpen={jest.fn()} />,
            );
            expect(container.querySelector(".mj_TrackerItemRow_origin")).toBeNull();
        });
    });
});
