/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import { NewSessionSheet } from "../../../src/journal/new-session-ui";
import type { ClientState, DeviceDTO, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

const AGENT_A: DeviceDTO = {
    device_id: 10,
    kind: "agent",
    name: "Box A",
    connected: true,
    is_self: false,
};

interface ClientInternals {
    state: ClientState;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

async function render(element: React.ReactElement): Promise<{
    container: HTMLDivElement;
    root: Root;
}> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    return { container, root };
}

const OPTIONS = {
    folders: [
        { path: "/srv/project", last_used: 2 },
        { path: "/home/user/workspace", last_used: 1 },
    ],
    models: [
        { value: "opus", label: "Opus 4.5" },
        { value: "sonnet", label: "Sonnet 4.5" },
    ],
    defaultModel: "opus",
    agents: ["claude", "codex"] as Array<"claude" | "codex">,
    defaultAgent: "claude" as const,
};

function signedIn(client: MatronJournalClient): void {
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        connection: "online",
    };
}

const byText = (container: HTMLElement, selector: string, text: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.trim() === text)!;

describe("New session split button (one tap)", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => localStorage.clear());

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    const main = (): HTMLButtonElement =>
        rendered!.container.querySelector<HTMLButtonElement>(".mj_NewSessionSplit_main")!;

    it("starts at once with the box defaults (no sheet) and opens the new conversation", async () => {
        const client = new MatronJournalClient();
        signedIn(client);
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "created", convoId: "new" });
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        rendered = await render(React.createElement(MatronApp, { client }));

        expect(rendered.container.querySelector('[role="group"][aria-label="New session"]')).not.toBeNull();
        // Defaults unknown (the box reports no default folder) → no hint, plain accessible name.
        expect(main().getAttribute("aria-label")).toBe("Start a new session");
        expect(rendered.container.querySelector(".mj_NewSessionSplit_hint")).toBeNull();
        await act(async () => main().click());
        expect(start).toHaveBeenCalledWith(10, "", false, {
            model: undefined,
            agent: undefined,
            idempotencyKey: expect.any(String),
        });
        expect(rendered.container.querySelector('[role="dialog"]')).toBeNull();
        expect(select).toHaveBeenCalledWith("new", { fromRpcCreate: true });
    });

    it("uses the remembered defaults and shows them as the hint", async () => {
        localStorage.setItem(
            "matron.newSessionDefaults.10",
            JSON.stringify({ folder: "/home/user/workspace", model: "sonnet", agent: "claude" }),
        );
        const client = new MatronJournalClient();
        signedIn(client);
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "created", convoId: "new" });
        jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        rendered = await render(React.createElement(MatronApp, { client }));
        expect(main().getAttribute("aria-label")).toBe("Start a new session: Sonnet · workspace");
        expect(rendered.container.querySelector(".mj_NewSessionSplit_hint")?.textContent).toBe("Sonnet · workspace");
        await act(async () => main().click());
        expect(start).toHaveBeenCalledWith(10, "/home/user/workspace", false, {
            model: "sonnet",
            agent: "claude",
            idempotencyKey: expect.any(String),
        });
    });

    it("says No box connected and disables one tap (⋯ stays, the sheet re-checks)", async () => {
        const client = new MatronJournalClient();
        signedIn(client);
        jest.spyOn(client, "listAgents").mockResolvedValue([{ ...AGENT_A, connected: false }]);
        rendered = await render(React.createElement(MatronApp, { client }));
        expect(main().disabled).toBe(true);
        expect(rendered.container.querySelector<HTMLButtonElement>(".mj_NewSessionSplit_more")!.disabled).toBe(false);
        expect(rendered.container.querySelector(".mj_NewSessionSplit_note")?.textContent).toBe("No box connected");
    });

    it("forgets saved defaults the box refuses, and says so", async () => {
        localStorage.setItem("matron.newSessionDefaults.10", JSON.stringify({ folder: "/gone", model: "opus" }));
        const client = new MatronJournalClient();
        signedIn(client);
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "startSessionRpc").mockResolvedValue({
            kind: "error",
            code: "bad_workdir",
            message: "That folder doesn’t exist on the box.",
        });
        rendered = await render(React.createElement(MatronApp, { client }));
        await act(async () => main().click());
        expect(localStorage.getItem("matron.newSessionDefaults.10")).toBeNull();
        expect(rendered.container.querySelector(".mj_NewSessionSplit_note")?.textContent).toContain(
            "Your saved defaults don’t work on this box any more.",
        );
    });

    it("prefers the box the defaults were saved for", async () => {
        localStorage.setItem("matron.newSessionBox", "11");
        const client = new MatronJournalClient();
        signedIn(client);
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, { ...AGENT_A, device_id: 11, name: "Box B" }]);
        const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "uncertain" });
        rendered = await render(React.createElement(MatronApp, { client }));
        await act(async () => main().click());
        expect(start.mock.calls[0][0]).toBe(11);
    });

    it("shows Retry · Options when the box can't be reached, and never auto-retries", async () => {
        const client = new MatronJournalClient();
        signedIn(client);
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        const start = jest
            .spyOn(client, "startSessionRpc")
            .mockResolvedValue({ kind: "error", reach: true, message: "Couldn't reach that box — try again." });
        rendered = await render(React.createElement(MatronApp, { client }));
        await act(async () => main().click());
        const note = rendered.container.querySelector('.mj_NewSessionSplit_note[role="alert"]')!;
        expect(note.textContent).toContain("Couldn’t reach the box.");
        expect(start).toHaveBeenCalledTimes(1);
        await act(async () => byText(note as HTMLElement, "button", "Options").click());
        expect(rendered.container.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it("shows May have started when the start times out", async () => {
        const client = new MatronJournalClient();
        signedIn(client);
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "uncertain" });
        rendered = await render(React.createElement(MatronApp, { client }));
        await act(async () => main().click());
        expect(rendered.container.querySelector('.mj_NewSessionSplit_note[role="status"]')?.textContent).toContain(
            "May have started.",
        );
    });
});

