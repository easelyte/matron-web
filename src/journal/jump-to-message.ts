/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Jump to a message: open a conversation on one row instead of at its tail. Search hits, mission
 * milestones and "jump to my last message" all name a journal seq. The client pages history back
 * until that seq is loaded (client.focusMessage), then the timeline scrolls the row into view and
 * flashes it. These are the pure halves of that, kept out of the components so they can be tested
 * without a layout engine.
 */

import type { JournalEvent } from "./types";

/** How long a landed row keeps its highlight. */
export const FOCUS_HIGHLIGHT_MS = 2_000;

/** Message kinds the user writes from the composer; "my last message" lands on one of these. */
const OWN_MESSAGE_TYPES = new Set(["text", "image", "file"]);

/**
 * The newest message the signed-in user sent, by seq, among `events`. A `fallback_for` row is a
 * plain-text copy of a tracker card for older clients, posted under the user's name but not
 * written by them, so it is skipped.
 */
export function newestOwnMessageSeq(events: readonly JournalEvent[]): number | undefined {
    let newest: number | undefined;
    for (const event of events) {
        if (!event.sender.startsWith("user:") || !OWN_MESSAGE_TYPES.has(event.type)) continue;
        if (event.payload.fallback_for !== undefined && event.payload.fallback_for !== null) continue;
        if (newest === undefined || event.seq > newest) newest = event.seq;
    }
    return newest;
}

/**
 * Which rendered row a jump to `target` lands on: the row with that seq, else the nearest one
 * before it (a milestone's own marker, or a deleted message, is not rendered), else the oldest row
 * there is. `seqs` is the rendered rows' seqs in timeline order.
 */
export function landingSeq(seqs: readonly number[], target: number): number | undefined {
    let best: number | undefined;
    for (const seq of seqs) {
        if (seq <= target && (best === undefined || seq > best)) best = seq;
    }
    if (best !== undefined) return best;
    let oldest: number | undefined;
    for (const seq of seqs) if (oldest === undefined || seq < oldest) oldest = seq;
    return oldest;
}

/**
 * The scrollTop that brings `row` into view inside `scroller`: centred when it fits, its top edge
 * just below the scroller's top when it is taller than the viewport, so a long message is read
 * from its start.
 */
export function focusScrollTop(scroller: HTMLElement, row: HTMLElement): number {
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const offset = rowRect.top - scrollerRect.top;
    const margin = 16;
    const lead =
        rowRect.height + margin * 2 >= scroller.clientHeight
            ? margin
            : Math.max(margin, (scroller.clientHeight - rowRect.height) / 2);
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.min(max, Math.max(0, scroller.scrollTop + offset - lead));
}

/** True for the shortcut that jumps to the user's last message: ⇧⌘U on a Mac, Ctrl+Shift+U elsewhere. */
export function isJumpToLastOwnShortcut(
    event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
    mac: boolean,
): boolean {
    if (event.altKey || !event.shiftKey || event.key.toLowerCase() !== "u") return false;
    return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * True while a modal dialog (the media viewer, a source view, settings, an upload sheet) is up: an
 * app-wide shortcut then leaves the key alone instead of acting on the timeline behind it.
 */
export const modalDialogOpen = (): boolean => document.querySelector("[aria-modal='true']") !== null;

export const isMacPlatform = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);

/** The shortcut's name for a button tooltip. */
export const jumpToLastOwnShortcutLabel = (): string => (isMacPlatform() ? "⇧⌘U" : "Ctrl+Shift+U");
