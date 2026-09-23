/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    availableResolutions,
    itemStatusText,
    kindLabel,
    needsUser,
    oneLine,
    resolutionLabel,
    resolveActionLabel,
    statusRowText,
} from "../../../src/journal/tracker/format";
import type { StatusSnapshot, TrackerItemKind, TrackerResolution } from "../../../src/journal/types";

describe("needsUser", () => {
    it("is true only for an open item awaiting the user", () => {
        expect(needsUser({ state: "open", awaiting: "user" })).toBe(true);
    });
    it("is false when the item is open but with the agent", () => {
        expect(needsUser({ state: "open", awaiting: "agent" })).toBe(false);
    });
    it("is false when the item is open awaiting nobody", () => {
        expect(needsUser({ state: "open", awaiting: null })).toBe(false);
    });
    it("is false for a closed item even if it still records awaiting-user", () => {
        expect(needsUser({ state: "closed", awaiting: "user" })).toBe(false);
    });
});

describe("itemStatusText", () => {
    it("leads with Needs you for an open awaiting-user item", () => {
        expect(itemStatusText({ state: "open", awaiting: "user", resolution: null })).toBe("Needs you");
    });
    it("shows the resolution label for a closed item that carries one", () => {
        expect(itemStatusText({ state: "closed", awaiting: null, resolution: "done" })).toBe("Closed · Done");
    });
    it("shows a bare Closed for a closed item with no resolution", () => {
        expect(itemStatusText({ state: "closed", awaiting: null, resolution: null })).toBe("Closed");
    });
    it("shows With the agent for an open agent-side item", () => {
        expect(itemStatusText({ state: "open", awaiting: "agent", resolution: null })).toBe("With the agent");
    });
    it("shows a plain Open for an open item awaiting nobody", () => {
        expect(itemStatusText({ state: "open", awaiting: null, resolution: null })).toBe("Open");
    });
    it("keeps needs-you priority over a stale closed resolution being absent", () => {
        // needsUser wins before the closed branch is even reached.
        expect(itemStatusText({ state: "open", awaiting: "user", resolution: "answered" })).toBe("Needs you");
    });
});

describe("availableResolutions", () => {
    it("offers done then dismiss for a task, regardless of reply state", () => {
        expect(availableResolutions({ kind: "task" }, false)).toEqual(["done", "cancelled"]);
        expect(availableResolutions({ kind: "task" }, true)).toEqual(["done", "cancelled"]);
    });
    it("only offers dismiss for a question with no user reply yet", () => {
        expect(availableResolutions({ kind: "question" }, false)).toEqual(["cancelled"]);
    });
    it("unlocks answered once the user has replied to a question", () => {
        expect(availableResolutions({ kind: "question" }, true)).toEqual(["answered", "cancelled"]);
    });
    it("offers reverse, decided and dismiss for a decision", () => {
        expect(availableResolutions({ kind: "decision" }, false)).toEqual(["reversed", "decided", "cancelled"]);
    });
    it("returns nothing for an unknown kind", () => {
        expect(availableResolutions({ kind: "unexpected" as TrackerItemKind }, true)).toEqual([]);
    });
});

describe("resolveActionLabel", () => {
    const cases: Array<[TrackerResolution, string]> = [
        ["done", "Mark done"],
        ["answered", "Mark answered"],
        ["decided", "Mark decided"],
        ["reversed", "Reverse"],
        ["cancelled", "Dismiss"],
    ];
    it.each(cases)("labels %s as %s", (resolution, label) => {
        expect(resolveActionLabel(resolution)).toBe(label);
    });
});

describe("resolutionLabel", () => {
    const cases: Array<[TrackerResolution, string]> = [
        ["done", "Done"],
        ["answered", "Answered"],
        ["decided", "Decided"],
        ["reversed", "Reversed"],
        ["cancelled", "Cancelled"],
    ];
    it.each(cases)("title-cases %s as %s", (resolution, label) => {
        expect(resolutionLabel(resolution)).toBe(label);
    });
});

describe("statusRowText", () => {
    const snap = (over: Partial<StatusSnapshot>): StatusSnapshot => ({
        state: "open",
        resolution: null,
        awaiting: null,
        ...over,
    });

    it("returns null when the transition carries no `to` snapshot", () => {
        expect(statusRowText({ author: "agent", meta: null })).toBeNull();
        expect(statusRowText({ author: "agent", meta: {} })).toBeNull();
        expect(statusRowText({ author: "agent", meta: undefined })).toBeNull();
    });
    it("describes a close with the resolution lower-cased and the actor", () => {
        expect(statusRowText({ author: "user", meta: { to: snap({ state: "closed", resolution: "done" }) } })).toBe(
            "You closed this as done",
        );
        expect(
            statusRowText({ author: "agent", meta: { to: snap({ state: "closed", resolution: "reversed" }) } }),
        ).toBe("Agent closed this as reversed");
    });
    it("describes a bare close when no resolution is present", () => {
        expect(statusRowText({ author: "user", meta: { to: snap({ state: "closed" }) } })).toBe("You closed this");
    });
    it("describes a reopen from a closed `from` to an open `to`", () => {
        expect(
            statusRowText({
                author: "agent",
                meta: { from: snap({ state: "closed", resolution: "done" }), to: snap({ state: "open" }) },
            }),
        ).toBe("Agent reopened this");
    });
    it("describes handing the item to the agent on an awaiting change", () => {
        expect(
            statusRowText({
                author: "user",
                meta: { from: snap({ awaiting: "user" }), to: snap({ awaiting: "agent" }) },
            }),
        ).toBe("Now with the agent");
    });
    it("describes handing the item back to the user on an awaiting change", () => {
        expect(
            statusRowText({
                author: "agent",
                meta: { from: snap({ awaiting: "agent" }), to: snap({ awaiting: "user" }) },
            }),
        ).toBe("Needs you");
    });
    it("returns null when a `to` exists but nothing displayable changed", () => {
        expect(
            statusRowText({
                author: "user",
                meta: { from: snap({ awaiting: "user" }), to: snap({ awaiting: "user" }) },
            }),
        ).toBeNull();
        // No `from` at all → cannot classify a reopen or an awaiting change.
        expect(statusRowText({ author: "user", meta: { to: snap({ state: "open" }) } })).toBeNull();
    });
});

describe("kindLabel", () => {
    it.each<[TrackerItemKind, string]>([
        ["question", "Question"],
        ["task", "Task"],
        ["decision", "Decision"],
    ])("labels %s as %s", (kind, label) => {
        expect(kindLabel(kind)).toBe(label);
    });
});

describe("oneLine", () => {
    it("collapses newlines and surrounding whitespace into single spaces and trims", () => {
        expect(oneLine("first\n\n  second\nthird ")).toBe("first second third");
    });
    it("trims a plain padded string with no newlines", () => {
        expect(oneLine("  hello world  ")).toBe("hello world");
    });
    it("returns an empty string for whitespace-only input", () => {
        expect(oneLine("  \n \n ")).toBe("");
    });
});
