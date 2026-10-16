/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    coordinatorBadgeText,
    parseConsentDecision,
    parseCoordinatorConsent,
    readCoordinatorDecisions,
    resetSessionStops,
    sessionStopState,
    spawnConsentRowsIn,
    stopSpawnedSession,
} from "../../../src/journal/coordinator-consent";
import type { JournalEvent } from "../../../src/journal/types";

const event = (seq: number, type: string, payload: Record<string, unknown>, convo = "c1"): JournalEvent => ({
    seq,
    convo_id: convo,
    ts: 1700000000 + seq,
    sender: "journal",
    type,
    payload,
});

const chatCard = (seq: number, room = "room-1", target = 12): JournalEvent =>
    event(seq, "permission_request", {
        kind: "agent_chat",
        request: "invite",
        room_id: room,
        from_device_id: 7,
        target_device_id: target,
    });

const spawnCard = (seq: number, requestId = "spawn-1"): JournalEvent =>
    event(seq, "permission_request", { kind: "agent_spawn", request_id: requestId, task: "Run the suite" });

const chatDecision = (seq: number, decision = "approve", extra: Record<string, unknown> = {}): JournalEvent =>
    event(seq, "consent_decision", {
        kind: "chat",
        room_id: "room-1",
        target_device_id: 12,
        decision,
        by: "coordinator",
        convo_id: "c1",
        reason: "Both boxes are on the same project",
        ...extra,
    });

const spawnDecision = (seq: number, decision = "approve", extra: Record<string, unknown> = {}): JournalEvent =>
    event(seq, "consent_decision", {
        kind: "spawn",
        request_id: "spawn-1",
        decision,
        by: "coordinator",
        convo_id: "c1",
        reason: "Test triage follows the box rules",
        ...extra,
    });

describe("parseConsentDecision", () => {
    it("names a chat ask by its room and target device, and a spawn by its request id", () => {
        expect(parseConsentDecision(chatDecision(1).payload)).toEqual({
            kind: "chat",
            approved: true,
            reason: "Both boxes are on the same project",
            askId: "room-1/12",
        });
        expect(parseConsentDecision(spawnDecision(1, "decline").payload)).toEqual({
            kind: "spawn",
            approved: false,
            reason: "Test triage follows the box rules",
            askId: "spawn-1",
        });
    });

    it("puts a multi-line reason on one line", () => {
        expect(
            parseConsentDecision(spawnDecision(1, "approve", { reason: "  one\n\ntwo\r\nthree " }).payload)?.reason,
        ).toBe("one two three");
    });

    it.each([
        ["an unknown kind", { kind: "other" }],
        ["an unknown decision", { decision: "maybe" }],
        ["a chat with no room", { kind: "chat", room_id: "", target_device_id: 12 }],
        ["a chat with no target device", { kind: "chat", room_id: "room-1", target_device_id: "12" }],
        ["a spawn with no request id", { request_id: "" }],
    ])("rejects %s", (_label, extra) => {
        expect(parseConsentDecision(spawnDecision(1, "approve", extra).payload)).toBeNull();
    });
});

describe("spawnConsentRowsIn", () => {
    const outcome = (seq: number, extra: Record<string, unknown> = {}): JournalEvent =>
        event(seq, "spawn_outcome", { request_id: "spawn-1", outcome: "started", child_convo_id: "child-1", ...extra });

    it("carries the Coordinator's answer to the card it finds, beside the card and its outcome", () => {
        const rows = spawnConsentRowsIn([spawnCard(10), spawnDecision(11), outcome(12)], "spawn-1");
        expect(rows.request?.seq).toBe(10);
        expect(rows.outcome).toMatchObject({ outcome: "started", child_convo_id: "child-1" });
        expect(rows.coordinatorDecision).toEqual({
            kind: "spawn",
            approved: true,
            reason: "Test triage follows the box rules",
            askId: "spawn-1",
        });
    });

    it("has no decision when the Coordinator did not answer, or answered another ask", () => {
        expect(spawnConsentRowsIn([spawnCard(10)], "spawn-1")).toEqual({ request: spawnCard(10), outcome: null });
        const rows = spawnConsentRowsIn(
            [spawnCard(10), spawnCard(11, "spawn-2"), spawnDecision(12, "approve", { request_id: "spawn-2" })],
            "spawn-1",
        );
        expect(rows.request?.seq).toBe(10);
        expect(rows.coordinatorDecision).toBeUndefined();
    });

    it("reads only journal-shaped consent_decision events: not a decision before its card, nor a chat one", () => {
        const rows = spawnConsentRowsIn(
            [
                spawnDecision(5),
                spawnCard(10),
                chatDecision(11, "approve", { room_id: "spawn-1" }),
                event(12, "text", { kind: "spawn", request_id: "spawn-1", decision: "approve" }),
            ],
            "spawn-1",
        );
        expect(rows.request?.seq).toBe(10);
        expect(rows.coordinatorDecision).toBeUndefined();
    });

    it("has no decision without the card, even when the decision is here", () => {
        expect(spawnConsentRowsIn([spawnDecision(11), outcome(12)], "spawn-1")).toEqual({
            request: null,
            outcome: expect.objectContaining({ outcome: "started" }),
        });
    });
});

