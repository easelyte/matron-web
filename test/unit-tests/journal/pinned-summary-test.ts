/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import {
    archiveStore,
    favoriteStore,
    MatronJournalClient,
    pinnedStore,
    unreadStore,
} from "../../../src/journal/client";
import { MatronApp, PinnedSummary, type ConversationSummary } from "../../../src/journal/components";
import { conversationSummary, parseSummaryBullets } from "../../../src/journal/summary";
import type { ClientState, Conversation, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

function conversation(overrides: Partial<Conversation> & { id: string }): Conversation {
    return {
        title: "One",
        session_state: "running",
        last_seq: 1,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        read_up_to_seq: 0,
        ...overrides,
    };
}

function signedInWith(conversations: Conversation[], selectedId: string): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = client as unknown as { state: ClientState };
    internals.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        selectedConversationId: selectedId,
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(element);
    });
    return { container, root };
}

describe("parseSummaryBullets", () => {
    it("strips the wire bullet marker so the list does not double it", () => {
        expect(parseSummaryBullets("• shipped the parser\n• wired the mount")).toEqual([
            "shipped the parser",
            "wired the mount",
        ]);
    });

    it("returns no bullets for absent or empty text", () => {
        expect(parseSummaryBullets(undefined)).toEqual([]);
        expect(parseSummaryBullets(null)).toEqual([]);
        expect(parseSummaryBullets("")).toEqual([]);
        expect(parseSummaryBullets("   \n\n  ")).toEqual([]);
    });

    it("drops blank lines and trims each bullet", () => {
        expect(parseSummaryBullets("•  padded  \n\n\n•\ttabbed\n")).toEqual(["padded", "tabbed"]);
    });

    it("drops a marker-only line rather than emitting an empty bullet", () => {
        expect(parseSummaryBullets("• real\n•\n•   ")).toEqual(["real"]);
    });

    it("attaches an unmarked line to the bullet it follows, per the producer's grammar", () => {
        // matron-bridge exports summaryBlocks() so every consumer agrees what a bullet is: a
        // marked line opens a block and following unmarked lines continue it. Dropping them
        // would delete exactly the "…but it is blocked on X" half of a wrapped bullet.
        expect(parseSummaryBullets("\u2022 Deployed\nBlocked on DNS\n\u2022 Next step")).toEqual([
            "Deployed Blocked on DNS",
            "Next step",
        ]);
    });

    it("gives a leading unmarked line its own bullet", () => {
        // Same grammar: with no open block, an unmarked line starts one. The bridge's
        // compaction path can let a codex preamble reach the column this way; it renders
        // rather than vanishing, which is what the producer and the roster blurb also do.
        expect(parseSummaryBullets("Here are the 3 bullets:\n\u2022 first\n\u2022 second")).toEqual([
            "Here are the 3 bullets:",
            "first",
            "second",
        ]);
    });

    it("degrades to no bullets on a non-string value instead of throwing mid-render", () => {
        // The snapshot row is cast, not parsed, and is persisted verbatim — a throw here would
        // wedge the app on every render AND survive reload, since the bad value is in IndexedDB.
        for (const value of [{}, 42, [], true]) {
            expect(parseSummaryBullets(value as unknown as string)).toEqual([]);
        }
        expect(conversationSummary({ summary: {} as unknown as string })).toBeNull();
    });

    it("renders unmarked prose as a single bullet", () => {
        // The column is documented upstream as a prose roster blurb; such a value must render
        // rather than vanish, and it is one statement, so it is one block.
        expect(parseSummaryBullets("A rolling prose blurb.")).toEqual(["A rolling prose blurb."]);
        expect(parseSummaryBullets("line one\nline two")).toEqual(["line one line two"]);
    });
});

describe("conversationSummary", () => {
    it("returns null — not empty bullets — when there is nothing to show", () => {
        // null renders nothing; {bullets: []} renders a "No summary yet" box. Every undigested
        // conversation must stay pixel-identical to before this surface had a feed.
        expect(conversationSummary(undefined)).toBeNull();
        expect(conversationSummary(null)).toBeNull();
        expect(conversationSummary({})).toBeNull();
        expect(conversationSummary({ summary: "" })).toBeNull();
        expect(conversationSummary({ summary: "   " })).toBeNull();
        expect(conversationSummary({ summary: "", summary_updated_at: 1_700_000_000_000 })).toBeNull();
    });

    it("builds a ready summary from the stored digest", () => {
        expect(conversationSummary({ summary: "• a\n• b", summary_updated_at: 1_700_000_000_000 })).toEqual({
            bullets: ["a", "b"],
            state: "ready",
            updatedAtMs: 1_700_000_000_000,
        });
    });

    it("omits updatedAtMs entirely when the server reports no change time", () => {
        // 0 means "never written" on the wire. Passing it through would label the bar with an
        // age measured from the 1970 epoch.
        for (const value of [undefined, 0, -1, Number.NaN]) {
            const result = conversationSummary({ summary: "• a", summary_updated_at: value });
            expect(result).toEqual({ bullets: ["a"], state: "ready" });
            expect(result && "updatedAtMs" in result).toBe(false);
        }
    });
});

