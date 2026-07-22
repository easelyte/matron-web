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
    BROWSER_MEMORY_SAFETY_MAX_BYTES,
    favoriteStore,
    MatronJournalClient,
    pinnedStore,
    PREFERENCES_UNAVAILABLE_ERROR,
    unreadStore,
} from "../../../src/journal/client";
import { makeDraftStore } from "../../../src/journal/composer-drafts";
import { EventContent, MatronApp } from "../../../src/journal/components";
import { makeRecentFoldersStore } from "../../../src/journal/slash-palette";
import type { ClientState, Conversation, JournalEvent, PendingMessage, Session } from "../../../src/journal/types";

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
    database?: unknown;
    pendingFiles: Map<string, File>;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInClient(
    options: {
        pendingMessages?: PendingMessage[];
        events?: JournalEvent[];
    } = {},
): MatronJournalClient {
    const client = new MatronJournalClient();
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: options.events ?? [],
        pendingMessages: options.pendingMessages ?? [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

function signedInWithRooms(conversations: Conversation[]): MatronJournalClient {
    const client = signedInClient();
    internals(client).state = {
        ...client.getSnapshot(),
        conversations,
    };
    return client;
}

async function renderClient(client: MatronJournalClient): Promise<{
    container: HTMLDivElement;
    root: Root;
}> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(MatronApp, { client }));
    });
    return { container, root };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
}

function menuItem(container: HTMLElement, text: string): Element | undefined {
    return [...container.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent?.includes(text));
}

function tabButton(container: HTMLElement, text: "All" | "Favorites"): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
        (candidate) => candidate.textContent === text,
    )!;
}

async function openMenu(container: HTMLElement): Promise<void> {
    await act(async () => button(container, "Conversation options").click());
}

beforeEach(() => localStorage.clear());

describe("session-control banners", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("renders the persistent storage banner alongside a transient control error", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            preferencesUnavailable: true,
            controlError: "Couldn't save — device storage is full or unavailable.",
        };

        rendered = await renderClient(client);

        expect(
            [...rendered.container.querySelectorAll('[role="status"]')].map((element) => element.textContent),
        ).toEqual([PREFERENCES_UNAVAILABLE_ERROR, "Couldn't save — device storage is full or unavailable."]);
    });
});

describe("markdown render-site integration", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("renders markdown only for EventContent text events", async () => {
        const client = signedInClient();
        const text = textEvent(1, "**bold text**");
        const promptReply: JournalEvent = {
            ...textEvent(2, "unused"),
            type: "prompt_reply",
            payload: { choice: "**plain reply**" },
        };
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        rendered = { container, root };

        await act(async () => {
            root.render(
                React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(EventContent, { client, event: text, answeredPrompts: new Set<number>() }),
                    React.createElement(EventContent, {
                        client,
                        event: promptReply,
                        answeredPrompts: new Set<number>(),
                    }),
                ),
            );
        });

        expect(container.querySelector(".mj_Markdown strong")?.textContent).toBe("bold text");
        const plainReply = container.querySelector(".mj_MessageText");
        expect(plainReply?.textContent).toBe("**plain reply**");
        expect(plainReply?.querySelector("strong")).toBeNull();
    });

    it("renders pending and streaming markdown while keeping the stream cursor outside the markdown subtree", async () => {
        const client = signedInClient({
            pendingMessages: [{ localId: "pending-markdown", convoId: "c1", body: "**pending bold**", createdAt: 1 }],
        });
        internals(client).state = {
            ...client.getSnapshot(),
            textStreams: { response: "**stream bold**" },
        };

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mx_EventTile_sending .mj_Markdown strong")?.textContent).toBe(
            "pending bold",
        );
        const cursor = rendered.container.querySelector(".mj_Cursor");
        const streamMarkdown = cursor?.parentElement;
        expect(streamMarkdown?.classList.contains("mj_Markdown")).toBe(true);
        expect(streamMarkdown?.querySelector("strong")?.textContent).toBe("stream bold");
        expect(cursor?.parentElement).toBe(streamMarkdown);
        expect(cursor?.parentElement?.children).toContain(cursor);
    });
});

function fileDragEvent(type: string, file: File): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files: [file] },
    });
    return event;
}

function inputTextarea(textarea: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function textEvent(seq: number, body: string): JournalEvent {
    return { seq, convo_id: "c1", ts: seq, sender: "agent", type: "text", payload: { body } };
}

function renderAppWithEvents(
    events: JournalEvent[],
    convoIds = ["c1"],
): Promise<{ container: HTMLDivElement; root: Root; client: MatronJournalClient }> {
    const conversations = convoIds.map((id) => ({ ...CONVERSATION, id, title: id }));
    const client = signedInWithRooms(conversations);
    internals(client).state = { ...client.getSnapshot(), events: events.filter((event) => event.convo_id === "c1") };
    internals(client).database = {
        events: jest.fn(async (convoId: string) => events.filter((event) => event.convo_id === convoId)),
        outbox: jest.fn(async () => []),
    };
    return renderClient(client).then((rendered) => ({ ...rendered, client }));
}

async function renderAppWithToolStream(): Promise<{
    container: HTMLDivElement;
    root: Root;
    client: MatronJournalClient;
}> {
    const client = signedInClient();
    internals(client).state = {
        ...client.getSnapshot(),
        toolStreams: {
            running: {
                messageRef: "running",
                content: "working",
                offset: 7,
                headTruncated: false,
                tool: "shell",
                command: "test",
            },
        },
    };
    return renderClient(client).then((rendered) => ({ ...rendered, client }));
}

async function rightClick(node: Element): Promise<void> {
    await act(async () => {
        node.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 32 }),
        );
    });
}

async function openRowMenu(container: HTMLElement, seq: number): Promise<void> {
    const row = container.querySelector(`[data-event-id="${seq}"]`);
    if (!row) throw new Error(`Missing event row: ${seq}`);
    await rightClick(row);
}

async function clickMenuItem(container: HTMLElement, label: string): Promise<void> {
    const item = [...container.querySelectorAll<HTMLButtonElement>('.mj_EventRowMenu [role="menuitem"]')].find(
        (candidate) => candidate.textContent === label,
    );
    if (!item) throw new Error(`Missing menu item: ${label}`);
    await act(async () => item.click());
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
    const item = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === label,
    );
    if (!item) throw new Error(`Missing button: ${label}`);
    await act(async () => item.click());
}

