/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import type { ClientState, Conversation, JournalEvent, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

const convo = (
    id: string,
    title: string,
    session_state = "done",
    parent_convo_id?: string,
    created_at = 0,
): Conversation => ({
    id,
    title,
    session_state,
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at,
    parent_convo_id,
    read_up_to_seq: 1,
});

const text = (convoId: string, seq: number, body: string, sender = "agent:claude"): JournalEvent => ({
    seq,
    convo_id: convoId,
    ts: 1_782_000_000_000 + seq * 60_000,
    sender,
    type: "text",
    payload: { body },
});

interface ClientInternals {
    state: ClientState;
    database?: unknown;
    api?: unknown;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInClient(
    conversations: Conversation[],
    selectedConversationId: string,
    events: JournalEvent[] = [],
): MatronJournalClient {
    const client = new MatronJournalClient();
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        selectedConversationId,
        events,
        pendingMessages: [],
        connection: "online",
    };
    return client;
}

function patchState(client: MatronJournalClient, patch: Partial<ClientState>): void {
    const target = client as unknown as { patch(patch: Partial<ClientState>): void };
    target.patch(patch);
}

let rendered: { container: HTMLDivElement; root: Root } | undefined;

async function renderClient(client: MatronJournalClient): Promise<HTMLDivElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(MatronApp, { client })));
    rendered = { container, root };
    return container;
}

// jsdom lays nothing out; give the app and the chat area real widths so the pane can tell
// "beside the chat" from "covering it".
function layOut(appRight: number, chatLeft: number): void {
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const left = this.classList.contains("mj_ChatView_wrapper") ? chatLeft : 0;
        return {
            left,
            top: 0,
            right: appRight,
            bottom: 800,
            width: appRight - left,
            height: 800,
            x: left,
            y: 0,
        } as DOMRect;
    });
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
    if (rendered) {
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();
        rendered = undefined;
    }
    document.body.innerHTML = "";
    jest.restoreAllMocks();
});

const PARENT = convo("parent", "Parent", "running");
const LINT = convo("parent:sub:1", "lint the workspace", "running", "parent", 1);
const DOCS = convo("parent:sub:2", "docs sweep", "done", "parent", 2);

describe("client.openSubChat", () => {
    it("opens a subagent beside its parent, and switches it", () => {
        const client = signedInClient([PARENT, LINT, DOCS], "parent");
        client.openSubChat(LINT.id);
        expect(client.getSnapshot().subChatPane).toEqual({ parentId: "parent", childId: LINT.id });
        client.openSubChat(DOCS.id);
        expect(client.getSnapshot().subChatPane).toEqual({ parentId: "parent", childId: DOCS.id });
        client.closeSubChat();
        expect(client.getSnapshot().subChatPane).toBeUndefined();
    });

    it("opens a subagent as the conversation when its parent is not on screen", () => {
        const client = signedInClient([PARENT, LINT, DOCS], LINT.id);
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue();
        client.openSubChat(DOCS.id);
        expect(select).toHaveBeenCalledWith(DOCS.id, { suppressNotFound: true });
        expect(client.getSnapshot().subChatPane).toBeUndefined();
    });
});

describe("client.conversationEvents", () => {
    it("fetches the newest page once when the history was never loaded, then reads the store", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        const stored = [text(LINT.id, 1, "hello")];
        const database = {
            putHistory: jest.fn().mockResolvedValue(undefined),
            events: jest.fn().mockResolvedValue(stored),
        };
        const api = { messages: jest.fn().mockResolvedValue({ events: stored }) };
        internals(client).database = database;
        internals(client).api = api;

        await expect(client.conversationEvents(LINT.id)).resolves.toEqual(stored);
        expect(api.messages).toHaveBeenCalledWith(LINT.id, undefined, 80);
        expect(database.putHistory).toHaveBeenCalledWith(stored);

        await client.conversationEvents(LINT.id);
        expect(api.messages).toHaveBeenCalledTimes(1);
        expect(database.events).toHaveBeenCalledTimes(2);
    });

    it("still returns what is stored when the fetch fails", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        const stored = [text(LINT.id, 1, "cached")];
        internals(client).database = { putHistory: jest.fn(), events: jest.fn().mockResolvedValue(stored) };
        internals(client).api = { messages: jest.fn().mockRejectedValue(new Error("offline")) };
        await expect(client.conversationEvents(LINT.id)).resolves.toEqual(stored);
    });
});

