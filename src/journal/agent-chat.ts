/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { asString, type EventPayload, type JournalEvent, type Session } from "./types";

/*
 * The agent-chat consent card: one agent asking the user's permission to talk to another.
 *
 * It arrives as a `permission_request` whose payload carries `kind: "agent_chat"`, and it is
 * answered over HTTP (`POST /agent-chat/answer`, keyed on `room_id` + `target_device_id`) —
 * never over `prompt_reply`, which nothing on the server reads for this card. The answer
 * leaves no event of its own; the journal records the decision in the card's conversation as
 * the consent item's `closed` marker, which is how a card decided on another device settles.
 */

export type AgentChatAsk = "invite" | "join";
export type AgentChatDecision = "approve" | "deny";

export interface AgentChatRequest {
    /** An `invite` pulls the target into the requester's room; a `join` asks to be let into
        someone else's room, and self-targets (`fromDeviceId === targetDeviceId`). */
    ask: AgentChatAsk;
    roomId: string;
    fromDeviceId: number;
    fromName: string;
    /** The device the parked row is filed under — half the answer key. For a join this is the
        joiner itself, so it must never be used to label the far end. */
    targetDeviceId: number;
    /** The far end, display only. For a join it is the room's owner. */
    toName: string;
    fromConvoId: string;
    fromConvoTitle: string;
    toConvoId: string;
    toConvoTitle: string;
    topic?: string;
    justification?: string;
}

