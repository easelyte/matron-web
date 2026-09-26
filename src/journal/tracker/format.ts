/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Pure display helpers for the tracker item inbox. Unit-testable; no DOM, no React.
// Status text ALWAYS derives from the structured item/comment fields (never a raw comment body),
// so a privacy-elided body never leaks and the labels stay consistent across surfaces.

import type { TrackerComment, TrackerItem, TrackerItemKind, TrackerResolution } from "../types";

/** An open item that is waiting on the user — the one urgent "needs you" state (orange). */
export function needsUser(item: Pick<TrackerItem, "state" | "awaiting">): boolean {
    return item.state === "open" && item.awaiting === "user";
}

/** The origin conversation's title as carried on the item, or null when the journal did not send
 *  one (an older journal, a deleted or untitled conversation). Narrowed with typeof because the
 *  field crosses a JSON boundary: a non-string must degrade to "no title", not throw in a render. */
export function itemOriginTitle(item: Pick<TrackerItem, "origin_convo_title">): string | null {
    const raw = item.origin_convo_title;
    return typeof raw === "string" ? raw.trim() || null : null;
}

/** Whether the item was filed from the conversation being viewed. An unknown viewer is never
 *  "this session", so provenance falls back to labelling the origin rather than hiding it. */
export function isFromViewedConvo(
    item: Pick<TrackerItem, "origin_convo_id">,
    viewedConvoId: string | null | undefined,
): boolean {
    return !!viewedConvoId && item.origin_convo_id === viewedConvoId;
}

/** Human label for a resolution (title case). */
export function resolutionLabel(resolution: TrackerResolution): string {
    switch (resolution) {
        case "done":
            return "Done";
        case "answered":
            return "Answered";
        case "decided":
            return "Decided";
        case "reversed":
            return "Reversed";
        case "cancelled":
            return "Cancelled";
    }
}

/** One-line status text for an item row / detail pill. */
export function itemStatusText(item: Pick<TrackerItem, "state" | "awaiting" | "resolution">): string {
    if (needsUser(item)) return "Needs you";
    if (item.state === "closed") {
        return item.resolution ? `Closed · ${resolutionLabel(item.resolution)}` : "Closed";
    }
    if (item.awaiting === "agent") return "With the agent";
    return "Open";
}

/**
 * Resolutions offered for an item, primary first (client convention; the server accepts any).
 * A question can only be "answered" once the user has actually replied.
 */
export function availableResolutions(item: Pick<TrackerItem, "kind">, hasUserReply: boolean): TrackerResolution[] {
    switch (item.kind) {
        case "task":
            return ["done", "cancelled"];
        case "question":
            return hasUserReply ? ["answered", "cancelled"] : ["cancelled"];
        case "decision":
            return ["reversed", "decided", "cancelled"];
        default:
            return [];
    }
}

/** The action-menu verb for a resolution (imperative). */
export function resolveActionLabel(resolution: TrackerResolution): string {
    switch (resolution) {
        case "done":
            return "Mark done";
        case "answered":
            return "Mark answered";
        case "decided":
            return "Mark decided";
        case "reversed":
            return "Reverse";
        case "cancelled":
            return "Dismiss";
    }
}

/**
 * Centered "status" comment text, derived from the structured `meta.to`/`meta.from` transition —
 * NEVER the raw body (which may be privacy-elided). Returns null when the transition carries no
 * displayable change, so the caller can fall back to the body if one is present.
 */
export function statusRowText(comment: Pick<TrackerComment, "author" | "meta">): string | null {
    const to = comment.meta?.to;
    const from = comment.meta?.from;
    const who = comment.author === "user" ? "You" : "Agent";
    if (!to) return null;
    if (to.state === "closed") {
        return `${who} closed this${to.resolution ? ` as ${resolutionLabel(to.resolution).toLowerCase()}` : ""}`;
    }
    if (from?.state === "closed" && to.state === "open") {
        return `${who} reopened this`;
    }
    if (from && to.awaiting !== from.awaiting) {
        return to.awaiting === "agent" ? "Now with the agent" : "Needs you";
    }
    return null;
}

/** Human label for an item kind. */
export function kindLabel(kind: TrackerItemKind): string {
    switch (kind) {
        case "question":
            return "Question";
        case "task":
            return "Task";
        case "decision":
            return "Decision";
    }
}

/**
 * Relative age for a timestamp ("just now", "5m ago", "3d ago", then a short date). Epoch ms;
 * `now` injectable for tests. Null/0/non-finite → "".
 */
export function formatRelativeTime(ms: number | null | undefined, now: number = Date.now()): string {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
    const deltaSec = Math.max(0, Math.round((now - ms) / 1000));
    if (deltaSec < 45) return "just now";
    const min = Math.round(deltaSec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Collapse newlines to spaces for a single-line row preview. */
export function oneLine(text: string): string {
    return text.replace(/\s*\n+\s*/g, " ").trim();
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Human-readable byte size. 0 → "0 B"; keeps one decimal above KB (e.g. "1.4 MB"). */
export function humanizeSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${SIZE_UNITS[unit]}`;
}
