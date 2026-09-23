/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import type { ClientState, Conversation, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "tester",
};

const conversation = (id: string, sessionState: string): Conversation => ({
    id,
    title: id,
    session_state: sessionState,
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

function signedInClient(sessionState: string): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as ClientInternals).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [conversation("c1", sessionState)],
        selectedConversationId: "c1",
        events: [],
        pendingMessages: [],
        connection: "online",
        // The bridge's 'thinking' activity ephemeral landed and no turn-end 'idle' followed.
        activity: { state: "thinking" },
    };
    return client;
}

function patchClient(client: MatronJournalClient, update: Partial<ClientState>): void {
    (client as unknown as ClientInternals).patch(update);
}

const indicator = (container: HTMLElement): HTMLElement | null => container.querySelector(".mj_Activity");

describe("timeline activity indicator gate", () => {
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

    async function render(client: MatronJournalClient): Promise<HTMLDivElement> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => root.render(React.createElement(MatronApp, { client })));
        rendered = { container, root };
        return container;
    }

    it("shows the indicator while the durable session_state is running", async () => {
        const container = await render(signedInClient("running"));
        expect(indicator(container)?.textContent).toBe("Thinking");
    });

    it("hides a stale 'thinking' once the durable session_state says the turn ended", async () => {
        // The turn-end 'idle' ephemeral is fire-and-forget and was dropped, so state.activity is
        // still 'thinking'. The replayed session_status → 'waiting' is what must clear the view.
        const client = signedInClient("running");
        const container = await render(client);
        expect(indicator(container)).not.toBeNull();

        await act(async () => patchClient(client, { conversations: [conversation("c1", "waiting")] }));
        expect(indicator(container)).toBeNull();

        // A 'thinking' that arrives before the durable 'running' is kept and re-shown when it lands.
        await act(async () => patchClient(client, { conversations: [conversation("c1", "running")] }));
        expect(indicator(container)?.textContent).toBe("Thinking");
    });
});
