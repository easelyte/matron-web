/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp, SubagentStrip } from "../../../src/journal/components";
import type { ClientState, Conversation, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "tester",
};

const conversation = (
    id: string,
    title: string,
    session_state: Conversation["session_state"],
    parent_convo_id?: string,
): Conversation => ({
    id,
    title,
    session_state,
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    parent_convo_id,
    read_up_to_seq: 0,
});

interface ClientInternals {
    state: ClientState;
}

function signedInClient(conversations: Conversation[], selectedConversationId: string): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as ClientInternals).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        selectedConversationId,
        events: [],
        pendingMessages: [],
        connection: "online",
    };
    return client;
}

async function renderClient(client: MatronJournalClient): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(MatronApp, { client })));
    return { container, root };
}

async function renderStrip(
    client: MatronJournalClient,
    mode: "parent" | "child",
): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(React.createElement(SubagentStrip, { client, state: client.getSnapshot(), mode })),
    );
    return { container, root };
}

describe("subagent strip", () => {
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

    it("shows every child in running-first order and treats unknown states as inactive", async () => {
        const running = conversation("running", "Running", "running", "parent");
        running.created_at = 2;
        const finished = conversation("finished", "Finished", "done", "parent");
        finished.created_at = 1;
        const queued = conversation("queued", "Queued", "queued", "parent");
        queued.created_at = 3;
        const client = signedInClient(
            [conversation("parent", "Parent", "running"), finished, running, queued],
            "parent",
        );
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue();

        rendered = await renderStrip(client, "parent");

        const list = rendered.container.querySelector('[role="list"]');
        const wrappers = list?.querySelectorAll(':scope > [role="listitem"]');
        const pills = list?.querySelectorAll<HTMLButtonElement>(".mj_SubagentPill");
        expect(wrappers).toHaveLength(3);
        expect(pills).toHaveLength(3);
        expect([...pills!].map((pill) => pill.textContent)).toEqual(["Running", "Finished", "Queued"]);
        expect(pills?.[0].querySelector(".mj_Spinner")).not.toBeNull();
        expect(pills?.[1].classList.contains("mj_SubagentPill_finished")).toBe(true);
        expect(pills?.[2].classList.contains("mj_SubagentPill_finished")).toBe(true);
        expect([...pills!].some((pill) => pill.getAttribute("role") === "listitem")).toBe(false);

        await act(async () => pills?.[2].click());
        expect(selectConversation).toHaveBeenCalledWith("queued");
    });

    it("shows siblings and marks the selected child as current", async () => {
        const client = signedInClient(
            [
                conversation("parent", "Parent", "running"),
                conversation("current", "Current", "running", "parent"),
                conversation("sibling", "Sibling", "done", "parent"),
            ],
            "current",
        );

        rendered = await renderStrip(client, "child");

        const pills = rendered.container.querySelectorAll<HTMLButtonElement>(".mj_SubagentPill");
        expect(pills).toHaveLength(2);
        expect([...pills].map((pill) => pill.textContent)).toEqual(["Current", "Sibling"]);
        expect(pills[0].classList.contains("mj_SubagentPill_current")).toBe(true);
        expect(pills[0].getAttribute("aria-current")).toBe("true");
        expect(pills[0].disabled).toBe(true);
    });

    it("renders nothing when there are no children", async () => {
        const client = signedInClient([conversation("parent", "Parent", "running")], "parent");

        rendered = await renderStrip(client, "parent");

        expect(rendered.container.querySelector(".mj_SubagentStrip")).toBeNull();
    });
});

