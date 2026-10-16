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

const conversation = (id: string): Conversation => ({
    id,
    title: id,
    session_state: "idle",
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    read_up_to_seq: 0,
});

const event = (seq: number, overrides: Partial<JournalEvent> = {}): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: 1_700_000_000_000 + seq * 1000,
    sender: "agent:box-a",
    type: "text",
    payload: { body: `message ${seq}` },
    ...overrides,
});

const range = (from: number, to: number, overrides: Partial<JournalEvent> = {}): JournalEvent[] =>
    Array.from({ length: to - from + 1 }, (_, index) => event(from + index, overrides));

describe("timeline arrivals", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) await act(async () => rendered!.root.unmount());
        rendered?.container.remove();
        rendered = undefined;
    });

    async function render(events: JournalEvent[]): Promise<{ client: MatronJournalClient; live: () => string }> {
        const client = new MatronJournalClient();
        (client as unknown as { state: ClientState }).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: [conversation("c1"), conversation("c2")],
            selectedConversationId: "c1",
            events,
            connection: "online",
        };
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => root.render(React.createElement(MatronApp, { client })));
        rendered = { container, root };
        const region = container.querySelector<HTMLElement>(".mj_ChatView_timeline > .mj_ScreenReaderOnly")!;
        return { client, live: () => region.textContent ?? "" };
    }

    const patch = (client: MatronJournalClient, update: Partial<ClientState>): Promise<void> =>
        act(async () => (client as unknown as { patch(update: Partial<ClientState>): void }).patch(update));

    it("announces a new message, but not the transcript it opened with", async () => {
        const { client, live } = await render(range(1, 5));
        expect(live()).toBe("");
        await patch(client, { events: [...range(1, 5), event(6, { payload: { body: "build finished" } })] });
        expect(live()).toContain("build finished");
    });

    it("announces a second message with the same text, and clears on a switch", async () => {
        const { client, live } = await render(range(1, 5));
        const same = { payload: { body: "done" } };
        await patch(client, { events: [...range(1, 5), event(6, same)] });
        const first = live();
        await patch(client, { events: [...range(1, 5), event(6, same), event(7, same)] });
        expect(live()).not.toBe(first);
        expect(live().trim()).toBe(first.trim());
        await patch(client, { selectedConversationId: "c2", events: range(20, 30, { convo_id: "c2" }) });
        expect(live()).toBe("");
    });

    it("stays quiet for older history, the user's own messages and another conversation", async () => {
        const { client, live } = await render(range(10, 15));
        await patch(client, { events: range(1, 15) });
        expect(live()).toBe("");
        await patch(client, { events: [...range(1, 15), event(16, { sender: "user:alice" })] });
        expect(live()).toBe("");
        await patch(client, { selectedConversationId: "c2", events: range(20, 30, { convo_id: "c2" }) });
        expect(live()).toBe("");
    });

    it("leaves the transcript list itself out of the live regions", async () => {
        await render(range(1, 3));
        expect(rendered!.container.querySelector("ol.mj_ChatView_messageList")!.hasAttribute("aria-live")).toBe(false);
    });
});
