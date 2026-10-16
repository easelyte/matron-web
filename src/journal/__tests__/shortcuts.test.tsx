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
import { matchShortcut, shortcutLabel } from "../shortcuts";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

const convo = (id: string): Conversation => ({
    id,
    title: `Chat ${id}`,
    session_state: "idle",
    last_seq: 5,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 5,
});

const text = (seq: number, sender: string, body: string): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: seq,
    sender,
    type: "text",
    payload: { body },
});

function signedInClient(events: JournalEvent[] = []): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [convo("c1"), convo("c2")],
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

type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;
const key = (over: Partial<Key>): Key => ({
    key: "k",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
});

describe("matchShortcut", () => {
    it("uses Cmd on a Mac and Ctrl elsewhere", () => {
        expect(matchShortcut(key({ metaKey: true }), true)).toEqual({ kind: "commandPalette" });
        expect(matchShortcut(key({ ctrlKey: true }), true)).toBeNull();
        expect(matchShortcut(key({ ctrlKey: true }), false)).toEqual({ kind: "commandPalette" });
        expect(matchShortcut(key({ metaKey: true }), false)).toBeNull();
    });

    it("names every shortcut the Mac binds", () => {
        const ctrl = (over: Partial<Key>): ReturnType<typeof matchShortcut> =>
            matchShortcut(key({ ctrlKey: true, ...over }), false);
        expect(ctrl({ key: "n" })).toEqual({ kind: "newSession" });
        expect(ctrl({ key: "F", shiftKey: true })).toEqual({ kind: "searchAllChats" });
        expect(ctrl({ key: "U", shiftKey: true })).toEqual({ kind: "jumpToLastOwnMessage" });
        expect(["1", "2", "3", "4", "5"].map((digit) => ctrl({ key: digit }))).toEqual([
            { kind: "section", section: "coordinator" },
            { kind: "section", section: "projects" },
            { kind: "section", section: "decisions" },
            { kind: "section", section: "conversations" },
            { kind: "section", section: "memories" },
        ]);
    });

    it("leaves Find, other keys and extra modifiers alone", () => {
        expect(matchShortcut(key({ key: "f", ctrlKey: true }), false)).toBeNull();
        expect(matchShortcut(key({ key: "6", ctrlKey: true }), false)).toBeNull();
        expect(matchShortcut(key({ key: "k", ctrlKey: true, altKey: true }), false)).toBeNull();
        expect(matchShortcut(key({ key: "k", ctrlKey: true, shiftKey: true }), false)).toBeNull();
        expect(matchShortcut(key({ key: "n", ctrlKey: true, metaKey: true }), false)).toBeNull();
        expect(matchShortcut(key({ key: "k" }), false)).toBeNull();
    });

    it("labels shortcuts for tooltips", () => {
        expect(shortcutLabel("n", { mac: true })).toBe("⌘N");
        expect(shortcutLabel("f", { mac: true, shift: true })).toBe("⇧⌘F");
        expect(shortcutLabel("n", { mac: false })).toBe("Ctrl+N");
        expect(shortcutLabel("f", { mac: false, shift: true })).toBe("Ctrl+Shift+F");
    });
});

