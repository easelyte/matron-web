/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { MouseEvent as ReactMouseEvent } from "react";

/** Same-origin Files deep links; relative fragments qualify too. */
export function filesDeepLinkHash(href: string | undefined): string | null {
    if (!href || typeof window === "undefined") return null;
    try {
        const url = new URL(href, window.location.href);
        return url.origin === window.location.origin && /^#files=./.test(url.hash) ? url.hash : null;
    } catch {
        return null;
    }
}

/** Extract only a path. A bridge token is a hint, never authentication or a URL to fetch. */
export function viewerFilePath(href: string | undefined): string | null {
    if (!href || typeof window === "undefined") return null;
    try {
        const hash = filesDeepLinkHash(href);
        if (hash) {
            const path = decodeURIComponent(hash.slice("#files=".length));
            return path.startsWith("/") ? path : null;
        }
        const url = new URL(href, window.location.href);
        if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith("/view")) return null;
        const token = url.searchParams.get("token") ?? "";
        const dot = token.lastIndexOf(".");
        if (dot <= 0 || dot === token.length - 1) return null;
        const payload = token.slice(0, dot);
        if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
        const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) =>
            c.charCodeAt(0),
        );
        const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!decoded || typeof decoded !== "object" || !("path" in decoded)) return null;
        return typeof decoded.path === "string" && decoded.path.startsWith("/") ? decoded.path : null;
    } catch {
        return null;
    }
}

export interface FileViewerTarget {
    path: string;
    opener: HTMLElement;
}

export const FILE_VIEWER_OPEN = "matron:file-viewer-open";

/** Modified and non-primary clicks retain the anchor's browser behaviour. */
export function handleViewerLinkClick(event: ReactMouseEvent<HTMLAnchorElement>, path: string): void {
    // A tracker link chip may live inside a clickable card. Never also open that card.
    event.stopPropagation();
    if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
    )
        return;
    event.preventDefault();
    window.dispatchEvent(
        new CustomEvent<FileViewerTarget>(FILE_VIEWER_OPEN, { detail: { path, opener: event.currentTarget } }),
    );
}