describe("New session options sheet", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => localStorage.clear());

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    async function openSheet(client: MatronJournalClient, onClose = jest.fn()): Promise<HTMLElement> {
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "sessionOptions").mockResolvedValue(OPTIONS);
        rendered = await render(React.createElement(NewSessionSheet, { client, onClose }));
        return rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
    }

    it("lays out folder · agent · model · browser · first task · remember · box, focused on the folder", async () => {
        const dialog = await openSheet(new MatronJournalClient());
        const labels = [...dialog.querySelectorAll(".mj_FieldLabel, .mj_SwitchLabel, .mj_CheckRow")].map((node) =>
            node.textContent?.trim(),
        );
        expect(labels).toEqual([
            "Folder",
            "Agent",
            "Model",
            "Browser tools",
            "First task (optional)",
            "Remember as my defaults",
        ]);
        expect(dialog.querySelector(".mj_BoxCaption")?.textContent).toBe("On Box A");
        const radios = [...dialog.querySelectorAll('.mj_FolderList [role="radio"]')].map((node) => node.textContent);
        expect(radios).toEqual(["/srv/project", "/home/user/workspace", "Other folder…"]);
        expect(document.activeElement?.textContent).toBe("/srv/project");
        const model = dialog.querySelector<HTMLSelectElement>("select")!;
        expect(model.value).toBe("opus");
        expect(model.selectedOptions[0].textContent).toBe("Opus 4.5 (box default)");
    });

    it("disables the model and browser tools for Codex", async () => {
        const dialog = await openSheet(new MatronJournalClient());
        await act(async () => byText(dialog, '.mj_Segmented [role="radio"]', "Codex").click());
        expect(dialog.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
        expect(dialog.textContent).toContain("Codex picks its own model");
        expect(dialog.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
        expect(dialog.textContent).toContain("Not available for Codex sessions");
    });

    it("starts with the picks, sends the first task as a message and remembers the defaults", async () => {
        const client = new MatronJournalClient();
        const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "created", convoId: "new" });
        jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        const send = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        // The new conversation is known to the client, so the first task goes out at once.
        jest.spyOn(client, "getSnapshot").mockReturnValue({
            ...new MatronJournalClient().getSnapshot(),
            conversations: [{ id: "new" } as never],
        });
        const onClose = jest.fn();
        const dialog = await openSheet(client, onClose);
        await act(async () => byText(dialog, '.mj_FolderList [role="radio"]', "/home/user/workspace").click());
        await act(async () => {
            const select = dialog.querySelector<HTMLSelectElement>("select")!;
            select.value = "sonnet";
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await act(async () => dialog.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
        await act(async () => {
            const task = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
            setter.call(task, "Fix the flaky test.");
            task.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => dialog.querySelector<HTMLInputElement>('.mj_CheckRow input[type="checkbox"]')!.click());
        await act(async () => byText(dialog, "button", "Start session").click());
        expect(start).toHaveBeenCalledWith(10, "/home/user/workspace", true, {
            model: "sonnet",
            agent: "claude",
            idempotencyKey: expect.any(String),
        });
        expect(onClose).toHaveBeenCalled();
        await act(async () => undefined);
        expect(send).toHaveBeenCalledWith("Fix the flaky test.", "new");
        expect(localStorage.getItem("matron.newSessionBox")).toBe("10");
        expect(JSON.parse(localStorage.getItem("matron.newSessionDefaults.10")!)).toEqual({
            folder: "/home/user/workspace",
            model: "sonnet",
            agent: "claude",
        });
    });

    it("shows the bridge's bad-folder error on the Other folder field", async () => {
        const client = new MatronJournalClient();
        jest.spyOn(client, "startSessionRpc").mockResolvedValue({
            kind: "error",
            code: "bad_workdir",
            message: "That folder doesn’t exist on the box.",
        });
        const dialog = await openSheet(client);
        await act(async () => byText(dialog, '.mj_FolderList [role="radio"]', "Other folder…").click());
        const input = dialog.querySelector<HTMLInputElement>(".mj_TextInput")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(input, "/opt/matron-wbe");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => byText(dialog, "button", "Start session").click());
        const error = dialog.querySelector('.mj_FieldError[role="alert"]')!;
        expect(error.textContent).toBe("That folder doesn’t exist on the box.");
        expect(input.getAttribute("aria-describedby")).toBe(error.id);
        expect(input.getAttribute("aria-invalid")).toBe("true");
    });
});

describe("New session overlay exclusivity", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("opening Settings closes NewSessionSheet and opening the sheet closes Settings", async () => {
        const client = new MatronJournalClient();
        internals(client).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            connection: "online",
        };
        jest.spyOn(client, "listAgents").mockReturnValue(new Promise(() => undefined));
        rendered = await render(React.createElement(MatronApp, { client }));

        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="New session options"]')!.click(),
        );
        expect(rendered.container.querySelector('[role="dialog"]')).not.toBeNull();

        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click(),
        );
        expect(rendered.container.querySelector('[role="dialog"]')).toBeNull();
        expect(rendered.container.querySelector(".mj_AccountMenu")).not.toBeNull();

        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="New session options"]')!.click(),
        );
        expect(rendered.container.querySelector(".mj_AccountMenu")).toBeNull();
        expect(rendered.container.querySelector('[role="dialog"]')).not.toBeNull();
    });
});