function renderComposerApp(
    convoIds: string[],
    client?: MatronJournalClient,
): Promise<{ container: HTMLDivElement; root: Root; client: MatronJournalClient }> {
    if (client) {
        const conversations = convoIds.map((id) => ({ ...CONVERSATION, id, title: id }));
        internals(client).state = {
            ...client.getSnapshot(),
            conversations,
            selectedConversationId: convoIds[0] ?? null,
            events: [],
        };
        internals(client).database = {
            events: jest.fn(async () => []),
            outbox: jest.fn(async () => []),
        };
        return renderClient(client).then((rendered) => ({ ...rendered, client }));
    }
    return renderAppWithEvents([], convoIds);
}

function renderComposerAppWithChild(
    parentId: string,
    childId: string,
): Promise<{ container: HTMLDivElement; root: Root; client: MatronJournalClient }> {
    const parent = { ...CONVERSATION, id: parentId, title: parentId };
    const child = { ...CONVERSATION, id: childId, title: childId, parent_convo_id: parentId };
    const client = signedInWithRooms([parent, child]);
    internals(client).state = { ...client.getSnapshot(), selectedConversationId: parentId };
    internals(client).database = {
        events: jest.fn(async () => []),
        outbox: jest.fn(async () => []),
    };
    return renderClient(client).then((rendered) => ({ ...rendered, client }));
}

function composerValue(container: HTMLElement): string {
    const textarea = container.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input");
    if (!textarea) throw new Error("Missing composer textarea");
    return textarea.value;
}

async function typeInComposer(container: HTMLElement, value: string): Promise<void> {
    const textarea = container.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input");
    if (!textarea) throw new Error("Missing composer textarea");
    await act(async () => inputTextarea(textarea, value));
}

async function pressEnter(container: HTMLElement): Promise<void> {
    const textarea = container.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input");
    if (!textarea) throw new Error("Missing composer textarea");
    await keydown(textarea, "Enter");
}

async function selectFirstPaletteItem(container: HTMLElement): Promise<void> {
    const item = container.querySelector<HTMLElement>('[role="option"]');
    if (!item) throw new Error("Missing palette item");
    await act(async () => item.click());
}

async function touchPress(node: Element, pointerId = 1): Promise<void> {
    const event = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 18,
    });
    Object.defineProperties(event, {
        pointerType: { value: "touch" },
        pointerId: { value: pointerId },
    });
    await act(async () => node.dispatchEvent(event));
}

async function keydown(
    element: Element,
    key: string,
    options: KeyboardEventInit & { keyCode?: number } = {},
): Promise<{ event: KeyboardEvent; dispatched: boolean }> {
    const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
    });
    if (options.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: options.keyCode });
    let dispatched = true;
    await act(async () => {
        dispatched = element.dispatchEvent(event);
        await Promise.resolve();
    });
    return { event, dispatched };
}

describe("slash command palette", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        (Element.prototype.scrollIntoView as jest.Mock).mockClear();
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    const composer = (): HTMLTextAreaElement => {
        const textarea = rendered?.container.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input");
        if (!textarea) throw new Error("Missing composer textarea");
        return textarea;
    };

    const options = (): HTMLElement[] => [
        ...(rendered?.container.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
    ];

    it("opens command rows for a slash-command prefix", async () => {
        rendered = await renderClient(signedInClient());

        await act(async () => inputTextarea(composer(), "/st"));

        expect(rendered.container.querySelector('[role="listbox"]')).not.toBeNull();
        expect(options().map((row) => row.querySelector(".mx_SlashPalette_trigger")?.textContent)).toEqual([
            "/start",
            "/stop",
            "/status",
        ]);
    });

    it("highlights with ArrowDown and selects with Enter without sending", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const arrow = await keydown(composer(), "ArrowDown");
        expect(arrow.dispatched).toBe(false);
        expect(arrow.event.defaultPrevented).toBe(true);
        expect(options()[0].getAttribute("aria-selected")).toBe("true");

        const enter = await keydown(composer(), "Enter");
        expect(enter.dispatched).toBe(false);
        expect(enter.event.defaultPrevented).toBe(true);
        expect(composer().value).toBe("/start ");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("leaves Shift+Enter untouched when a row is highlighted", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));
        await keydown(composer(), "ArrowDown");

        const shifted = await keydown(composer(), "Enter", { shiftKey: true });

        expect(shifted.dispatched).toBe(true);
        expect(shifted.event.defaultPrevented).toBe(false);
        expect(composer().value).toBe("/st");
        expect(options()[0].getAttribute("aria-selected")).toBe("true");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("sends the literal body on Enter when no row is highlighted", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const enter = await keydown(composer(), "Enter");

        expect(enter.dispatched).toBe(false);
        expect(enter.event.defaultPrevented).toBe(true);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith("/st", "c1");
    });

    it("dismisses the palette with Escape without changing the body", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const escape = await keydown(composer(), "Escape");

        expect(escape.dispatched).toBe(false);
        expect(escape.event.defaultPrevented).toBe(true);
        expect(rendered.container.querySelector('[role="listbox"]')).toBeNull();
        expect(composer().value).toBe("/st");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("completes the first row with Tab", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const tab = await keydown(composer(), "Tab");

        expect(tab.dispatched).toBe(false);
        expect(tab.event.defaultPrevented).toBe(true);
        expect(composer().value).toBe("/start ");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("does not select, send, or cancel IME Enter events", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));
        await keydown(composer(), "ArrowDown");

        const composing = await keydown(composer(), "Enter", { isComposing: true });
        const legacyComposing = await keydown(composer(), "Enter", { keyCode: 229 });

        for (const result of [composing, legacyComposing]) {
            expect(result.dispatched).toBe(true);
            expect(result.event.defaultPrevented).toBe(false);
        }
        expect(composer().value).toBe("/st");
        expect(options()[0].getAttribute("aria-selected")).toBe("true");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("highlights and click-selects a recent folder exactly once", async () => {
        makeRecentFoldersStore(SESSION).record("/srv/Project");
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/workdir /srv/P"));
        expect(options().map((row) => row.textContent)).toEqual(["/srv/Project"]);

        await act(async () =>
            options()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true })),
        );
        expect(options()[0].getAttribute("aria-selected")).toBe("true");
        expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

        const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        await act(async () => options()[0].dispatchEvent(mouseDown));
        expect(mouseDown.defaultPrevented).toBe(true);
        expect(composer().value).toBe("/workdir /srv/P");

        await act(async () => options()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
        expect(composer().value).toBe("/workdir /srv/Project");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("records only folder commands accepted by sendMessage", async () => {
        const store = makeRecentFoldersStore(SESSION);
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        rendered = await renderClient(client);

        await act(async () => inputTextarea(composer(), "/workdir /op/accepted"));
        await keydown(composer(), "Enter");
        expect(store.matches("")).toContain("/op/accepted");
        const acceptedSnapshot = JSON.stringify(store.matches(""));

        await act(async () => inputTextarea(composer(), "/workdir /op/rejected"));
        await keydown(composer(), "Enter");

        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(store.matches("")).not.toContain("/op/rejected");
        expect(JSON.stringify(store.matches(""))).toBe(acceptedSnapshot);
    });
});

