/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Coordinator consent approval, as the cards show it. When the user lets the Coordinator answer
 * chat and spawn asks (Settings → Coordinator), the journal appends a client-only
 * `consent_decision` event on the card's conversation for each one it answers: `{kind,
 * request_id | room_id + target_device_id, decision, by, convo_id, reason}`. The timeline draws a
 * one-line notice for it (coordinator-notices.tsx), and the card it is about carries a badge:
 * "Approved by the Coordinator — <reason>". A spawn the Coordinator let start can be stopped from
 * its card with one tap, which sends `/stop` into the spawned session's own conversation.
 */

import { agentChatAskId, agentChatCardKey, parseAgentChatRequest } from "./agent-chat";
import { asString, type EventPayload, findSpawnConsentRows, type JournalEvent, type SpawnConsentRows } from "./types";

export interface CoordinatorDecision {
    kind: "chat" | "spawn";
    approved: boolean;
    /** The Coordinator's reason on one line, or "" when it gave none. */
    reason: string;
    /** `<room_id>/<target_device_id>` for a chat, the `request_id` for a spawn. */
    askId: string;
}

/** Every run of line breaks becomes one space, blank lines included. */
export function oneLineConsentReason(value: unknown): string {
    return asString(value)
        .split(/[\n\v\f\r\u0085\u2028\u2029]+/)
        .join(" ")
        .trim();
}

/** A `consent_decision` payload, or null when it names no kind, decision or ask. */
export function parseConsentDecision(payload: EventPayload): CoordinatorDecision | null {
    const kind = asString(payload.kind);
    const decision = asString(payload.decision);
    if ((kind !== "chat" && kind !== "spawn") || (decision !== "approve" && decision !== "decline")) return null;
    let askId: string;
    if (kind === "chat") {
        const roomId = asString(payload.room_id);
        const device = payload.target_device_id;
        if (!roomId || typeof device !== "number" || !Number.isSafeInteger(device)) return null;
        askId = agentChatAskId({ roomId, targetDeviceId: device });
    } else {
        askId = asString(payload.request_id);
        if (!askId) return null;
    }
    return { kind, approved: decision === "approve", reason: oneLineConsentReason(payload.reason), askId };
}

/** "Approved by the Coordinator — <reason>" / "Declined by the Coordinator". */
export function coordinatorBadgeText(decision: Pick<CoordinatorDecision, "approved" | "reason">): string {
    const line = decision.approved ? "Approved by the Coordinator" : "Declined by the Coordinator";
    return decision.reason ? `${line} — ${decision.reason}` : line;
}

function spawnRequestId(event: JournalEvent): string {
    return event.type === "permission_request" && asString(event.payload.kind) === "agent_spawn"
        ? asString(event.payload.request_id)
        : "";
}

/**
 * The Coordinator's answers, keyed by the card they are about (agentChatCardKey). A renewed ask
 * reuses its key (a fresh chat ask after a decline or an expiry), so a decision always lands on
 * the latest card for it seen before the decision.
 */
export function readCoordinatorDecisions(events: readonly JournalEvent[]): ReadonlyMap<string, CoordinatorDecision> {
    const decisions = new Map<string, CoordinatorDecision>();
    const latestChatCard = new Map<string, string>();
    const latestSpawnCard = new Map<string, string>();
    for (const event of events) {
        if (event.type === "permission_request") {
            const chat = parseAgentChatRequest(event.payload);
            if (chat) {
                latestChatCard.set(agentChatAskId(chat), agentChatCardKey(event));
                continue;
            }
            const requestId = spawnRequestId(event);
            if (requestId) latestSpawnCard.set(requestId, agentChatCardKey(event));
            continue;
        }
        if (event.type !== "consent_decision") continue;
        const decision = parseConsentDecision(event.payload);
        if (!decision) continue;
        const card = (decision.kind === "chat" ? latestChatCard : latestSpawnCard).get(decision.askId);
        if (card) decisions.set(card, decision);
    }
    return decisions;
}

/**
 * findSpawnConsentRows, plus the Coordinator's answer to the card it found: the tracker item's
 * copy of the card carries the same badge as the timeline's.
 */
export function spawnConsentRowsIn(events: readonly JournalEvent[], requestId: string): SpawnConsentRows {
    const rows = findSpawnConsentRows(events, requestId);
    if (!rows.request) return rows;
    const coordinatorDecision = readCoordinatorDecisions(events).get(agentChatCardKey(rows.request));
    return coordinatorDecision ? { ...rows, coordinatorDecision } : rows;
}

// ── Stop session ──────────────────────────────────────────────────────────────────────────────
// Where a Stop session tap is, per spawned conversation. In memory only (the stopped session's
// own chat is the durable record), and outside the card so a card that scrolls away and back
// keeps its state. Signing out forgets it all (resetSessionStops), so the next account never
// sees another account's "Stop sent"; a send still in flight then lands nowhere.

export type SessionStopState =
    { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "failed"; message: string };

const IDLE: SessionStopState = { kind: "idle" };
const stopStates = new Map<string, SessionStopState>();
const stopListeners = new Set<() => void>();
// Bumped by resetSessionStops, so a send that started before a sign-out cannot write its answer
// into the next session's state.
let stopGeneration = 0;

function setStopState(convoId: string, state: SessionStopState): void {
    stopStates.set(convoId, state);
    for (const listener of stopListeners) listener();
}

export function subscribeSessionStops(listener: () => void): () => void {
    stopListeners.add(listener);
    return () => stopListeners.delete(listener);
}

export function sessionStopState(convoId: string): SessionStopState {
    return stopStates.get(convoId) ?? IDLE;
}

/**
 * Stop session: sends `/stop` into the spawned session's conversation. Once sent it stays settled
 * (the session's own chat says it stopped); a failure can be tried again.
 */
export async function stopSpawnedSession(convoId: string, send: (convoId: string) => Promise<boolean>): Promise<void> {
    const current = sessionStopState(convoId).kind;
    if (current === "sending" || current === "sent") return;
    const generation = stopGeneration;
    setStopState(convoId, { kind: "sending" });
    let sent = false;
    try {
        sent = await send(convoId);
    } catch {
        sent = false;
    }
    if (generation !== stopGeneration) return;
    setStopState(convoId, sent ? { kind: "sent" } : { kind: "failed", message: "Couldn't send the stop. Try again." });
}

/** Forget every Stop session tap: on sign-out (MatronJournalClient.logout), and between tests. */
export function resetSessionStops(): void {
    stopGeneration += 1;
    stopStates.clear();
    for (const listener of stopListeners) listener();
}

// ── The switch (Settings → Coordinator) ───────────────────────────────────────────────────────

/** `consent` from a GET or PUT /coordinator body; undefined from a journal without the switch. */
export function parseCoordinatorConsent(raw: unknown): boolean | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const consent = (raw as { consent?: unknown }).consent;
    return typeof consent === "boolean" ? consent : undefined;
}
