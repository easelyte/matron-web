/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { MouseEvent as ReactMouseEvent } from "react";

// In-app handling for Files deep links (`<app-origin>/#files=<url-encoded-abs-path>`) that appear
// as ordinary links in chat markdown or tracker link chips. Without this they render like any
// external https link (target="_blank"), so a click opens a second copy of the app in a new
// window/tab instead of switching the Files pane of the window the operator is already in.

const FILES_HASH = /^#files=./;

/**
 * The `#files=…` fragment of `href` when it is a Files deep link into THIS app (same origin as
 * the page), else null. A relative `#files=…` href resolves against the page, so it qualifies.
 * Any path on our origin is accepted: the fragment is only meaningful to this client, and the
 * app is served from a single origin.
 */
export function filesDeepLinkHash(href: string | undefined): string | null {
    if (!href || typeof window === "undefined") return null;
    let url: URL;
    try {
        url = new URL(href, window.location.href);
    } catch {
        return null;
    }
    if (url.origin !== window.location.origin) return null;
    return FILES_HASH.test(url.hash) ? url.hash : null;
}

/**
 * Route a Files deep-link fragment through the client's existing `hashchange` listener
 * (client.applyFilesDeepLink), which opens the pane and then clears the fragment. replaceState
 * rather than `location.hash =` so the click leaves no extra history entry behind.
 */
export function openFilesDeepLink(hash: string): void {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
}

// A plain primary click. Modified (cmd/ctrl/shift/alt) or non-primary clicks keep the browser's
// default so "open in new tab/window" still works; middle-click fires auxclick, not click.
function isPlainPrimaryClick(event: ReactMouseEvent): boolean {
    return (
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey
    );
}

/**
 * Click handler for an anchor whose href is a Files deep link: a plain click opens the Files pane
 * in the current window without a reload; anything else falls through to the browser.
 */
export function handleFilesLinkClick(event: ReactMouseEvent<HTMLAnchorElement>, hash: string): void {
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    // The link may sit inside a clickable surface (a tracker card is a <button> that opens the
    // item, which would close the Files pane again) — the click is fully handled here.
    event.stopPropagation();
    openFilesDeepLink(hash);
}
