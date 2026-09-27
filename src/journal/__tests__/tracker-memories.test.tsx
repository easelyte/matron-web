/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import { MemoriesList } from "../tracker/MemoriesList";
import { memoryFormError, MemoryDetail } from "../tracker/MemoryDetail";
import { TrackerPane } from "../tracker/TrackerPane";
import type { ClientState, Memory } from "../types";

function memory(over: Partial<Memory> = {}): Memory {
    return {
        id: "me_1",
        name: "avoid-eric",
        type: "feedback",
        description: "Never start sessions on eric.",
        body: "**Why:** reserved.",
        origin_convo_id: "c1",
        origin_device_id: 2,
        created_by: "agent",
        updated_by: "agent",
        created_at: Date.now() - 60_000,
        updated_at: Date.now() - 30_000,
        ...over,
    };
}

function fakeClient(over: Record<string, unknown> = {}): MatronJournalClient {
    return {
        loadMissions: jest.fn().mockResolvedValue(undefined),
        loadInbox: jest.fn().mockResolvedValue(undefined),
        loadItem: jest.fn().mockResolvedValue(undefined),
        loadMission: jest.fn().mockResolvedValue(undefined),
        loadMemories: jest.fn().mockResolvedValue(undefined),
        saveMemory: jest.fn().mockResolvedValue(true),
        deleteMemory: jest.fn().mockResolvedValue(true),
        closeTrackerView: jest.fn(),
        openTrackerView: jest.fn(),
        openTrackerItem: jest.fn(),
        openTrackerMission: jest.fn(),
        openTrackerMemory: jest.fn(),
        closeTrackerMemory: jest.fn(),
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
        ...over,
    } as unknown as MatronJournalClient;
}

async function mount(element: React.ReactElement): Promise<{ container: HTMLElement }> {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
        createRoot(container).render(element);
    });
    return { container };
}

beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no TextEncoder; utf8Length (the body byte cap) needs one, as in tracker-api-test.
    globalThis.TextEncoder = NodeTextEncoder as typeof TextEncoder;
    globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
});

afterEach(() => {
    document.body.innerHTML = "";
});

describe("MemoriesList", () => {
    it("renders one row per memory with name, type and description, and a New memory button", async () => {
        const onOpen = jest.fn();
        const onNew = jest.fn();
        const { container } = await mount(
            <MemoriesList
                memories={[memory(), memory({ id: "me_2", name: "use-opus-on-fable-maxed-boxes", type: "user" })]}
                onOpenMemory={onOpen}
                onNewMemory={onNew}
            />,
        );
        const rows = container.querySelectorAll(".mj_TrackerMemoryRow");
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector(".mj_TrackerMemoryRow_name")?.textContent).toBe("avoid-eric");
        expect(rows[0].querySelector(".mj_TrackerMemoryRow_type")?.textContent).toBe("How to work");
        expect(rows[0].querySelector(".mj_TrackerMemoryRow_desc")?.textContent).toBe("Never start sessions on eric.");
        await act(async () => {
            (rows[1] as HTMLButtonElement).click();
        });
        expect(onOpen).toHaveBeenCalledWith("use-opus-on-fable-maxed-boxes");
        await act(async () => {
            (container.querySelector(".mj_TrackerMemoriesHead .mj_TrackerButton") as HTMLButtonElement).click();
        });
        expect(onNew).toHaveBeenCalled();
    });

    it("says there are no memories yet on an empty list", async () => {
        const { container } = await mount(
            <MemoriesList memories={[]} onOpenMemory={jest.fn()} onNewMemory={jest.fn()} />,
        );
        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("No memories yet");
    });
});

describe("memoryFormError", () => {
    it("mirrors the journal's rules", () => {
        expect(memoryFormError({ name: "avoid-eric", description: "d", body: "" })).toBeNull();
        expect(memoryFormError({ name: "Bad Name", description: "d", body: "" })).toMatch(/lowercase/);
        expect(memoryFormError({ name: "ok", description: "   ", body: "" })).toMatch(/required/);
        expect(memoryFormError({ name: "ok", description: "a".repeat(201), body: "" })).toMatch(/200/);
        expect(memoryFormError({ name: "ok", description: "a\nb", body: "" })).toMatch(/single line/);
        expect(memoryFormError({ name: "ok", description: "d", body: "é".repeat(4097) })).toMatch(/8 KB/);
        expect(memoryFormError({ name: "ok", description: "d", body: "é".repeat(4096) })).toBeNull();
    });
});