describe("client.conversationEvents for the conversation on screen", () => {
    it("loads its first page through the chat's own history paging, not beside it", async () => {
        const client = signedInClient([PARENT], "parent");
        const stored = [text("parent", 1, "hello")];
        const database = {
            putHistory: jest.fn().mockResolvedValue(undefined),
            events: jest.fn().mockResolvedValue(stored),
            reconcilePersistedOwnMessages: jest.fn().mockResolvedValue(undefined),
        };
        internals(client).database = database;
        internals(client).api = { messages: jest.fn().mockResolvedValue({ events: stored }) };
        const loadOlder = jest.spyOn(client, "loadOlderHistory");

        await expect(client.conversationEvents("parent")).resolves.toEqual(stored);
        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(client.getSnapshot().loadingHistory).toBe(false);
        expect(client.getSnapshot().hasOlderHistory).toBe(false);
    });

    it("waits for a page already in flight instead of fetching it again", async () => {
        const client = signedInClient([PARENT], "parent");
        const stored = [text("parent", 1, "hello")];
        const api = { messages: jest.fn() };
        internals(client).database = { putHistory: jest.fn(), events: jest.fn().mockResolvedValue(stored) };
        internals(client).api = api;
        patchState(client, { loadingHistory: true });

        let settled = false;
        const pending = client.conversationEvents("parent").then((events) => {
            settled = true;
            return events;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        patchState(client, { loadingHistory: false });
        await expect(pending).resolves.toEqual(stored);
        expect(api.messages).not.toHaveBeenCalled();
    });
});

describe("Subtask lines", () => {
    it("draws a matched Subtask line as a card that opens the subagent beside the chat", async () => {
        const client = signedInClient([PARENT, LINT, DOCS], "parent", [
            text("parent", 1, "🔀 Subtask: lint the workspace"),
        ]);
        jest.spyOn(client, "conversationEvents").mockResolvedValue([text(LINT.id, 1, "Linting 14 packages")]);
        layOut(1400, 300);
        const container = await renderClient(client);

        const card = container.querySelector<HTMLButtonElement>(".mj_SubtaskCard");
        expect(card?.getAttribute("aria-label")).toBe("Open subagent lint the workspace, running");
        expect(card?.textContent).toContain("Subagent · running");
        // The row around it is the ordinary transcript row.
        expect(card?.closest("li.mj_EventTile")).not.toBeNull();

        await act(async () => card?.click());
        const pane = container.querySelector("aside.mj_SubChatPane");
        expect(pane?.getAttribute("aria-label")).toBe("Subagent lint the workspace");
        expect(pane?.classList.contains("mj_SubChatPane_covering")).toBe(false);
        expect(pane?.textContent).toContain("Linting 14 packages");
        expect(pane?.textContent).toContain("Running");
        // The parent chat stays on screen with its composer.
        expect(client.getSnapshot().selectedConversationId).toBe("parent");
        expect(container.querySelector(".mj_ChatView")).not.toBeNull();
    });

    it("stays plain text until the subagent is known, then becomes a card", async () => {
        const client = signedInClient([PARENT], "parent", [text("parent", 1, "🔀 Subtask: docs sweep")]);
        const container = await renderClient(client);
        expect(container.querySelector(".mj_SubtaskCard")).toBeNull();
        expect(container.textContent).toContain("🔀 Subtask: docs sweep");

        await act(async () => patchState(client, { conversations: [PARENT, DOCS] }));
        expect(container.querySelector(".mj_SubtaskCard")?.getAttribute("aria-label")).toBe(
            "Open subagent docs sweep, finished",
        );
    });

    it("leaves the user's own messages alone", async () => {
        const client = signedInClient([PARENT, DOCS], "parent", [
            text("parent", 1, "🔀 Subtask: docs sweep", "user:alice"),
        ]);
        const container = await renderClient(client);
        expect(container.querySelector(".mj_SubtaskCard")).toBeNull();
    });
});

describe("the subagent pane", () => {
    it("closes from its header, and belongs to the chat it was opened from", async () => {
        const other = convo("other", "Other");
        const client = signedInClient([PARENT, LINT, DOCS, other], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        jest.spyOn(client, "selectConversation").mockImplementation(async (id) => {
            patchState(client, { selectedConversationId: id });
        });
        layOut(1400, 300);
        const container = await renderClient(client);

        await act(async () => client.openSubChat(DOCS.id));
        expect(container.querySelector("aside.mj_SubChatPane")?.textContent).toContain("No messages yet");
        expect(container.querySelector(".mj_SubChatPane_state")?.textContent).toBe("Finished");

        await act(async () => void client.selectConversation("other"));
        expect(container.querySelector("aside.mj_SubChatPane")).toBeNull();
        await act(async () => void client.selectConversation("parent"));
        expect(container.querySelector("aside.mj_SubChatPane")).not.toBeNull();

        await act(async () =>
            container.querySelector<HTMLButtonElement>('button[aria-label="Close subagent"]')?.click(),
        );
        expect(container.querySelector("aside.mj_SubChatPane")).toBeNull();
    });

    it("folds the transcript as the chat does: a decided permission shows once, as answered", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([
            {
                seq: 1,
                convo_id: LINT.id,
                ts: 1_782_000_000_000,
                sender: "agent:claude",
                type: "permission_request",
                payload: { description: "Run the linter?", question: "Run the linter?", options: ["Allow", "Deny"] },
            },
            {
                seq: 2,
                convo_id: LINT.id,
                ts: 1_782_000_060_000,
                sender: "user:alice",
                type: "prompt_reply",
                payload: { target_seq: 1, choice: "Allow" },
            },
        ]);
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        const rows = container.querySelectorAll(".mj_SubChatPane_row");
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain("Allow");
    });

    it("closes when covering the chat and a Markdown file opens its preview beside the chat", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([
            {
                seq: 1,
                convo_id: LINT.id,
                ts: 1_782_000_000_000,
                sender: "agent:claude",
                type: "file",
                payload: { blob_ref: "notes-md", name: "notes.md", size: 120, content_type: "text/markdown" },
            },
        ]);
        layOut(1000, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        await act(async () =>
            container
                .querySelector<HTMLButtonElement>('.mj_SubChatPane button[aria-label="Preview notes.md"]')
                ?.click(),
        );
        expect(client.getSnapshot().subChatPane).toBeUndefined();
        expect(container.querySelector(".mj_MdPreview")).not.toBeNull();
    });

    it("switches between siblings from its header", async () => {
        const client = signedInClient([PARENT, LINT, DOCS], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));

        const select = container.querySelector<HTMLSelectElement>('select[aria-label="Switch subagent"]');
        expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual([
            "● lint the workspace",
            "○ docs sweep",
        ]);
        await act(async () => {
            select!.value = DOCS.id;
            select!.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(client.getSnapshot().subChatPane?.childId).toBe(DOCS.id);
    });

    it("covers the chat, with a back button, when the chat area is narrower than 820px", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1000, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));

        const pane = container.querySelector<HTMLElement>("aside.mj_SubChatPane");
        expect(pane?.classList.contains("mj_SubChatPane_covering")).toBe(true);
        expect(pane?.style.left).toBe("300px");
        expect(container.querySelector('button[aria-label="Close subagent"]')).toBeNull();
        const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back to chat"]');
        expect(document.activeElement).toBe(back);
        await act(async () => back?.click());
        expect(client.getSnapshot().subChatPane).toBeUndefined();
    });
});