describe("composer drafts", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    test("draft persists per conversation across navigation", async () => {
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(rendered.container, "draft for one");
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(composerValue(rendered.container)).toBe("");
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(rendered.container)).toBe("draft for one");
    });

    test("a completion pick (folder) is persisted", async () => {
        jest.spyOn(require("../../../src/journal/slash-palette"), "makeRecentFoldersStore").mockReturnValue({
            record: jest.fn(),
            matches: () => ["work/dir"],
        });
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(rendered.container, "/workdir wo");
        await selectFirstPaletteItem(rendered.container);
        const composed = composerValue(rendered.container);
        expect(composed).not.toBe("/workdir wo");
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(rendered.container)).toBe(composed);
    });

    test("a throwing setItem does not lose the draft on navigation", async () => {
        const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("q", "QuotaExceededError");
        });
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(rendered.container, "kept in memory");
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(rendered.container)).toBe("kept in memory");
        spy.mockRestore();
    });

    test("keystroke debounces the localStorage write (no setItem before 250ms, one after)", async () => {
        jest.useFakeTimers();
        const setItem = jest.spyOn(Storage.prototype, "setItem");
        const result = await renderComposerApp(["c1"]);
        rendered = result;
        setItem.mockClear();
        await typeInComposer(rendered.container, "x");
        expect(setItem).not.toHaveBeenCalled();
        await act(async () => {
            jest.advanceTimersByTime(250);
        });
        expect(setItem).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    test("pagehide flushes a pending draft write within the debounce window", async () => {
        jest.useFakeTimers();
        const setItem = jest.spyOn(Storage.prototype, "setItem");
        const result = await renderComposerApp(["c1"]);
        rendered = result;
        await typeInComposer(result.container, "unsaved edit");
        setItem.mockClear();
        await act(async () => {
            window.dispatchEvent(new Event("pagehide"));
        });
        expect(setItem).toHaveBeenCalled();
        jest.useRealTimers();
    });

    test("unmount (switch to read-only child) within the debounce window flushes the draft (round-4 B1)", async () => {
        jest.useFakeTimers();
        const result = await renderComposerAppWithChild("c1", "c1-child");
        rendered = result;
        await typeInComposer(result.container, "edit before unmount");
        await act(async () => {
            await result.client.selectConversation("c1-child");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("edit before unmount");
        jest.useRealTimers();
    });
});

describe("composer sends", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    test("two rapid Enters send once", async () => {
        let resolve!: (value: boolean) => void;
        const client = signedInClient();
        const send = jest
            .spyOn(client, "sendMessage")
            .mockReturnValue(new Promise((promiseResolve) => (resolve = promiseResolve)));
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "hi");
        await pressEnter(result.container);
        await pressEnter(result.container);
        expect(send).toHaveBeenCalledTimes(1);
        await act(async () => {
            resolve(true);
        });
    });

    test("cross-convo: send in A pending, Enter in B not blocked; A resolve leaves B untouched; A draft cleared", async () => {
        let resolveA!: (value: boolean) => void;
        const client = signedInClient();
        const send = jest
            .spyOn(client, "sendMessage")
            .mockReturnValueOnce(new Promise((promiseResolve) => (resolveA = promiseResolve)))
            .mockResolvedValue(true);
        const result = await renderComposerApp(["c1", "c2"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await typeInComposer(result.container, "B-msg");
        await pressEnter(result.container);
        expect(send).toHaveBeenNthCalledWith(2, "B-msg", "c2");
        await act(async () => {
            resolveA(true);
        });
        expect(composerValue(result.container)).toBe("");
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("");
    });

    test("same-convo interleave: follow-up Y typed during a pending send is preserved", async () => {
        let resolveX!: (value: boolean) => void;
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockReturnValueOnce(
            new Promise((promiseResolve) => (resolveX = promiseResolve)),
        );
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await typeInComposer(result.container, "Y");
        await act(async () => {
            resolveX(true);
        });
        expect(composerValue(result.container)).toBe("Y");
        expect(makeDraftStore(SESSION).read("c1").text).toBe("Y");
    });

    test("same-convo ABA interleave: a re-typed X during a pending X send is preserved", async () => {
        let resolveX!: (value: boolean) => void;
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockReturnValueOnce(
            new Promise((promiseResolve) => (resolveX = promiseResolve)),
        );
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await typeInComposer(result.container, "Y");
        await typeInComposer(result.container, "X");
        await act(async () => {
            resolveX(true);
        });
        expect(composerValue(result.container)).toBe("X");
        expect(makeDraftStore(SESSION).read("c1").text).toBe("X");
    });

    test("late resolve after a conversation switch does not resurrect the sent draft", async () => {
        let resolveX!: (value: boolean) => void;
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockReturnValueOnce(
            new Promise((promiseResolve) => (resolveX = promiseResolve)),
        );
        const result = await renderComposerApp(["c1", "c2"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await act(async () => {
            resolveX(true);
            await result.client.selectConversation("c2");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("");
        expect(makeDraftStore(SESSION).read("c1").text).toBe("");
    });

    test("recent-folder is recorded on a successful folder-bearing send", async () => {
        const record = jest.fn();
        jest.spyOn(require("../../../src/journal/slash-palette"), "makeRecentFoldersStore").mockReturnValue({
            record,
            matches: () => [],
        });
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "/start work/dir do it");
        await pressEnter(result.container);
        await act(async () => undefined);
        expect(record).toHaveBeenCalledWith("work/dir");
    });

    test("an addToOutbox rejection is caught (no unhandled rejection), text retained, lock released", async () => {
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "hi");
        await pressEnter(result.container);
        await act(async () => undefined);
        expect(composerValue(result.container)).toBe("hi");
        jest.spyOn(client, "sendMessage").mockResolvedValueOnce(true);
        await pressEnter(result.container);
        await act(async () => undefined);
        expect(composerValue(result.container)).toBe("");
    });

    test("remount clears a resolved send and a post-resolution Enter does not duplicate", async () => {
        let resolveX!: (value: boolean) => void;
        const result = await renderComposerAppWithChild("c1", "c1-child");
        rendered = result;
        const send = jest
            .spyOn(result.client, "sendMessage")
            .mockReturnValueOnce(new Promise((promiseResolve) => (resolveX = promiseResolve)));
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await act(async () => {
            await result.client.selectConversation("c1-child");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("X");
        await act(async () => {
            resolveX(true);
        });
        expect(composerValue(result.container)).toBe("");
        await pressEnter(result.container);
        expect(send).toHaveBeenCalledTimes(1);
    });
});

describe("attachment composer", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("opens the picker, dispatches files, and resets it so the same file can be selected again", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles").mockImplementation(() => undefined);
        rendered = await renderClient(client);
        const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]');
        if (!input) throw new Error("Missing file input");
        const clickInput = jest.spyOn(input, "click");

        await act(async () => button(rendered!.container, "Attach a file").click());

        expect(clickInput).toHaveBeenCalledTimes(1);
        expect(input.multiple).toBe(true);
        expect(button(rendered.container, "Attach a file").getAttribute("aria-disabled")).toBeNull();
        expect(button(rendered.container, "Voice message").getAttribute("aria-disabled")).toBe("true");

        const file = new File(["same"], "same.txt", { type: "text/plain" });
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        Object.defineProperty(input, "value", { configurable: true, writable: true, value: "selected" });

        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
        expect(input.value).toBe("");
        input.value = "selected";
        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

        expect(stageFiles).toHaveBeenNthCalledWith(1, [file]);
        expect(stageFiles).toHaveBeenNthCalledWith(2, [file]);
        expect(input.value).toBe("");
    });

    it("accepts file drops, prevents browser navigation, and clears the overlay", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles").mockImplementation(() => undefined);
        rendered = await renderClient(client);
        const room = rendered.container.querySelector<HTMLElement>(".mx_RoomView");
        if (!room) throw new Error("Missing conversation pane");
        const file = new File(["drop"], "drop.txt", { type: "text/plain" });
        const dragOver = fileDragEvent("dragover", file);

        await act(async () => room.dispatchEvent(dragOver));
        expect(dragOver.defaultPrevented).toBe(true);
        expect(rendered!.container.textContent).toContain("Drop files to attach");

        const drop = fileDragEvent("drop", file);
        await act(async () => room.dispatchEvent(drop));

        expect(drop.defaultPrevented).toBe(true);
        expect(stageFiles).toHaveBeenCalledWith([file]);
        expect(rendered.container.textContent).not.toContain("Drop files to attach");
    });

    it("shows the overlay only for file drags and keeps it active over child elements", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const room = rendered.container.querySelector<HTMLElement>(".mx_RoomView");
        const child = rendered.container.querySelector<HTMLElement>(".mx_RoomView_body");
        if (!room || !child) throw new Error("Missing conversation pane");

        const textDrag = new Event("dragover", { bubbles: true, cancelable: true });
        Object.defineProperty(textDrag, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
        await act(async () => room.dispatchEvent(textDrag));
        expect(textDrag.defaultPrevented).toBe(false);
        expect(rendered!.container.textContent).not.toContain("Drop files to attach");

        const file = new File(["drag"], "drag.txt", { type: "text/plain" });
        await act(async () => room.dispatchEvent(fileDragEvent("dragover", file)));
        const overChild = new MouseEvent("dragleave", { bubbles: true, relatedTarget: child });
        await act(async () => room.dispatchEvent(overChild));
        expect(rendered!.container.textContent).toContain("Drop files to attach");

        await act(async () => room.dispatchEvent(new Event("dragend", { bubbles: true })));
        expect(rendered.container.textContent).not.toContain("Drop files to attach");

        await act(async () => room.dispatchEvent(fileDragEvent("dragover", file)));
        const leavePane = new MouseEvent("dragleave", { bubbles: true, relatedTarget: document.body });
        await act(async () => room.dispatchEvent(leavePane));
        expect(rendered.container.textContent).not.toContain("Drop files to attach");
    });

    it("dispatches pasted clipboard files", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles").mockImplementation(() => undefined);
        rendered = await renderClient(client);
        const textarea = rendered.container.querySelector<HTMLTextAreaElement>("textarea");
        if (!textarea) throw new Error("Missing composer textarea");
        const screenshot = new File(["image"], "screenshot.png", { type: "image/png" });
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: { files: [screenshot] } });

        await act(async () => textarea.dispatchEvent(paste));

        expect(stageFiles).toHaveBeenCalledWith([screenshot]);
    });

    it("paste while the modal is open appends exactly once (composer handler inert)", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles");
        rendered = await renderClient(client);
        await act(async () => client.stageFiles([new File(["a"], "a.txt", { type: "text/plain" })]));
        stageFiles.mockClear();

        const textareaEl = rendered.container.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input")!;
        const pasted = new File(["p"], "p.png", { type: "image/png" });
        await act(async () => {
            textareaEl.dispatchEvent(
                Object.assign(new Event("paste", { bubbles: true }), { clipboardData: { files: [pasted] } }),
            );
        });
        expect(stageFiles).toHaveBeenCalledTimes(1);
        expect(client.getSnapshot().stagedUploads!.total).toBe(2);
    });

    it("file drop while the modal is open prevents navigation and stages nothing extra", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await act(async () => client.stageFiles([new File(["a"], "a.txt", { type: "text/plain" })]));
        const stageFiles = jest.spyOn(client, "stageFiles");

        const scrim = rendered.container.querySelector<HTMLElement>(".mj_UploadConfirm_scrim")!;
        const dragOver = fileDragEvent("dragover", new File(["d"], "d.txt", { type: "text/plain" }));
        await act(async () => scrim.dispatchEvent(dragOver));
        expect(dragOver.defaultPrevented).toBe(true);

        const drop = fileDragEvent("drop", new File(["d"], "d.txt", { type: "text/plain" }));
        await act(async () => scrim.dispatchEvent(drop));
        expect(drop.defaultPrevented).toBe(true);
        expect(stageFiles).not.toHaveBeenCalled();
    });

    it("renders uploading and sending attachments as chips rather than empty text bubbles", async () => {
        const client = signedInClient({
            pendingMessages: [
                {
                    localId: "uploading",
                    convoId: "c1",
                    body: "",
                    createdAt: 1,
                    kind: "image",
                    filename: "photo.png",
                    attachState: "uploading",
                },
                {
                    localId: "sending",
                    convoId: "c1",
                    body: "",
                    createdAt: 2,
                    kind: "file",
                    filename: "notes.txt",
                    attachState: "sending",
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_AttachmentChip_uploading")?.textContent).toContain("Uploading…");
        expect(rendered.container.querySelector(".mj_AttachmentChip_sending")?.textContent).toContain("Sending…");
        expect(rendered.container.querySelector(".mx_EventTile_sending")).toBeNull();
        expect(rendered.container.querySelector(".mj_MessageText")).toBeNull();
    });

    it("renders pending messages in timestamp order among journal events", async () => {
        const client = signedInClient({
            events: [
                {
                    kind: "journal",
                    seq: 1,
                    convo_id: "c1",
                    ts: 100,
                    sender: "agent:dev",
                    type: "text",
                    payload: { body: "first event" },
                },
                {
                    kind: "journal",
                    seq: 2,
                    convo_id: "c1",
                    ts: 300,
                    sender: "agent:dev",
                    type: "text",
                    payload: { body: "last event" },
                },
            ],
            pendingMessages: [
                { localId: "pending-late", convoId: "c1", body: "pending late", createdAt: 250 },
                { localId: "pending-early", convoId: "c1", body: "pending early", createdAt: 200 },
            ],
        });
        rendered = await renderClient(client);

        expect(
            [...rendered.container.querySelectorAll(".mx_EventTile_content")].map((item) => item.textContent),
        ).toEqual(["first event", "pending early", "pending late", "last event"]);
    });

    it("renders an echoed file as the inline media tile", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "file",
                    payload: { blob_ref: "media-1", filename: "report.pdf", size: 12 },
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_File")?.textContent).toContain("report.pdf");
        expect(rendered.container.querySelector(".mj_AttachmentChip")).toBeNull();
    });

    it("renders the caption under file tiles and pending chips, and prefers errorMessage on error chips", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:dan",
                    type: "file",
                    payload: {
                        blob_ref: "m1",
                        filename: "notes.txt",
                        size: 10,
                        caption: "read this first",
                    },
                },
            ],
            pendingMessages: [
                {
                    localId: "p1",
                    convoId: "c1",
                    body: "",
                    createdAt: 2,
                    kind: "image",
                    filename: "shot.png",
                    size: 5,
                    contentType: "image/png",
                    blobRef: null,
                    attachState: "error",
                    errorKind: "upload_failed",
                    canRetry: true,
                    caption: "look at this",
                    errorMessage: "Conversation was archived in another tab — unarchive to retry.",
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.textContent).toContain("read this first");
        expect(rendered.container.textContent).toContain("look at this");
        expect(rendered.container.textContent).toContain("unarchive to retry");
    });

    it("shows Retry only when canRetry is true and dispatches the retry", async () => {
        const errorMessage: PendingMessage = {
            localId: "failed",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "failed.txt",
            attachState: "error",
            errorKind: "upload_failed",
            canRetry: false,
        };
        const client = signedInClient({ pendingMessages: [errorMessage] });
        const retry = jest.spyOn(client, "retryAttachment").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        expect(rendered.container.querySelector(".mj_AttachmentChip_error")?.textContent).toContain(
            "Couldn't upload attachment.",
        );
        expect([...rendered.container.querySelectorAll("button")].some((item) => item.textContent === "Retry")).toBe(
            false,
        );

        await act(async () => rendered?.root.unmount());
        rendered.container.remove();
        rendered = undefined;

        const retryableClient = signedInClient({ pendingMessages: [{ ...errorMessage, canRetry: true }] });
        const retryable = jest.spyOn(retryableClient, "retryAttachment").mockResolvedValue(undefined);
        rendered = await renderClient(retryableClient);
        const retryButton = [...rendered.container.querySelectorAll("button")].find(
            (item) => item.textContent === "Retry",
        );
        if (!retryButton) throw new Error("Missing Retry button");
        await act(async () => retryButton.click());

        expect(retry).not.toHaveBeenCalled();
        expect(retryable).toHaveBeenCalledWith("failed");
    });

    it("shows the original terminal Electron upload error without Retry", async () => {
        const client = signedInClient({
            pendingMessages: [
                {
                    localId: "desktop-failed",
                    convoId: "c1",
                    body: "",
                    createdAt: 1,
                    kind: "file",
                    filename: "desktop.bin",
                    attachState: "error",
                    errorKind: "electron_binary_unsupported",
                    errorMessage: "Attachments aren't supported in this desktop package.",
                    canRetry: false,
                },
            ],
        });

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_AttachmentChip_error")?.textContent).toContain(
            "Attachments aren't supported in this desktop package.",
        );
        expect([...rendered.container.querySelectorAll("button")].some((item) => item.textContent === "Retry")).toBe(
            false,
        );
    });

    it("Dismiss durably removes the attachment row and its retained bytes", async () => {
        const message: PendingMessage = {
            localId: "failed",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "failed.txt",
            attachState: "error",
            errorKind: "upload_failed",
            canRetry: true,
        };
        const rows = new Map([[message.localId, message]]);
        const database = {
            deleteOutboxRow: jest.fn(async (localId: string) => {
                rows.delete(localId);
            }),
            events: jest.fn().mockResolvedValue([]),
            outbox: jest.fn(async () => [...rows.values()]),
        };
        const client = signedInClient({ pendingMessages: [message] });
        internals(client).database = database;
        internals(client).pendingFiles.set(message.localId, new File(["retry"], message.filename!));
        rendered = await renderClient(client);
        const dismiss = [...rendered.container.querySelectorAll("button")].find(
            (item) => item.textContent === "Dismiss",
        );
        if (!dismiss) throw new Error("Missing Dismiss button");

        await act(async () => {
            dismiss.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(database.deleteOutboxRow).toHaveBeenCalledWith(message.localId);
        expect(rows.has(message.localId)).toBe(false);
        expect(internals(client).pendingFiles.has(message.localId)).toBe(false);
        expect(rendered.container.querySelector(".mj_AttachmentChip")).toBeNull();
    });
});

