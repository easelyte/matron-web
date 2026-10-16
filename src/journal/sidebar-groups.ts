/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Day sections for the conversation list, as the Mac sidebar groups its rows ("Today",
 * "Yesterday", a weekday within the week, then the date). Pure functions over an already
 * sorted row list; `now` is injected so tests are stable across midnight.
 */

import { dateTimeFormat } from "./date-format";
import type { Conversation } from "./types";

const DAY_MS = 86_400_000;

function startOfDay(timestamp: number): number {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", the weekday for the last six days, else "25 August" (with a year when it differs). */
export function dayLabel(timestamp: number, now: number = Date.now(), locale?: string): string {
    const daysAgo = Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY_MS);
    if (daysAgo <= 0) return "Today";
    if (daysAgo === 1) return "Yesterday";
    const then = new Date(timestamp);
    if (daysAgo <= 6) return dateTimeFormat(locale, { weekday: "long" }).format(then);
    const sameYear = then.getFullYear() === new Date(now).getFullYear();
    return dateTimeFormat(
        locale,
        sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" },
    ).format(then);
}

export interface DayGroup {
    label: string;
    rows: Conversation[];
}

/** Buckets consecutive rows by their day label, keeping the incoming order inside each group. */
export function groupByDay(rows: Conversation[], now: number = Date.now(), locale?: string): DayGroup[] {
    const groups: DayGroup[] = [];
    for (const row of rows) {
        const label = dayLabel(row.last_ts ?? row.created_at, now, locale);
        const last = groups[groups.length - 1];
        if (last && last.label === label) last.rows.push(row);
        else groups.push({ label, rows: [row] });
    }
    return groups;
}
