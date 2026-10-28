/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../../../src/journal/api";
import {
    accessWords,
    handoverCountsText,
    handoverOutcomeText,
    handoverPhase,
    HANDOVER_REPLY_HINT,
    isPeopleCardPayload,
    parsePeopleCard,
    PeopleCardView,
} from "../../../src/journal/people-card";
import { eventSnippet } from "../../../src/journal/types";
import type { Grant, GrantAnswer, JournalEvent } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

// Payloads shaped as the journal writes them (docs/protocol.md, "Hand-over").
const handoverOut = {
    kind: "mission_handover",
    direction: "out",
    grant_id: "gr_7",
    level: "owner",
    owner: { user_id: 2, name: "alice" },
    grantee: { name: "bob", address: "bob" },
    subject: { kind: "mission", id: "ms_1", num: 4, title: "Cover editor" },
    brief: "The palette is done. **Next:** the export dialog.",
    preview: {
        missions: 1,
        milestones: 3,
        items: 5,
        comments: 9,
        attachments: [
            { media_id: "md_1", name: "palette.png", mime: "image/png", size: 2048, item_num: 12 },
            { media_id: "md_2", name: "notes.pdf", mime: "application/pdf", size: 3 * 1024 * 1024, item_num: 13 },
        ],
    },
    from_device_id: 7,
    from_name: "box-a",
    from_convo_id: "c1",
};
const handoverIn = {
    kind: "mission_handover",
    direction: "in",
    grant_id: "gr_8",
    level: "owner",
    owner: { user_id: 2, name: "alice" },
    grantee: { name: "bob", address: "bob" },
    subject: { kind: "mission", title: "Cover editor" },
    brief: "The palette is done.",
    preview: { missions: 1, milestones: 3, items: 5, comments: 9, attachments: 2 },
};
const projectOut = {
    ...handoverOut,
    grant_id: "gr_9",
    subject: { kind: "project", id: "pr_1", num: 2, title: "Editor polish" },
    preview: { missions: 3, milestones: 0, items: 1, comments: 0, attachments: [] },
};

function grant(over: Partial<Grant> = {}): Grant {
    return {
        id: "gr_7",
        direction: "out",
        subject_kind: "mission",
        level: "owner",
        state: "awaiting_owner",
        pending_level: null,
        pending_state: null,
        ...over,
    };
}

const cardEvent = (payload: Record<string, unknown>): JournalEvent => ({
    seq: 40,
    convo_id: "c1",
    ts: 1700000000,
    sender: "journal",
    type: "permission_request",
    payload,
});

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("parsePeopleCard for a hand-over", () => {
    it("is a people card, with its own mirror link", () => {
        expect(isPeopleCardPayload(handoverOut)).toBe(true);
        expect(parsePeopleCard(handoverOut)!.consentUrl).toBe("matron://consent/handover/gr_7");
        expect(parsePeopleCard(handoverIn)!.consentUrl).toBe("matron://consent/handover/gr_8");
    });

    it("words each side and names the subject", () => {
        const out = parsePeopleCard(handoverOut)!;
        expect(out.label).toBe("Hand-over");
        expect(out.person).toBe("bob");
        expect(out.headline).toBe("Your agent asks to hand a mission over to bob");
        expect(out.topicLabel).toBe("Mission");
        expect(out.topic).toBe("Cover editor");

        const incoming = parsePeopleCard(handoverIn)!;
        expect(incoming.person).toBe("alice");
        expect(incoming.headline).toBe("alice wants to hand a mission over to you");

        const project = parsePeopleCard(projectOut)!;
        expect(project.headline).toBe("Your agent asks to hand a project over to bob");
        expect(project.topicLabel).toBe("Project");
    });

    it("reads the brief, the counts and the owner's file list", () => {
        const details = parsePeopleCard(handoverOut)!.handover!;
        expect(details.brief).toBe("The palette is done. **Next:** the export dialog.");
        expect(details.counts).toEqual({ missions: 1, milestones: 3, items: 5, comments: 9, attachments: 2 });
        expect(details.attachments).toEqual([
            { mediaId: "md_1", name: "palette.png", size: 2048, itemNum: 12 },
            { mediaId: "md_2", name: "notes.pdf", size: 3 * 1024 * 1024, itemNum: 13 },
        ]);
    });

    it("takes the recipient's file count as a number and lists no files there", () => {
        const details = parsePeopleCard(handoverIn)!.handover!;
        expect(details.counts.attachments).toBe(2);
        expect(details.attachments).toEqual([]);
    });

    it("drops malformed and repeated file entries", () => {
        const details = parsePeopleCard({
            ...handoverOut,
            preview: { attachments: [null, { name: "no id" }, { media_id: "md_1" }, { media_id: "md_1" }] },
        })!.handover!;
        expect(details.attachments).toEqual([{ mediaId: "md_1", name: "Untitled file", size: null, itemNum: null }]);
    });

    it("has no hand-over part on other kinds", () => {
        expect(parsePeopleCard({ kind: "contact_request", direction: "in", contact_id: "ct_1" })!.handover).toBeNull();
    });

    it("matches the journal's minted snippet", () => {
        expect(eventSnippet("permission_request", handoverOut)).toBe("🤝 Hand-over request");
    });
});

