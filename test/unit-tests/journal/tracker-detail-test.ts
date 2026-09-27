/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { ItemDetail } from "../../../src/journal/tracker/ItemDetail";
import type { TrackerItem } from "../../../src/journal/types";

function item(over: Partial<TrackerItem> = {}): TrackerItem {
    return {
        id: "it_1",
        num: 1,
        kind: "task",
        state: "open",
        resolution: null,
        awaiting: "agent",
        rank: 0,
        title: "Ship it",
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
        ...over,
    };
}

async function renderDetail(record: TrackerItem): Promise<{
    container: HTMLDivElement;
    root: Root;
    client: MatronJournalClient;
}> {
    const client = new MatronJournalClient();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(ItemDetail, { item: record, comments: [], client, onBack: () => undefined }));
    });
    return { container, root, client };
}

function chips(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(".mj_TrackerLinkChip")];
}

describe("ItemDetail link chips", () => {
    let rendered: { container: HTMLDivElement; root: Root; client: MatronJournalClient } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("keeps http(s) links as external anchors", async () => {
        rendered = await renderDetail(
            item({
                links: [{ url: "https://github.com/o/r/pull/1", title: "PR" }, { url: "http://example.com/spec" }],
            }),
        );
        const [https, http] = chips(rendered.container);
        expect(https).toBeInstanceOf(HTMLAnchorElement);
        expect((https as HTMLAnchorElement).getAttribute("href")).toBe("https://github.com/o/r/pull/1");
        expect((https as HTMLAnchorElement).target).toBe("_blank");
        expect(https.textContent).toBe("PR");
        expect(http).toBeInstanceOf(HTMLAnchorElement);
        expect((http as HTMLAnchorElement).getAttribute("href")).toBe("http://example.com/spec");
        expect(http.textContent).toBe("http://example.com/spec");
    });

    it("opens a matron://item/N link in-app instead of handing the scheme to the browser", async () => {
        rendered = await renderDetail(item({ links: [{ url: "matron://item/7", title: "Related item" }] }));
        const { client, container } = rendered;
        const open = jest.spyOn(client, "openTrackerLink").mockImplementation(() => undefined);
        const [chip] = chips(container);
        expect(chip).toBeInstanceOf(HTMLAnchorElement);
        expect((chip as HTMLAnchorElement).target).toBe("");
        expect(chip.textContent).toBe("Related item");

        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        await act(async () => {
            chip.dispatchEvent(click);
        });
        expect(click.defaultPrevented).toBe(true);
        expect(open).toHaveBeenCalledWith("item", 7);
    });

    it("opens a matron://mission/N link in-app too", async () => {
        rendered = await renderDetail(item({ links: [{ url: "matron://mission/5", title: "Its mission" }] }));
        const { client, container } = rendered;
        const open = jest.spyOn(client, "openTrackerLink").mockImplementation(() => undefined);
        const [chip] = chips(container);
        expect(chip).toBeInstanceOf(HTMLAnchorElement);
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        await act(async () => {
            chip.dispatchEvent(click);
        });
        expect(click.defaultPrevented).toBe(true);
        expect(open).toHaveBeenCalledWith("mission", 5);
    });

    it("renders any other non-http(s) link as inert text", async () => {
        rendered = await renderDetail(
            item({
                links: [
                    { url: "matron://consent/abc", title: "Consent card" },
                    { url: "matron://item/0", title: "Bad item" },
                    { url: "javascript:alert(1)" },
                ],
            }),
        );
        const all = chips(rendered.container);
        expect(all).toHaveLength(3);
        for (const chip of all) expect(chip).not.toBeInstanceOf(HTMLAnchorElement);
        expect(rendered.container.querySelector("a")).toBeNull();
        expect(all.map((chip) => chip.textContent)).toEqual(["Consent card", "Bad item", "javascript:alert(1)"]);
    });
});
