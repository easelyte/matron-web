/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import type { ClientState, Conversation, Session } from "../types";
import { trackerItem } from "./tracker-fixtures";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

const convo = (id: string, over: Partial<Conversation> = {}): Conversation => ({
    id,
    title: `Chat ${id}`,
    session_state: "idle",
    last_seq: 5,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 5,
    ...over,
});

function signedInClient(conversations: Conversation[], archived: string[] = []): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        selectedConversationId: conversations[0]?.id,
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: new Set(archived),
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

describe("NavRail", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
    });

    beforeEach(() => {
        localStorage.clear();
        archiveStore.read(SESSION);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function render(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
    }

    const entries = (): HTMLButtonElement[] => [
        ...container.querySelectorAll<HTMLButtonElement>('[data-testid="nav-rail"] button[data-nav]'),
    ];
    const entry = (key: string): HTMLButtonElement =>
        container.querySelector<HTMLButtonElement>(`button[data-nav="${key}"]`)!;

    it("shows the four Mac entries in order, then the fork entries, and marks Conversations current", async () => {
        await render(signedInClient([convo("c1")]));
        expect(entries().map((button) => button.dataset.nav)).toEqual([
            "coordinator",
            "projects",
            "decisions",
            "conversations",
            "memories",
            "files",
            "ops",
            "search",
        ]);
        expect(entries().map((button) => button.textContent)).toEqual([
            "Coordinator",
            "Projects",
            "For you",
            "Conversations",
            "Memories",
            "Files",
            "Ops",
            "Search",
        ]);
        expect(entry("conversations").getAttribute("aria-current")).toBe("page");
        expect(entry("projects").getAttribute("aria-current")).toBeNull();
    });

    it("opens the tracker views from the rail and returns to conversations", async () => {
        const client = signedInClient([convo("c1")]);
        await render(client);
        await act(async () => entry("projects").click());
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "missions" });
        expect(entry("projects").getAttribute("aria-current")).toBe("page");
        expect(entry("conversations").getAttribute("aria-current")).toBeNull();
        await act(async () => entry("decisions").click());
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "inbox" });
        await act(async () => entry("memories").click());
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "memories" });
        await act(async () => entry("conversations").click());
        expect(client.getSnapshot().trackerView?.open).toBeFalsy();
        expect(entry("conversations").getAttribute("aria-current")).toBe("page");
    });

    it("badges Conversations with the unread total, excluding archived rows", async () => {
        await render(
            signedInClient(
                [
                    convo("c1", { unread_count: 3, read_up_to_seq: 2 }),
                    convo("c2", { unread_count: 2, read_up_to_seq: 3 }),
                    convo("c3"),
                ],
                ["c2"],
            ),
        );
        expect(entry("conversations").querySelector(".mj_NavRail_badge")?.textContent).toBe("3");
        expect(entry("conversations").getAttribute("aria-label")).toBe("Conversations, 3 unread");
        expect(entry("projects").querySelector(".mj_NavRail_badge")).toBeNull();
    });

    it("badges For you with the open items awaiting the user", async () => {
        const client = signedInClient([convo("c1")]);
        (client as unknown as { state: ClientState }).state.inboxItems = [
            trackerItem({ id: "it_1", num: 1, kind: "question", awaiting: "user" }),
            trackerItem({ id: "it_2", num: 2, kind: "notice", awaiting: "user" }),
            trackerItem({ id: "it_3", num: 3, kind: "task", awaiting: "agent" }),
            trackerItem({ id: "it_4", num: 4, state: "closed", awaiting: null, resolution: "done" }),
        ];
        await render(client);
        expect(entry("decisions").querySelector(".mj_NavRail_badge")?.textContent).toBe("2");
        expect(entry("decisions").getAttribute("aria-label")).toBe("For you, 2 need you");
    });

    it("drops the For you badge when nothing needs the user", async () => {
        const client = signedInClient([convo("c1")]);
        (client as unknown as { state: ClientState }).state.inboxItems = [trackerItem({ awaiting: "agent" })];
        await render(client);
        expect(entry("decisions").querySelector(".mj_NavRail_badge")).toBeNull();
        expect(entry("decisions").getAttribute("aria-label")).toBe("For you");
    });

    it("shows no badge when nothing is unread", async () => {
        await render(signedInClient([convo("c1")]));
        expect(entry("conversations").querySelector(".mj_NavRail_badge")).toBeNull();
        expect(entry("conversations").getAttribute("aria-label")).toBe("Conversations");
    });

    it("replaces the wordmark and New-session button with a titled header and moves chrome to the rail foot", async () => {
        await render(signedInClient([convo("c1")]));
        expect(container.querySelector(".mj_Wordmark")).toBeNull();
        expect(container.querySelector(".mj_NewSessionButton")).toBeNull();
        expect(container.querySelector(".mj_ConversationListTitle")?.textContent).toBe("Conversations");
        expect(container.querySelector('.mj_ConversationListHeader button[aria-label="New session"]')).not.toBeNull();
        const footer = container.querySelector('[data-testid="nav-rail"] .mj_NavRail_footer');
        expect(footer?.querySelector('button[aria-label^="Settings"]')).not.toBeNull();
        // Theme moved into the Settings sheet (unify step 6).
        expect(footer?.querySelector("button[aria-label^='Theme']")).toBeNull();
        expect(container.querySelector(".mj_SidebarFooter")).toBeNull();
    });
});

describe("left panel width with the nav rail", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(() => {
        localStorage.clear();
        Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        Reflect.deleteProperty(document.documentElement, "clientWidth");
    });

    it("clamps a stored list width against the window minus the rail", async () => {
        localStorage.clear();
        localStorage.setItem("matron_sidebar_width", "600");
        await act(async () => root.render(<MatronApp client={signedInClient([convo("c1")])} />));
        const panel = container.querySelector<HTMLElement>(".mj_Sidebar_outerWrapper")!;
        // (1000 − 72) / 2 = 464: the list may take half of what the rail leaves.
        expect(panel.style.getPropertyValue("--mj-left-panel-width")).toBe("464px");
    });

    it("moves a width saved under the earlier storage key to the current one", async () => {
        localStorage.clear();
        localStorage.setItem("mx_lhs_size", "600");
        await act(async () => root.render(<MatronApp client={signedInClient([convo("c1")])} />));
        const panel = container.querySelector<HTMLElement>(".mj_Sidebar_outerWrapper")!;
        // (1000 − 72) / 2 = 464: the list may take half of what the rail leaves.
        expect(panel.style.getPropertyValue("--mj-left-panel-width")).toBe("464px");
        expect(localStorage.getItem("matron_sidebar_width")).toBe("600");
        expect(localStorage.getItem("mx_lhs_size")).toBeNull();
    });

    it("keeps the current width when both storage keys hold one", async () => {
        localStorage.clear();
        localStorage.setItem("matron_sidebar_width", "300");
        localStorage.setItem("mx_lhs_size", "600");
        await act(async () => root.render(<MatronApp client={signedInClient([convo("c1")])} />));
        const panel = container.querySelector<HTMLElement>(".mj_Sidebar_outerWrapper")!;
        expect(panel.style.getPropertyValue("--mj-left-panel-width")).toBe("300px");
        expect(localStorage.getItem("matron_sidebar_width")).toBe("300");
        expect(localStorage.getItem("mx_lhs_size")).toBeNull();
    });
});
