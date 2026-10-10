/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * "Enable browser tools" state (redesign v6, CONTRACTS 3): idle → queued → restarting → on.
 *
 * Whether browser tools are ON is read from data, never from the transcript: the bridge's
 * status frame carries `extras`, the MCP extras the session's process was spawned with (the
 * journal caches and replays it, so it survives reconnects, offline spells and stopped
 * sessions). A frame without `extras` (an older bridge) makes the state "unknown", and the
 * session-menu row is hidden rather than guessed.
 *
 * Only the TRANSIENT phases of a request the operator just made are read from the conversation:
 * their own `/restart --browser` message and the bridge's fixed replies to it —
 *   "Waiting for turn to finish before restarting…"   → queued (the restart waits for the turn)
 *   "🔄 Restarting Claude session..."                   → restarting
 *   "Claude session restarted.…"                        → done (the status frame says on/off)
 *   "--browser is a Claude-only session extra…"         → refused (back to idle)
 */

import { type JournalEvent } from "./types";

export type BrowserToolsState = "unknown" | "idle" | "queued" | "restarting" | "on";

export const BROWSER_RESTART_COMMAND = "/restart --browser";
export const BROWSER_RESTART_NOW_COMMAND = "/restart --browser --force";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const RESTART_REQUEST = /^[/!]restart\b/i;
const QUEUED = /^Waiting for turn to finish before restarting\b/;
const RESTARTING = /^🔄\s*Restarting\b/u;
const RESTARTED = /^(Claude|Codex) session restarted\./;
const REFUSED = /--browser is a Claude-only session extra/;
/**
 * Bridge replies that end a pending restart without one happening: no live session, the session
 * stopped, the parked restart failed or was replaced by another parked command, or an attachment
 * blocked it.
 */
const ABANDONED = [
    /^No active session\b/,
    /^Session stopped\.$/,
    /^Deferred \/restart failed\b/,
    /\(replacing the queued \/restart\)/,
    /^An attachment is still being processed\b/,
    /^\[Session ended \(exit -?\d+\)\]$/,
];

type Pending = { phase: "sent" | "queued" | "restarting"; force: boolean } | null;

/**
 * Derive the browser-tools state of one conversation from its status-frame `extras` and its
 * events (oldest first). `extras` undefined = the bridge publishes none (older bridge).
 * `sessionRunning` covers the moment between sending the request and the bridge's first reply
 * (a busy agent means a plain request waits for the turn; `--force` restarts at once).
 */
export function browserToolsState(
    events: readonly JournalEvent[],
    sessionRunning: boolean,
    extras: readonly string[] | undefined,
): BrowserToolsState {
    // The spawned process has the extra: on, whatever a (possibly windowed) transcript implies.
    if (extras?.includes("browser")) return "on";
    let pending: Pending = null;
    for (const event of events) {
        if (event.type !== "text") continue;
        const body = asString(event.payload.body).trim();
        if (event.sender.startsWith("user:")) {
            if (RESTART_REQUEST.test(body)) {
                // Any /restart replaces a parked one; only a --browser one is ours to track.
                pending = /(^|\s)--browser\b/.test(body)
                    ? { phase: "sent", force: /(^|\s)--force\b/.test(body) }
                    : null;
            }
            continue;
        }
        if (!pending && !RESTARTED.test(body)) continue;
        if (RESTARTED.test(body)) {
            pending = null;
        } else if (REFUSED.test(body) || ABANDONED.some((pattern) => pattern.test(body))) {
            pending = null;
        } else if (QUEUED.test(body)) {
            pending = { ...pending!, phase: "queued" };
        } else if (RESTARTING.test(body)) {
            pending = { ...pending!, phase: "restarting" };
        } else if (pending?.phase === "restarting") {
            // Mid-restart the session is being recreated: any other bridge reply is its failure.
            pending = null;
        }
    }
    if (!pending) return extras ? "idle" : "unknown";
    if (pending.phase === "restarting") return "restarting";
    if (pending.force) return "restarting";
    // Parked behind the turn. session_state can't tell "turn over" from "waiting on a prompt"
    // (both read 'waiting'), so a parked request stays queued until the bridge answers; the
    // ABANDONED replies above cover the ways it drops one.
    if (pending.phase === "queued" || sessionRunning) return "queued";
    return "restarting";
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
