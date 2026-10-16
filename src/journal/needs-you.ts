/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// What the conversation list and the rail flag beside a row or a section: the items that wait on
// the user, counted per conversation and across the missions, and the sessions that arrived
// without the user starting them here. Pure; no DOM, no React.

import { needsUser } from "./tracker/format";
import type { Conversation, Mission, TrackerItem } from "./types";

/**
 * Open items awaiting the user, counted per origin conversation (the Mac's needsUserCounts). Read
 * off the app-wide open items the client keeps live; empty until they have loaded.
 */
export function needsYouByConversation(items: readonly TrackerItem[] | undefined): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of items ?? []) {
        if (!needsUser(item)) continue;
        counts.set(item.origin_convo_id, (counts.get(item.origin_convo_id) ?? 0) + 1);
    }
    return counts;
}

/**
 * The Projects rail badge: open items awaiting the user that sit on a mission which is still open.
 * The Mac adds up its open missions' counts; here the open items are the live source (the missions
 * list only refreshes while the tracker is open), so they are counted directly and the missions
 * list, when loaded, only rules out the ones on a closed mission.
 */
export function projectsNeedsYou(
    items: readonly TrackerItem[] | undefined,
    missions: readonly Pick<Mission, "id" | "state">[] | undefined,
): number {
    const closed = new Set((missions ?? []).filter((mission) => mission.state !== "open").map((mission) => mission.id));
    let total = 0;
    for (const item of items ?? []) {
        if (needsUser(item) && item.mission_id != null && !closed.has(item.mission_id)) total += 1;
    }
    return total;
}

/** Markers that lead an agent-chat room's title (the current one and the legacy one). */
const ROOM_MARKERS = ["↔️ ", "🔗 "];
/** The marker the bridge puts ahead of the short on a title a session another agent started earned. */
const SPAWNED_MARKER = "🐣 ";

function leadsWithSessionShort(title: string): boolean {
    const rest = title.startsWith(SPAWNED_MARKER) ? title.slice(SPAWNED_MARKER.length) : title;
    return /^\[[\p{L}\p{N}]{2}\] /u.test(rest);
}

/**
 * Whether a title is an agent-chat room's: it leads with a room marker, or names its two sides with
 * the arrow between them. A session's own title leads with its `[ab] ` short and a room's never
 * does, so an arrow in the user's own words does not make a session a room.
 */
export function isAgentRoomTitle(title: string): boolean {
    if (ROOM_MARKERS.some((marker) => title.startsWith(marker))) return true;
    if (leadsWithSessionShort(title)) return false;
    return title.replace(/\uFE0F/g, "").includes(" \u2194 ");
}

/** Whether a sent line is the bridge's start command: `/start` or `!start`, any case. */
export function isStartCommand(body: string): boolean {
    return /^\s*[/!]start(?:\s|$)/i.test(body);
}

/**
 * A conversation whose first frame is older than this when it arrives (a reconnect replaying what
 * was missed) is not marked new: only sessions born while this tab was live are, so coming back
 * from a long sleep never flags a pile of old sessions.
 */
export const NEW_CONVERSATION_STALE_MS = 2 * 60_000;

/** How long an ask stays claimable: a session on an awake box is born within a second or two. */
const START_INTENT_WINDOW_MS = 60_000;

export interface StartedSessionIntents {
    /** A start this device sent to `box` (null when the box is not known) at `now`. */
    noteBox(box: number | null, now: number): void;
    /** The start sent to `box` was answered with this conversation, which settles that box's ask. */
    noteConversation(conversationId: string, box: number | null): void;
    /** The start sent to `box` was refused or may not have gone out: forget its ask. */
    forgetBox(box: number | null): void;
    /** Whether a conversation just born answers one of the asks above, consuming the ask if so. */
    claim(conversation: Pick<Conversation, "id" | "agent_device_id" | "title">, now: number): boolean;
    /** Whether an ask is still waiting for a session on a particular box. */
    awaitsKnownBox(now: number): boolean;
}

/**
 * The session starts this device asked for and has not yet seen born (the Mac's
 * LocalStartIntents): a New session sheet start or a `/start` line from the composer. The journal
 * does not say who started a conversation, so a live-born one is "started here" only when it
 * answers one of these; every other one gets the "New" marker. One ask per box, newest wins.
 */
export function startedSessionIntents(): StartedSessionIntents {
    let asks: Array<{ box: number | null; at: number }> = [];
    const started = new Set<string>();
    return {
        noteBox(box, now) {
            asks = [...asks.filter((ask) => ask.box !== box), { box, at: now }];
        },
        noteConversation(conversationId, box) {
            asks = asks.filter((ask) => ask.box !== box);
            started.add(conversationId);
        },
        forgetBox(box) {
            asks = asks.filter((ask) => ask.box !== box);
        },
        claim(conversation, now) {
            if (started.delete(conversation.id)) return true;
            asks = asks.filter((ask) => now - ask.at <= START_INTENT_WINDOW_MS);
            // A title already wearing the spawned marker never answers a start.
            if (conversation.title.startsWith(SPAWNED_MARKER)) return false;
            const box = conversation.agent_device_id ?? null;
            const index = asks.findIndex((ask) => ask.box === null || ask.box === box);
            if (index < 0) return false;
            asks.splice(index, 1);
            return true;
        },
        awaitsKnownBox(now) {
            asks = asks.filter((ask) => now - ask.at <= START_INTENT_WINDOW_MS);
            return asks.some((ask) => ask.box !== null);
        },
    };
}
