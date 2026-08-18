/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../client";
import { EventContent } from "../components";
import { eventSnippet, type JournalEvent } from "../types";
import fixture from "./peer_message.fixture.json";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

type MountedEvent = {
    container: HTMLDivElement;
    root: Root;
};

async function mountEvent(event: JournalEvent): Promise<MountedEvent> {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
        root.render(
            <EventContent
                client={new MatronJournalClient()}
                event={event}
                answeredPromptReplies={new Map<string, { choice?: string }>()}
            />,
        );
    });
    return { container, root };
}

describe("peer_message fixture and rendering", () => {
    const mountedEvents: MountedEvent[] = [];

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        await act(async () => {
            for (const { root } of mountedEvents.splice(0)) root.unmount();
        });
    });

    it("keeps the vendored wire fixture exact and renders it as a third-class message", async () => {
        expect(Object.keys(fixture)).toEqual(["fixtureVersion", "event"]);
        expect(fixture.fixtureVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(Object.keys(fixture.event)).toEqual(["seq", "convo_id", "ts", "sender", "type", "payload"]);
        expect(Object.keys(fixture.event.payload)).toEqual(["from_convo", "from_name", "from_kind", "body"]);
        expect(JSON.stringify(fixture)).not.toContain("idem_key");

        const mounted = await mountEvent(fixture.event);
        mountedEvents.push(mounted);

        const peerMessage = mounted.container.querySelector(".mj_PeerMessage");
        expect(peerMessage).not.toBeNull();
        expect(peerMessage?.querySelector(".mj_Markdown")).toBeNull();
        expect(peerMessage?.querySelector(".mj_OpenAIMark.mj_PeerMessage_mark")).not.toBeNull();
        expect(peerMessage?.querySelector(".mj_PeerMessage_label")?.textContent).toBe("from «Sender Session»");
        expect(peerMessage?.querySelector(".mj_MessageText")?.textContent).toBe("Coordinate on the release checklist.");
        expect(eventSnippet(fixture.event.type, fixture.event.payload)).toBe("Coordinate on the release checklist.");
    });

    it("uses the kind glyph and sanitizes the sender label and body", async () => {
        const event: JournalEvent = {
            ...fixture.event,
            payload: {
                ...fixture.event.payload,
                from_name: "  Claude\u0000\n Session  ",
                from_kind: "claude",
                body: "  Coordinate\u0000\n on   release.  ",
            },
        };
        const mounted = await mountEvent(event);
        mountedEvents.push(mounted);

        expect(mounted.container.querySelector(".mj_AnthropicMark.mj_PeerMessage_mark")).not.toBeNull();
        expect(mounted.container.querySelector(".mj_PeerMessage_label")?.textContent).toBe("from «Claude Session»");
        expect(mounted.container.querySelector(".mj_MessageText")?.textContent).toBe("Coordinate on release.");
    });

    it("strips bidi format controls from every peer-message text sink", async () => {
        const event: JournalEvent = {
            ...fixture.event,
            payload: {
                ...fixture.event.payload,
                from_name: "Release\u202eAgent\u202c",
                body: "Deploy\u2067later\u2069 now",
            },
        };
        const mounted = await mountEvent(event);
        mountedEvents.push(mounted);

        expect(mounted.container.querySelector(".mj_PeerMessage_label bdi")?.textContent).toBe("Release Agent");
        expect(mounted.container.querySelector(".mj_MessageText bdi")?.textContent).toBe("Deploy later now");
        expect(eventSnippet(event.type, event.payload)).toBe("Deploy later now");
        expect(mounted.container.textContent).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    });
});