describe("mission share level", () => {
    it("says what the share lets the other person do", () => {
        expect(accessWords("contribute")).toBe("can contribute");
        expect(accessWords("read")).toBe("can read");
        expect(accessWords("owner")).toBe("");
        const share = {
            kind: "mission_share",
            direction: "out",
            grant_id: "gr_1",
            level: "contribute",
            grantee: { name: "bob" },
            mission: { id: "ms_1", num: 4, title: "Cover editor" },
        };
        expect(parsePeopleCard(share)!.access).toBe("can contribute");
        expect(parsePeopleCard({ ...share, level: "read" })!.access).toBe("can read");
    });
});

describe("handoverPhase", () => {
    it.each<[string, Partial<Grant>, string]>([
        ["owner still to answer", { state: "awaiting_owner" }, "open"],
        ["sent to the recipient", { state: "pending" }, "sent"],
        ["accepted", { state: "active", copy_id: "ms_9" }, "handed"],
        ["declined", { state: "declined" }, "declined"],
        ["expired", { state: "expired" }, "expired"],
        ["revoked", { state: "revoked", revoked_by: "owner" }, "withdrawn"],
    ])("owner side: %s", (_name, over, phase) => {
        expect(handoverPhase(grant(over))).toBe(phase);
    });

    it("recipient side: open while pending, then accepted", () => {
        expect(handoverPhase(grant({ direction: "in", state: "pending" }))).toBe("open");
        expect(handoverPhase(grant({ direction: "in", state: "active" }))).toBe("handed");
    });

    it("reads a raise of an active read share from its pending fields", () => {
        const raise = grant({ level: "read", state: "active", pending_level: "owner", pending_state: "pending" });
        expect(handoverPhase(raise)).toBe("sent");
        expect(handoverPhase({ ...raise, direction: "in" })).toBe("open");
        // A raise that ended clears its fields: the read share is all that is left.
        expect(handoverPhase(grant({ level: "read", state: "active" }))).toBe("ended");
    });

    it("says how it ended", () => {
        expect(handoverOutcomeText("open", "out", "bob")).toBeNull();
        expect(handoverOutcomeText("sent", "out", "bob")).toBe("Approved — waiting for bob to accept");
        expect(handoverOutcomeText("handed", "out", "bob")).toBe("Handed over to bob");
        expect(handoverOutcomeText("handed", "in", "alice")).toBe("Accepted — it is now yours");
        expect(handoverOutcomeText("declined", "in", "alice")).toBe("Declined");
    });

    it("counts what crosses, leaving out zeros", () => {
        expect(handoverCountsText(parsePeopleCard(handoverOut)!.handover!)).toBe(
            "1 mission · 3 milestones · 5 items · 9 comments · 2 files",
        );
        expect(handoverCountsText(parsePeopleCard(projectOut)!.handover!)).toBe("3 missions · 1 item");
    });
});

