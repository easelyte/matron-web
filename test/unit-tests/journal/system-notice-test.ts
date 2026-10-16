/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { MatronJournalClient } from "../../../src/journal/client";
import { EventContent } from "../../../src/journal/components";
import { sameTimelineSection, systemNotice } from "../../../src/journal/system-notice";
import type { JournalEvent } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();

const FULL =
    "🤝 A consent request is waiting for the user: \nchat ch_1 — just now: alice asks to chat with bob\n" +
    '  consent_decide(kind: "chat", id: "ch_1", decision: approve|decline, reason: …)\n' +
    "Say in one line what you did.";

function textEvent(payload: Record<string, unknown>, sender = "agent:box-a"): JournalEvent {
    return {
        kind: "journal",
        seq: 7,
        convo_id: "c_coord",
        ts: NOW,
        sender,
        type: "text",
        payload: { body: FULL, from: "assistant", ...payload },
    };
}

const consent = { kind: "consent", icon: "🤝", summary: "alice → bob chat · artwork render · #12" };

describe("systemNotice", () => {
    it("reads the bridge's tag off a text event", () => {
        expect(systemNotice(textEvent({ notice: consent }))).toEqual(consent);
    });

    it("ignores untagged text, other event types and unusable tags", () => {
        expect(systemNotice(textEvent({}))).toBeNull();
        expect(systemNotice({ ...textEvent({ notice: consent }), type: "prompt" })).toBeNull();
        expect(systemNotice(textEvent({ notice: "consent" }))).toBeNull();
        expect(systemNotice(textEvent({ notice: [consent] }))).toBeNull();
        expect(systemNotice(textEvent({ notice: { kind: "consent", icon: "🤝", summary: "  " } }))).toBeNull();
    });

    it("flattens the summary to one line and falls back on a missing icon or kind", () => {
        const notice = systemNotice(textEvent({ notice: { summary: "line one\nline two" } }));
        expect(notice).toEqual({ kind: "notice", icon: "ℹ️", summary: "line one line two" });
    });
});

describe("sameTimelineSection", () => {
    it("groups same-sender messages but never a notice row", () => {
        const reply = textEvent({ body: "Approved." });
        const notice = textEvent({ notice: consent });
        expect(sameTimelineSection(reply, reply)).toBe(true);
        expect(sameTimelineSection(notice, reply)).toBe(false);
        expect(sameTimelineSection(reply, notice)).toBe(false);
        expect(sameTimelineSection(reply, textEvent({ body: "x" }, "agent:box-b"))).toBe(false);
    });
});

describe("System notice row in the timeline", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("shows one collapsed line for a tagged notice, with the full text inside", async () => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const client = { openTrackerLink: jest.fn() } as unknown as MatronJournalClient;
        const props = { client, answeredPromptReplies: new Map() };

        await act(async () =>
            root.render(React.createElement(EventContent, { ...props, event: textEvent({ notice: consent }) })),
        );
        const details = container.querySelector<HTMLDetailsElement>("details.mj_SystemNotice");
        expect(details).not.toBeNull();
        expect(details!.open).toBe(false);
        expect(details!.dataset.noticeKind).toBe("consent");
        expect(container.querySelector(".mj_SystemNotice_summary")?.textContent).toBe(consent.summary);
        expect(container.querySelector(".mj_SystemNotice_icon")?.textContent).toBe("🤝");
        // The agent-only lines live in the collapsed body only, never in the summary line.
        expect(container.querySelector("summary")?.textContent).not.toContain("consent_decide");
        expect(container.querySelector(".mj_SystemNotice_body")?.textContent).toContain("consent_decide");

        // An untagged reply renders as ordinary markdown.
        await act(async () =>
            root.render(React.createElement(EventContent, { ...props, event: textEvent({ body: "Approved." }) })),
        );
        expect(container.querySelector(".mj_SystemNotice")).toBeNull();
        expect(container.textContent).toContain("Approved.");

        await act(async () => root.unmount());
        container.remove();
    });
});