describe("EventRow context menu and source sheet", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    test("right-click a text EventRow opens a menu with Copy and View source", async () => {
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        await openRowMenu(rendered.container, 5);
        const items = [...rendered.container.querySelectorAll('.mj_EventRowMenu [role="menuitem"]')].map(
            (node) => node.textContent,
        );
        expect(items).toEqual(["Copy", "View source"]);
    });

    test("a non-text event hides Copy, keeps View source", async () => {
        rendered = await renderAppWithEvents([
            { seq: 6, convo_id: "c1", ts: 1, sender: "agent", type: "diff", payload: {} },
        ]);
        await openRowMenu(rendered.container, 6);
        expect(
            [...rendered.container.querySelectorAll('.mj_EventRowMenu [role="menuitem"]')].map(
                (node) => node.textContent,
            ),
        ).toEqual(["View source"]);
    });

    test("a ToolStream / pending placeholder row has no menu on right-click", async () => {
        rendered = await renderAppWithToolStream();
        const row = rendered.container.querySelector(".mj_LiveTool")?.closest("li");
        if (!row) throw new Error("Missing tool stream row");
        await rightClick(row);
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();
    });

    test("Copy on a text row calls the clipboard with the body", async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        rendered = await renderAppWithEvents([textEvent(5, "hello")]);
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "Copy");
        expect(writeText).toHaveBeenCalledWith("hello");
    });

    test("View source shows the event DTO JSON; Copy button, Done, Esc, and backdrop all close", async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        const pre = rendered.container.querySelector(".mj_EventSource_json");
        expect(pre?.textContent).toContain('"seq": 5');
        expect(pre?.textContent).toContain('"body": "hi"');
        await clickButton(rendered.container, "Copy");
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"seq": 5'));
        await clickButton(rendered.container, "Done");
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();
        expect(document.activeElement).toBe(rendered.container.querySelector('[data-event-id="5"]'));

        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();

        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        await act(async () => {
            (rendered?.container.querySelector(".mj_EventSource_scrim") as HTMLElement).click();
        });
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();
    });

    test("View source traps Tab and Shift+Tab within the sheet", async () => {
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        const sheet = rendered.container.querySelector(".mj_EventSource");
        const buttons = [...(sheet?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        expect(buttons.map((candidate) => candidate.textContent)).toEqual(["Copy", "Done"]);
        expect(document.activeElement).toBe(buttons[1]);

        const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        await act(async () => document.dispatchEvent(forward));
        expect(forward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(buttons[0]);

        const backward = new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        await act(async () => document.dispatchEvent(backward));
        expect(backward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(buttons[1]);
    });

    test("long-press opens the menu; a scroll during the press cancels it", async () => {
        jest.useFakeTimers();
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        const row = rendered.container.querySelector('[data-event-id="5"]') as HTMLElement;
        await touchPress(row);
        await act(async () => {
            document.dispatchEvent(new Event("scroll", { bubbles: true }));
            jest.advanceTimersByTime(500);
        });
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();
        await touchPress(row);
        await act(async () => jest.advanceTimersByTime(500));
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
    });

    test("a long-press timer firing after the row unmounts does not poison the next conversation", async () => {
        jest.useFakeTimers();
        const result = await renderAppWithEvents(
            [textEvent(5, "hi"), { ...textEvent(6, "new conversation"), convo_id: "c2" }],
            ["c1", "c2"],
        );
        rendered = result;
        const row = rendered.container.querySelector('[data-event-id="5"]') as HTMLElement;
        await touchPress(row, 1);
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await act(async () => jest.advanceTimersByTime(500));
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();

        const newRow = rendered.container.querySelector('[data-event-id="6"]') as HTMLElement;
        await touchPress(newRow, 2);
        await act(async () => jest.advanceTimersByTime(500));
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
    });

    test("switching conversations closes an OPEN MENU (menu still open, not via View source)", async () => {
        const result = await renderAppWithEvents([textEvent(5, "hi")], ["c1", "c2"]);
        rendered = result;
        await openRowMenu(rendered.container, 5);
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();
    });

    test("switching conversations closes an open source sheet", async () => {
        const result = await renderAppWithEvents([textEvent(5, "hi")], ["c1", "c2"]);
        rendered = result;
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        expect(rendered.container.querySelector(".mj_EventSource")).not.toBeNull();
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();
    });

    test("long-pressing a prompt button opens the menu without activating the button", async () => {
        jest.useFakeTimers();
        const prompt: JournalEvent = {
            seq: 7,
            convo_id: "c1",
            ts: 1,
            sender: "agent",
            type: "prompt",
            payload: { question: "Choose", options: ["Yes"] },
        };
        const result = await renderAppWithEvents([prompt]);
        rendered = result;
        const sendPromptReply = jest.spyOn(result.client, "sendPromptReply").mockReturnValue(true);
        const option = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === "Yes",
        );
        if (!option) throw new Error("Missing prompt option");
        await touchPress(option);
        await act(async () => jest.advanceTimersByTime(500));
        await act(async () => option.click());
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
        expect(sendPromptReply).not.toHaveBeenCalled();
    });
});

describe("UploadConfirmDialog", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    const stage = async (client: MatronJournalClient, files: File[]): Promise<void> => {
        await act(async () => client.stageFiles(files));
    };

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        if (!URL.createObjectURL) URL.createObjectURL = () => "blob:preview";
        if (!URL.revokeObjectURL) URL.revokeObjectURL = () => undefined;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("renders preview + caption for an image and confirms with the typed caption on Send and on Enter", async () => {
        const client = signedInClient();
        const confirm = jest.spyOn(client, "confirmStagedFile").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        await stage(client, [new File(["x"], "shot.png", { type: "image/png" })]);

        const dialog = rendered.container.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.getAttribute("aria-modal")).toBe("true");
        expect(dialog!.querySelector("img")).not.toBeNull();

        const textarea = dialog!.querySelector<HTMLTextAreaElement>("textarea");
        expect(document.activeElement).toBe(textarea);
        expect(textarea!.maxLength).toBe(4096);
        await act(async () => {
            inputTextarea(textarea!, "look here");
        });
        const headId = client.getSnapshot().stagedUploads!.items[0].id;
        await act(async () => button(dialog as HTMLElement, "Send").click());
        expect(confirm).toHaveBeenCalledWith(headId, "look here");
    });

    it("makes background keyboard controls inert and restores composer focus when the dialog closes", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const composer = rendered.container.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input")!;
        composer.focus();

        await stage(client, [new File(["a"], "a.txt", { type: "text/plain" })]);

        const appContent = rendered.container.querySelector<HTMLElement>(".mx_MatrixChat")!;
        const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(appContent.hasAttribute("inert")).toBe(true);
        expect(
            rendered.container.querySelectorAll(".mx_MatrixChat button, .mx_MatrixChat textarea").length,
        ).toBeGreaterThan(0);
        for (const control of rendered.container.querySelectorAll(".mx_MatrixChat button, .mx_MatrixChat textarea")) {
            expect(control.closest("[inert]")).toBe(appContent);
        }
        expect(document.activeElement).toBe(dialog.querySelector<HTMLTextAreaElement>("textarea"));

        await act(async () => button(dialog, "Cancel").click());
        expect(appContent.hasAttribute("inert")).toBe(false);
        expect(document.activeElement).toBe(composer);
    });

    it("shows name+size (no img) for non-images, pages 'File k of N', and isolates captions per page", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await stage(client, [
            new File(["a"], "a.txt", { type: "text/plain" }),
            new File(["b"], "b.txt", { type: "text/plain" }),
        ]);
        const dialog = (): HTMLElement => rendered!.container.querySelector('[role="dialog"]')!;
        expect(dialog().textContent).toContain("File 1 of 2");
        expect(dialog().querySelector("img")).toBeNull();
        expect(dialog().textContent).toContain("a.txt");

        const textarea = dialog().querySelector<HTMLTextAreaElement>("textarea")!;
        await act(async () => {
            inputTextarea(textarea, "caption for a");
        });
        await act(async () => {
            const headId = client.getSnapshot().stagedUploads!.items[0].id;
            client.skipStagedFile(headId);
        });
        expect(dialog().textContent).toContain("File 2 of 2");
        expect(dialog().querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    });

    it("keyboard contract: Enter confirms; Shift+Enter, IME-composing Enter, and keyCode-229 Enter do not; Escape skips", async () => {
        const client = signedInClient();
        const confirm = jest.spyOn(client, "confirmStagedFile").mockResolvedValue(undefined);
        const skip = jest.spyOn(client, "skipStagedFile");
        rendered = await renderClient(client);
        await stage(client, [new File(["ok"], "ok.png", { type: "image/png" })]);
        const textarea = (): HTMLTextAreaElement =>
            rendered!.container.querySelector<HTMLElement>('[role="dialog"]')!.querySelector("textarea")!;
        const key = (init: KeyboardEventInit & { keyCode?: number }) =>
            act(async () => {
                const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
                if (init.keyCode) Object.defineProperty(event, "keyCode", { value: init.keyCode });
                textarea().dispatchEvent(event);
            });

        await key({ key: "Enter", shiftKey: true });
        expect(confirm).not.toHaveBeenCalled();
        await key({ key: "Enter", isComposing: true } as KeyboardEventInit);
        expect(confirm).not.toHaveBeenCalled();
        await key({ key: "Enter", keyCode: 229 });
        expect(confirm).not.toHaveBeenCalled();
        await key({ key: "Enter" });
        expect(confirm).toHaveBeenCalledTimes(1);
        await key({ key: "Escape" });
        expect(skip).toHaveBeenCalledTimes(1);
    });

    it("zero-byte and over-cap files disable Send AND the Enter path", async () => {
        const client = signedInClient();
        const confirm = jest.spyOn(client, "confirmStagedFile").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        const empty = new File([], "empty.bin", { type: "application/octet-stream" });
        const big = new File([""], "big.bin", { type: "application/octet-stream" });
        Object.defineProperty(big, "size", { value: BROWSER_MEMORY_SAFETY_MAX_BYTES + 1 });
        await stage(client, [empty, big]);

        for (let page = 0; page < 2; page += 1) {
            const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
            expect(dialog.querySelector<HTMLButtonElement>("button.mj_UploadConfirm_send")?.disabled).toBe(true);
            const textarea = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
            await act(async () => {
                textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            });
            expect(confirm).not.toHaveBeenCalled();
            await act(async () => client.skipStagedFile(client.getSnapshot().stagedUploads!.items[0].id));
        }
    });

    it("does not create or render a preview for an over-cap image", async () => {
        const createObjectURL = jest.spyOn(URL, "createObjectURL");
        const client = signedInClient();
        rendered = await renderClient(client);
        const bigImage = new File(["image"], "big.png", { type: "image/png" });
        Object.defineProperty(bigImage, "size", { value: BROWSER_MEMORY_SAFETY_MAX_BYTES + 1 });

        await stage(client, [bigImage]);

        const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(dialog.querySelector("img")).toBeNull();
        expect(dialog.textContent).toContain("too large");
    });

    it("shows the archived error state with Close, and pasted files append as pages", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await stage(client, [new File(["a"], "a.txt", { type: "text/plain" })]);
        const pasted = new File(["p"], "p.png", { type: "image/png" });
        await act(async () => {
            document.dispatchEvent(
                Object.assign(new Event("paste", { bubbles: true }), {
                    clipboardData: { files: [pasted] },
                }),
            );
        });
        expect(client.getSnapshot().stagedUploads!.total).toBe(2);

        const state = internals(client) as ClientInternals & { api: unknown };
        state.state.session = {
            serverUrl: "https://journal.test",
            token: "token",
            deviceId: 1,
            userId: 1,
            username: "user",
        };
        state.database = {};
        state.api = {};
        const cancel = jest.spyOn(client, "cancelStagedFiles");
        await act(async () => client.archiveConversation("c1"));
        const headId = client.getSnapshot().stagedUploads!.items[0].id;
        await act(async () => client.confirmStagedFile(headId, "x"));
        const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.textContent).toContain("archived in another tab");
        await act(async () => button(dialog, "Close").click());
        expect(cancel).toHaveBeenCalled();
    });

    it("revokes object URLs on advance and on close", async () => {
        const revoke = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
        jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
        const client = signedInClient();
        rendered = await renderClient(client);
        await stage(client, [
            new File(["a"], "a.png", { type: "image/png" }),
            new File(["b"], "b.png", { type: "image/png" }),
        ]);
        await act(async () => client.skipStagedFile(client.getSnapshot().stagedUploads!.items[0].id));
        expect(revoke).toHaveBeenCalledWith("blob:preview");
        await act(async () => client.cancelStagedFiles());
        expect(revoke).toHaveBeenCalledTimes(2);
    });
});

