/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Shareable tracker links: `https://<journal>/u/<name>/<n>`. The journal serves this app's
// index.html for `/u/*`, so the app reads the path once on load and opens what number `n` of user
// `name` is (an item, mission, milestone or project) through the same lookup "go to number" uses.

export interface TrackerLinkPath {
    user: string;
    num: number;
}

/**
 * `/u/alice/412` (or `/u/alice/412/`) → `{ user: "alice", num: 412 }`; any other path → null. The
 * prefix before `/u/` is allowed, so an app served under a sub-path still reads its links.
 */
export function parseTrackerLinkPath(pathname: string): TrackerLinkPath | null {
    const match = /(?:^|\/)u\/([^/]+)\/([0-9]{1,15})\/?$/.exec(pathname);
    if (!match) return null;
    let user: string;
    try {
        user = decodeURIComponent(match[1]).trim();
    } catch {
        return null;
    }
    const num = Number(match[2]);
    if (!user || !Number.isSafeInteger(num) || num <= 0) return null;
    return { user, num };
}

/**
 * An absolute http(s) link to a `/u/<name>/<n>` page on the origin this app is served from (so a
 * link to this deployment's own tracker), or null for any other URL. A query or fragment is
 * allowed and ignored.
 */
export function parseOwnTrackerUrl(href: string, origin: string = window.location.origin): TrackerLinkPath | null {
    if (!/^https?:\/\//i.test(href)) return null;
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    return url.origin === origin ? parseTrackerLinkPath(url.pathname) : null;
}

/**
 * What the web app says about a link to another user's number, which it cannot show: the
 * tracker here lists the signed-in user's own rows. The Mac app shows one shared with the user.
 */
export function othersLinkMessage(link: TrackerLinkPath): string {
    return `#${link.num} is on ${link.user}'s tracker. The web app shows only your own; the Matron app for Mac opens what ${link.user} shares with you.`;
}
