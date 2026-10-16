/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * "Subtask" lines and the subagent side pane.
 *
 * The bridge announces every Task/Agent tool call in the parent transcript as a plain text
 * message, `🔀 Subtask: <description>`, with no machine-readable link to the child conversation it
 * spawns. The child's title is the same label the description came from, so the line is matched
 * to a child by title (as the Mac app does): exact titles first, then the same label cut short by
 * the bridge on either side (the line's description at 80 units, the watcher's title at 37 and
 * "…"). Duplicate titles (the same agent run again) prefer a running child, then the newest.
 *
 * The side pane shares one slot beside the chat with the Tasks & decisions pane (chatSidePane). A
 * subagent wins the slot, as on the Mac; opening either closes the other.
 */

import { splitTitle } from "./boxes";
import { childrenOf, type ClientState, type Conversation, conversationTitle, isSubChat } from "./types";

const SUBTASK_PREFIX = "🔀 Subtask: ";

/** The description a bridge subtask line carries, or undefined when `body` is not one. The line
 *  is always the whole message (apart from surrounding whitespace), never part of one. */
export function subtaskDescription(body: string): string | undefined {
    const head = body.trimStart();
    if (!head.startsWith(SUBTASK_PREFIX)) return undefined;
    const description = head.slice(SUBTASK_PREFIX.length).trim();
    return description || undefined;
}

/** A child's title as the bridge wrote it, and without its "[ab] " session short and marker,
 *  which the description never carries. */
function titleForms(child: Conversation): string[] {
    const raw = conversationTitle(child);
    const bare = splitTitle(raw).title;
    return bare && bare !== raw ? [raw, bare] : [raw];
}

/** The bridge cuts a Subtask line's description at this many UTF-16 units. */
export const SUBTASK_DESCRIPTION_LIMIT = 80;
/** The bridge's subagent watcher titles a child from the same description, cut to 37 units and
 *  "…" when it is longer than 40. */
const TITLE_ELLIPSIS = "…";
/** A cut title shorter than this says too little to link a line to it. */
const MIN_CUT_TITLE_LENGTH = 12;

/** `text` without a half character a cut at a UTF-16 unit can leave at its end (a lone high
 *  surrogate, or the replacement character it may have become on the way). */
function cutStem(text: string): string {
    return text.replace(/(?:[\uD800-\uDBFF]|\uFFFD)+$/u, "");
}

/** Whether `title` and `description` are the same label, cut short by the bridge on either side:
 *  a watcher title "<first 37>…" that the (longer) description starts with, or a description cut
 *  at the bridge's limit that the (longer) title starts with. A short description that merely
 *  starts a longer title is not a match: its own child may simply not have arrived yet. */
function isCutMatch(description: string, title: string): boolean {
    if (title.endsWith(TITLE_ELLIPSIS)) {
        const head = cutStem(title.slice(0, -TITLE_ELLIPSIS.length));
        if (head.length >= MIN_CUT_TITLE_LENGTH && description.length > head.length && description.startsWith(head))
            return true;
    }
    // Trimming can take a space off the end of a cut description, so allow one unit less.
    if (description.length >= SUBTASK_DESCRIPTION_LIMIT - 1) {
        const head = cutStem(description);
        if (title.length > head.length && title.startsWith(head)) return true;
    }
    return false;
}

/** The child a subtask line most plausibly refers to, from `children` in creation order. Exact
 *  titles win; only without one does a title cut short by the bridge (isCutMatch) count. */
export function resolveSubtaskTarget(description: string, children: readonly Conversation[]): Conversation | undefined {
    const exact = children.filter((child) => titleForms(child).includes(description));
    const matches =
        exact.length > 0
            ? exact
            : children.filter((child) => titleForms(child).some((title) => isCutMatch(description, title)));
    for (let index = matches.length - 1; index >= 0; index -= 1) {
        if (matches[index].session_state === "running") return matches[index];
    }
    return matches[matches.length - 1];
}

/**
 * The conversations a subtask line in `convoId` can open. In a parent these are its children; in
 * a subagent they are its siblings, because the bridge flattens nested agents into siblings of
 * the top-level parent.
 */
export function subtaskCandidates(conversations: readonly Conversation[], convoId: string): Conversation[] {
    const own = conversations.find((conversation) => conversation.id === convoId);
    const parentId = own?.parent_convo_id || convoId;
    return childrenOf(conversations as Conversation[], parentId);
}

// ── The side pane beside the chat ────────────────────────────────────────────────────────────

/** Below this width of the chat area, the pane covers the chat instead of sitting beside it. */
export const SIDE_BY_SIDE_MIN_WIDTH = 820;
/** The chat keeps at least this much room beside the pane. */
export const CHAT_COLUMN_MIN_WIDTH = 420;
/** The pane opens at this width and can be dragged wider, never narrower. */
export const SIDE_PANE_MIN_WIDTH = 380;

/** A dragged pane width, kept between its minimum and what leaves the chat its minimum. */
export function clampSidePaneWidth(width: number, areaWidth: number): number {
    const max = Math.max(SIDE_PANE_MIN_WIDTH, areaWidth - CHAT_COLUMN_MIN_WIDTH);
    return Math.round(Math.min(max, Math.max(SIDE_PANE_MIN_WIDTH, width)));
}

export type ChatSidePane = { kind: "subchat"; parentId: string; childId: string } | { kind: "tasks"; convoId: string };

/**
 * What the one slot beside the chat shows, if anything. Only one pane is ever there; a subagent
 * wins, as on the Mac (the client also closes the other when either opens, so this precedence only
 * settles a state that slipped through).
 *
 * - The subagent pane belongs to the chat it was opened from: another chat never inherits it, and
 *   coming back to that chat brings it back.
 * - The Tasks pane follows the chat on screen, but not a subagent opened on its own.
 * - Nothing shows beside the tracker.
 */
export function chatSidePane(
    state: Pick<ClientState, "subChatPane" | "selectedConversationId" | "trackerView"> &
        Partial<Pick<ClientState, "chatTasks" | "conversations">>,
): ChatSidePane | undefined {
    const selectedId = state.selectedConversationId;
    if (state.trackerView?.open || !selectedId) return undefined;
    const subChat = state.subChatPane;
    if (subChat && subChat.parentId === selectedId) return { kind: "subchat", ...subChat };
    if (state.chatTasks?.open) {
        const selected = state.conversations?.find((conversation) => conversation.id === selectedId);
        if (!selected || !isSubChat(selected)) return { kind: "tasks", convoId: selectedId };
    }
    return undefined;
}
