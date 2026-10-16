/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { MatronJournalClient } from "../client";
import { MatronApp } from "../components";
import type { AgentRosterEntry, ClientState, Conversation, ConvoPin, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};
const AGENTS: AgentRosterEntry[] = [{ device_id: 7, name: "maple", tag_char: null }];

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
    agent_device_id: 7,
    ...over,
});

const pin = (convoId: string, position: number, over: Partial<ConvoPin> = {}): ConvoPin => ({
    convo_id: convoId,
    label: `Desk ${convoId}`,
    emoji: "",
    position,
    device_id: 7,
    created_at: 1,
    updated_at: 1,
    ...over,
});

function signedInClient(over: Partial<ClientState>): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        agents: AGENTS,
        connection: "online",
        ...over,
    };
    return client;
}

describe("journal pins in the sidebar", () => {
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
        document.body.innerHTML = "";
    });

    async function render(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
    }

    const pinnedSection = (): HTMLElement => container.querySelector<HTMLElement>('section[aria-label="Pinned"]')!;

    it("renders journal pins in position order with label first and the title secondary", async () => {
        await render(
            signedInClient({
                conversations: [convo("c1"), convo("c2", { unread_count: 3 }), convo("c3")],
                journalPins: [pin("c2", 0, { emoji: "🚀" }), pin("c1", 1)],
            }),
        );
        const rows = [...pinnedSection().querySelectorAll<HTMLElement>(".mj_ConversationListItem")];
        expect(rows.map((row) => row.querySelector('[data-testid="conversation-name"]')?.textContent)).toEqual([
            "Desk c2",
            "Desk c1",
        ]);
        expect(rows[0].querySelector(".mj_PinGlyph")?.textContent).toBe("🚀");
        expect(rows[1].querySelector(".mj_PinGlyph")?.textContent).toBe("D");
        expect(rows[0].querySelector(".mj_ConversationListSnippet")?.textContent).toBe("Chat c2");
        expect(rows[0].querySelector(".mj_UnreadBadge")?.textContent).toBe("3");
        // Pinned rows leave the day groups.
        const dayRows = [...container.querySelectorAll('section:not([aria-label="Pinned"]) .mj_ConversationListItem')];
        expect(dayRows.map((row) => row.querySelector('[data-testid="conversation-name"]')?.textContent)).toEqual([
            "Chat c3",
        ]);
    });

    it("greys a missing pin with only Move pin… and Unpin", async () => {
        await render(
            signedInClient({ conversations: [convo("c1")], journalPins: [pin("gone", 0, { missing: true })] }),
        );
        const missing = pinnedSection().querySelector(".mj_PinRow_missing")!;
        expect(missing.textContent).toContain("Desk gone");
        expect([...missing.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
            "Move pin…",
            "Unpin",
        ]);
    });

    it("offers a successor under its pin", async () => {
        const client = signedInClient({
            conversations: [convo("c1"), convo("c9")],
            journalPins: [pin("c1", 0, { successor: { convo_id: "c9", title: "Chat c9", created_at: 2 } })],
        });
        const accept = jest.spyOn(client, "acceptPinSuccessor").mockResolvedValue();
        await render(client);
        const hint = pinnedSection().querySelector(".mj_PinSuccessor")!;
        expect(hint.querySelector(".mj_PinSuccessor_text")?.textContent).toBe("New session on maple — move pin here?");
        await act(async () => [...hint.querySelectorAll("button")].find((b) => b.textContent === "Move")!.click());
        expect(accept).toHaveBeenCalledWith(expect.objectContaining({ convo_id: "c1" }));
    });

    it("leaves an archived pin out of the Active tab's Pinned section", async () => {
        await render(
            signedInClient({
                conversations: [convo("c1"), convo("c2")],
                journalPins: [pin("c1", 0), pin("c2", 1)],
                archivedIds: new Set(["c2"]),
            }),
        );
        const rows = [...pinnedSection().querySelectorAll(".mj_ConversationListItem")];
        expect(rows.map((row) => row.querySelector('[data-testid="conversation-name"]')?.textContent)).toEqual([
            "Desk c1",
        ]);
    });

    it("keeps an archived pin that is missing or offers a successor, so it can still be managed", async () => {
        await render(
            signedInClient({
                conversations: [convo("c1"), convo("c9")],
                journalPins: [
                    pin("gone", 0, { missing: true }),
                    pin("c1", 1, { successor: { convo_id: "c9", title: "Chat c9", created_at: 2 } }),
                ],
                archivedIds: new Set(["gone", "c1"]),
            }),
        );
        expect(pinnedSection().textContent).toContain("Desk gone");
        expect(pinnedSection().querySelector(".mj_PinSuccessor")).not.toBeNull();
    });

    it("does not claim no matches when the search matches only a pin label", async () => {
        const client = signedInClient({
            conversations: [convo("c1"), convo("c2")],
            journalPins: [pin("c1", 0, { label: "On-call" })],
        });
        await render(client);
        const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(search, "on-call");
            search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(pinnedSection().textContent).toContain("On-call");
        expect(container.textContent).not.toContain("No conversations match your search.");
    });

    it("draws a pinned sub-chat once, in the Pinned section, not again under its parent", async () => {
        await render(
            signedInClient({
                conversations: [
                    convo("p1"),
                    convo("k1", { parent_convo_id: "p1", title: "Sub k1", session_state: "running" }),
                ],
                journalPins: [pin("k1", 0)],
            }),
        );
        const rows = [...container.querySelectorAll(".mj_ConversationListItem")];
        expect(rows.filter((row) => row.textContent?.includes("Sub k1")).length).toBe(1);
        expect(pinnedSection().textContent).toContain("Desk k1");
    });

    it("keeps the browser-local Pinned section when the journal has no pins", async () => {
        await render(
            signedInClient({
                conversations: [convo("c1"), convo("c2")],
                pinnedIds: new Set(["c2"]),
                journalPins: null,
            }),
        );
        const rows = [...pinnedSection().querySelectorAll(".mj_ConversationListItem")];
        expect(rows.map((row) => row.querySelector('[data-testid="conversation-name"]')?.textContent)).toEqual([
            "Chat c2",
        ]);
        expect(pinnedSection().querySelector(".mj_PinGlyph")).toBeNull();
    });

    it("opens the pin sheet from the row menu and shows the pin limit inline", async () => {
        const client = signedInClient({ conversations: [convo("c1", { title: "🐣 [ab] Deploy" })], journalPins: [] });
        const save = jest.spyOn(client, "savePin").mockResolvedValue("You can pin up to 5 chats.");
        await render(client);
        const trigger = container.querySelector<HTMLButtonElement>(".mj_ConversationMenu_trigger")!;
        await act(async () => trigger.click());
        const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
            (button) => button.textContent === "Pin to sidebar…",
        )!;
        await act(async () => item.click());
        const label = document.querySelector<HTMLInputElement>("#mj-pin-label")!;
        expect(label.value).toBe("Deploy");
        await act(async () => document.querySelector<HTMLFormElement>(".mj_PinSheet")!.requestSubmit());
        expect(save).toHaveBeenCalledWith("c1", { label: "Deploy", emoji: "" });
        expect(document.querySelector('.mj_PinSheet [role="alert"]')?.textContent).toBe("You can pin up to 5 chats.");
    });

    it("offers Move up / Move down by position in the row menu", async () => {
        const client = signedInClient({
            conversations: [convo("c1"), convo("c2")],
            journalPins: [pin("c1", 0), pin("c2", 1)],
        });
        const shift = jest.spyOn(client, "shiftPin").mockResolvedValue();
        await render(client);
        const triggers = pinnedSection().querySelectorAll<HTMLButtonElement>(".mj_ConversationMenu_trigger");
        await act(async () => triggers[0].click());
        const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
        expect(labels).toEqual(expect.arrayContaining(["Edit pin…", "Move down", "Move pin…", "Unpin"]));
        expect(labels).not.toContain("Move up");
        const down = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
            (button) => button.textContent === "Move down",
        )!;
        await act(async () => down.click());
        expect(shift).toHaveBeenCalledWith("c1", "down", ["c1", "c2"]);
    });

    it("steps Move up / Move down over a hidden archived pin", async () => {
        const client = signedInClient({
            conversations: [convo("c1"), convo("c2"), convo("c3")],
            journalPins: [pin("c1", 0), pin("c2", 1), pin("c3", 2)],
            archivedIds: new Set(["c2"]),
        });
        const shift = jest.spyOn(client, "shiftPin").mockResolvedValue();
        await render(client);
        const triggers = pinnedSection().querySelectorAll<HTMLButtonElement>(".mj_ConversationMenu_trigger");
        await act(async () => triggers[1].click());
        const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        expect(items.map((item) => item.textContent)).not.toContain("Move down");
        await act(async () => items.find((button) => button.textContent === "Move up")!.click());
        expect(shift).toHaveBeenCalledWith("c3", "up", ["c1", "c3"]);
    });

    it("keeps Edit pin…, Move pin… and Unpin on an archived pin's row in the Archived tab", async () => {
        await render(
            signedInClient({
                conversations: [convo("c1"), convo("c2")],
                journalPins: [pin("c1", 0), pin("c2", 1)],
                archivedIds: new Set(["c2"]),
            }),
        );
        const archivedTab = container.querySelector<HTMLButtonElement>('button[data-tab="archived"]')!;
        await act(async () => archivedTab.click());
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_ConversationMenu_trigger")!.click());
        const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
        expect(labels).toEqual(expect.arrayContaining(["Edit pin…", "Move pin…", "Unpin"]));
        expect(labels).not.toContain("Pin to sidebar…");
        expect(labels).not.toContain("Move up");
        expect(labels).not.toContain("Move down");
    });

    it("does not say there are no conversations beside a pin that is still shown", async () => {
        await render(signedInClient({ conversations: [], journalPins: [pin("gone", 0, { missing: true })] }));
        expect(pinnedSection().textContent).toContain("Desk gone");
        expect(container.textContent).not.toContain("Your agent conversations will appear here.");
    });

    async function openMovePinSheet(): Promise<HTMLElement> {
        await act(async () =>
            pinnedSection().querySelector<HTMLButtonElement>(".mj_ConversationMenu_trigger")!.click(),
        );
        const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
            (button) => button.textContent === "Move pin…",
        )!;
        await act(async () => item.click());
        return document.querySelector<HTMLElement>(".mj_PinSheet")!;
    }

    const chooserRows = (sheet: HTMLElement): string[] =>
        [...sheet.querySelectorAll('[aria-label="Conversations"] [role="listitem"]')].map(
            (row) => row.textContent ?? "",
        );

    it("filters the Move pin chooser by box when its conversations span two or more boxes", async () => {
        await render(
            signedInClient({
                agents: [
                    { device_id: 7, name: "maple", tag_char: null },
                    { device_id: 8, name: "ash", tag_char: null },
                ],
                conversations: [
                    convo("c1"),
                    convo("c2"),
                    convo("c3", { agent_device_id: 8 }),
                    convo("c4", { agent_device_id: 8 }),
                ],
                journalPins: [pin("c1", 0)],
            }),
        );
        const sheet = await openMovePinSheet();
        const filter = sheet.querySelector<HTMLElement>('[role="group"][aria-label="Filter by box"]')!;
        const options = (): HTMLButtonElement[] => [...filter.querySelectorAll<HTMLButtonElement>("button")];
        // The pinned c1 is no candidate, so maple counts one conversation.
        expect(options().map((button) => button.textContent)).toEqual(["All", "ash 2", "maple 1"]);
        expect(options()[0].getAttribute("aria-pressed")).toBe("true");
        expect(chooserRows(sheet)).toHaveLength(3);

        await act(async () => options()[1].click());
        expect(options()[1].getAttribute("aria-pressed")).toBe("true");
        expect(chooserRows(sheet).map((text) => text.includes("Chat c3") || text.includes("Chat c4"))).toEqual([
            true,
            true,
        ]);

        // The box combines with the search.
        const search = sheet.querySelector<HTMLInputElement>("#mj-pin-move-search")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(search, "c4");
            search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(chooserRows(sheet)).toHaveLength(1);
        expect(chooserRows(sheet)[0]).toContain("Chat c4");

        // Choosing the active box again clears it.
        await act(async () => options()[1].click());
        expect(options()[0].getAttribute("aria-pressed")).toBe("true");
        expect(chooserRows(sheet)).toHaveLength(1);
    });

    it("hides the Move pin chooser's box filter when every candidate is on one box", async () => {
        await render(
            signedInClient({
                agents: [
                    { device_id: 7, name: "maple", tag_char: null },
                    { device_id: 8, name: "ash", tag_char: null },
                ],
                conversations: [convo("c1", { agent_device_id: 8 }), convo("c2"), convo("c3")],
                journalPins: [pin("c1", 0)],
            }),
        );
        const sheet = await openMovePinSheet();
        expect(sheet.querySelector('[aria-label="Filter by box"]')).toBeNull();
        expect(chooserRows(sheet)).toHaveLength(2);
    });

    it("leaves a pinned sub-chat out of its collapsed parent's hidden count", async () => {
        await render(
            signedInClient({
                conversations: [
                    convo("p1"),
                    convo("k1", { parent_convo_id: "p1", session_state: "running" }),
                    convo("k2", { parent_convo_id: "p1", session_state: "running" }),
                ],
                journalPins: [pin("k1", 0)],
                collapsedSubagentParentIds: new Set(["p1"]),
            }),
        );
        expect(container.querySelector(".mj_ConversationListCollapsedSubs")?.textContent).toBe("1");
    });
});
