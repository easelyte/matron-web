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

const conversation = (id: string, title: string, parent_convo_id?: string): Conversation => ({
    id,
    title,
    session_state: "done",
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
                conversation("root:sub:linked", "Linked child", "root"),
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

    it("shows a child as a top-level fallback when its parent is archived", async () => {
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

        const names = [...container.querySelectorAll('[data-testid="room-name"]')].map(
            (element) => element.textContent,
        );
        expect(names).toEqual(["Linked child"]);
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
        await clickTab("Favs");
        expect(childName().some((name) => name.includes("Linked child"))).toBe(false);

        // Archived: the archived child IS discoverable (flat top-level row) + unarchivable.
        await clickTab("Archived");
        expect(childName()).toEqual(["Linked child"]);
    });
});
