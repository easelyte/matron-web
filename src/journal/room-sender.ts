/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { formatClockTime, formatShortDate } from "./date-format";
import { isSystemNoticeEvent } from "./system-notice";
import { type JournalEvent } from "./types";

/**
 * Who wrote a message in an agent-chat room, as the room header shows it.
 *
 * Uses only what the event already carries: the journal's `sender` (`agent:<box>`, `user:<name>`,
 * or `person:<name>@<host>` for the other person's side of a room) and the bridge's `notice` tag.
 * Our own side gets `<user>@<our journal host>` so it reads the same way as theirs.
 */
export type RoomSide = "ours" | "theirs" | "system";

export interface RoomSenderLabel {
    side: RoomSide;
    /** Primary label, e.g. `dan@peer.example` or `alice@journal.example`. */
    name: string;
    /** Secondary detail, e.g. the box our agent runs on, or "agent" for the other side. */
    detail?: string;
}

/** Our journal's host from the session's server URL; empty when it cannot be parsed. */
export function journalHost(serverUrl: string | undefined): string {
    if (!serverUrl) return "";
    try {
        return new URL(serverUrl).host;
    } catch {
        return "";
    }
}

/** Whether a sender belongs to another person's journal (a federated or cross-user room). */
export function isPersonSender(sender: string): boolean {
    return sender.startsWith("person:");
}

export function roomSenderLabel(
    event: Pick<JournalEvent, "sender" | "type" | "payload">,
    ours: { username?: string; host?: string },
): RoomSenderLabel {
    if (isSystemNoticeEvent(event as JournalEvent)) return { side: "system", name: "System" };
    const separator = event.sender.indexOf(":");
    const kind = separator === -1 ? "" : event.sender.slice(0, separator);
    const rest = separator === -1 ? event.sender : event.sender.slice(separator + 1);
    // A username that is already an address (an email login) keeps its own host.
    const ourName = ours.username
        ? ours.host && !ours.username.includes("@")
            ? `${ours.username}@${ours.host}`
            : ours.username
        : "";
    if (kind === "person") {
        const via = event.payload?.via;
        return { side: "theirs", name: rest, detail: via === "agent" ? "their agent" : undefined };
    }
    if (kind === "user") return { side: "ours", name: ourName || rest };
    if (kind === "agent") {
        // The bridge stamps the speaking session on a room message (`from_session`), so two
        // sessions on one box tell apart.
        const stamped = event.payload?.from_session as { title?: unknown } | undefined;
        const title = typeof stamped?.title === "string" ? stamped.title.trim() : "";
        const agent = title ? `our agent · ${title}` : "our agent";
        return { side: "ours", name: ourName || rest, detail: ourName ? `${agent} · ${rest}` : agent };
    }
    return { side: "system", name: rest || "System" };
}

function sameLocalDay(a: number, b: number): boolean {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** A message's time: the clock time today, with the date in front on any other day. */
export function formatMessageTime(timestamp: number, now: number = Date.now()): string {
    if (!Number.isFinite(timestamp)) return "";
    const clock = formatClockTime(timestamp);
    if (sameLocalDay(timestamp, now)) return clock;
    const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
    const day = sameYear
        ? formatShortDate(timestamp)
        : new Date(timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    return `${day}, ${clock}`;
}

/** Full date and time for a tooltip. */
export function formatFullTime(timestamp: number): string {
    if (!Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}