describe("the subagent pane: focus, keyboard and switching", () => {
    it("hands focus back to the composer when closed beside the chat and its opener is gone", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close subagent"]')!;
        close.focus();
        await act(async () => close.click());
        expect(container.querySelector("aside.mj_SubChatPane")).toBeNull();
        expect(document.activeElement).toBe(container.querySelector(".mj_Composer textarea"));
    });

    it("hands focus back to the Subtask card that opened it", async () => {
        const client = signedInClient([PARENT, LINT], "parent", [text("parent", 1, "🔀 Subtask: lint the workspace")]);
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1400, 300);
        const container = await renderClient(client);
        const card = container.querySelector<HTMLButtonElement>(".mj_ChatView_timeline .mj_SubtaskCard")!;
        card.focus();
        await act(async () => card.click());
        expect(document.activeElement).toBe(card);
        const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close subagent"]')!;
        close.focus();
        await act(async () => close.click());
        expect(document.activeElement).toBe(card);
    });

    it("keeps the covered chat out of reach", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1000, 300);
        const container = await renderClient(client);
        const chat = container.querySelector<HTMLElement>(".mj_ChatView_wrapper")!;
        expect(chat.hasAttribute("inert")).toBe(false);
        await act(async () => client.openSubChat(LINT.id));
        expect(chat.hasAttribute("inert")).toBe(true);
        await act(async () => client.closeSubChat());
        expect(chat.hasAttribute("inert")).toBe(false);
    });

    it("resizes from the keyboard within its limits", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1400, 300); // a 1100px chat area: the pane can grow to 680px
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        const handle = container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize subagent pane"]')!;
        const pane = container.querySelector<HTMLElement>("aside.mj_SubChatPane")!;
        expect(handle.tabIndex).toBe(0);
        expect(handle.getAttribute("aria-valuenow")).toBe("380");
        expect(handle.getAttribute("aria-valuemax")).toBe("680");
        const press = async (key: string): Promise<void> =>
            act(async () => {
                handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
            });
        await press("ArrowLeft");
        expect(pane.style.width).toBe("396px");
        await press("ArrowRight");
        await press("ArrowRight");
        expect(pane.style.width).toBe("380px");
        await press("End");
        expect(handle.getAttribute("aria-valuenow")).toBe("680");
    });

    it("never shows the previous subagent's rows while the next one loads", async () => {
        const client = signedInClient([PARENT, LINT, DOCS], "parent");
        let resolveDocs: (events: JournalEvent[]) => void = () => undefined;
        jest.spyOn(client, "conversationEvents").mockImplementation((id) =>
            id === LINT.id
                ? Promise.resolve([text(LINT.id, 1, "lint output")])
                : new Promise((resolve) => {
                      resolveDocs = resolve;
                  }),
        );
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        expect(container.querySelector("aside.mj_SubChatPane")?.textContent).toContain("lint output");
        await act(async () => client.openSubChat(DOCS.id));
        const pane = container.querySelector("aside.mj_SubChatPane")!;
        expect(pane.textContent).not.toContain("lint output");
        expect(pane.textContent).toContain("Loading");
        await act(async () => resolveDocs([text(DOCS.id, 1, "docs output")]));
        expect(pane.textContent).toContain("docs output");
    });
});

