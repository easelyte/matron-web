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
import type { AgentRosterEntry, ClientState, Conversation, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};
const TWO_BOXES: AgentRosterEntry[] = [
    { device_id: 1, name: "ash", tag_char: null },
    { device_id: 2, name: "birch", tag_char: "B" },
];

const convo = (id: string, over: Partial<Conversation> = {}): Conversation => ({
    id,
    title: `Chat ${id}`,
    session_state: "idle",
    last_seq: 5,
    unread_count: 0,
    snippet: "Restarted nginx",
    created_at: Date.now() - 60_000,
    last_ts: Date.now() - 60_000,
    read_up_to_seq: 5,
    ...over,
});

function signedInClient(conversations: Conversation[], agents: AgentRosterEntry[]): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        agents,
        selectedConversationId: conversations[0]?.id,
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: new Set(),
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

describe("sidebar rows", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
    });

    beforeEach(() => {
        localStorage.clear();
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

    const row = (): HTMLElement => container.querySelector<HTMLElement>(".mj_ConversationListItem")!;

    it("leads the title with the box letter and session short when there are two boxes", async () => {
        await render(
            signedInClient([convo("c1", { title: "🐣 [53] Restart of mission", agent_device_id: 1 })], TWO_BOXES),
        );
        const tag = row().querySelector(".mj_SessionTag")!;
        expect(tag.querySelector(".mj_SessionTag_letter")?.textContent).toBe("A");
        expect(tag.querySelector(".mj_SessionTag_short")?.textContent).toBe("53");
        expect(
            (tag.querySelector(".mj_SessionTag_letter") as HTMLElement).style.getPropertyValue("--mj-box-light"),
        ).toMatch(/^#[0-9a-f]{6}$/);
        expect(row().querySelector('[data-testid="conversation-name"]')?.textContent).toBe(
            "A:53 🐣 Restart of mission",
        );
    });

    it("shows the bare title with no tag for a single box, still without the [short] prefix", async () => {
        await render(
            signedInClient([convo("c1", { title: "🐣 [53] Restart of mission", agent_device_id: 1 })], [TWO_BOXES[0]]),
        );
        expect(row().querySelector(".mj_SessionTag")).toBeNull();
        expect(row().querySelector('[data-testid="conversation-name"]')?.textContent).toBe("🐣 Restart of mission");
    });

    it("puts the snippet and the relative time on one meta line", async () => {
        await render(signedInClient([convo("c1")], TWO_BOXES));
        const meta = row().querySelector(".mj_ConversationListMeta")!;
        expect(meta.textContent).toMatch(/^Restarted nginx · .+/);
        expect(row().querySelector(".mj_ConversationListPreview")).toBeNull();
        // The snippet is its own truncating span so a long snippet never eats the time.
        expect(meta.querySelector(".mj_ConversationListSnippet")?.textContent).toBe("Restarted nginx");
        expect(meta.querySelector(".mj_ConversationListTime")).not.toBeNull();
    });

    it("keeps day labels out of the list semantics: each group is its own list of listitems", async () => {
        const yesterday = Date.now() - 36 * 3_600_000;
        await render(
            signedInClient([convo("c1"), convo("c2", { created_at: yesterday, last_ts: yesterday })], TWO_BOXES),
        );
        expect(container.querySelector(".mj_ConversationListGroup h3")).toBeNull();
        expect(container.querySelectorAll('.mj_ConversationListGroup [role="list"]').length).toBeGreaterThanOrEqual(2);
        expect(
            container.querySelectorAll('.mj_ConversationListGroup [role="list"] > :not([role="listitem"])').length,
        ).toBe(0);
        expect(container.querySelector('[data-testid="conversation-list"]')?.getAttribute("role")).toBeNull();
    });

    it("uses the same tag and stripped title in the chat header and subagent pills", async () => {
        await render(
            signedInClient(
                [
                    convo("c1", { title: "🐣 [dc] matron-web · deploy", agent_device_id: 1, session_state: "running" }),
                    convo("s1", {
                        title: "🐣 [7a] test triage",
                        agent_device_id: 1,
                        parent_convo_id: "c1",
                        session_state: "running",
                    }),
                ],
                TWO_BOXES,
            ),
        );
        const heading = container.querySelector(".mj_ChatHeader_heading")!;
        expect(heading.textContent).toContain("🐣 matron-web · deploy");
        expect(heading.textContent).not.toContain("[dc]");
        expect(heading.querySelector(".mj_SessionTag_short")?.textContent).toBe("dc");
        const pill = container.querySelector(".mj_SubagentPill_name")!;
        expect(pill.textContent).not.toContain("[7a]");
        expect(pill.querySelector(".mj_SessionTag_short")?.textContent).toBe("7a");
    });

    it("groups rows under day headers, Today first", async () => {
        const yesterday = Date.now() - 36 * 3_600_000;
        await render(
            signedInClient([convo("c1"), convo("c2", { created_at: yesterday, last_ts: yesterday })], TWO_BOXES),
        );
        const labels = [...container.querySelectorAll(".mj_ConversationListGroup_label")].map((el) => el.textContent);
        expect(labels[0]).toBe("Today");
        expect(labels.length).toBeGreaterThanOrEqual(2);
    });
});
