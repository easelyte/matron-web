/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import type { ChatTasksState, Conversation, TrackerItem } from "../types";
import { ChatTasksPane } from "../tracker/ChatTasksPane";
import { trackerItem } from "./tracker-fixtures";

interface FakeClient {
    loadChatTasks: jest.Mock;
    toggleChatTasks: jest.Mock;
    setChatTasksScope: jest.Mock;
    createChatItem: jest.Mock;
    moveChatTask: jest.Mock;
    dismissChatTasksError: jest.Mock;
    openTrackerItem: jest.Mock;
}

function fakeClient(): FakeClient {
    return {
        loadChatTasks: jest.fn().mockResolvedValue(undefined),
        toggleChatTasks: jest.fn(),
        setChatTasksScope: jest.fn(),
        createChatItem: jest.fn().mockResolvedValue({ ok: true }),
        moveChatTask: jest.fn().mockResolvedValue(undefined),
        dismissChatTasksError: jest.fn(),
        openTrackerItem: jest.fn(),
    };
}

const CONVERSATIONS = [
    { id: "c1", title: "Build the site" },
    { id: "c2", title: "Fix the login" },
] as unknown as Conversation[];

const TASKS: TrackerItem[] = [
    trackerItem({ id: "a", num: 11, kind: "task", awaiting: null, rank: 100, title: "Draft the copy" }),
    trackerItem({ id: "b", num: 12, kind: "task", awaiting: null, rank: 200, title: "Pick the fonts" }),
    trackerItem({ id: "c", num: 13, kind: "task", awaiting: null, rank: 300, title: "Ship it" }),
];

let mounted: { root: Root; container: HTMLDivElement } | undefined;

async function mount(
    client: FakeClient,
    pane: ChatTasksState,
    convoId = "c1",
): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            <ChatTasksPane
                client={client as unknown as MatronJournalClient}
                pane={pane}
                convoId={convoId}
                conversations={CONVERSATIONS}
            />,
        );
    });
    mounted = { root, container };
    return mounted;
}

