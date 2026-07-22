/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp, NewSessionSheet } from "../../../src/journal/components";
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

const AGENT_B: DeviceDTO = {
    device_id: 11,
    kind: "agent",
    name: "Box B",
    connected: true,
    is_self: false,
};

interface ClientInternals {
    state: ClientState;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function textButton(container: HTMLElement, text: string): HTMLButtonElement {
    const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    if (!match) throw new Error(`Missing button: ${text}`);
    return match;
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

describe("NewSessionSheet", () => {
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

    it("runs agent to folder to start and selects the created conversation", async () => {
        const client = new MatronJournalClient();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);
        jest.spyOn(client, "recentFolders").mockResolvedValue([{ path: "/srv/project", last_used: 1 }]);
        const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({
            kind: "created",
            convoId: "created-1",
        });
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        const close = jest.fn();

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: close }));
        await act(async () => textButton(rendered!.container, "Box AConnected").click());
        await act(async () => textButton(rendered!.container, "/srv/project").click());

        expect(start).toHaveBeenCalledWith(AGENT_A.device_id, "/srv/project", false);
        expect(close).toHaveBeenCalledTimes(1);
        expect(select).toHaveBeenCalledWith("created-1", { fromRpcCreate: true });
    });

    it("auto-skips a sole connected agent and hides Back", async () => {
        const client = new MatronJournalClient();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "recentFolders").mockResolvedValue([]);

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

        expect(rendered.container.textContent).toContain("Start on Box A");
        expect([...rendered.container.querySelectorAll("button")].some((item) => item.textContent === "Back")).toBe(
            false,
        );
    });

    it("shows agents-error and Retry re-runs the roster request", async () => {
        const client = new MatronJournalClient();
        const listAgents = jest
            .spyOn(client, "listAgents")
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce([AGENT_A, AGENT_B]);

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
        expect(rendered.container.textContent).toContain("Couldn't load agents.");

        await act(async () => textButton(rendered!.container, "Retry").click());

        expect(listAgents).toHaveBeenCalledTimes(2);
        expect(rendered.container.textContent).toContain("Box A");
    });

    it("does not let a late recent-folders reply replace the starting state", async () => {
        const client = new MatronJournalClient();
        const folders = deferred<[]>();
        const starting = deferred<{ kind: "uncertain" }>();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "recentFolders").mockReturnValue(folders.promise);
        jest.spyOn(client, "startSessionRpc").mockReturnValue(starting.promise);

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
        await act(async () => textButton(rendered!.container, "Start").click());
        expect(rendered.container.textContent).toContain("Starting session…");

        await act(async () => folders.resolve([]));

        expect(rendered.container.textContent).toContain("Starting session…");
        expect(rendered.container.textContent).not.toContain("Folder path");
        await act(async () => starting.resolve({ kind: "uncertain" }));
    });

    it("ignores an out-of-order folder reply after re-entering the same agent", async () => {
        const client = new MatronJournalClient();
        const first = deferred<Array<{ path: string; last_used: number | null }>>();
        const second = deferred<Array<{ path: string; last_used: number | null }>>();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);
        jest.spyOn(client, "recentFolders").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
        await act(async () => textButton(rendered!.container, "Box AConnected").click());
        await act(async () => textButton(rendered!.container, "Back").click());
        await act(async () => textButton(rendered!.container, "Box AConnected").click());
        await act(async () => second.resolve([{ path: "/new", last_used: 2 }]));
        await act(async () => first.resolve([{ path: "/stale", last_used: 1 }]));

        expect(rendered.container.textContent).toContain("/new");
        expect(rendered.container.textContent).not.toContain("/stale");
    });

    it("suppresses navigation when dismissed while start is pending", async () => {
        const client = new MatronJournalClient();
        const start = deferred<{ kind: "created"; convoId: string }>();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "recentFolders").mockResolvedValue([]);
        jest.spyOn(client, "startSessionRpc").mockReturnValue(start.promise);
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        const close = jest.fn();

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: close }));
        await act(async () => textButton(rendered!.container, "Start").click());
        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
        );
        await act(async () => start.resolve({ kind: "created", convoId: "created-late" }));

        expect(close).toHaveBeenCalledTimes(1);
        expect(select).not.toHaveBeenCalled();
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
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]')!.click(),
        );
        expect(rendered.container.querySelector('[role="dialog"]')).not.toBeNull();

        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click(),
        );
        expect(rendered.container.querySelector('[role="dialog"]')).toBeNull();
        expect(rendered.container.querySelector(".mj_AccountMenu")).not.toBeNull();

        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]')!.click(),
        );
        expect(rendered.container.querySelector(".mj_AccountMenu")).toBeNull();
        expect(rendered.container.querySelector('[role="dialog"]')).not.toBeNull();
    });
});
