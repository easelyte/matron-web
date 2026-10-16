/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Shared Intl.DateTimeFormat instances. Building a formatter loads locale data and costs far
 * more than formatting with one, and the sidebar and transcript format a timestamp per row on
 * every render, so constructing one per call dominated rendering with many rows on screen.
 * `toLocaleDateString`/`toLocaleTimeString` with options build one per call too.
 *
 * A formatter fixes the time zone when it is built, so the key carries the current zone: the UTC
 * offset, read on every call, and the zone's name, re-read at most once a minute because reading
 * it builds a formatter. After the machine's zone changes (travel, a DST switch) the next call, or
 * one within the minute when the new zone has the same offset, builds a fresh formatter.
 */

const cache = new Map<string, Intl.DateTimeFormat>();
const ZONE_RECHECK_MS = 60_000;
let zone = { name: "", checkedAt: -Infinity };

function zoneName(): string {
    const now = Date.now();
    if (now - zone.checkedAt >= ZONE_RECHECK_MS) {
        zone = { name: new Intl.DateTimeFormat().resolvedOptions().timeZone, checkedAt: now };
    }
    return zone.name;
}

/** A cached `new Intl.DateTimeFormat(locale, options)`. */
export function dateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${locale ?? ""}|${new Date().getTimezoneOffset()}|${zoneName()}|${JSON.stringify(options)}`;
    let format = cache.get(key);
    if (!format) {
        format = new Intl.DateTimeFormat(locale, options);
        cache.set(key, format);
    }
    return format;
}
