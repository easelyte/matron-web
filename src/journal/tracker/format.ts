/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Pure display helpers for the tracker (missions + item inbox). Unit-testable; no DOM, no React.
// Status text ALWAYS derives from the structured item/comment fields (never a raw comment body),
// so a privacy-elided body never leaks and the labels stay consistent across surfaces.

import { dateTimeFormat } from "../date-format";
import type {
    Mission,
    TrackerActor,
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

/**
 * Whether the item belongs on For you's Done tab, as the journal's `state=done` view decides it: a
 * question, decision or notice that is closed, or open but answered (the user acted on it and it no
 * longer waits on them). Tasks are the agents' work list. Only an agent's item counts while open: one the user filed
 * is work they handed out, not something they answered.
 */
export function inDone(
    item: Pick<TrackerItem, "kind" | "state" | "awaiting" | "last_user_input_at" | "created_by">,
): boolean {
    if (item.kind === "task") return false;
    return (
        item.state === "closed" ||
        (item.created_by === "agent" && item.awaiting !== "user" && item.last_user_input_at != null)
    );
}

/** The Done tab's order (the journal's `sort=acted`): the user's own last action on the item, else
 *  when it was closed, else its last update. Newest first. */
export function doneSortKey(item: Pick<TrackerItem, "last_user_input_at" | "closed_at" | "updated_at">): number {
    return item.last_user_input_at ?? item.closed_at ?? item.updated_at;
}

/** A notice the user has not marked seen yet: it offers the one-tap Seen button. */
export function awaitsSeen(item: Pick<TrackerItem, "kind" | "state">): boolean {
    return item.kind === "notice" && item.state === "open";
}

/**
 * The item's own one-tap answers to draw under its body: all of them while the item is open, none
 * once it is closed (a closed item takes a reply, not a button press). A journal that predates item
 * actions sends no `actions`; an open notice from one still offers its Seen button.
 */
export function offeredItemActions(item: Pick<TrackerItem, "kind" | "state" | "actions">): string[] {
    if (item.state !== "open") return [];
    return item.actions ?? (item.kind === "notice" ? ["Seen"] : []);
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

/** The reserved label that marks an item as "handle elsewhere" — the explicit, actionable routing
 * state. Set/cleared via the item's labels; distinct from the informational "this came
 *  from another session" state so an operator can say "route this to its home" without collapsing
 *  the two. */
export const ROUTE_ELSEWHERE_LABEL = "route-elsewhere";

export function isRouteElsewhere(item: Pick<TrackerItem, "labels">): boolean {
    return item.labels.includes(ROUTE_ELSEWHERE_LABEL);
}

/** An item's relationship to the session currently viewing it: `here` (same origin as
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
    const title = itemOriginTitle(item);
    if (isRouteElsewhere(item)) return { kind: "elsewhere", title };
    if (isFromViewedConvo(item, currentConvoId)) return { kind: "here" };
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
/** A closed row's one-word status. A notice the user closed with its own button was read, not
 *  done, so it says "Seen". */
export function closedStatusLabel(item: Pick<TrackerItem, "kind" | "resolution" | "chosen_action">): string {
    if (item.kind === "notice" && item.chosen_action?.toLowerCase() === "seen") return "Seen";
    return item.resolution ? resolutionLabel(item.resolution) : "Closed";
}

export function itemStatusText(
    item: Pick<TrackerItem, "state" | "awaiting" | "resolution"> & Partial<Pick<TrackerItem, "kind" | "chosen_action">>,
): string {
    if (needsUser(item)) return "Needs you";
    if (item.state === "closed") {
        if (item.kind === "notice" && item.chosen_action?.toLowerCase() === "seen") return "Closed · Seen";
        return item.resolution ? `Closed · ${resolutionLabel(item.resolution)}` : "Closed";
    }
    if (item.awaiting === "agent") return "With the agent";
    return "Open";
}

/**
 * True for a consent card: an item the journal filed for a chat or spawn request, carrying a
 * `matron://consent/...` link. It closes when the request is decided and cannot be reopened.
 */
export function isConsentItem(item: Pick<TrackerItem, "links">): boolean {
    return (item.links ?? []).some((link) => typeof link?.url === "string" && link.url.startsWith("matron://consent/"));
}

/**
 * The spawn request id a consent item stands for, from its `matron://consent/spawn/<id>` link;
 * null for any other item (an agent-chat consent item included). Strict like the Apple client:
 * only the exact form the journal writes counts, with scheme and host compared case-insensitively
 * and the kind and id as written, so no query, fragment, trailing slash or extra segment. The
 * first well-formed link wins; the journal writes one.
 */
export function spawnConsentRequestId(item: Pick<TrackerItem, "links">): string | null {
    const prefix = "matron://consent/";
    for (const link of item.links ?? []) {
        const url = typeof link?.url === "string" ? link.url : "";
        if (url.slice(0, prefix.length).toLowerCase() !== prefix) continue;
        const match = /^spawn\/([^/?#]+)$/.exec(url.slice(prefix.length));
        if (match) return match[1];
    }
    return null;
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
        // A notice is closed by its Seen button; the menu offers only Dismiss for one that is moot.
        case "notice":
            return ["cancelled"];
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
        case "notice":
            return "To read";
    }
}

/** Human label for a milestone kind. */
export function milestoneKindLabel(kind: TrackerMilestoneKind): string {
    return kind === "user_input" ? "Your input" : "Progress";
}

/**
 * Relative age for a timestamp ("just now", "5m ago", "3d ago", then a short date). Epoch ms;
 * `now` injectable for tests. Null/0 → "".
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
    return dateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(ms));
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

/**
 * A status line's byline: "Updated 12m ago by an agent" / "… by you", a week or more back
 * "Updated on <date> …". Null when the status carries no time; no "by" clause when the author is
 * unknown.
 */
export function statusByline(
    updatedAt: number | null | undefined,
    by: TrackerActor | null | undefined,
    now: number = Date.now(),
): string | null {
    const when = formatRelativeTime(updatedAt, now);
    if (!when) return null;
    const phrase = when === "just now" || when.endsWith(" ago") ? when : `on ${when}`;
    const who = by === "user" ? " by you" : by === "agent" ? " by an agent" : "";
    return `Updated ${phrase}${who}`;
}

/**
 * A mission's open items in the two groups its page shows: what waits on the user ("Needs you")
 * and everything else open ("Open tasks & decisions"), each in the journal's order.
 */
export function missionItemGroups<T extends Pick<TrackerItem, "state" | "awaiting">>(
    items: readonly T[],
): { needsYou: T[]; others: T[] } {
    const needsYou: T[] = [];
    const others: T[] = [];
    for (const item of items) {
        if (item.state !== "open") continue;
        (needsUser(item) ? needsYou : others).push(item);
    }
    return { needsYou, others };
}