describe("MemoryDetail", () => {
    it("saves an existing memory with its name fixed and the whole body, then goes back", async () => {
        const client = fakeClient();
        const onBack = jest.fn();
        const { container } = await mount(<MemoryDetail memory={memory()} client={client} onBack={onBack} />);
        expect(container.querySelector("input[placeholder='avoid-eric-and-fatima']")).toBeNull();
        const description = container.querySelector("input[type='text']") as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(description, "Never start sessions on eric or fatima.");
            description.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
            (container.querySelector(".mj_TrackerConfirm_actions .mj_TrackerButton") as HTMLButtonElement).click();
        });
        expect(client.saveMemory).toHaveBeenCalledWith("avoid-eric", {
            description: "Never start sessions on eric or fatima.",
            body: "**Why:** reserved.",
            type: "feedback",
        });
        expect(onBack).toHaveBeenCalled();
    });

    it("refuses a bad name on the new-memory form without calling the client", async () => {
        const client = fakeClient();
        const { container } = await mount(<MemoryDetail memory={null} client={client} onBack={jest.fn()} />);
        expect(container.querySelector("input[placeholder='avoid-eric-and-fatima']")).not.toBeNull();
        await act(async () => {
            (container.querySelector(".mj_TrackerConfirm_actions .mj_TrackerButton") as HTMLButtonElement).click();
        });
        expect(container.querySelector(".mj_TrackerMemoryForm_error")?.textContent).toMatch(/Name must be/);
        expect(client.saveMemory).not.toHaveBeenCalled();
    });

    it("refuses a new memory whose name already exists instead of overwriting it", async () => {
        const client = fakeClient({
            getSnapshot: jest
                .fn()
                .mockReturnValue({ selectedConversationId: "c1", conversations: [], memories: [memory()] }),
        });
        const { container } = await mount(<MemoryDetail memory={null} client={client} onBack={jest.fn()} />);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        const [nameInput, descriptionInput] = Array.from(
            container.querySelectorAll("input[type='text']"),
        ) as HTMLInputElement[];
        await act(async () => {
            setter?.call(nameInput, "avoid-eric");
            nameInput.dispatchEvent(new Event("input", { bubbles: true }));
            setter?.call(descriptionInput, "Something else.");
            descriptionInput.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
            (container.querySelector(".mj_TrackerConfirm_actions .mj_TrackerButton") as HTMLButtonElement).click();
        });
        expect(container.querySelector(".mj_TrackerMemoryForm_error")?.textContent).toMatch(/already exists/);
        expect(client.saveMemory).not.toHaveBeenCalled();
    });

    it("deletes behind a confirm", async () => {
        const client = fakeClient();
        const onBack = jest.fn();
        const { container } = await mount(<MemoryDetail memory={memory()} client={client} onBack={onBack} />);
        await act(async () => {
            (container.querySelector(".mj_TrackerMemoryForm_delete") as HTMLButtonElement).click();
        });
        expect(client.deleteMemory).not.toHaveBeenCalled();
        await act(async () => {
            (container.querySelector(".mj_TrackerButton_danger") as HTMLButtonElement).click();
        });
        expect(client.deleteMemory).toHaveBeenCalledWith("avoid-eric");
        expect(onBack).toHaveBeenCalled();
    });
});

describe("TrackerPane memories tab", () => {
    it("loads memories only when the tab is shown, and renders the list or the selected editor", async () => {
        const client = fakeClient();
        const base = { trackerView: { open: true, view: "memories" }, memories: [memory()] } as unknown as ClientState;
        const { container } = await mount(<TrackerPane client={client} state={base} />);
        expect(client.loadMemories).toHaveBeenCalledTimes(1);
        expect(container.querySelectorAll(".mj_TrackerMemoryRow")).toHaveLength(1);
        expect(container.querySelector(".mj_TrackerViewSwitch_tab[aria-selected='true']")?.textContent).toBe(
            "Memories",
        );

        const editing = {
            ...base,
            trackerView: { open: true, view: "memories", selectedMemoryName: "avoid-eric" },
        } as unknown as ClientState;
        const { container: editor } = await mount(<TrackerPane client={client} state={editing} />);
        expect(editor.querySelector(".mj_TrackerMemoryForm")).not.toBeNull();
        expect(editor.querySelector(".mj_TrackerSection_header")?.textContent).toBe("avoid-eric");

        const stale = {
            ...base,
            memoriesError: "HTTP 503",
        } as unknown as ClientState;
        const { container: withNotice } = await mount(<TrackerPane client={client} state={stale} />);
        expect(withNotice.querySelector(".mj_TrackerStaleNotice")?.textContent).toMatch(/Couldn't refresh memories/);
        expect(withNotice.querySelectorAll(".mj_TrackerMemoryRow")).toHaveLength(1);
        expect(withNotice.querySelector(".mj_TrackerErrorBanner")).toBeNull();

        const inbox = { trackerView: { open: true, view: "inbox" }, inboxItems: [] } as unknown as ClientState;
        const fresh = fakeClient();
        await mount(<TrackerPane client={fresh} state={inbox} />);
        expect(fresh.loadMemories).not.toHaveBeenCalled();
    });
});
