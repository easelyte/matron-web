/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    availableResolutions,
    isFromViewedConvo,
    itemOriginTitle,
    itemStatusText,
    kindLabel,
    milestoneKindLabel,
    missionLabel,
    needsUser,
    offeredItemActions,
    oneLine,
    closedStatusLabel,
    resolutionLabel,
    resolveActionLabel,
    spawnConsentRequestId,
    statusByline,
    statusRowText,
    missionItemGroups,
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

describe("offeredItemActions", () => {
    it("offers every action while the item is open, whoever it awaits", () => {
        expect(offeredItemActions({ kind: "question", state: "open", actions: ["Option A", "Option B"] })).toEqual([
            "Option A",
            "Option B",
        ]);
        expect(offeredItemActions({ kind: "task", state: "open", actions: ["Go"] })).toEqual(["Go"]);
    });
    it("offers none once the item is closed", () => {
        expect(offeredItemActions({ kind: "question", state: "closed", actions: ["Go"] })).toEqual([]);
        expect(offeredItemActions({ kind: "notice", state: "closed", actions: ["Seen"] })).toEqual([]);
    });
    it("offers none when the item has none", () => {
        expect(offeredItemActions({ kind: "question", state: "open", actions: [] })).toEqual([]);
        expect(offeredItemActions({ kind: "question", state: "open" })).toEqual([]);
    });
    it("still offers Seen on an open notice from a journal that predates item actions", () => {
        expect(offeredItemActions({ kind: "notice", state: "open" })).toEqual(["Seen"]);
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
        expect(
            itemStatusText({
                state: "closed",
                awaiting: null,
                resolution: "done",
                kind: "notice",
                chosen_action: "Seen",
            }),
        ).toBe("Closed · Seen");
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
    it("offers only dismiss for a notice (its Seen button closes it)", () => {
        expect(availableResolutions({ kind: "notice" }, false)).toEqual(["cancelled"]);
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

describe("closedStatusLabel", () => {
    it("says Seen for a notice the user closed with its own button", () => {
        expect(closedStatusLabel({ kind: "notice", resolution: "done", chosen_action: "Seen" })).toBe("Seen");
        expect(closedStatusLabel({ kind: "notice", resolution: "done", chosen_action: "seen" })).toBe("Seen");
    });
    it("keeps the resolution for anything else, and Closed when there is none", () => {
        expect(closedStatusLabel({ kind: "notice", resolution: "done", chosen_action: null })).toBe("Done");
        expect(closedStatusLabel({ kind: "question", resolution: "answered", chosen_action: "Seen" })).toBe("Answered");
        expect(closedStatusLabel({ kind: "decision", resolution: null })).toBe("Closed");
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

describe("missionLabel", () => {
    it("uses the title when present", () => {
        expect(missionLabel({ title: "Ship the tracker", num: 7 })).toBe("Ship the tracker");
    });
    it("falls back to #num when the title is blank or whitespace", () => {
        expect(missionLabel({ title: "", num: 7 })).toBe("#7");
        expect(missionLabel({ title: "   ", num: 12 })).toBe("#12");
    });
});

describe("kindLabel", () => {
    it.each<[TrackerItemKind, string]>([
        ["question", "Question"],
        ["task", "Task"],
        ["decision", "Decision"],
        ["notice", "To read"],
    ])("labels %s as %s", (kind, label) => {
        expect(kindLabel(kind)).toBe(label);
    });
});

describe("milestoneKindLabel", () => {
    it("labels user_input as Your input and everything else as Progress", () => {
        expect(milestoneKindLabel("user_input")).toBe("Your input");
        expect(milestoneKindLabel("progress")).toBe("Progress");
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

describe("itemOriginTitle", () => {
    it("returns the trimmed title the journal put on the item", () => {
        expect(itemOriginTitle({ origin_convo_title: "  Auth refactor " })).toBe("Auth refactor");
    });

    it("is null when the field is absent, null, blank, or not a string", () => {
        expect(itemOriginTitle({})).toBeNull();
        expect(itemOriginTitle({ origin_convo_title: null })).toBeNull();
        expect(itemOriginTitle({ origin_convo_title: "   " })).toBeNull();
        expect(itemOriginTitle({ origin_convo_title: 42 as unknown as string })).toBeNull();
    });
});

describe("isFromViewedConvo", () => {
    it("is true only when the viewed conversation is the item's origin", () => {
        expect(isFromViewedConvo({ origin_convo_id: "c1" }, "c1")).toBe(true);
        expect(isFromViewedConvo({ origin_convo_id: "c1" }, "c2")).toBe(false);
    });

    it("treats an unknown viewer as another session", () => {
        expect(isFromViewedConvo({ origin_convo_id: "c1" }, null)).toBe(false);
        expect(isFromViewedConvo({ origin_convo_id: "c1" }, undefined)).toBe(false);
    });
});

describe("spawnConsentRequestId", () => {
    const withLink = (url: string): { links: { url: string }[] } => ({ links: [{ url }] });

    it("reads the request id from the journal's spawn consent link", () => {
        expect(spawnConsentRequestId(withLink("matron://consent/spawn/sp_1"))).toBe("sp_1");
    });
    it("compares the scheme and host case-insensitively, the kind as written", () => {
        expect(spawnConsentRequestId(withLink("MATRON://Consent/spawn/sp_1"))).toBe("sp_1");
        expect(spawnConsentRequestId(withLink("matron://consent/Spawn/sp_1"))).toBeNull();
    });
    it("rejects anything but the exact shape", () => {
        for (const url of [
            "matron://consent/spawn/",
            "matron://consent/spawn//sp_1",
            "matron://consent/spawn/sp_1/",
            "matron://consent/spawn/sp_1/extra",
            "matron://consent/spawn/sp_1?x=1",
            "matron://consent/spawn/sp_1#top",
            "https://example.com/consent/spawn/sp_1",
        ]) {
            expect(spawnConsentRequestId(withLink(url))).toBeNull();
        }
    });
    it("is null for an agent-chat consent item and for an ordinary one", () => {
        expect(spawnConsentRequestId(withLink("matron://consent/chat/room_1/7"))).toBeNull();
        expect(spawnConsentRequestId({ links: [] })).toBeNull();
    });
    it("takes the first well-formed link", () => {
        expect(
            spawnConsentRequestId({
                links: [
                    { url: "https://example.com/pull/1" },
                    { url: "matron://consent/spawn/sp_2" },
                    { url: "matron://consent/spawn/sp_3" },
                ],
            }),
        ).toBe("sp_2");
    });
});

describe("statusByline", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    it("says when and who, in a sentence", () => {
        expect(statusByline(now - 12 * 60_000, "agent", now)).toBe("Updated 12m ago by an agent");
        expect(statusByline(now - 3 * 3_600_000, "user", now)).toBe("Updated 3h ago by you");
        expect(statusByline(now - 10_000, "agent", now)).toBe("Updated just now by an agent");
    });
    it("drops the author when unknown", () => {
        expect(statusByline(now - 2 * 86_400_000, null, now)).toBe("Updated 2d ago");
    });
    it("names the date a week or more back", () => {
        expect(statusByline(now - 30 * 86_400_000, "agent", now)).toMatch(/^Updated on .+ by an agent$/);
    });
    it("is null without a time", () => {
        expect(statusByline(null, "agent", now)).toBeNull();
        expect(statusByline(undefined, undefined, now)).toBeNull();
    });
});

describe("missionItemGroups", () => {
    it("splits open items into needs-you and the rest, keeping the journal's order", () => {
        const items = [
            { id: "a", state: "open" as const, awaiting: "user" as const },
            { id: "b", state: "open" as const, awaiting: "agent" as const },
            { id: "c", state: "open" as const, awaiting: null },
            { id: "d", state: "open" as const, awaiting: "user" as const },
            { id: "e", state: "closed" as const, awaiting: null },
        ];
        const groups = missionItemGroups(items);
        expect(groups.needsYou.map((item) => item.id)).toEqual(["a", "d"]);
        expect(groups.others.map((item) => item.id)).toEqual(["b", "c"]);
    });
});
