/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * "Enable browser tools" state (redesign v6, CONTRACTS 3): idle → queued → restarting → on.
 *
 * The bridge has no structured restart events yet, so the state is read from the conversation
 * itself: the operator's own `/restart --browser` message and the bridge's fixed replies to it —
 *   "Waiting for turn to finish before restarting…"   → queued (the restart waits for the turn)
 *   "🔄 Restarting Claude session..."                   → restarting
 *   "Claude session restarted.\n…\nExtras: browser"     → on (no `browser` extra → off)
 *   "--browser is a Claude-only session extra…"         → refused (back to idle)
 * A structured bridge event would replace this scan (see HANDOFF bridge gaps).
 */

import { type JournalEvent } from "./types";

export type BrowserToolsState = "idle" | "queued" | "restarting" | "on";

export const BROWSER_RESTART_COMMAND = "/restart --browser";
export const BROWSER_RESTART_NOW_COMMAND = "/restart --browser --force";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const RESTART_REQUEST = /^[/!]restart\b/i;
const QUEUED = /^Waiting for turn to finish before restarting\b/;
const RESTARTING = /^🔄\s*Restarting\b/u;
const RESTARTED = /^(Claude|Codex) session restarted\./;
const REFUSED = /--browser is a Claude-only session extra/;

/**
 * Derive the browser-tools state of one conversation from its events (oldest first).
 * `sessionRunning` covers the moment between sending the request and the bridge's first reply:
 * a busy agent means the restart will wait (queued), an idle one restarts at once.
 */
export function browserToolsState(events: readonly JournalEvent[], sessionRunning: boolean): BrowserToolsState {
    let state: BrowserToolsState = "idle";
    let on = false;
    // A browser restart the operator asked for and the bridge hasn't finished yet.
    let pending: "sent" | "queued" | "restarting" | null = null;
    for (const event of events) {
        if (event.type !== "text") continue;
        const body = asString(event.payload.body).trim();
        if (event.sender.startsWith("user:")) {
            if (RESTART_REQUEST.test(body)) {
                // Any /restart replaces a parked one; only a --browser one is ours to track.
                pending = /(^|\s)--browser\b/.test(body) ? "sent" : null;
            }
            continue;
        }
        if (REFUSED.test(body)) {
            pending = null;
        } else if (QUEUED.test(body)) {
            if (pending) pending = "queued";
        } else if (RESTARTING.test(body)) {
            if (pending) pending = "restarting";
        } else if (RESTARTED.test(body)) {
            on = /^Extras:.*\bbrowser\b/im.test(body);
            pending = null;
        }
    }
    if (pending === "sent") state = sessionRunning ? "queued" : "restarting";
    else if (pending) state = pending;
    else state = on ? "on" : "idle";
    return state;
}

/**
 * Seqs of the bridge's "Restarting…" notices that answer a `/restart --browser`, so the thread
 * can word them "Restarting with browser tools…" (the design's notice copy).
 */
export function browserRestartNoticeSeqs(events: readonly JournalEvent[]): ReadonlySet<number> {
    const seqs = new Set<number>();
    let pending = false;
    for (const event of events) {
        if (event.type !== "text") continue;
        const body = asString(event.payload.body).trim();
        if (event.sender.startsWith("user:")) {
            if (RESTART_REQUEST.test(body)) pending = /(^|\s)--browser\b/.test(body);
            continue;
        }
        if (REFUSED.test(body) || RESTARTED.test(body)) pending = false;
        else if (pending && RESTARTING.test(body)) seqs.add(event.seq);
    }
    return seqs;
}