describe("the subagent pane and the Markdown preview, and Escape", () => {
    const MD_FILE: JournalEvent = {
        seq: 1,
        convo_id: LINT.id,
        ts: 1_782_000_000_000,
        sender: "agent:claude",
        type: "file",
        payload: { blob_ref: "notes-md", name: "notes.md", size: 120, content_type: "text/markdown" },
    };

    it("stays beside the chat when a Markdown preview opens beside it", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([MD_FILE]);
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        await act(async () =>
            container
                .querySelector<HTMLButtonElement>('.mj_SubChatPane button[aria-label="Preview notes.md"]')
                ?.click(),
        );
        expect(container.querySelector(".mj_MdPreview")).not.toBeNull();
        const pane = container.querySelector("aside.mj_SubChatPane");
        expect(pane?.classList.contains("mj_SubChatPane_covering")).toBe(false);
        expect(container.querySelector(".mj_ChatView_wrapper")?.hasAttribute("inert")).toBe(false);
    });

    it("goes back to the chat on Escape while it covers the chat", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1000, 300);
        await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(client.getSnapshot().subChatPane).toBeUndefined();
    });

    it("leaves Escape alone beside the chat", async () => {
        const client = signedInClient([PARENT, LINT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        layOut(1400, 300);
        await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(client.getSnapshot().subChatPane).toEqual({ parentId: "parent", childId: LINT.id });
    });
});

