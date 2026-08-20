/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

import { MessageSearchResults, renderSnippet } from "../../../src/journal/components";
import type { MessageSearchState, SearchHit } from "../../../src/journal/types";

const NOW = 1_700_000_000_000;

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
    return {
        convo_id: "c1",
        title: "Deploy notes",
        seq: 42,
        ts: NOW,
        sender: "agent:dev-1",
        snippet: "the **rollout** window",
        live: false,
        ...overrides,
    };
}

function search(overrides: Partial<MessageSearchState> = {}): MessageSearchState {
    return { query: "rollout", hits: [hit()], loading: false, failed: false, ...overrides };
}

async function render(node: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(node);
    });
    return { container, root };
}

describe("renderSnippet", () => {
    it("turns **…** markers into <mark> highlights and leaves the rest as text", () => {
        const parts = renderSnippet("a **hit** b");
        // Three segments: "a ", "hit" (marked), " b".
        expect(parts).toHaveLength(3);
        expect(React.isValidElement(parts[1]) && (parts[1] as React.ReactElement).type).toBe("mark");
    });

    it("does not interpret HTML in the snippet", async () => {
        const { container, root } = await render(React.createElement("div", {}, renderSnippet("<b>not html</b>")));
        expect(container.querySelector("b")).toBeNull();
        expect(container.textContent).toContain("<b>not html</b>");
        await act(async () => root.unmount());
    });
});

describe("MessageSearchResults", () => {
    it("renders nothing when the query is blank", async () => {
        const { container, root } = await render(
            React.createElement(MessageSearchResults, { query: "  ", search: search(), now: NOW, onSelect: () => {} }),
        );
        expect(container.querySelector('[data-testid="message-search-results"]')).toBeNull();
        await act(async () => root.unmount());
    });

    it("renders nothing when the results are for a stale query", async () => {
        const { container, root } = await render(
            React.createElement(MessageSearchResults, {
                query: "current",
                search: search({ query: "stale" }),
                now: NOW,
                onSelect: () => {},
            }),
        );
        expect(container.querySelector('[data-testid="message-search-results"]')).toBeNull();
        await act(async () => root.unmount());
    });

    it("renders a hit with title, highlighted snippet, and a Messages heading", async () => {
        const { container, root } = await render(
            React.createElement(MessageSearchResults, {
                query: "rollout",
                search: search(),
                now: NOW,
                onSelect: () => {},
            }),
        );
        expect(container.textContent).toContain("Messages");
        expect(container.querySelector(".mj_SearchHit_title")?.textContent).toBe("Deploy notes");
        expect(container.querySelector("mark.mj_SearchHit_mark")?.textContent).toBe("rollout");
        await act(async () => root.unmount());
    });

    it("calls onSelect with the hit's conversation id when clicked", async () => {
        const onSelect = jest.fn();
        const { container, root } = await render(
            React.createElement(MessageSearchResults, {
                query: "rollout",
                search: search({ hits: [hit({ convo_id: "c9" })] }),
                now: NOW,
                onSelect,
            }),
        );
        const btn = container.querySelector<HTMLButtonElement>(".mj_SearchHit")!;
        await act(async () => {
            btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onSelect).toHaveBeenCalledWith("c9");
        await act(async () => root.unmount());
    });

    it("shows an empty-state message when a settled search has no hits", async () => {
        const { container, root } = await render(
            React.createElement(MessageSearchResults, {
                query: "rollout",
                search: search({ hits: [], loading: false }),
                now: NOW,
                onSelect: () => {},
            }),
        );
        expect(container.textContent).toContain("No messages match your search.");
        await act(async () => root.unmount());
    });

    it("shows a searching state while loading with no hits yet (never stale rows)", async () => {
        const { container, root } = await render(
            React.createElement(MessageSearchResults, {
                query: "rollout",
                search: search({ hits: [], loading: true }),
                now: NOW,
                onSelect: () => {},
            }),
        );
        expect(container.textContent).toContain("Searching…");
        expect(container.querySelector(".mj_SearchHit")).toBeNull();
        await act(async () => root.unmount());
    });

    it("shows a failure message when the search failed", async () => {
        const { container, root } = await render(
            React.createElement(MessageSearchResults, {
                query: "rollout",
                search: search({ hits: [], failed: true }),
                now: NOW,
                onSelect: () => {},
            }),
        );
        expect(container.textContent).toContain("Search is unavailable right now.");
        await act(async () => root.unmount());
    });
});
