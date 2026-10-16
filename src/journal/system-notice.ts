/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { JournalEvent } from "./types";

/**
 * A bridge notice published beside a turn it injected into the session (a consent nudge, a
 * routine fire, a room message, a spawn outcome…). The bridge tags the text event with
 * `payload.notice = {kind, icon, summary}`; the timeline shows it as one short row that expands
 * to the full `body`. Agent replies never carry the tag.
 */
export interface SystemNotice {
    kind: string;
    icon: string;
    summary: string;
}

const SUMMARY_MAX = 200;
const ICON_MAX = 8;
const FALLBACK_ICON = "ℹ️";

function oneLine(value: unknown, max: number): string {
    if (typeof value !== "string") return "";
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The compact-row tag on a text event, or null when it has none (or an unusable one). */
export function systemNotice(event: JournalEvent): SystemNotice | null {
    if (event.type !== "text") return null;
    const raw = event.payload.notice;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const notice = raw as Record<string, unknown>;
    const summary = oneLine(notice.summary, SUMMARY_MAX);
    if (!summary) return null;
    const icon = oneLine(notice.icon, ICON_MAX) || FALLBACK_ICON;
    const kind = oneLine(notice.kind, 32) || "notice";
    return { kind, icon, summary };
}

export function isSystemNoticeEvent(event: JournalEvent): boolean {
    return systemNotice(event) !== null;
}

/**
 * Two neighbouring timeline events share a sender section (one header, grouped bubbles) when they
 * have the same sender and neither is a notice row: a notice stands alone, so the agent reply after
 * it opens a new section with its own header.
 */
export function sameTimelineSection(a: JournalEvent, b: JournalEvent): boolean {
    return a.sender === b.sender && !isSystemNoticeEvent(a) && !isSystemNoticeEvent(b);
}