describe("conversation menu controls", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("menu shows Pin when unpinned and Unpin when pinned", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Pin")).toBeTruthy();
        expect(menuItem(rendered.container, "Unpin")).toBeFalsy();
        await act(async () => (menuItem(rendered!.container, "Pin") as HTMLElement).click());
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Unpin")).toBeTruthy();
    });

    it("menu shows Add to Favorites when unfavorited and Remove from Favorites when favorited", async () => {
        favoriteStore.write(SESSION, new Set([CONVERSATION.id]));
        const client = signedInClient();
        rendered = await renderClient(client);
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Remove from Favorites")).toBeTruthy();
    });

    it("menu shows Mark as unread (not Mark as read) for a read, non-archived row", async () => {
        rendered = await renderClient(signedInClient());
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Mark as unread")).toBeTruthy();
        expect(menuItem(rendered.container, "Mark as read")).toBeFalsy();
    });

    it("menu shows Mark as read (not Mark as unread) for an override-only unread row, and clicking it clears the override", async () => {
        unreadStore.write(SESSION, new Set([CONVERSATION.id]));
        const client = signedInClient();
        rendered = await renderClient(client);
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Mark as read")).toBeTruthy();
        expect(menuItem(rendered.container, "Mark as unread")).toBeFalsy();
        await act(async () => (menuItem(rendered!.container, "Mark as read") as HTMLElement).click());
        expect(client.getSnapshot().unreadOverrideIds.has(CONVERSATION.id)).toBe(false);
    });

    it("menu offers neither Mark-read nor Mark-unread for an archived row (read affordances are active-only)", async () => {
        archiveStore.write(SESSION, new Set([CONVERSATION.id]));
        rendered = await renderClient(signedInClient());
        const toggle = rendered.container.querySelector<HTMLButtonElement>(".mj_RoomList_archivedToggle")!;
        await act(async () => toggle.click());
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Mark as unread")).toBeFalsy();
        expect(menuItem(rendered.container, "Mark as read")).toBeFalsy();
        expect(menuItem(rendered.container, "Unarchive")).toBeTruthy();
    });

    it("keeps the selected conversation when unfavoriting hides it from the Favorites tab", async () => {
        favoriteStore.write(SESSION, new Set([CONVERSATION.id]));
        const client = signedInClient();
        rendered = await renderClient(client);
        await act(async () => tabButton(rendered!.container, "Favorites").click());
        await openMenu(rendered.container);
        await act(async () => (menuItem(rendered!.container, "Remove from Favorites") as HTMLElement).click());

        expect(rendered.container.querySelector('[data-testid="room-name"]')).toBeNull();
        expect(client.getSnapshot().selectedConversationId).toBe(CONVERSATION.id);
    });

    it("moves keyboard focus through every menu item with arrow keys and wraps", async () => {
        rendered = await renderClient(signedInClient());
        await openMenu(rendered.container);
        const menu = rendered.container.querySelector<HTMLElement>('[role="menu"]')!;
        const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        expect(items.map((item) => item.textContent?.trim())).toEqual([
            "Pin",
            "Add to Favorites",
            "Mark as unread",
            "Archive",
        ]);
        expect(document.activeElement).toBe(items[0]);

        for (const expected of [...items.slice(1), items[0]]) {
            await act(async () => {
                menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
            });
            expect(document.activeElement).toBe(expected);
        }
        await act(async () => {
            menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        });
        expect(document.activeElement).toBe(items.at(-1));
    });

    it("opens the conversation menu on right-click", async () => {
        rendered = await renderClient(signedInClient());
        const row = rendered.container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]')!;

        await act(async () => {
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 32 }),
            );
        });

        expect(rendered.container.querySelector('[role="menu"]')).not.toBeNull();
        expect(menuItem(rendered.container, "Pin")).toBeTruthy();
    });

    it("opens the conversation menu after a touch long-press", async () => {
        jest.useFakeTimers();
        rendered = await renderClient(signedInClient());
        const row = rendered.container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]')!;
        const pointerDown = new MouseEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            clientX: 12,
            clientY: 18,
        });
        Object.defineProperty(pointerDown, "pointerType", { value: "touch" });

        await act(async () => {
            row.dispatchEvent(pointerDown);
            jest.advanceTimersByTime(500);
        });

        expect(rendered.container.querySelector('[role="menu"]')).not.toBeNull();
        expect(menuItem(rendered.container, "Pin")).toBeTruthy();
    });
});