describe("app shortcuts", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
        Element.prototype.scrollIntoView = () => {};
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

    // jsdom reports no platform, so Ctrl is the modifier here.
    async function press(
        keyName: string,
        over: Partial<KeyboardEventInit> = {},
        target: EventTarget = document.body,
    ): Promise<KeyboardEvent> {
        const event = new KeyboardEvent("keydown", {
            key: keyName,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
            ...over,
        });
        await act(async () => {
            target.dispatchEvent(event);
        });
        return event;
    }

    const palette = (): HTMLElement | null => document.querySelector(".mj_CommandPalette_scrim");
    const paletteRows = (): string[] =>
        [...document.querySelectorAll(".mj_CommandPalette .mj_SlashPalette_trigger")].map((row) => row.textContent!);
    const composer = (): HTMLTextAreaElement => container.querySelector(".mj_ComposerInput_input")!;

    function type(input: HTMLInputElement, value: string): void {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    it("⌘K opens the slash palette with every command, and ⌘K again closes it", async () => {
        await render(signedInClient());
        const event = await press("k");
        expect(event.defaultPrevented).toBe(true);
        expect(palette()).not.toBeNull();
        expect(paletteRows()).toContain("/start");
        expect(paletteRows()).toContain("!esc");
        expect(document.activeElement).toBe(document.querySelector(".mj_CommandPalette_input"));
        await press("k", {}, document.activeElement!);
        expect(palette()).toBeNull();
    });

    it("⌘K closes the palette after focus has left its field", async () => {
        await render(signedInClient());
        await press("k");
        (document.activeElement as HTMLElement).blur();
        const event = await press("k");
        expect(event.defaultPrevented).toBe(true);
        expect(palette()).toBeNull();
    });

    it("filters as you type and puts the picked command in the composer, ready for arguments", async () => {
        jest.useFakeTimers();
        try {
            await render(signedInClient());
            await press("k");
            const input = document.querySelector<HTMLInputElement>(".mj_CommandPalette_input")!;
            await act(async () => type(input, "/sta"));
            expect(paletteRows()).toEqual(["/start", "/status"]);
            await press("ArrowDown", { ctrlKey: false }, input);
            await press("Enter", { ctrlKey: false }, input);
            await act(async () => {
                jest.runOnlyPendingTimers();
            });
            expect(palette()).toBeNull();
            expect(composer().value).toBe("/status ");
            expect(document.activeElement).toBe(composer());
        } finally {
            jest.useRealTimers();
        }
    });

    it("Escape closes the palette and leaves the draft alone", async () => {
        await render(signedInClient());
        await press("k");
        await press("Escape", { ctrlKey: false }, document.querySelector(".mj_CommandPalette_input")!);
        expect(palette()).toBeNull();
        expect(composer().value).toBe("");
    });

    it("keeps Tab inside the palette and gives focus back on close", async () => {
        await render(signedInClient());
        composer().focus();
        await press("k", {}, composer());
        const input = document.querySelector<HTMLInputElement>(".mj_CommandPalette_input")!;
        expect(input.getAttribute("role")).toBe("combobox");
        expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
        const tab = await press("Tab", { ctrlKey: false }, input);
        expect(tab.defaultPrevented).toBe(true);
        await press("Escape", { ctrlKey: false }, input);
        expect(palette()).toBeNull();
        expect(document.activeElement).toBe(composer());
    });

    it("⌘K does nothing without a conversation on screen", async () => {
        const client = signedInClient();
        await render(client);
        await act(async () => client.openTrackerView({ view: "missions" }));
        const event = await press("k");
        expect(event.defaultPrevented).toBe(false);
        expect(palette()).toBeNull();
    });

    it("⌘2 … ⌘5 switch sections in the Mac's order", async () => {
        const client = signedInClient();
        await render(client);
        await press("2");
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "missions" });
        await press("3");
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "inbox" });
        await press("5");
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "memories" });
        await press("4");
        expect(client.getSnapshot().trackerView?.open).toBeFalsy();
    });

    it("⌘1 opens the Coordinator's conversation when the journal names one", async () => {
        const client = signedInClient();
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue();
        const ask = jest.spyOn(client, "coordinatorConversationId").mockResolvedValue(null);
        await render(client);
        await press("1");
        expect(select).not.toHaveBeenCalled();
        ask.mockResolvedValue("c2");
        await press("1");
        expect(select).toHaveBeenCalledWith("c2", { suppressNotFound: true });
    });

    it("drops a Coordinator answer that lands after another section shortcut", async () => {
        const client = signedInClient();
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue();
        let answer: (id: string | null) => void = () => undefined;
        jest.spyOn(client, "coordinatorConversationId").mockReturnValue(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );
        await render(client);
        await press("1");
        await press("2");
        await act(async () => answer("c2"));
        expect(select).not.toHaveBeenCalled();
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "missions" });
    });

    it("drops a Coordinator answer that lands after the user went elsewhere without a shortcut", async () => {
        const client = signedInClient();
        let answer: (id: string | null) => void = () => undefined;
        jest.spyOn(client, "coordinatorConversationId").mockImplementation(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        await render(client);
        await press("1");
        act(() => client.openTrackerView({ view: "inbox" }));
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue();
        await act(async () => answer("c2"));
        expect(select).not.toHaveBeenCalled();
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "inbox" });

        // Back to the conversation through the rail, not a shortcut.
        await press("1");
        act(() => client.closeTrackerView());
        await act(async () => answer("c2"));
        expect(select).not.toHaveBeenCalled();
    });

    it("ignores a held ⌘K's auto-repeat", async () => {
        await render(signedInClient());
        await press("k");
        await press("k", { repeat: true }, document.activeElement!);
        expect(palette()).not.toBeNull();
        await press("k");
        await press("k", { repeat: true });
        expect(palette()).toBeNull();
    });

    it("keeps a held shortcut's repeats from the browser without acting again", async () => {
        const client = signedInClient();
        await render(client);
        await press("2");
        await act(async () => client.closeTrackerView());
        const repeat = await press("2", { repeat: true });
        expect(repeat.defaultPrevented).toBe(true);
        expect(client.getSnapshot().trackerView?.open).toBeFalsy();
    });

    it("⌘N opens the new-session sheet", async () => {
        const client = signedInClient();
        await render(client);
        await press("n");
        // The fork's one-tap sheet answers the shortcut; its title id is generated, so match the dialog.
        expect(document.querySelector('[role="dialog"].mj_NewSessionSheet')).not.toBeNull();
    });

    it("⇧⌘F focuses the sidebar search on Conversations only", async () => {
        const client = signedInClient();
        await render(client);
        await press("F", { shiftKey: true });
        expect(document.activeElement?.id).toBe("conversation-search-input");
        (document.activeElement as HTMLElement).blur();
        await act(async () => client.openTrackerView({ view: "inbox" }));
        await press("F", { shiftKey: true });
        expect(document.activeElement?.id).not.toBe("conversation-search-input");
    });

    it("⇧⌘U jumps to my last message through the client, once", async () => {
        const client = signedInClient([
            text(1, "user:alice", "first"),
            text(2, "user:alice", "second"),
            text(3, "agent:claude", "reply"),
        ]);
        const jump = jest.spyOn(client, "jumpToLastOwnMessage");
        await render(client);
        const event = await press("U", { shiftKey: true });
        expect(event.defaultPrevented).toBe(true);
        // One binding only: the timeline's pill shares this shortcut rather than binding its own.
        expect(jump).toHaveBeenCalledTimes(1);
        await act(async () => {
            await jump.mock.results[0].value;
        });
        expect(container.querySelector('.mj_EventTile[data-event-id="2"]')?.classList).toContain(
            "mj_EventTile_focused",
        );
    });

    it("leaves Ctrl+Shift+U to a text field off a Mac", async () => {
        const client = signedInClient([text(1, "user:alice", "first")]);
        const jump = jest.spyOn(client, "jumpToLastOwnMessage");
        await render(client);
        const event = await press("U", { shiftKey: true }, composer());
        expect(event.defaultPrevented).toBe(false);
        expect(jump).not.toHaveBeenCalled();
    });

    it("fires from a text field like the Mac's menu shortcuts", async () => {
        const client = signedInClient();
        await render(client);
        await press("2", {}, composer());
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "missions" });
    });

    it("stays out of the way while a dialog is open", async () => {
        const client = signedInClient();
        await render(client);
        await act(async () => client.openGoToNumber());
        const event = await press("2");
        expect(event.defaultPrevented).toBe(false);
        expect(client.getSnapshot().trackerView?.open).toBeFalsy();
    });
});

describe("coordinatorConversationId", () => {
    const withApi = (coordinator: jest.Mock): MatronJournalClient => {
        const client = signedInClient();
        (client as unknown as { api: unknown }).api = { coordinator };
        return client;
    };

    it("asks the journal each time and answers its conversation id", async () => {
        const coordinator = jest.fn().mockResolvedValue({ convo_id: "c9", consent: false });
        const client = withApi(coordinator);
        expect(await client.coordinatorConversationId()).toBe("c9");
        expect(await client.coordinatorConversationId()).toBe("c9");
        expect(coordinator).toHaveBeenCalledTimes(2);
    });

    it("is null for no Coordinator, an odd answer, a failed read or no session", async () => {
        expect(await withApi(jest.fn().mockResolvedValue({ convo_id: null })).coordinatorConversationId()).toBeNull();
        expect(await withApi(jest.fn().mockResolvedValue("nope")).coordinatorConversationId()).toBeNull();
        expect(await withApi(jest.fn().mockRejectedValue(new Error("down"))).coordinatorConversationId()).toBeNull();
        expect(await new MatronJournalClient().coordinatorConversationId()).toBeNull();
    });
});
