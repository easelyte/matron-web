/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Chat-pane breakpoints (redesign v6, GENERATIVE-SYSTEM §3). The measured element is the CHAT
 * PANE, never the viewport: a ResizeObserver sets `data-pane` = narrow (≤480) · medium (≤760) ·
 * wide on it, and the order-of-sacrifice CSS keys on that. The phone layout (@media ≤700px)
 * is separate and unchanged.
 */

export type PaneBand = "narrow" | "medium" | "wide";

/** --mj-bp-pane-narrow / --mj-bp-pane-medium. */
export const PANE_NARROW_MAX = 480;
export const PANE_MEDIUM_MAX = 760;

export function paneBand(width: number): PaneBand {
    return width <= PANE_NARROW_MAX ? "narrow" : width <= PANE_MEDIUM_MAX ? "medium" : "wide";
}

/** Set `data-pane` on the chat pane for its current width (called from its ResizeObserver). */
export function applyPaneBand(pane: HTMLElement, width: number): void {
    const band = paneBand(width);
    if (pane.dataset.pane !== band) pane.dataset.pane = band;
}