describe("hand-over card", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(() => {
        if (rendered) {
            act(() => rendered!.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    async function render(
        payload: Record<string, unknown>,
        {
            loadGrant = jest.fn().mockResolvedValue(grant()),
            answerGrant = jest.fn(),
            findItem = jest.fn().mockResolvedValue(null),
            onOpenItem = jest.fn(),
        }: {
            loadGrant?: jest.Mock;
            answerGrant?: jest.Mock;
            findItem?: jest.Mock;
            onOpenItem?: jest.Mock;
        } = {},
    ): Promise<HTMLDivElement> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const event = cardEvent(payload);
        await act(async () => {
            root.render(
                React.createElement(PeopleCardView, {
                    event,
                    card: parsePeopleCard(payload)!,
                    findItem,
                    onOpenItem,
                    loadGrant: loadGrant as unknown as (id: string) => Promise<Grant>,
                    answerGrant: answerGrant as unknown as (id: string, answer: GrantAnswer) => Promise<Grant>,
                }),
            );
        });
        rendered = { container, root };
        return container;
    }

    const button = (el: Element, label: string): HTMLButtonElement | undefined =>
        [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    const boxes = (el: Element): HTMLInputElement[] => [
        ...el.querySelectorAll<HTMLInputElement>(".mj_HandoverFiles input[type=checkbox]"),
    ];

    it("owner side: shows the brief, the counts, every file ticked, and the reply hint", async () => {
        const container = await render(handoverOut);

        expect(container.querySelector(".mj_HandoverBrief")?.textContent).toContain("the export dialog");
        expect(container.querySelector(".mj_HandoverCounts")?.textContent).toContain(
            "1 mission · 3 milestones · 5 items · 9 comments · 2 files",
        );
        expect(boxes(container).map((box) => box.checked)).toEqual([true, true]);
        expect(container.textContent).toContain("palette.png");
        expect(container.textContent).toContain("#12 · 2 KB");
        expect(container.textContent).toContain("3.0 MB");
        expect(button(container, "Approve")).toBeDefined();
        expect(button(container, "Decline")).toBeDefined();
        expect(container.querySelector(".mj_HandoverHint")?.textContent).toBe(HANDOVER_REPLY_HINT);
    });

    it("Approve sends the unticked files as exclude_media, then shows the outcome", async () => {
        const answerGrant = jest.fn().mockResolvedValue(grant({ state: "pending" }));
        const container = await render(handoverOut, { answerGrant });

        await act(async () => boxes(container)[1].click());
        expect(boxes(container).map((box) => box.checked)).toEqual([true, false]);
        await act(async () => button(container, "Approve")!.click());

        expect(answerGrant).toHaveBeenCalledWith("gr_7", {
            decision: "approve",
            exclude_media: ["md_2"],
            keep_level: "read",
        });
        expect(container.querySelector(".mj_HandoverOutcome")?.textContent).toBe(
            "Approved — waiting for bob to accept",
        );
        expect(button(container, "Approve")).toBeUndefined();
        expect(boxes(container).every((box) => box.closest("fieldset")!.disabled)).toBe(true);
    });

    it("Approve with every file ticked sends an empty exclude_media", async () => {
        const answerGrant = jest.fn().mockResolvedValue(grant({ state: "pending" }));
        const container = await render(handoverOut, { answerGrant });

        await act(async () => button(container, "Approve")!.click());
        expect(answerGrant).toHaveBeenCalledWith("gr_7", {
            decision: "approve",
            exclude_media: [],
            keep_level: "read",
        });
    });

    it("owner side: the keep-contributing switch starts from the ask and its answer is sent", async () => {
        const answerGrant = jest.fn().mockResolvedValue(grant({ state: "pending" }));
        const container = await render({ ...handoverOut, keep_level: "contribute" }, { answerGrant });
        const toggle = container.querySelector<HTMLInputElement>(".mj_HandoverKeep input[role=switch]")!;

        expect(toggle.checked).toBe(true);
        expect(container.querySelector(".mj_HandoverKeep_hint")?.textContent).toBe(
            "You can keep adding milestones, items and comments to their copy.",
        );
        await act(async () => toggle.click());
        expect(container.querySelector(".mj_HandoverKeep_hint")?.textContent).toBe(
            "You keep read access to their copy.",
        );
        await act(async () => toggle.click());
        await act(async () => button(container, "Approve")!.click());
        expect(answerGrant).toHaveBeenCalledWith("gr_7", {
            decision: "approve",
            exclude_media: [],
            keep_level: "contribute",
        });
        expect(container.querySelector<HTMLInputElement>(".mj_HandoverKeep input")!.disabled).toBe(true);
    });

    it("owner side: the switch is off when the ask did not ask to keep contributing", async () => {
        const container = await render(handoverOut);
        expect(container.querySelector<HTMLInputElement>(".mj_HandoverKeep input[role=switch]")!.checked).toBe(false);
    });

    it("recipient side: says whether the owner stays on as a contributor", async () => {
        const loadGrant = jest.fn().mockResolvedValue(grant({ id: "gr_8", direction: "in", state: "pending" }));
        const staying = await render({ ...handoverIn, keep_level: "contribute" }, { loadGrant });
        expect(staying.querySelector(".mj_HandoverKeep_hint")?.textContent).toBe(
            "alice stays on as a contributor; you can end that any time.",
        );
        expect(staying.querySelector("input[role=switch]")).toBeNull();
    });

    it("recipient side: read-only by default", async () => {
        const loadGrant = jest.fn().mockResolvedValue(grant({ id: "gr_8", direction: "in", state: "pending" }));
        const container = await render(handoverIn, { loadGrant });
        expect(container.querySelector(".mj_HandoverKeep_hint")?.textContent).toBe("alice keeps read access.");
    });

    it("Decline sends only the decision", async () => {
        const answerGrant = jest.fn().mockResolvedValue(grant({ state: "declined" }));
        const container = await render(handoverOut, { answerGrant });

        await act(async () => button(container, "Decline")!.click());
        expect(answerGrant).toHaveBeenCalledWith("gr_7", { decision: "decline" });
        expect(container.querySelector(".mj_HandoverOutcome")?.textContent).toBe("Declined");
        expect(container.querySelector(".mj_HandoverHint")).toBeNull();
    });

    it("shows the outcome of a card answered elsewhere, without buttons", async () => {
        const loadGrant = jest.fn().mockResolvedValue(grant({ state: "active", copy_id: "ms_9" }));
        const container = await render(handoverOut, { loadGrant });

        expect(loadGrant).toHaveBeenCalledWith("gr_7");
        expect(container.querySelector(".mj_HandoverOutcome")?.textContent).toBe("Handed over to bob");
        expect(button(container, "Approve")).toBeUndefined();
    });

    it("says so when the answer comes too late, and rereads the grant", async () => {
        const loadGrant = jest
            .fn()
            .mockResolvedValueOnce(grant())
            .mockResolvedValueOnce(grant({ state: "expired" }));
        const answerGrant = jest
            .fn()
            .mockRejectedValue(new JournalApiError("conflict", 409, "conflict", undefined, { blocked_by: "expired" }));
        const container = await render(handoverOut, { loadGrant, answerGrant });

        await act(async () => button(container, "Approve")!.click());
        expect(container.textContent).toContain("This hand-over expired.");
        expect(container.querySelector(".mj_HandoverOutcome")?.textContent).toContain("Expired");
    });

    it("hides the buttons as soon as the journal says the card was answered, before the reread lands", async () => {
        const loadGrant = jest
            .fn()
            .mockResolvedValueOnce(grant())
            .mockReturnValueOnce(new Promise(() => undefined));
        const answerGrant = jest
            .fn()
            .mockRejectedValue(new JournalApiError("conflict", 409, "conflict", undefined, { blocked_by: "pending" }));
        const container = await render(handoverOut, { loadGrant, answerGrant });

        await act(async () => button(container, "Approve")!.click());
        expect(container.textContent).toContain("Already answered.");
        expect(button(container, "Approve")).toBeUndefined();
        expect(button(container, "Decline")).toBeUndefined();
        expect(answerGrant).toHaveBeenCalledTimes(1);
    });

    it("ends the card on a 404 answer without waiting for a reread", async () => {
        const loadGrant = jest
            .fn()
            .mockResolvedValueOnce(grant())
            .mockReturnValueOnce(new Promise(() => undefined));
        const answerGrant = jest.fn().mockRejectedValue(new JournalApiError("gone", 404));
        const container = await render(handoverOut, { loadGrant, answerGrant });

        await act(async () => button(container, "Approve")!.click());
        expect(container.textContent).toContain("This hand-over is no longer open.");
        expect(container.querySelector(".mj_HandoverOutcome")?.textContent).toBe("No longer open");
        expect(button(container, "Approve")).toBeUndefined();
    });

    it("keeps the card open when the reread after a conflict fails for a passing reason", async () => {
        const loadGrant = jest.fn().mockResolvedValueOnce(grant()).mockRejectedValueOnce(new Error("offline"));
        const answerGrant = jest
            .fn()
            .mockRejectedValue(new JournalApiError("conflict", 409, "conflict", undefined, { blocked_by: "pending" }));
        const container = await render(handoverOut, { loadGrant, answerGrant });

        await act(async () => button(container, "Approve")!.click());
        expect(container.querySelector(".mj_HandoverOutcome")).toBeNull();
        expect(button(container, "Approve")).toBeDefined();
    });

    it("keeps the buttons after a network failure so the owner can try again", async () => {
        const answerGrant = jest.fn().mockRejectedValue(new Error("offline"));
        const container = await render(handoverOut, { answerGrant });

        await act(async () => button(container, "Approve")!.click());
        expect(container.textContent).toContain("Not sent");
        expect(button(container, "Approve")).toBeDefined();
    });

    it("recipient side: brief, counts and Accept / Decline, no file boxes and no session picker", async () => {
        const answerGrant = jest.fn().mockResolvedValue(grant({ direction: "in", state: "active" }));
        const loadGrant = jest.fn().mockResolvedValue(grant({ id: "gr_8", direction: "in", state: "pending" }));
        const container = await render(handoverIn, { loadGrant, answerGrant });

        expect(container.textContent).toContain("alice wants to hand a mission over to you");
        expect(container.querySelector(".mj_HandoverCounts")?.textContent).toContain("Arrives");
        expect(container.querySelector(".mj_HandoverCounts")?.textContent).toContain("2 files");
        expect(boxes(container)).toEqual([]);
        expect(container.querySelector("select")).toBeNull();
        expect(container.querySelector(".mj_HandoverHint")).toBeNull();

        await act(async () => button(container, "Accept")!.click());
        expect(answerGrant).toHaveBeenCalledWith("gr_8", { decision: "approve" });
        expect(container.querySelector(".mj_HandoverOutcome")?.textContent).toBe("Accepted — it is now yours");
    });

    it("opens the mirror item, where a reply reaches the agent", async () => {
        const onOpenItem = jest.fn();
        const container = await render(handoverOut, { findItem: jest.fn().mockResolvedValue(31), onOpenItem });

        await act(async () => button(container, "Open the item")!.click());
        expect(onOpenItem).toHaveBeenCalledWith(31);
    });

    it("a mission share card shows its level", async () => {
        const container = await render({
            kind: "mission_share",
            direction: "in",
            grant_id: "gr_1",
            level: "contribute",
            owner: { name: "alice" },
            mission: { id: "ms_1", num: 4, title: "Cover editor" },
        });
        expect(container.querySelector(".mj_PeopleDetail_access")?.textContent).toBe("Accesscan contribute");
    });
});
