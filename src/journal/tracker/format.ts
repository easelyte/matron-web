/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Pure display helpers for the tracker (missions + item inbox). Unit-testable; no DOM, no React.
// Status text ALWAYS derives from the structured item/comment fields (never a raw comment body),
// so a privacy-elided body never leaks and the labels stay consistent across surfaces.

import { humanizeMtime } from "../files/format";
import type {
    Mission,
    TrackerComment,
    TrackerItem,
    TrackerItemKind,
    TrackerMilestoneKind,
    TrackerResolution,
} from "../types";

/** An open item that is waiting on the user — the one urgent "needs you" state (orange). */
export function needsUser(item: Pick<TrackerItem, "state" | "awaiting">): boolean {
    return item.state === "open" && item.awaiting === "user";
}

/** The reserved label that marks an item as "handle elsewhere" — the explicit, actionable routing
 *  state (spec #213). Set/cleared via the item's labels; distinct from the informational "this came
 *  from another session" state so an operator can say "route this to its home" without collapsing
 *  the two. */
export const ROUTE_ELSEWHERE_LABEL = "route-elsewhere";

export function isRouteElsewhere(item: Pick<TrackerItem, "labels">): boolean {
    return item.labels.includes(ROUTE_ELSEWHERE_LABEL);
}

/** An item's relationship to the session currently viewing it (spec #213): `here` (same origin as
 *  the viewer — no badge), `other` (a different session — informational "from «title»"), or
 *  `elsewhere` (the explicit route-elsewhere label — actionable). */
export type ItemProvenance =
    { kind: "here" } | { kind: "other"; title: string | null } | { kind: "elsewhere"; title: string | null };

// The route-elsewhere label is ACTIONABLE and wins over the origin comparison: an item flagged
// "handle elsewhere" reads that way even when viewed from its own origin. Otherwise same origin as
// the viewer is "here"; a different (or unknown) viewer is "other". An unknown viewer therefore
// degrades to labelling everything "other" — the pre-#213 all-scope behaviour, never a wrong "here".
export function itemProvenance(
    item: Pick<TrackerItem, "labels" | "origin_convo_id" | "origin_convo_title">,
    currentConvoId: string | null | undefined,
): ItemProvenance {
    const title = item.origin_convo_title?.trim() || null;
    if (isRouteElsewhere(item)) return { kind: "elsewhere", title };
    if (currentConvoId && item.origin_convo_id === currentConvoId) return { kind: "here" };
    return { kind: "other", title };
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

/** A mission's display label — its title, or `#num` when the title is blank/elided. */
export function missionLabel(mission: Pick<Mission, "title" | "num">): string {
    return mission.title?.trim() || `#${mission.num}`;
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

/** Human label for a milestone kind. */
export function milestoneKindLabel(kind: TrackerMilestoneKind): string {
    return kind === "user_input" ? "Your input" : "Progress";
}

/**
 * Relative age for a timestamp ("just now", "5m ago", "3d ago", then a short date). Thin wrapper
 * over the Files pane's `humanizeMtime` (the repo's existing relative-time helper) so the tracker
 * and Files read time the same way. Epoch ms; `now` injectable for tests. Null/0 → "".
 */
export function formatRelativeTime(ms: number | null | undefined, now: number = Date.now()): string {
    if (ms == null) return "";
    return humanizeMtime(ms, now);
}

/** Collapse newlines to spaces for a single-line row preview. */
export function oneLine(text: string): string {
    return text.replace(/\s*\n+\s*/g, " ").trim();
}