function deviceId(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

// The journal defaults topic/justification to "" rather than omitting them, so absent and
// empty arrive identically — collapse both so the card drops the row.
function nonEmpty(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

/** True for any payload of the agent-chat kind, answerable or not. */
export function isAgentChatPayload(payload: EventPayload): boolean {
    return asString(payload.kind) === "agent_chat";
}

/**
 * Parses an agent-chat `permission_request` payload, or `null` when it is not one or cannot be
 * answered. Strict about the fields the answer needs (`room_id`, `target_device_id`,
 * `from_device_id`, a known `request`): a card we cannot answer must never draw buttons.
 */
export function parseAgentChatRequest(payload: EventPayload): AgentChatRequest | null {
    if (!isAgentChatPayload(payload)) return null;
    const roomId = asString(payload.room_id);
    const ask = payload.request;
    const fromDeviceId = deviceId(payload.from_device_id);
    const targetDeviceId = deviceId(payload.target_device_id);
    if (!roomId || (ask !== "invite" && ask !== "join") || fromDeviceId === undefined || targetDeviceId === undefined) {
        return null;
    }
    return {
        ask,
        roomId,
        fromDeviceId,
        fromName: asString(payload.from_name),
        targetDeviceId,
        // Display-only and optional: a journal that predates them still yields an answerable card.
        toName: asString(payload.to_name),
        fromConvoId: asString(payload.from_convo_id),
        fromConvoTitle: asString(payload.from_convo_title),
        toConvoId: asString(payload.to_convo_id),
        toConvoTitle: asString(payload.to_convo_title),
        topic: nonEmpty(payload.topic),
        justification: nonEmpty(payload.justification),
    };
}

/** `<room_id>/<target_device_id>` — the ask's key. A renewed ask reuses it. */
export function agentChatAskId(request: Pick<AgentChatRequest, "roomId" | "targetDeviceId">): string {
    return `${request.roomId}/${request.targetDeviceId}`;
}

export function agentChatRequesterLabel(request: AgentChatRequest): string {
    return request.fromName || `Device ${request.fromDeviceId}`;
}

// For a join the far end is the room's owner, so this deliberately never falls back to
// targetDeviceId — that id is the joiner.
export function agentChatTargetLabel(request: AgentChatRequest): string {
    if (request.toName) return request.toName;
    return request.ask === "invite" ? `Device ${request.targetDeviceId}` : "the room's owner";
}

/**
 * A session as the conversation list shows it: the first two characters of its id, then its
 * title — unless the title already opens with them (bridges seed titles as
 * `"<box>:<short id> words"`), so it never stutters. `undefined` when no session was named.
 */
export function agentChatSessionLabel(id: string, title: string): string | undefined {
    const short = id.slice(0, 2);
    const trimmed = title.trim();
    if (!short) return trimmed || undefined;
    if (!trimmed) return short;
    const firstWord = trimmed.split(/\s/, 1)[0];
    const carriesShortId = firstWord === short || firstWord.endsWith(`:${short}`);
    return carriesShortId ? trimmed : `${short} · ${trimmed}`;
}

function endpointLabel(device: string, convoId: string, convoTitle: string): string {
    const session = agentChatSessionLabel(convoId, convoTitle);
    return session ? `${device} — ${session}` : device;
}

export function agentChatFromLabel(request: AgentChatRequest): string {
    return endpointLabel(agentChatRequesterLabel(request), request.fromConvoId, request.fromConvoTitle);
}

export function agentChatToLabel(request: AgentChatRequest): string {
    return endpointLabel(agentChatTargetLabel(request), request.toConvoId, request.toConvoTitle);
}

/** One line stating what is being asked. Names the far end: "another agent" is not something
    a user can consent to. */
export function agentChatHeadline(request: AgentChatRequest): string {
    return request.ask === "invite"
        ? `${agentChatRequesterLabel(request)} wants to start a chat with ${agentChatTargetLabel(request)}.`
        : `${agentChatRequesterLabel(request)} wants to join this chat.`;
}

/** The inert line drawn in place of an agent-chat card the parser rejected. */
export function unanswerableAgentRequestNotice(payload: EventPayload): string {
    const topic = nonEmpty(payload.topic);
    const task = asString(payload.task).split("\n", 1)[0];
    const headline = topic ?? (task || undefined);
    return headline
        ? `Agent request that can't be answered here: ${headline}`
        : "Agent request that can't be answered here";
}

/** How a card has been settled: decided (on any device, or by the Coordinator) or no longer
    awaiting an answer. */
export type AgentChatResolution = { kind: "answered"; approved: boolean; byCoordinator?: true } | { kind: "expired" };

export function agentChatCardKey(event: Pick<JournalEvent, "convo_id" | "seq">): string {
    return `${event.convo_id}:${event.seq}`;
}

// The journal's closing notes for an ask that lapsed (expired, the room closed, the ask gone).
const LAPSED_NOTE_OPENINGS = ["Expired", "The room was closed", "Closed — "];

/**
 * How a consent item's closing marker settles its chat card, or `undefined` when the close is
 * not the ask's (the user closed the mirror by hand; the ask is still waiting). A journal that
 * names the ask says how it ended in `consent_outcome`; older journals only say it in the
 * closing note, read by its fixed openings.
 */
export function agentChatResolutionFromClose(marker: EventPayload): AgentChatResolution | undefined {
    const consentAsk = asString(marker.consent_ask);
    const outcome = asString(marker.consent_outcome);
    const comment = marker.comment;
    const note = comment && typeof comment === "object" ? asString((comment as EventPayload).body) : "";
    // The Coordinator's answer: `decided_by` from a journal that names it, else its closing note.
    const byCoordinator =
        asString(marker.decided_by) === "coordinator" ||
        note.startsWith("Approved by the Coordinator") ||
        note.startsWith("Declined by the Coordinator");
    const answered = (approved: boolean): AgentChatResolution =>
        byCoordinator ? { kind: "answered", approved, byCoordinator: true } : { kind: "answered", approved };
    if (consentAsk || outcome) {
        if (outcome === "approved") return answered(true);
        if (outcome === "denied") return answered(false);
        return outcome ? { kind: "expired" } : undefined;
    }
    if (note.startsWith("Approved")) return answered(true);
    if (note.startsWith("Declined")) return answered(false);
    if (LAPSED_NOTE_OPENINGS.some((opening) => note.startsWith(opening))) return { kind: "expired" };
    return undefined;
}

/**
 * Reads what the timeline says about its agent-chat cards, keyed by `agentChatCardKey`.
 *
 * Each card is paired with its consent item: by `consent_ask` when the marker names the ask,
 * else with the most recent unclaimed card (the journal files the item in the same tick it
 * journals the card). The item's `closed` marker then settles the card. A renewed ask reuses
 * the key, so a decision always lands on the newest card for it.
 */
export function readAgentChatResolutions(events: readonly JournalEvent[]): Map<string, AgentChatResolution> {
    const resolutions = new Map<string, AgentChatResolution>();
    const latestCard = new Map<string, string>();
    const unpaired: string[] = [];
    const cardForItem = new Map<string, string>();
    // Items whose `created` marker named the ask: the journal names it on every close it
    // makes, so a close of one of these that names nothing is a hand close.
    const itemsNamingTheirAsk = new Set<string>();

    for (const event of events) {
        if (event.type === "permission_request") {
            const request = parseAgentChatRequest(event.payload);
            if (!request) continue;
            const key = agentChatCardKey(event);
            latestCard.set(agentChatAskId(request), key);
            unpaired.push(key);
            continue;
        }
        if (event.type !== "item" || asString(event.payload.consent) !== "chat") continue;
        const marker = event.payload;
        const itemId = asString(marker.item_id);
        const consentAsk = asString(marker.consent_ask);
        const action = asString(marker.action);
        if (action === "created") {
            // Only a card no other item has claimed: when this marker's own card fell outside
            // the loaded history, the latest card for the key is an older ask's.
            let card: string | undefined;
            if (consentAsk) {
                const candidate = latestCard.get(consentAsk);
                card = candidate && unpaired.includes(candidate) ? candidate : undefined;
            } else {
                card = unpaired[unpaired.length - 1];
            }
            if (!card) continue;
            cardForItem.set(itemId, card);
            if (consentAsk) itemsNamingTheirAsk.add(itemId);
            unpaired.splice(unpaired.indexOf(card), 1);
        } else if (action === "closed") {
            const candidate = consentAsk ? latestCard.get(consentAsk) : undefined;
            const unclaimedForAsk = candidate && unpaired.includes(candidate) ? candidate : undefined;
            const card = cardForItem.get(itemId) ?? unclaimedForAsk;
            if (!card) continue;
            if (itemsNamingTheirAsk.has(itemId) && !consentAsk && !asString(marker.consent_outcome)) continue;
            const resolution = agentChatResolutionFromClose(marker);
            if (!resolution) continue;
            // A decision, once read, is not undone by a later close saying the ask lapsed.
            if (resolution.kind === "expired" && resolutions.get(card)?.kind === "answered") continue;
            resolutions.set(card, resolution);
        }
    }
    return resolutions;
}

// A tap's answer, remembered across reloads: the HTTP answer leaves no event of its own, and
// the consent item's closing marker arrives a beat later (or, after a 409, says nothing this
// device can match). Stored per server and user, like the other per-session preferences, so a
// different account never inherits another's answers. Bounded so it can't grow without limit.
const ANSWERS_KEY_PREFIX = "matron.agentChatAnswers";
const MAX_REMEMBERED_ANSWERS = 500;
export type RememberedAgentChatAnswer = AgentChatDecision | "expired";

/** The storage scope for a signed-in session's remembered answers; `undefined` when signed out. */
export function agentChatAnswersScope(session: Session | undefined | null): string | undefined {
    return session ? `${ANSWERS_KEY_PREFIX}:${encodeURIComponent(session.serverUrl)}:${session.userId}` : undefined;
}

function readAnswers(scope: string): Record<string, RememberedAgentChatAnswer> {
    try {
        const raw = window.localStorage.getItem(scope);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? (parsed as Record<string, RememberedAgentChatAnswer>) : {};
    } catch {
        return {};
    }
}

export function rememberedAgentChatAnswer(
    scope: string | undefined,
    cardKey: string,
): RememberedAgentChatAnswer | undefined {
    if (!scope) return undefined;
    const value = readAnswers(scope)[cardKey];
    return value === "approve" || value === "deny" || value === "expired" ? value : undefined;
}

export function rememberAgentChatAnswer(
    scope: string | undefined,
    cardKey: string,
    answer: RememberedAgentChatAnswer,
): void {
    if (!scope) return;
    const answers = readAnswers(scope);
    // A decision outranks a later "no longer waiting": the 409 a second answer for the same
    // card gets once the first has been applied must not erase what the first one decided.
    const previous = answers[cardKey];
    if (answer === "expired" && (previous === "approve" || previous === "deny")) return;
    delete answers[cardKey];
    answers[cardKey] = answer;
    const keys = Object.keys(answers);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_ANSWERS))) delete answers[stale];
    try {
        window.localStorage.setItem(scope, JSON.stringify(answers));
    } catch {
        // Storage full or blocked: the card still settles for this page's lifetime.
    }
}
