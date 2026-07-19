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

    it("hides linked children but keeps orphan children as top-level fallbacks", async () => {
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

        const names = [...container.querySelectorAll('[data-testid="room-name"]')].map(
            (element) => element.textContent,
        );
        expect(names).toEqual(["Root", "Orphan child"]);
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
            (button) => button.textContent === "Favorites",
        );
        await act(async () => favoritesTab?.click());

        expect(container.textContent).toContain("No favorite conversations yet.");
        expect(container.textContent).not.toContain("No favorites match your search.");
    });
});
