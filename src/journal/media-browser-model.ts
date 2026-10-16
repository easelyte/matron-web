/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * What the conversation's Media / Files / Links browser lists, built from the conversation's
 * locally stored events (the whole known history, not just the rows on screen). Every list is
 * newest first. Images go to Media, other attachments to Files, and every http(s) link found in
 * a text message goes to Links, once, at its newest sighting.
 */

import { buildMediaCorpus, type MediaItem } from "./media-viewer";
import { asString, type JournalEvent } from "./types";

export interface LinkEntry {
    url: string;
    /** The first line of the message the link was last seen in, cut at 200 characters. */
    context: string;
    /** When that message was sent (ms). */
    ts: number;
}

export interface MediaBrowserEntries {
    media: MediaItem[];
    files: MediaItem[];
    links: LinkEntry[];
}

const LINK_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// Punctuation that ends a sentence or a markdown construct, not the link.
const TRAILING_PUNCTUATION = /[.,;:!?*_~]+$/;

function trimLink(raw: string): string {
    let url = raw;
    for (;;) {
        const before = url;
        url = url.replace(TRAILING_PUNCTUATION, "");
        // A closing bracket belongs to the link only when the link also opened one, as in a
        // Wikipedia-style URL; otherwise it closes markdown or prose around the link.
        for (const [open, close] of [
            ["(", ")"],
            ["[", "]"],
            ["{", "}"],
        ]) {
            if (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
        }
        if (url === before) return url;
    }
}

/** Every http(s) link in `text`, in order of appearance (duplicates kept). */
export function extractLinks(text: string): string[] {
    const links: string[] = [];
    for (const match of text.matchAll(LINK_PATTERN)) {
        const url = trimLink(match[0]);
        if (/^https?:\/\/[^/?#]+/i.test(url)) links.push(url);
    }
    return links;
}

export function buildMediaBrowserEntries(events: readonly JournalEvent[]): MediaBrowserEntries {
    const newestFirst = [...events].sort((left, right) => right.seq - left.seq);
    const attachments = buildMediaCorpus(newestFirst);
    const links: LinkEntry[] = [];
    const seen = new Set<string>();
    for (const event of newestFirst) {
        if (event.type !== "text" || asString(event.payload.fallback_for)) continue;
        const body = asString(event.payload.body);
        if (!body.includes("http")) continue;
        const context = (body.split(/\r?\n/, 1)[0] ?? "").slice(0, 200);
        for (const url of extractLinks(body)) {
            if (seen.has(url)) continue;
            seen.add(url);
            links.push({ url, context, ts: event.ts });
        }
    }
    return {
        media: attachments.filter((item) => item.isImageEvent),
        files: attachments.filter((item) => !item.isImageEvent),
        links,
    };
}