describe("coordinatorBadgeText", () => {
    it("reads the decision with its reason, and without one when none was given", () => {
        expect(coordinatorBadgeText({ approved: true, reason: "Same project" })).toBe(
            "Approved by the Coordinator — Same project",
        );
        expect(coordinatorBadgeText({ approved: false, reason: "" })).toBe("Declined by the Coordinator");
    });
});

describe("readCoordinatorDecisions", () => {
    it("keys each decision by the card it answers", () => {
        const decisions = readCoordinatorDecisions([chatCard(10), spawnCard(11), chatDecision(12), spawnDecision(13)]);
        expect(decisions.get("c1:10")).toMatchObject({ kind: "chat", approved: true });
        expect(decisions.get("c1:11")).toMatchObject({ kind: "spawn", approved: true });
        expect(decisions.size).toBe(2);
    });

    it("lands a renewed ask's decision on the newest card only", () => {
        const decisions = readCoordinatorDecisions([chatCard(10), chatCard(20), chatDecision(21, "decline")]);
        expect(decisions.has("c1:10")).toBe(false);
        expect(decisions.get("c1:20")).toMatchObject({ approved: false });
    });

    it("keeps an earlier card's decision when the ask is renewed after it", () => {
        const decisions = readCoordinatorDecisions([chatCard(10), chatDecision(11, "decline"), chatCard(20)]);
        expect(decisions.get("c1:10")).toMatchObject({ approved: false });
        expect(decisions.has("c1:20")).toBe(false);
    });

    it("ignores a decision for another ask, one before its card, and one that does not parse", () => {
        const decisions = readCoordinatorDecisions([
            spawnDecision(5),
            chatCard(10, "room-2"),
            chatCard(11, "room-1", 99),
            spawnCard(12, "spawn-2"),
            chatDecision(13),
            spawnDecision(14),
            event(15, "consent_decision", { kind: "spawn" }),
        ]);
        expect(decisions.size).toBe(0);
    });

    it("never matches a chat decision to a spawn card or the other way round", () => {
        const decisions = readCoordinatorDecisions([
            spawnCard(10, "room-1/12"),
            chatCard(11),
            spawnDecision(12, "approve", { request_id: "room-1/12" }),
            chatDecision(13, "decline"),
        ]);
        expect(decisions.get("c1:10")).toMatchObject({ kind: "spawn", approved: true });
        expect(decisions.get("c1:11")).toMatchObject({ kind: "chat", approved: false });
    });
});

describe("stopSpawnedSession", () => {
    afterEach(() => resetSessionStops());

    it("sends once, then stays settled", async () => {
        const send = jest.fn().mockResolvedValue(true);
        const stopping = stopSpawnedSession("child-1", send);
        expect(sessionStopState("child-1")).toEqual({ kind: "sending" });
        await stopSpawnedSession("child-1", send);
        await stopping;
        expect(sessionStopState("child-1")).toEqual({ kind: "sent" });
        await stopSpawnedSession("child-1", send);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith("child-1");
    });

    it("can be tried again after a failure", async () => {
        const send = jest.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline"));
        await stopSpawnedSession("child-1", send);
        expect(sessionStopState("child-1")).toEqual({ kind: "failed", message: "Couldn't send the stop. Try again." });
        await stopSpawnedSession("child-1", send);
        expect(sessionStopState("child-1").kind).toBe("failed");
        send.mockResolvedValueOnce(true);
        await stopSpawnedSession("child-1", send);
        expect(sessionStopState("child-1")).toEqual({ kind: "sent" });
        expect(send).toHaveBeenCalledTimes(3);
    });

    it("forgets every tap on reset, and a send still in flight then lands nowhere", async () => {
        await stopSpawnedSession("child-1", jest.fn().mockResolvedValue(true));
        let finish!: (sent: boolean) => void;
        const stopping = stopSpawnedSession("child-2", () => new Promise<boolean>((done) => (finish = done)));
        expect(sessionStopState("child-2")).toEqual({ kind: "sending" });

        resetSessionStops();
        expect(sessionStopState("child-1")).toEqual({ kind: "idle" });
        expect(sessionStopState("child-2")).toEqual({ kind: "idle" });

        finish(true);
        await stopping;
        expect(sessionStopState("child-2")).toEqual({ kind: "idle" });
    });
});

describe("parseCoordinatorConsent", () => {
    it("reads the switch, and nothing from a journal without it", () => {
        expect(parseCoordinatorConsent({ convo_id: null, consent: false })).toBe(false);
        expect(parseCoordinatorConsent({ convo_id: "c9", consent: true })).toBe(true);
        expect(parseCoordinatorConsent({ convo_id: "c9" })).toBeUndefined();
        expect(parseCoordinatorConsent({ consent: "yes" })).toBeUndefined();
        expect(parseCoordinatorConsent(null)).toBeUndefined();
    });
});