describe("subagent strip integration", () => {
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

    it("renders every child in running-first order and opens the clicked child", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("running-a", "Research", "running", "parent"),
            conversation("finished", "Finished", "done", "parent"),
            conversation("running-b", "Draft", "running", "parent"),
        ];
        const client = signedInClient(conversations, "parent");
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue();

        rendered = await renderClient(client);

        const pills = rendered.container.querySelectorAll(".mj_SubagentPill");
        expect(pills).toHaveLength(3);
        expect([...pills].map((pill) => pill.textContent)).toEqual(["Research", "Draft", "Finished"]);
        expect(pills[2].classList.contains("mj_SubagentPill_finished")).toBe(true);

        await act(async () => (pills[1] as HTMLButtonElement).click());
        expect(selectConversation).toHaveBeenCalledWith("running-b");
    });

    it("renders finished children when the selected conversation has no running children", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("finished", "Finished", "done", "parent"),
        ];
        rendered = await renderClient(signedInClient(conversations, "parent"));

        const strip = rendered.container.querySelector(".mj_SubagentStrip");
        const pill = strip?.querySelector(".mj_SubagentPill");
        expect(strip).not.toBeNull();
        expect(pill?.textContent).toBe("Finished");
        expect(pill?.classList.contains("mj_SubagentPill_finished")).toBe(true);
    });

    it("does not render the removed parent header switcher", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("finished", "Finished", "done", "parent"),
        ];
        const client = signedInClient(conversations, "parent");

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_SubagentStrip")).not.toBeNull();
        expect(rendered.container.querySelector(".mj_SubagentSwitcher")).toBeNull();
    });

    it("hides the parent header switcher when there are no children", async () => {
        rendered = await renderClient(signedInClient([conversation("parent", "Parent", "running")], "parent"));

        expect(
            [...rendered.container.querySelectorAll("button")].some((button) =>
                /subagents?/.test(button.textContent ?? ""),
            ),
        ).toBe(false);
    });

    it("shows only siblings when viewing a child", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("child", "Child", "running", "parent"),
            conversation("sibling", "Sibling", "done", "parent"),
            conversation("running-grandchild", "Running grandchild", "running", "child"),
            conversation("finished-grandchild", "Finished grandchild", "done", "child"),
        ];
        rendered = await renderClient(signedInClient(conversations, "child"));

        const pills = rendered.container.querySelectorAll(".mj_SubagentPill");
        expect(pills).toHaveLength(2);
        expect([...pills].map((pill) => pill.textContent)).toEqual(["Child", "Sibling"]);
    });

    it("pins a back chip naming the parent in child view and returns to it on click (#531)", async () => {
        const conversations = [
            conversation("parent", "Parent deploy", "running"),
            conversation("child", "Child", "running", "parent"),
            conversation("sibling", "Sibling", "done", "parent"),
        ];
        const client = signedInClient(conversations, "child");
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue();
        rendered = await renderClient(client);

        const back = rendered.container.querySelector<HTMLButtonElement>(".mj_SubagentBack");
        expect(back).not.toBeNull();
        // Names its destination — the parent title, not a bare "Back".
        expect(back?.querySelector(".mj_SubagentBack_name")?.textContent).toBe("Parent deploy");
        expect(back?.getAttribute("aria-label")).toBe("Back to Parent deploy");
        // Pinned before the scrolling pill run, separated by a hairline.
        expect(rendered.container.querySelector(".mj_SubagentStrip_hairline")).not.toBeNull();
        expect(rendered.container.querySelector(".mj_SubagentStrip_run")).not.toBeNull();

        await act(async () => back?.click());
        expect(selectConversation).toHaveBeenCalledWith("parent");
    });

    it("shows no back chip in parent view (#531)", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("child", "Child", "running", "parent"),
        ];
        rendered = await renderClient(signedInClient(conversations, "parent"));

        expect(rendered.container.querySelector(".mj_SubagentBack")).toBeNull();
        expect(rendered.container.querySelector(".mj_SubagentStrip_hairline")).toBeNull();
    });

    it("marks the current sibling pill as ringed + non-interactive in child view (#531)", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("child", "Child", "running", "parent"),
            conversation("sibling", "Sibling", "done", "parent"),
        ];
        rendered = await renderClient(signedInClient(conversations, "child"));

        const current = rendered.container.querySelector<HTMLButtonElement>(".mj_SubagentPill_current");
        expect(current?.textContent).toBe("Child");
        expect(current?.disabled).toBe(true);
    });

    it("returns to the parent on Escape when nothing else is open (#531 §10.11.E)", async () => {
        const conversations = [
            conversation("parent", "Parent", "running"),
            conversation("child", "Child", "running", "parent"),
        ];
        const client = signedInClient(conversations, "child");
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue();
        rendered = await renderClient(client);

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(selectConversation).toHaveBeenCalledWith("parent");
    });
});
