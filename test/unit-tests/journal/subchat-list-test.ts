/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import type { ClientState, Conversation, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "user",
};

interface ClientInternals {
    state: ClientState;
}

const conversation = (
    id: string,
    title: string,
    parent_convo_id?: string,
    session_state: Conversation["session_state"] = "done",
): Conversation => ({
    id,
    title,
    session_state,
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    parent_convo_id,
    read_up_to_seq: 0,
});

describe("subchat conversation list", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it("nests linked children under their parent and keeps orphan children as top-level fallbacks", async () => {
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [
                conversation("root", "Root"),
                // #533: a nested child only renders while RUNNING, so the linked child must be
                // running to appear beneath its parent. The orphan (missing parent) is a
                // top-level fallback and is NOT subject to the active-only gate.
                conversation("root:sub:linked", "Linked child", "root", "running"),
                conversation("missing:sub:orphan", "Orphan child", "missing"),
            ],
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        const rows = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomListItem")];
        const names = rows.map((row) => row.querySelector('[data-testid="room-name"]')?.textContent);
        // #532: the linked child now renders nested (↳ prefix) beneath its parent; the orphan
        // (missing parent) stays a top-level fallback.
        expect(names).toEqual(["Root", "↳ Linked child", "Orphan child"]);
        const childRow = rows[1];
        expect(childRow.classList.contains("mj_RoomListItem_sub")).toBe(true);
        // The parent's own row is NOT a subagent row.
        expect(rows[0].classList.contains("mj_RoomListItem_sub")).toBe(false);
    });

    it("nests only RUNNING children in Active/Favorites; a done child drops out but Archived is unchanged (#533)", async () => {
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [
                conversation("root", "Root", undefined, "running"),
                conversation("root:sub:running", "Running child", "root", "running"),
                conversation("root:sub:done", "Done child", "root", "done"),
                conversation("root:sub:archived", "Archived child", "root", "done"),
            ],
            // The archived child is archived regardless of its (done) session state.
            archivedIds: new Set(["root:sub:archived"]),
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root.render(React.createElement(MatronApp, { client })));

        const names = (): string[] =>
            [...container.querySelectorAll('[data-testid="room-name"]')].map((element) => element.textContent ?? "");
        const clickTab = async (label: string): Promise<void> => {
            const tab = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomListTab")].find((button) =>
                (button.textContent ?? "").includes(label),
            );
            await act(async () => tab?.click());
        };

        // Active: only the RUNNING child nests; the done child does NOT render a sidebar row.
        expect(names()).toEqual(["Root", "↳ Running child"]);
        expect(names().some((name) => name.includes("Done child"))).toBe(false);

        // The done child is NOT dropped from the store — it stays in state.conversations so the
        // header pill strip can still surface it when the parent is selected.
        expect(client.getSnapshot().conversations.some((c) => c.id === "root:sub:done")).toBe(true);

        // Archived tab: the archived child is discoverable regardless of its (done) session state
        // — the active-only gate does not apply here (behavior unchanged from #532).
        await clickTab("Archived");
        expect(names()).toEqual(["Archived child"]);
    });

    it("hides a done child whose (archived) parent still exists — not top-level, not in Active (#536)", async () => {
        // The blocker: a parent that EXISTS but is archived is NOT an orphan, so its done
        // child must be filtered like any other done child — it must NOT reappear as a
        // permanent top-level room. (Previously the fallback path bypassed the transient gate.)
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("root", "Root"), conversation("root:sub:linked", "Linked child", "root")],
            archivedIds: new Set(["root"]),
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        const names = (): string[] =>
            [...container.querySelectorAll('[data-testid="room-name"]')].map((element) => element.textContent ?? "");
        const clickTab = async (label: string): Promise<void> => {
            const tab = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomListTab")].find((button) =>
                (button.textContent ?? "").includes(label),
            );
            await act(async () => tab?.click());
        };

        // Active: the archived parent is gone AND its done child does not leak in.
        expect(names()).toEqual([]);
        expect(container.textContent).toContain("No active conversations.");
        // The done child is not archived either, so it appears nowhere in the flat Archived tab.
        await clickTab("Archived");
        expect(names()).toEqual(["Root"]);
    });

    it("keeps a genuinely orphaned child (missing parent) visible top-level regardless of state (#536)", async () => {
        // Recovery path: only a truly MISSING parent (id absent from state) grants a child
        // unconditional top-level visibility — even when the child itself is done.
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("orphan:child", "Orphan child", "deleted-parent")],
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        const names = [...container.querySelectorAll('[data-testid="room-name"]')].map(
            (element) => element.textContent,
        );
        expect(names).toEqual(["Orphan child"]);
    });

    it("shows a RUNNING child of an archived parent top-level (transient), not a permanent room (#536)", async () => {
        // A running child of an archived parent can't nest (its parent isn't an Active row),
        // so it renders top-level — but per the transient rule, not permanently: once it is
        // done it is hidden (covered by the archived-parent-done-child test above).
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [
                conversation("root", "Root"),
                conversation("root:sub:run", "Running child", "root", "running"),
            ],
            archivedIds: new Set(["root"]),
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        // Top-level (NOT nested — its parent is archived, so there is no parent row to nest under).
        const rows = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomListItem")];
        const names = rows.map((row) => row.querySelector('[data-testid="room-name"]')?.textContent);
        expect(names).toEqual(["Running child"]);
        expect(rows[0].classList.contains("mj_RoomListItem_sub")).toBe(false);
    });

    it("does not target a hidden done child of an archived parent in mark-all (#536)", async () => {
        // Blocker 1: the hidden child has no row and no Mark-all button; mark-all must not
        // target it either, or its unread override would be stuck with no way to clear it.
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("root", "Root"), conversation("root:sub:linked", "Linked child", "root")],
            archivedIds: new Set(["root"]),
            unreadOverrideIds: new Set(["root:sub:linked"]),
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        // No Mark-all button (the hidden child is not an active-unread row) and mark-all leaves
        // the override untouched (the hidden child is never a target).
        expect(container.querySelector('button[aria-label="Mark all as read"]')).toBeNull();
        await act(async () => client.markAllRead());
        expect(client.getSnapshot().unreadOverrideIds).toEqual(new Set(["root:sub:linked"]));
    });

    it("renders a running grandchild top-level (never lost) and hides a done grandchild (#536)", async () => {
        // Blocker 2: nesting is capped at one level. A running grandchild (its direct parent is
        // itself a nested child) can't nest, so it must render TOP-LEVEL rather than being
        // pulled from the list and never rendered. A done grandchild stays hidden.
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [
                conversation("gp", "Grandparent", undefined, "running"),
                conversation("gp:p", "Parent child", "gp", "running"),
                conversation("gp:p:g", "Grandchild", "gp:p", "running"),
                conversation("gp:p:g2", "Done grandchild", "gp:p", "done"),
            ],
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        const rows = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomListItem")];
        const names = rows.map((row) => row.querySelector('[data-testid="room-name"]')?.textContent);
        // Grandparent, its nested running child, then the running grandchild as a top-level row.
        // The done grandchild is hidden. No running descendant is lost.
        expect(names).toEqual(["Grandparent", "↳ Parent child", "Grandchild"]);
        // The grandchild renders as a top-level row (not an indented subagent row).
        const grandchildRow = rows[2];
        expect(grandchildRow.classList.contains("mj_RoomListItem_sub")).toBe(false);
    });

    it("renders a running grandchild rooted at an ARCHIVED parent (terminal case, not lost) (#536)", async () => {
        // The case the parentPresent host approximation lost: archived A → done child B (hidden)
        // → running grandchild C. B is not a real top-level row, so C must resolve top-level and
        // get a row — B's "not active" appearance must not be mistaken for host eligibility.
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [
                conversation("A", "Root A"),
                conversation("A:B", "Child B", "A", "done"),
                conversation("A:B:C", "Grandchild C", "A:B", "running"),
            ],
            archivedIds: new Set(["A"]),
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        const rows = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomListItem")];
        const names = rows.map((row) => row.querySelector('[data-testid="room-name"]')?.textContent);
        // Only the running grandchild renders (top-level row); the archived root and the hidden
        // done child do not.
        expect(names).toEqual(["Grandchild C"]);
        expect(rows[0].classList.contains("mj_RoomListItem_sub")).toBe(false);
    });

    it("excludes a linked child's unread override from the active aggregate and mark-all", async () => {
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("root", "Root"), conversation("root:sub:linked", "Linked child", "root")],
            unreadOverrideIds: new Set(["root:sub:linked"]),
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });

        expect(container.querySelector('button[aria-label="Mark all as read"]')).toBeNull();
        await act(async () => client.markAllRead());
        expect(client.getSnapshot().unreadOverrideIds).toEqual(new Set(["root:sub:linked"]));
    });

    it("excludes a linked child from the favorite aggregate", async () => {
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("root", "Root"), conversation("root:sub:linked", "Linked child", "root")],
            favoriteIds: new Set(["root:sub:linked"]),
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        await act(async () => {
            root.render(React.createElement(MatronApp, { client }));
        });
        const favoritesTab = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
            (button) => button.getAttribute("aria-label") === "Favorites",
        );
        await act(async () => favoritesTab?.click());

        expect(container.textContent).toContain("No favorite conversations yet.");
        expect(container.textContent).not.toContain("No favorites match your search.");
    });

    it("keeps an archived child out of Active/Favorites and discoverable in Archived (#532)", async () => {
        const client = new MatronJournalClient();
        const state = client.getSnapshot();
        (client as unknown as ClientInternals).state = {
            ...state,
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("root", "Root"), conversation("root:sub:linked", "Linked child", "root")],
            // The child is archived while its parent stays active.
            archivedIds: new Set(["root:sub:linked"]),
            favoriteIds: new Set(["root"]),
            selectedConversationId: undefined,
            connection: "online",
        };
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root.render(React.createElement(MatronApp, { client })));

        const childName = (): string[] =>
            [...container.querySelectorAll('[data-testid="room-name"]')].map((element) => element.textContent ?? "");
        const clickTab = async (label: string): Promise<void> => {
            const tab = [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomListTab")].find((button) =>
                (button.textContent ?? "").includes(label),
            );
            await act(async () => tab?.click());
        };

        // Active (default): the archived child must NOT leak in under its active parent.
        expect(childName()).toEqual(["Root"]);
        expect(childName().some((name) => name.includes("Linked child"))).toBe(false);

        // Favorites (parent favorited): the archived child must NOT leak in either.
        await clickTab("Favorites");
        expect(childName().some((name) => name.includes("Linked child"))).toBe(false);

        // Archived: the archived child IS discoverable (flat top-level row) + unarchivable.
        await clickTab("Archived");
        expect(childName()).toEqual(["Linked child"]);
    });
});