describe("the slot beside the chat, shared with the Tasks pane", () => {
    const panes = (container: HTMLElement): { subchat: number; tasks: number } => ({
        subchat: container.querySelectorAll("aside.mj_SubChatPane").length,
        tasks: container.querySelectorAll("aside.mj_ChatTasks").length,
    });

    function tasksClient(): MatronJournalClient {
        const client = signedInClient([PARENT, LINT, DOCS], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        jest.spyOn(client, "loadChatTasks").mockResolvedValue();
        return client;
    }

    it("opening a subagent closes the Tasks pane", async () => {
        const client = tasksClient();
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () => client.toggleChatTasks(true));
        expect(panes(container)).toEqual({ subchat: 0, tasks: 1 });
        await act(async () => client.openSubChat(LINT.id));
        expect(panes(container)).toEqual({ subchat: 1, tasks: 0 });
        expect(client.getSnapshot().chatTasks?.open).toBe(false);
        expect(container.querySelector('button[aria-label^="Tasks and decisions"]')?.getAttribute("aria-pressed")).toBe(
            "false",
        );
    });

    it("opening Tasks from the header closes the subagent pane", async () => {
        const client = tasksClient();
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () => client.openSubChat(LINT.id));
        const toggle = container.querySelector<HTMLButtonElement>('button[aria-label^="Tasks and decisions"]')!;
        expect(toggle.getAttribute("aria-pressed")).toBe("false");
        await act(async () => toggle.click());
        expect(panes(container)).toEqual({ subchat: 0, tasks: 1 });
        expect(client.getSnapshot().subChatPane).toBeUndefined();
        expect(toggle.getAttribute("aria-pressed")).toBe("true");
        await act(async () => toggle.click());
        expect(panes(container)).toEqual({ subchat: 0, tasks: 0 });
    });

    it("never mounts both, even from a state that has both open", async () => {
        const client = tasksClient();
        layOut(1400, 300);
        const container = await renderClient(client);
        await act(async () =>
            patchState(client, {
                subChatPane: { parentId: "parent", childId: LINT.id },
                chatTasks: { open: true } as ClientState["chatTasks"],
            }),
        );
        expect(panes(container)).toEqual({ subchat: 1, tasks: 0 });
    });
});

describe("the media browser", () => {
    const EVENTS: JournalEvent[] = [
        text("parent", 1, "Report is up at https://example.com/report.\nDetails inside."),
        {
            seq: 2,
            convo_id: "parent",
            ts: 1_782_000_120_000,
            sender: "agent:claude",
            type: "file",
            payload: { blob_ref: "file-1", name: "notes.zip", size: 4096, content_type: "application/zip" },
        },
    ];

    async function openBrowser(client: MatronJournalClient): Promise<HTMLElement> {
        const container = await renderClient(client);
        await act(async () =>
            container.querySelector<HTMLButtonElement>('button[aria-label="Media, files and links"]')?.click(),
        );
        const dialog = document.querySelector<HTMLElement>('[role="dialog"].mj_MediaBrowser');
        if (!dialog) throw new Error("Media browser did not open");
        return dialog;
    }

    function tab(dialog: HTMLElement, label: string): HTMLButtonElement {
        const match = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
            (t) => t.textContent === label,
        );
        if (!match) throw new Error(`Missing tab ${label}`);
        return match;
    }

    it("opens from the chat header on Media, with Files and Links tabs", async () => {
        const client = signedInClient([PARENT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue(EVENTS);
        const dialog = await openBrowser(client);

        expect([...dialog.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
            "Media",
            "Files",
            "Links",
        ]);
        expect(tab(dialog, "Media").getAttribute("aria-selected")).toBe("true");
        expect(dialog.textContent).toContain("No media yet");

        await act(async () => tab(dialog, "Files").click());
        expect(dialog.querySelector(".mj_MediaBrowser_file")?.textContent).toContain("notes.zip");
        expect(dialog.querySelector(".mj_MediaBrowser_file")?.textContent).toContain("4 KB");

        await act(async () => tab(dialog, "Links").click());
        const link = dialog.querySelector<HTMLAnchorElement>("a.mj_MediaBrowser_link");
        expect(link?.getAttribute("href")).toBe("https://example.com/report");
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
        expect(link?.textContent).toContain("Report is up at https://example.com/report.");
    });

    it("moves between tabs with the arrow keys and closes on Escape or Done", async () => {
        const client = signedInClient([PARENT], "parent");
        jest.spyOn(client, "conversationEvents").mockResolvedValue([]);
        let dialog = await openBrowser(client);

        await act(async () =>
            tab(dialog, "Media").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
        );
        expect(tab(dialog, "Links").getAttribute("aria-selected")).toBe("true");
        expect(dialog.textContent).toContain("No links yet");

        await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
        expect(document.querySelector(".mj_MediaBrowser")).toBeNull();

        await act(async () =>
            rendered?.container
                .querySelector<HTMLButtonElement>('button[aria-label="Media, files and links"]')
                ?.click(),
        );
        dialog = document.querySelector<HTMLElement>(".mj_MediaBrowser")!;
        const done = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Done");
        await act(async () => done?.click());
        expect(document.querySelector(".mj_MediaBrowser")).toBeNull();
    });
});
