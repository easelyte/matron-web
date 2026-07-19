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
    username: "tester",
};

const conversation = (id: string): Conversation => ({
    id,
    title: id,
    session_state: "running",
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    read_up_to_seq: 0,
});

interface ClientInternals {
    state: ClientState;
    patch(update: Partial<ClientState>): void;
}

function signedInClient(): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as ClientInternals).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [conversation("c1"), conversation("c2")],
        selectedConversationId: "c1",
        events: [],
        pendingMessages: [],
        connection: "online",
    };
    return client;
}

function patchClient(client: MatronJournalClient, update: Partial<ClientState>): void {
    (client as unknown as ClientInternals).patch(update);
}

async function renderClient(client: MatronJournalClient): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(MatronApp, { client })));
    return { container, root };
}

function setScrollMetrics(node: HTMLDivElement, scrollTop: number): void {
    Object.defineProperties(node, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 100 },
        scrollTop: { configurable: true, value: scrollTop, writable: true },
    });
}

describe("timeline tail following", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;
    let callbacks: Map<number, FrameRequestCallback>;
    let nextFrame: number;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        callbacks = new Map();
        nextFrame = 1;
        jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
            const handle = nextFrame++;
            callbacks.set(handle, callback);
            return handle;
        });
        jest.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((handle) => {
            callbacks.delete(handle);
        });
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    const flushFrames = async (): Promise<void> => {
        const queued = [...callbacks.values()];
        callbacks.clear();
        await act(async () => queued.forEach((callback) => callback(performance.now())));
    };

    it("shows the jump button only when not following and re-follows on click", async () => {
        rendered = await renderClient(signedInClient());
        const panel = rendered.container.querySelector<HTMLDivElement>(".mx_RoomView_messagePanel")!;
        setScrollMetrics(panel, 0);

        expect(rendered.container.querySelector(".mj_JumpToBottom")).toBeNull();
        panel.dispatchEvent(new Event("scroll"));
        await flushFrames();

        const jump = rendered.container.querySelector<HTMLButtonElement>(".mj_JumpToBottom");
        expect(jump).not.toBeNull();
        await act(async () => jump?.click());
        expect(panel.scrollTop).toBe(1000);
        expect(rendered.container.querySelector(".mj_JumpToBottom")).toBeNull();
    });

    it("does not force-follow incoming events while scrolled up", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const panel = rendered.container.querySelector<HTMLDivElement>(".mx_RoomView_messagePanel")!;
        setScrollMetrics(panel, 0);
        panel.dispatchEvent(new Event("scroll"));
        await flushFrames();

        const incoming: JournalEvent = {
            seq: 1,
            convo_id: "c1",
            ts: 1,
            sender: "agent:test",
            type: "text",
            payload: { text: "incoming" },
        };
        await act(async () => patchClient(client, { events: [incoming] }));

        expect(panel.scrollTop).toBe(0);
        expect(rendered.container.querySelector(".mj_JumpToBottom")).not.toBeNull();
    });

    it("a sendTick bump cancels a pending stale frame and forces follow", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const panel = rendered.container.querySelector<HTMLDivElement>(".mx_RoomView_messagePanel")!;
        setScrollMetrics(panel, 0);

        panel.dispatchEvent(new Event("scroll"));
        await flushFrames();
        expect(rendered.container.querySelector(".mj_JumpToBottom")).not.toBeNull();

        panel.scrollTop = 0;
        panel.dispatchEvent(new Event("scroll"));
        expect(callbacks.size).toBe(1);
        await act(async () => patchClient(client, { sendTick: client.getSnapshot().sendTick + 1 }));
        await flushFrames();

        expect(callbacks.size).toBe(0);
        expect(panel.scrollTop).toBe(1000);
        expect(rendered.container.querySelector(".mj_JumpToBottom")).toBeNull();
    });

    it("keeps following after own-send while an older-history page is pending", async () => {
        const client = signedInClient();
        let resolveHistory!: () => void;
        const historyPage = new Promise<void>((resolve) => (resolveHistory = resolve));
        jest.spyOn(client, "loadOlderHistory").mockImplementation(() => {
            patchClient(client, { loadingHistory: true });
            return historyPage.then(() => {
                const older: JournalEvent = {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:test",
                    type: "text",
                    payload: { text: "older" },
                };
                patchClient(client, { events: [older], loadingHistory: false });
            });
        });
        rendered = await renderClient(client);
        const panel = rendered.container.querySelector<HTMLDivElement>(".mx_RoomView_messagePanel")!;
        setScrollMetrics(panel, 100);
        panel.dispatchEvent(new Event("scroll"));
        await flushFrames();

        await act(async () => rendered?.container.querySelector<HTMLButtonElement>(".mj_LoadHistory")?.click());
        await act(async () => patchClient(client, { sendTick: client.getSnapshot().sendTick + 1 }));
        expect(panel.scrollTop).toBe(1000);

        await act(async () => {
            resolveHistory();
            await historyPage;
        });

        expect(panel.scrollTop).toBe(1000);
        expect(rendered.container.querySelector(".mj_JumpToBottom")).toBeNull();
    });

    it("a conversation switch forces follow and a pre-switch frame cannot flip it off", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const panel = rendered.container.querySelector<HTMLDivElement>(".mx_RoomView_messagePanel")!;
        setScrollMetrics(panel, 0);

        panel.dispatchEvent(new Event("scroll"));
        await flushFrames();
        expect(rendered.container.querySelector(".mj_JumpToBottom")).not.toBeNull();

        panel.scrollTop = 0;
        panel.dispatchEvent(new Event("scroll"));
        const staleCallbacks = [...callbacks.values()];
        await act(async () => patchClient(client, { selectedConversationId: "c2", events: [] }));
        await act(async () => staleCallbacks.forEach((callback) => callback(performance.now())));

        expect(panel.scrollTop).toBe(1000);
        expect(rendered.container.querySelector(".mj_JumpToBottom")).toBeNull();
    });
});
