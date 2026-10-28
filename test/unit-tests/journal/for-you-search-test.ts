/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { ItemsInbox, itemMatchesQuery } from "../../../src/journal/tracker/ItemsInbox";
import type { ClientState, TrackerItem } from "../../../src/journal/types";

function item(num: number, title: string, over: Partial<TrackerItem> = {}): TrackerItem {
    return {
        id: `it_${num}`,
        num,
        kind: "question",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: num,
        title,
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: num,
        updated_at: num,
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
        ...over,
    } as TrackerItem;
}

function makeClient(overrides: Partial<ClientState>): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        ...overrides,
    };
    return client;
}

function rowTitles(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".mj_TrackerItemRow_title")].map((el) => el.textContent ?? "");
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

describe("itemMatchesQuery", () => {
    const it1 = item(1755, "Design audit done", { body: "The side-by-side audit" });

    it("matches every word across number, title, text and origin", () => {
        expect(itemMatchesQuery(it1, "design", "deploy")).toBe(true);
        expect(itemMatchesQuery(it1, "AUDIT side", "deploy")).toBe(true);
        expect(itemMatchesQuery(it1, "audit deploy", "deploy")).toBe(true);
        expect(itemMatchesQuery(it1, "#1755", "deploy")).toBe(true);
        expect(itemMatchesQuery(it1, "1755", "deploy")).toBe(true);
        expect(itemMatchesQuery(it1, "design nginx", "deploy")).toBe(false);
    });

    it("lets an empty query through", () => {
        expect(itemMatchesQuery(it1, "   ", "")).toBe(true);
    });

    it("matches an item's new text once the item changes, and a renamed origin", () => {
        const before = item(1, "Old title");
        expect(itemMatchesQuery(before, "old", "chat")).toBe(true);
        const after = { ...before, title: "New title" };
        expect(itemMatchesQuery(after, "new", "chat")).toBe(true);
        expect(itemMatchesQuery(after, "old", "chat")).toBe(false);
        expect(itemMatchesQuery(after, "renamed", "renamed chat")).toBe(true);
        expect(itemMatchesQuery(after, "chat", "other")).toBe(false);
    });
});

describe("For you search field", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered!.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    async function render(items: TrackerItem[]): Promise<HTMLDivElement> {
        const client = makeClient({});
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(ItemsInbox, { items, client, onOpenItem: () => undefined }));
        });
        rendered = { container, root };
        return container;
    }

    it("filters the list as you type and says when nothing matches", async () => {
        const container = await render([
            item(1, "Pick the nginx timeout"),
            item(2, "Approve the design tokens"),
            item(3, "Design audit done"),
        ]);
        const input = container.querySelector<HTMLInputElement>('[data-testid="for-you-search"]')!;
        expect(input).not.toBeNull();
        expect(rowTitles(container)).toHaveLength(3);

        await type(input, "design");
        expect(rowTitles(container).map((t) => t.replace(/^#\d+\s*/, ""))).toEqual([
            "Design audit done",
            "Approve the design tokens",
        ]);

        await type(input, "kubernetes");
        expect(rowTitles(container)).toEqual([]);
        expect(container.textContent).toContain("No matches");

        await type(input, "");
        expect(rowTitles(container)).toHaveLength(3);
    });

    it("keeps the query across tab switches", async () => {
        const container = await render([
            item(1, "Pick the nginx timeout"),
            item(2, "Roll nginx config", { kind: "task", awaiting: "agent" }),
            item(3, "Approve the design tokens"),
        ]);
        const input = container.querySelector<HTMLInputElement>('[data-testid="for-you-search"]')!;
        await type(input, "nginx");
        expect(rowTitles(container)).toHaveLength(1);
        const allOpen = [...container.querySelectorAll("button")].find((b) => b.textContent === "All open")!;
        await act(async () => allOpen.click());
        expect(input.value).toBe("nginx");
        expect(rowTitles(container)).toHaveLength(2);
    });
});
