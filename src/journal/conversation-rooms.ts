/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The chat header's "Rooms · n": the agent-chat rooms one conversation takes part in, as the
 * Mac's ConversationRoomsRule lists them. A room is a conversation whose `participant_convos`
 * (from `/snapshot` and membership `convo_meta` frames) names this one — the starter and
 * everyone who joined alike. Newest activity first, never-active last, then id for a stable
 * order; a room is never a room of itself.
 */

import { splitTitle } from "./boxes";
import type { Conversation } from "./types";

export type RoomRunState = "running" | "waiting" | "done";

export interface ConversationRoom {
    id: string;
    /** The room's title with the session short and the room marker peeled off. */
    title: string;
    state: RoomRunState;
    /** Time of the room's newest message, or undefined when nothing has been said yet. */
    lastActivity?: number;
    /** The room's other participant conversations this device knows, in journal order. */
    peers: Conversation[];
    /** Participant conversations this device has no row for (a private box, not yet synced). */
    unknownPeers: number;
}

/** The Mac's DashboardSessionState: running and done as they are, anything else waiting. */
export function roomRunState(sessionState: string): RoomRunState {
    return sessionState === "running" || sessionState === "done" ? sessionState : "waiting";
}

export const ROOM_STATE_LABEL: Record<RoomRunState, string> = {
    running: "Running",
    waiting: "Waiting",
    done: "Done",
};

/** A stored room title as the rooms surfaces draw it; the id when nothing is left. */
export function roomTitle(conversation: Pick<Conversation, "id" | "title">): string {
    return splitTitle(conversation.title.trim()).title.trim() || conversation.id;
}

/** Whether a conversation is an agent-chat room with someone joined (the journal's `isRoom`). */
export function isJoinedRoom(conversation: Pick<Conversation, "participant_convos"> | undefined): boolean {
    return (conversation?.participant_convos?.length ?? 0) > 0;
}

export function roomsOf(convoId: string, conversations: readonly Conversation[]): ConversationRoom[] {
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    return conversations
        .filter((room) => room.id !== convoId && room.participant_convos?.includes(convoId))
        .map((room) => {
            const others = [...new Set(room.participant_convos)].filter((id) => id !== convoId && id !== room.id);
            const peers = others.flatMap((id) => {
                const peer = byId.get(id);
                return peer ? [peer] : [];
            });
            // Message time when the row has one; never-active rows carry their creation time
            // as last_ts, which the Mac's last_activity_ts would not.
            const lastActivity = room.snippet || room.last_ts !== room.created_at ? room.last_ts : undefined;
            return {
                id: room.id,
                title: roomTitle(room),
                state: roomRunState(room.session_state),
                lastActivity,
                peers,
                unknownPeers: others.length - peers.length,
            };
        })
        .sort((a, b) => {
            if (a.lastActivity !== undefined && b.lastActivity !== undefined && a.lastActivity !== b.lastActivity) {
                return b.lastActivity - a.lastActivity;
            }
            if (a.lastActivity !== undefined && b.lastActivity === undefined) return -1;
            if (a.lastActivity === undefined && b.lastActivity !== undefined) return 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
}

/** "Rooms · 2"; null for a chat that is in no room (no control). */
export function roomsLabel(count: number): string | null {
    return count > 0 ? `Rooms · ${count}` : null;
}

export function roomsAccessibilityLabel(count: number): string {
    return `${count} agent chat room${count === 1 ? "" : "s"}`;
}
