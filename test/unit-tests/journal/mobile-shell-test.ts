/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Mobile shell contracts: which region is visible on a phone (the sidebar and the main region are
 * mutually exclusive below the mobile breakpoint, toggled by CSS classes), the mobile bottom nav,
 * the connection status living in Settings rather than a persistent footer, and the
 * disconnected-only banner.
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
import { MatronApp } from "../../../src/journal/components";
import type { ClientState, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });

const CONVERSATION = {
    id: "c1",
    title: "One",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

interface ClientInternals {
    state: ClientState;
    patch(update: Partial<ClientState>): void;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInClient(overrides: Partial<ClientState> = {}): MatronJournalClient {
    const client = new MatronJournalClient();
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: undefined,
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
        ...overrides,
    };
    // The panes' load effects hit the network; the shell contracts below don't need data.
    jest.spyOn(client, "loadMissions").mockResolvedValue();
    jest.spyOn(client, "loadInbox").mockResolvedValue();
    return client;
}

let rendered: { container: HTMLDivElement; root: Root } | undefined;

async function render(client: MatronJournalClient): Promise<HTMLDivElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(MatronApp, { client }));
    });
    rendered = { container, root };
    return container;
}

async function patch(client: MatronJournalClient, update: Partial<ClientState>): Promise<void> {
    await act(async () => internals(client).patch(update));
}

afterEach(async () => {
    if (rendered) {
        const { root, container } = rendered;
        await act(async () => root.unmount());
        container.remove();
        rendered = undefined;
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
});

const sidebar = (container: HTMLElement): HTMLElement => container.querySelector(".mx_LeftPanel_outerWrapper")!;
const main = (container: HTMLElement): HTMLElement => container.querySelector(".mx_RoomView_wrapper")!;

describe("mobile region visibility", () => {
    // Root cause of "the tracker button does nothing on mobile": the sidebar was hidden only when a
    // CONVERSATION was selected, so opening the tracker (or Files) from the conversation list left
    // the full-width sidebar in place and squeezed the pane to zero width.
    it("hides the sidebar when the tracker opens from the conversation list", async () => {
        const client = signedInClient();
        const container = await render(client);
        expect(sidebar(container).classList.contains("mj_Sidebar_mobileHidden")).toBe(false);
        expect(main(container).classList.contains("mj_Chat_mobileHidden")).toBe(true);

        await act(async () => {
            container.querySelector<HTMLButtonElement>('.mj_NavRail_entry[data-nav="projects"]')!.click();
        });

        expect(container.querySelector(".mj_TrackerPane")).not.toBeNull();
        expect(sidebar(container).classList.contains("mj_Sidebar_mobileHidden")).toBe(true);
        expect(main(container).classList.contains("mj_Chat_mobileHidden")).toBe(false);
    });

    it("hides the sidebar when Files opens from the conversation list", async () => {
        const client = signedInClient();
        const container = await render(client);

        await patch(client, { filesView: { open: true, path: "/root" } });

        expect(sidebar(container).classList.contains("mj_Sidebar_mobileHidden")).toBe(true);
        expect(main(container).classList.contains("mj_Chat_mobileHidden")).toBe(false);
    });

    it("returns to the list when the tracker closes with no conversation selected", async () => {
        const client = signedInClient({ trackerView: { open: true, view: "inbox" } });
        const container = await render(client);

        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[aria-label="Close tracker"]')!.click();
        });

        expect(sidebar(container).classList.contains("mj_Sidebar_mobileHidden")).toBe(false);
        expect(main(container).classList.contains("mj_Chat_mobileHidden")).toBe(true);
    });
});

describe("connection banner (only when there is a problem)", () => {
    const banner = (container: HTMLElement): HTMLElement | null => container.querySelector(".mj_ConnectionBanner");

    it("is absent while online", async () => {
        const container = await render(signedInClient());
        expect(banner(container)).toBeNull();
    });

    it("appears after the grace delay when offline, with a Reconnect action", async () => {
        jest.useFakeTimers();
        const client = signedInClient({ connection: "offline" });
        const reconnect = jest.spyOn(client, "reconnect").mockImplementation(() => undefined);
        const container = await render(client);
        expect(banner(container)).toBeNull();

        await act(async () => {
            jest.advanceTimersByTime(3_000);
        });

        expect(banner(container)?.textContent).toContain("Offline");
        await act(async () => banner(container)!.querySelector<HTMLButtonElement>("button")!.click());
        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it("waits out a brief connecting blip before showing, and clears on reconnect", async () => {
        jest.useFakeTimers();
        const client = signedInClient();
        const container = await render(client);

        await patch(client, { connection: "connecting" });
        expect(banner(container)).toBeNull();

        await act(async () => {
            jest.advanceTimersByTime(3_000);
        });
        expect(banner(container)?.textContent).toContain("Reconnecting");

        await patch(client, { connection: "online" });
        expect(banner(container)).toBeNull();
    });
});