describe("PinnedSummary rendering", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        await act(async () => rendered?.root.unmount());
        rendered?.container.remove();
        rendered = undefined;
    });

    it("renders nothing at all for a null summary", async () => {
        rendered = await render(React.createElement(PinnedSummary, { summary: null }));
        expect(rendered.container.querySelector(".mj_PinnedSummary")).toBeNull();
        expect(rendered.container.innerHTML).toBe("");
    });

    it("renders one item per bullet and no age label when the time is unknown", async () => {
        const summary: ConversationSummary = { bullets: ["first", "second"], state: "ready" };
        rendered = await render(React.createElement(PinnedSummary, { summary }));
        const items = [...rendered.container.querySelectorAll(".mj_PinnedSummary_item")];
        expect(items.map((item) => item.textContent)).toEqual(["first", "second"]);
        expect(rendered.container.querySelector(".mj_PinnedSummary_meta")).toBeNull();
    });

    it("renders a relative age label when the time is known", async () => {
        const summary: ConversationSummary = {
            bullets: ["first"],
            state: "ready",
            updatedAtMs: Date.now() - 5 * 60_000,
        };
        rendered = await render(React.createElement(PinnedSummary, { summary }));
        expect(rendered.container.querySelector(".mj_PinnedSummary_meta")?.textContent).toBe("updated 5m ago");
    });

    it("clamps an over-long bullet behind an Expand toggle", async () => {
        const long = `${"x".repeat(200)} tail`;
        rendered = await render(React.createElement(PinnedSummary, { summary: { bullets: [long] } }));
        const clamped = (): Element | null => rendered!.container.querySelector(".mj_PinnedSummary_item_clamp");
        const more = (): HTMLButtonElement | null =>
            rendered!.container.querySelector<HTMLButtonElement>(".mj_PinnedSummary_more");
        expect(clamped()).not.toBeNull();
        expect(more()?.textContent).toBe("Expand");
        await act(async () => more()?.click());
        expect(clamped()).toBeNull();
        expect(more()?.textContent).toBe("Show less");
        await act(async () => more()?.click());
        expect(clamped()).not.toBeNull();
    });

    it("shows the empty-state box only when bullets are explicitly empty", async () => {
        // Unreachable from the app (conversationSummary returns null instead) — kept covered
        // because the component branch still exists.
        rendered = await render(React.createElement(PinnedSummary, { summary: { bullets: [] } }));
        expect(rendered.container.querySelector(".mj_PinnedSummary_empty")).not.toBeNull();
    });
});

describe("pinned summary in the app", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeEach(() => localStorage.clear());

    afterEach(async () => {
        await act(async () => rendered?.root.unmount());
        rendered?.container.remove();
        rendered = undefined;
    });

    it("feeds the selected conversation's stored digest into the pinned bar", async () => {
        const client = signedInWith(
            [conversation({ id: "c1", summary: "• parsed the digest\n• mounted the bar", summary_updated_at: 0 })],
            "c1",
        );
        rendered = await render(React.createElement(MatronApp, { client }));
        const items = [...rendered.container.querySelectorAll(".mj_PinnedSummary_item")];
        expect(items.map((item) => item.textContent)).toEqual(["parsed the digest", "mounted the bar"]);
        // summary_updated_at: 0 (the server's "never") must not become a 1970 age label.
        expect(rendered.container.querySelector(".mj_PinnedSummary_meta")).toBeNull();
    });

    it("renders no bar for a conversation without a digest", async () => {
        const client = signedInWith([conversation({ id: "c1", summary: "" })], "c1");
        rendered = await render(React.createElement(MatronApp, { client }));
        expect(rendered.container.querySelector(".mj_PinnedSummary")).toBeNull();
    });

    it("renders no bar for a sub-chat, whose parent's digest is not its own", async () => {
        // The bridge's summary pass is per-session, so children never carry one.
        const client = signedInWith(
            [
                conversation({ id: "c1", summary: "• parent work" }),
                conversation({ id: "s1", parent_convo_id: "c1", title: "child" }),
            ],
            "s1",
        );
        rendered = await render(React.createElement(MatronApp, { client }));
        expect(rendered.container.querySelector(".mj_PinnedSummary")).toBeNull();
    });

    it("renders no bar against a server that sends no summary field at all", async () => {
        const client = signedInWith([conversation({ id: "c1" })], "c1");
        rendered = await render(React.createElement(MatronApp, { client }));
        expect(rendered.container.querySelector(".mj_PinnedSummary")).toBeNull();
    });
});