function rowTitles(container: HTMLElement, section: string): string[] {
    const el = container.querySelector(`section[aria-label="${section}"]`);
    return Array.from(el?.querySelectorAll(".mj_TrackerItemRow_title") ?? []).map((t) =>
        (t.textContent ?? "").replace(/^#\d+/, ""),
    );
}

function dragEvent(type: string, data: Map<string, string>, clientY = 0): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clientY", { value: clientY });
    Object.defineProperty(event, "dataTransfer", {
        value: {
            types: [...data.keys()],
            setData: (key: string, value: string) => data.set(key, value),
            getData: (key: string) => data.get(key) ?? "",
            effectAllowed: "all",
            dropEffect: "none",
        },
    });
    return event;
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ChatTasksPane", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        if (mounted) {
            act(() => mounted!.root.unmount());
            mounted.container.remove();
            mounted = undefined;
        }
    });

    it("loads on mount and lists the sections", async () => {
        const client = fakeClient();
        const items = [
            ...TASKS,
            trackerItem({ id: "q", num: 14, kind: "question", awaiting: "user", title: "Which colour?" }),
            trackerItem({ id: "d", num: 15, kind: "decision", awaiting: null, title: "Use the blue" }),
            trackerItem({ id: "x", num: 16, kind: "task", state: "closed", awaiting: null, title: "Set up" }),
        ];
        const { container } = await mount(client, { open: true, scope: "c1", items });

        expect(client.loadChatTasks).toHaveBeenCalled();
        expect(rowTitles(container, "Needs you")).toEqual(["Which colour?"]);
        expect(rowTitles(container, "Tasks")).toEqual(["Draft the copy", "Pick the fonts", "Ship it"]);
        expect(rowTitles(container, "Decisions")).toEqual(["Use the blue"]);
        expect(rowTitles(container, "Done")).toEqual(["Set up"]);
        // In This chat no row names its origin.
        expect(container.querySelector(".mj_TrackerItemRow_origin")).toBeNull();
    });

    it("names another chat's rows in All", async () => {
        const client = fakeClient();
        const items = [trackerItem({ id: "q", num: 4, origin_convo_id: "c2", title: "Reset the password?" })];
        const { container } = await mount(client, { open: true, allFor: "c1", scope: "all", items });

        expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("All");
        expect(container.querySelector(".mj_TrackerItemRow_origin")?.textContent).toBe("from Fix the login");
    });

    it("switches scope and closes", async () => {
        const client = fakeClient();
        const { container } = await mount(client, { open: true, scope: "c1", items: [] });

        const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        act(() => tabs[1].click());
        expect(client.setChatTasksScope).toHaveBeenCalledWith("all");
        act(() => tabs[0].click());
        expect(client.setChatTasksScope).toHaveBeenCalledWith("chat");
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close tasks and decisions"]')!.click());
        expect(client.toggleChatTasks).toHaveBeenCalledWith(false);
    });

    it("shows the empty, loading, failed and unsupported states", async () => {
        const client = fakeClient();
        const empty = await mount(client, { open: true, scope: "c1", items: [] });
        expect(empty.container.textContent).toContain("Nothing tracked yet");
        act(() => empty.root.unmount());

        // A list loaded for the other scope is not shown under this one.
        const loading = await mount(client, { open: true, scope: "all", items: TASKS });
        expect(loading.container.textContent).toContain("Loading…");
        act(() => loading.root.unmount());

        const failed = await mount(client, { open: true, scope: "c1", error: "down" });
        expect(failed.container.textContent).toContain("Couldn't load items");
        act(() => failed.root.unmount());

        const old = await mount(client, { open: true, unsupported: true });
        expect(old.container.textContent).toContain("Tracker not available");
        expect(old.container.querySelector<HTMLButtonElement>('[aria-label="New item"]')?.disabled).toBe(true);
    });

    it("opens a row's item in the tracker", async () => {
        const client = fakeClient();
        const { container } = await mount(client, { open: true, scope: "c1", items: TASKS });
        act(() => container.querySelector<HTMLButtonElement>(".mj_TrackerItemRow")!.click());
        expect(client.openTrackerItem).toHaveBeenCalledWith(11);
    });

    it("files a new item from the form", async () => {
        const client = fakeClient();
        const { container } = await mount(client, { open: true, scope: "c1", items: [] });

        act(() => container.querySelector<HTMLButtonElement>('[aria-label="New item"]')!.click());
        const form = container.querySelector<HTMLFormElement>('form[aria-label="New item"]')!;
        const add = Array.from(form.querySelectorAll("button")).find((b) => b.textContent === "Add")!;
        expect(add.disabled).toBe(true);

        const question = Array.from(form.querySelectorAll("button")).find((b) => b.textContent === "Question")!;
        act(() => question.click());
        act(() => typeInto(form.querySelector("input")!, "Which host?"));
        act(() => typeInto(form.querySelector("textarea")!, "Either is fine"));
        expect(add.disabled).toBe(false);
        await act(async () => add.click());

        expect(client.createChatItem).toHaveBeenCalledWith(
            { kind: "question", title: "Which host?", body: "Either is fine" },
            expect.any(String),
        );
        expect(container.querySelector('form[aria-label="New item"]')).toBeNull();
    });

    it("keeps the form and says why when a create fails", async () => {
        const client = fakeClient();
        client.createChatItem.mockResolvedValue({ ok: false, reason: "Couldn't file the item: offline" });
        const { container } = await mount(client, { open: true, scope: "c1", items: [] });

        act(() => container.querySelector<HTMLButtonElement>('[aria-label="New item"]')!.click());
        const form = container.querySelector<HTMLFormElement>('form[aria-label="New item"]')!;
        act(() => typeInto(form.querySelector("input")!, "Write tests"));
        await act(async () => form.requestSubmit());

        expect(client.createChatItem).toHaveBeenCalledWith(
            { kind: "task", title: "Write tests", body: "" },
            expect.any(String),
        );
        expect(form.querySelector('[role="alert"]')?.textContent).toBe("Couldn't file the item: offline");
        expect(form.querySelector("input")!.value).toBe("Write tests");

        // A retry of the same draft reuses its key; an edit makes a new one.
        const firstKey = client.createChatItem.mock.calls[0][1];
        const task = Array.from(form.querySelectorAll("button")).find((b) => b.textContent === "Task")!;
        act(() => task.click()); // already selected: not an edit
        await act(async () => form.requestSubmit());
        expect(client.createChatItem.mock.calls[1][1]).toBe(firstKey);
        act(() => typeInto(form.querySelector("input")!, "Write more tests"));
        await act(async () => form.requestSubmit());
        expect(client.createChatItem.mock.calls[2][1]).not.toBe(firstKey);
    });

    it("drags a task to a new place", async () => {
        const client = fakeClient();
        const { container } = await mount(client, { open: true, scope: "c1", items: TASKS });
        const rows = container.querySelectorAll<HTMLElement>(".mj_ChatTasks_task");
        expect(rows[0].getAttribute("draggable")).toBe("true");
        const data = new Map<string, string>();

        act(() => {
            rows[0].dispatchEvent(dragEvent("dragstart", data));
        });
        // Over the lower half of the last row: the drop lands at the end.
        act(() => {
            rows[2].dispatchEvent(dragEvent("dragover", data, 1));
        });
        expect(rows[2].className).toContain("mj_ChatTasks_task_dropAfter");
        act(() => {
            rows[2].dispatchEvent(dragEvent("drop", data, 1));
        });

        expect(client.moveChatTask).toHaveBeenCalledWith("a", 2);
    });

    it("drags a task up, before another", async () => {
        const client = fakeClient();
        const { container } = await mount(client, { open: true, scope: "c1", items: TASKS });
        const rows = container.querySelectorAll<HTMLElement>(".mj_ChatTasks_task");
        const data = new Map<string, string>();

        act(() => {
            rows[2].dispatchEvent(dragEvent("dragstart", data));
        });
        act(() => {
            rows[1].dispatchEvent(dragEvent("dragover", data, 0));
        });
        act(() => {
            rows[1].dispatchEvent(dragEvent("drop", data, 0));
        });

        expect(client.moveChatTask).toHaveBeenCalledWith("c", 1);
    });

    it("moves a task with Alt+arrow keys", async () => {
        const client = fakeClient();
        const { container } = await mount(client, { open: true, scope: "c1", items: TASKS });
        const second = container.querySelectorAll<HTMLElement>(".mj_ChatTasks_task .mj_TrackerItemRow")[1];

        act(() => {
            second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
        });
        expect(client.moveChatTask).toHaveBeenCalledWith("b", 0);
        act(() => {
            second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        });
        expect(client.moveChatTask).toHaveBeenCalledTimes(1);
    });

    it("keeps focus on a task moved from the keyboard, and tells how to move it", async () => {
        const client = fakeClient();
        const { container, root } = await mount(client, { open: true, scope: "c1", items: TASKS });
        const rowOf = (id: string): HTMLButtonElement =>
            container.querySelector<HTMLButtonElement>(`[data-task-id="${id}"] .mj_TrackerItemRow`)!;
        const hint = document.getElementById(rowOf("a").getAttribute("aria-describedby")!);
        expect(hint?.textContent).toBe("Alt+Up and Alt+Down move the focused task.");

        rowOf("a").focus();
        act(() => {
            rowOf("a").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
        });
        expect(client.moveChatTask).toHaveBeenCalledWith("a", 1);
        // Browsers drop focus when React moves the focused row's node; jsdom does not, so stand in.
        rowOf("a").blur();
        // The client redraws the list with "a" after "b".
        const moved = [TASKS[1], { ...TASKS[0], rank: 250 }, TASKS[2]];
        await act(async () => {
            root.render(
                <ChatTasksPane
                    client={client as unknown as MatronJournalClient}
                    pane={{ open: true, scope: "c1", items: moved }}
                    convoId="c1"
                    conversations={CONVERSATIONS}
                />,
            );
        });
        expect(rowTitles(container, "Tasks")).toEqual(["Pick the fonts", "Draft the copy", "Ship it"]);
        expect(document.activeElement).toBe(rowOf("a"));
    });

    describe("covering the chat on a narrow window", () => {
        const realMatchMedia = window.matchMedia;
        beforeEach(() => {
            window.matchMedia = ((query: string) => ({ matches: true, media: query })) as typeof window.matchMedia;
        });
        afterEach(() => {
            window.matchMedia = realMatchMedia;
        });

        it("takes focus, closes on Escape, and hands focus back", async () => {
            const opener = document.createElement("button");
            document.body.append(opener);
            opener.focus();
            const client = fakeClient();
            const { container } = await mount(client, { open: true, scope: "c1", items: TASKS });
            const close = container.querySelector<HTMLButtonElement>(".mj_ChatTasks_close")!;
            expect(document.activeElement).toBe(close);

            act(() => {
                close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            });
            expect(client.toggleChatTasks).toHaveBeenCalledWith(false);

            act(() => mounted!.root.unmount());
            mounted!.container.remove();
            mounted = undefined;
            expect(document.activeElement).toBe(opener);
            opener.remove();
        });
    });

    it("shows a failed move until dismissed", async () => {
        const client = fakeClient();
        const { container } = await mount(client, {
            open: true,
            scope: "c1",
            items: TASKS,
            actionError: "Couldn't move the task: conflict",
        });
        const banner = container.querySelector('[role="alert"]')!;
        expect(banner.textContent).toContain("Couldn't move the task: conflict");
        act(() => banner.querySelector("button")!.click());
        expect(client.dismissChatTasksError).toHaveBeenCalled();
    });
});
