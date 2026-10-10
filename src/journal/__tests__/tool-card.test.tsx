/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";
import { resetShowTheWorkForTests, SHOW_THE_WORK_KEY } from "../show-the-work";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};
const CONVERSATION: Conversation = {
    id: "c1",
    title: "One",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 1,
};

function toolEvent(payload: Record<string, unknown>): JournalEvent {
    return {
        seq: 1,
        convo_id: "c1",
        ts: Date.UTC(2026, 9, 4, 14, 2),
        sender: "agent:claude",
        type: "tool_output",
        payload,
    };
}

function clientWith(events: JournalEvent[]): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: "c1",
        events,
        pendingMessages: [],
        connection: "online",
        archivedIds: new Set(),
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

describe("tool card summary", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
    });

    beforeEach(() => {
        localStorage.clear();
        // Tool cards render inline only with Developer view on (the fork's default is off).
        localStorage.setItem(SHOW_THE_WORK_KEY, "true");
        resetShowTheWorkForTests();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function render(payload: Record<string, unknown>): Promise<HTMLElement> {
        await act(async () => root.render(<MatronApp client={clientWith([toolEvent(payload)])} />));
        return container.querySelector<HTMLElement>(".mj_ToolCard")!;
    }

    it("shows a green glyph, the bold command and grey args for a clean exit, with no badge or time", async () => {
        const card = await render({ command: "git status --short", exit_code: 0, snippet: "M file" });
        const summary = card.querySelector("summary")!;
        expect(summary.querySelector(".mj_ToolCard_status_ok")).not.toBeNull();
        expect(summary.querySelector(".mj_ToolCard_cmd")?.textContent).toBe("git");
        expect(summary.querySelector(".mj_ToolCard_args")?.textContent?.trim()).toBe("status --short");
        expect(summary.textContent).not.toContain("$ ");
        expect(summary.querySelector(".mj_ToolBadge")).toBeNull();
        expect(summary.querySelector("time")).toBeNull();
        expect(summary.getAttribute("title")).toBe("git status --short");
        expect(summary.getAttribute("aria-label")).toBe("git status --short, exit 0");
        expect(card.querySelector(".mj_ToolCard_meta")?.textContent).toMatch(/^exit 0 · \d/);
    });

    it("shows a red glyph and says failed for a non-zero exit", async () => {
        const card = await render({ command: "pnpm test", exit_code: 1, snippet: "FAIL" });
        const summary = card.querySelector("summary")!;
        expect(summary.querySelector(".mj_ToolCard_status_failed")).not.toBeNull();
        expect(summary.getAttribute("aria-label")).toBe("pnpm test, failed, exit 1");
        expect(card.querySelector(".mj_ToolCard_meta")?.textContent).toMatch(/^exit 1 · /);
    });

    it("treats a denied tool as failed even with exit 0", async () => {
        const card = await render({ command: "rm -rf /", exit_code: 0, denied: true, snippet: "" });
        expect(card.querySelector("summary .mj_ToolCard_status_failed")).not.toBeNull();
        expect(card.querySelector(".mj_ToolCard_meta")?.textContent).toMatch(/^denied · /);
    });

    it("keeps a one-word command whole with no args span", async () => {
        const card = await render({ command: "ls", exit_code: 0, snippet: "" });
        expect(card.querySelector("summary .mj_ToolCard_cmd")?.textContent).toBe("ls");
        expect(card.querySelector("summary .mj_ToolCard_args")).toBeNull();
    });
});