describe("conversation row affordances", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("renders pinned rows before unpinned in the active list", async () => {
        const roomA = { ...CONVERSATION, id: "room-a", title: "Room A" };
        const roomB = { ...CONVERSATION, id: "room-b", title: "Room B" };
        pinnedStore.write(SESSION, new Set(["room-b"]));
        rendered = await renderClient(signedInWithRooms([roomA, roomB]));
        const names = [...rendered.container.querySelectorAll('[data-testid="room-name"]')].map(
            (element) => element.textContent,
        );
        expect(names[0]).toBe("Room B");
        expect(names[1]).toBe("Room A");
    });

    it("override-unread row announces marked-unread in the row button's accessible name and renders no numeric badge", async () => {
        unreadStore.write(SESSION, new Set([CONVERSATION.id]));
        rendered = await renderClient(signedInClient());
        const row = rendered.container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]');
        expect(row?.getAttribute("aria-label")).toContain("marked unread");
        expect(rendered.container.querySelector(".mj_UnreadBadge")).toBeNull();
    });
});

describe("conversation list tabs", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("renders All + Favorites buttons with aria-pressed tracking the active view", async () => {
        rendered = await renderClient(signedInClient());
        expect(tabButton(rendered.container, "All").getAttribute("aria-pressed")).toBe("true");
        expect(tabButton(rendered.container, "Favorites").getAttribute("aria-pressed")).toBe("false");
    });

    it("clicking Favorites filters to favorited rows, sets aria-pressed, focuses the tab, hides archived section", async () => {
        const fav = { ...CONVERSATION, id: "fav", title: "Fav Room" };
        const other = { ...CONVERSATION, id: "other", title: "Other Room" };
        favoriteStore.write(SESSION, new Set(["fav"]));
        rendered = await renderClient(signedInWithRooms([fav, other]));
        await act(async () => tabButton(rendered!.container, "Favorites").click());
        expect(tabButton(rendered.container, "Favorites").getAttribute("aria-pressed")).toBe("true");
        expect(document.activeElement).toBe(tabButton(rendered.container, "Favorites"));
        const names = [...rendered.container.querySelectorAll('[data-testid="room-name"]')].map(
            (element) => element.textContent,
        );
        expect(names).toEqual(["Fav Room"]);
        expect(rendered.container.querySelector(".mj_RoomList_archivedToggle")).toBeNull();
    });

    it("shows the no-favorites-yet state when nothing is starred", async () => {
        rendered = await renderClient(signedInClient());
        await act(async () => tabButton(rendered!.container, "Favorites").click());
        expect(rendered.container.textContent).toContain("No favorite conversations yet.");
    });

    it("distinguishes 'no favorites match search' from 'no favorites yet'", async () => {
        const fav = { ...CONVERSATION, id: "fav", title: "Alpha" };
        favoriteStore.write(SESSION, new Set(["fav"]));
        rendered = await renderClient(signedInWithRooms([fav]));
        await act(async () => tabButton(rendered!.container, "Favorites").click());
        const search = rendered.container.querySelector<HTMLInputElement>("#room-list-search-input")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(search, "zzz-no-match");
            search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(rendered.container.textContent).toContain("No favorites match your search.");
        expect(rendered.container.textContent).not.toContain("No favorite conversations yet.");
    });

    it("switching tabs leaves selectedConversationId unchanged when the selected row is filtered out", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await act(async () => tabButton(rendered!.container, "Favorites").click());
        expect(client.getSnapshot().selectedConversationId).toBe(CONVERSATION.id);
    });
});
