/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot } from "react-dom/client";

import {
    consentDecisionNotice,
    CoordinatorEventNotice,
    coordinatorNotice,
    isUnrenderableNoticeEvent,
    routineNotice,
} from "../coordinator-notices";
import type { EventPayload, JournalEvent } from "../types";

function event(type: string, payload: EventPayload): JournalEvent {
    return { kind: "journal", seq: 1, convo_id: "c1", ts: 1, sender: "journal", type, payload };
}

describe("coordinatorNotice", () => {
    it("says whether this chat gained or lost the role", () => {
        expect(coordinatorNotice({ role: "assigned" })?.text).toBe("This chat is now the Coordinator");
        expect(coordinatorNotice({ role: "released" })?.text).toBe("This chat is no longer the Coordinator");
    });

    it("rejects an unknown or missing role", () => {
        expect(coordinatorNotice({ role: "promoted" })).toBeNull();
        expect(coordinatorNotice({})).toBeNull();
    });
});

describe("routineNotice", () => {
    const base = { routine_id: "r1", name: " daily-sweep " };

    it("says who saved or deleted which routine", () => {
        expect(routineNotice({ ...base, action: "saved", created: true, by: "user" })?.text).toBe(
            "You created a routine · daily-sweep",
        );
        expect(routineNotice({ ...base, action: "saved", by: "agent" })?.text).toBe(
            "Coordinator updated a routine · daily-sweep",
        );
        expect(routineNotice({ ...base, action: "deleted", created: true, by: "agent" })?.text).toBe(
            "Coordinator deleted a routine · daily-sweep",
        );
    });

    it("words each fire outcome and flags the undelivered ones", () => {
        const fired = (outcome?: string): ReturnType<typeof routineNotice> =>
            routineNotice({ ...base, action: "fired", ...(outcome === undefined ? {} : { outcome }) });
        expect(fired("applied now")).toEqual({ text: "Routine fired · daily-sweep", glyph: "routine" });
        expect(fired()).toEqual({ text: "Routine fired · daily-sweep", glyph: "routine" });
        expect(fired("applied deferred")).toEqual({
            text: "Routine fired · daily-sweep — queued for the next idle point",
            glyph: "routine",
        });
        expect(fired("missed")).toEqual({ text: "Routine missed · daily-sweep", glyph: "warning" });
        expect(fired("no_coordinator")).toEqual({
            text: "Routine not delivered · daily-sweep — no Coordinator box",
            glyph: "warning",
        });
        expect(fired("failed agent_unreachable")).toEqual({
            text: "Routine not delivered · daily-sweep — agent_unreachable",
            glyph: "warning",
        });
        expect(fired("failed")).toEqual({ text: "Routine not delivered · daily-sweep", glyph: "warning" });
    });

    it("rejects a payload without an id, a name or a known action", () => {
        expect(routineNotice({ name: "x", action: "fired" })).toBeNull();
        expect(routineNotice({ routine_id: "r1", name: "  ", action: "fired" })).toBeNull();
        expect(routineNotice({ ...base, action: "paused" })).toBeNull();
    });
});

describe("consentDecisionNotice", () => {
    it("says what the Coordinator decided, with its reason on one line", () => {
        expect(
            consentDecisionNotice({ kind: "spawn", decision: "approve", reason: "Follows the box rules\nfor box-a" })
                ?.text,
        ).toBe("Coordinator approved the spawn request — Follows the box rules for box-a");
        expect(
            consentDecisionNotice({ kind: "chat", decision: "approve", reason: "First line\r\n\r\nsecond\u2028third" })
                ?.text,
        ).toBe("Coordinator approved the chat request — First line second third");
        expect(consentDecisionNotice({ kind: "chat", decision: "decline", reason: "  " })?.text).toBe(
            "Coordinator declined the chat request",
        );
    });

    it("rejects an unknown kind or decision", () => {
        expect(consentDecisionNotice({ kind: "item", decision: "approve" })).toBeNull();
        expect(consentDecisionNotice({ kind: "chat", decision: "maybe" })).toBeNull();
    });
});

describe("isUnrenderableNoticeEvent", () => {
    it("is true only for a Coordinator event whose payload renders nothing", () => {
        expect(isUnrenderableNoticeEvent(event("coordinator", {}))).toBe(true);
        expect(isUnrenderableNoticeEvent(event("routine", { name: "x" }))).toBe(true);
        expect(isUnrenderableNoticeEvent(event("consent_decision", {}))).toBe(true);
        expect(isUnrenderableNoticeEvent(event("coordinator", { role: "assigned" }))).toBe(false);
        expect(isUnrenderableNoticeEvent(event("text", {}))).toBe(false);
        expect(isUnrenderableNoticeEvent(event("constructor", {}))).toBe(false);
    });
});

describe("CoordinatorEventNotice", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("renders a quiet one-line notice that is not a button", async () => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(
                <CoordinatorEventNotice
                    event={event("routine", {
                        routine_id: "r1",
                        name: "deploy-window",
                        action: "fired",
                        outcome: "missed",
                    })}
                />,
            );
        });
        const notice = container.querySelector(".mj_CoordinatorNotice");
        expect(notice?.textContent).toBe("Routine missed · deploy-window");
        expect(notice?.tagName).toBe("DIV");
        // The row truncates; the full line stays reachable on hover.
        expect(notice?.getAttribute("title")).toBe("Routine missed · deploy-window");
        expect(container.querySelector("button")).toBeNull();
        await act(async () => root.unmount());
        container.remove();
    });
});
