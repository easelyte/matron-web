/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Pure display + filtering helpers for the Work surface. No DOM, no React, so every rule the list
// and the detail share (preview text, labels, ordering, filtering) is unit-testable on its own.

import type { WorkViewClaim, WorkViewGroup, WorkViewGroupBy, WorkViewLoop } from "../work-view";
import { oneLine } from "./format";

export type WorkLoopStatus = WorkViewLoop["status"];

/** Statuses that are set aside on purpose rather than in play. */
export const SET_ASIDE_STATUSES: ReadonlySet<WorkLoopStatus> = new Set<WorkLoopStatus>(["parked", "paused"]);

/** Status filter values. `open` (the default) is everything in play: active + blocked. */
export type WorkStatusFilter = "open" | "all" | WorkLoopStatus;

export const WORK_STATUS_ORDER: readonly WorkLoopStatus[] = ["active", "blocked", "parked", "paused"];

export interface WorkFilters {
    status: WorkStatusFilter;
    /** A domain key, or "" for every domain. */
    domain: string;
    /** Free text; matched case-insensitively against id, title, description, next step and tags. */
    query: string;
}

export const DEFAULT_WORK_FILTERS: WorkFilters = { status: "open", domain: "", query: "" };

export function statusLabel(status: WorkLoopStatus): string {
    switch (status) {
        case "active":
            return "Active";
        case "blocked":
            return "Blocked";
        case "parked":
            return "Parked";
        case "paused":
            return "Paused";
    }
}

export function statusFilterLabel(filter: WorkStatusFilter): string {
    if (filter === "open") return "In play";
    if (filter === "all") return "All statuses";
    return statusLabel(filter);
}

/** The one status that asks for attention. Rendered with the tracker's needs-you treatment. */
export function needsAttention(loop: Pick<WorkViewLoop, "status">): boolean {
    return loop.status === "blocked";
}

/**
 * Strip inline markdown so a preview line reads as prose: `**bold**` → bold, `` `code` `` → code,
 * `[text](url)` → text. Block syntax (bullets, headings, quotes) is dropped at the line start.
 * Deliberately small: previews are one ellipsised line, not a renderer.
 */
export function plainText(markdown: string): string {
    return markdown
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1");
}

/**
 * The collapsed row's summary: the description's FIRST PARAGRAPH, as plain text on one line.
 *
 * Loop descriptions are written as a standalone lead sentence, a blank line, then detail -- so the
 * first paragraph is the summary the author intended. An older single-paragraph description is its
 * own first paragraph, so nothing regresses. Flattening the whole text instead jams labels and
 * bullets into the preview, which is what made structured descriptions read worse than plain ones.
 */
export function summaryLine(description: string): string {
    const [first = ""] = description.trim().split(/\n\s*\n/, 1);
    return oneLine(plainText(first));
}

export function claimHolder(claim: WorkViewClaim): string {
    const label = claim.holder_label?.trim();
    if (label) return label;
    return `Session ${claim.convo_id.slice(0, 6) || "unknown"}`;
}

/** Advisory claim copy: a claim is a collision hint, never a lock, and the wording says so. */
export function claimCopy(claim: WorkViewClaim): string {
    const holder = claimHolder(claim);
    switch (claim.liveness) {
        case "live":
            return `${holder} appears to be on this`;
        case "stale":
            return `${holder} · looks abandoned`;
        case "unknown":
            return `${holder} · claimed — liveness unknown`;
    }
}

/** "operator" → "Operator". Owners are free-text on the wire; only the first letter is touched. */
export function ownerLabel(owner: string | undefined): string {
    const text = owner?.trim() ?? "";
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/** Epoch ms for an `opened` timestamp, or null when absent or unparseable. */
export function openedMs(loop: Pick<WorkViewLoop, "opened">): number | null {
    if (!loop.opened) return null;
    const ms = Date.parse(loop.opened);
    return Number.isNaN(ms) ? null : ms;
}

const DAY_MS = 86_400_000;

/**
 * Compact age for a meta line: "today", "3d", "5w", "4mo", "2y". Loops live for weeks, so the
 * tracker's minute-grained relative time (which switches to a calendar date after a week) would
 * make every row read as a date; an age is what you scan a backlog for.
 */
export function compactAge(ms: number | null, now: number = Date.now()): string {
    if (ms === null) return "";
    const days = Math.max(0, Math.floor((now - ms) / DAY_MS));
    if (days < 1) return "today";
    if (days < 14) return `${days}d`;
    if (days < 60) return `${Math.floor(days / 7)}w`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
}

/** Spoken form of compactAge for accessible names ("opened 3 weeks ago"). */
export function spokenAge(ms: number | null, now: number = Date.now()): string {
    const compact = compactAge(ms, now);
    if (!compact) return "";
    if (compact === "today") return "opened today";
    const match = /^(\d+)(d|w|mo|y)$/.exec(compact);
    if (!match) return "";
    const count = Number(match[1]);
    const unit = { d: "day", w: "week", mo: "month", y: "year" }[match[2] as "d" | "w" | "mo" | "y"];
    return `opened ${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** Absolute calendar date for the detail header ("Sep 1, 2026"). */
export function openedDate(ms: number | null): string {
    if (ms === null) return "";
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Within a group: priority first (P1 = most urgent, so lower number first -- the producer's ordering), then age (oldest
 * first, so long-standing work does not sink), then id. A loop without `opened` -- an older server,
 * or a store value that was not a timestamp -- sorts after every dated loop of its priority, so the
 * comparison stays a total order when dated and undated loops are mixed.
 */
export function compareLoops(a: WorkViewLoop, b: WorkViewLoop): number {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aOpened = openedMs(a) ?? Number.POSITIVE_INFINITY;
    const bOpened = openedMs(b) ?? Number.POSITIVE_INFINITY;
    if (aOpened !== bOpened) return aOpened < bOpened ? -1 : 1;
    return a.id - b.id;
}

export function matchesStatus(loop: WorkViewLoop, status: WorkStatusFilter): boolean {
    if (status === "all") return true;
    if (status === "open") return !SET_ASIDE_STATUSES.has(loop.status);
    return loop.status === status;
}

export function matchesQuery(loop: WorkViewLoop, query: string): boolean {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return true;
    const haystack = [
        `#${loop.id}`,
        loop.title,
        loop.description,
        loop.next_action ?? "",
        loop.repo,
        loop.domain,
        loop.owner ?? "",
        loop.claim ? claimHolder(loop.claim) : "",
    ]
        .join("\n")
        .toLowerCase();
    return terms.every((term) => haystack.includes(term));
}

export function matchesFilters(loop: WorkViewLoop, filters: WorkFilters): boolean {
    return (
        matchesStatus(loop, filters.status) &&
        (filters.domain === "" || loop.domain === filters.domain) &&
        matchesQuery(loop, filters.query)
    );
}

/*
 * A group as RENDERED. The wire type constrains `loops` to a non-empty tuple (the schema's
 * minItems: 1), which is a guarantee about the payload, not about a filtered view of it; filtering
 * is expressed over a plain array so the wire contract keeps its stronger shape.
 */
export interface WorkDisplayGroup {
    key: string;
    loops: WorkViewLoop[];
}

/** Filter every group, sort what is left, and drop groups the filters empty. */
export function applyFilters(groups: readonly WorkViewGroup[], filters: WorkFilters): WorkDisplayGroup[] {
    return groups
        .map((group) => ({
            key: group.key,
            loops: group.loops.filter((loop) => matchesFilters(loop, filters)).sort(compareLoops),
        }))
        .filter((group) => group.loops.length > 0);
}

export function allLoops(groups: readonly WorkViewGroup[]): WorkViewLoop[] {
    return groups.flatMap((group) => group.loops);
}

export function findLoop(groups: readonly WorkViewGroup[], id: number): WorkViewLoop | undefined {
    return allLoops(groups).find((loop) => loop.id === id);
}

/** Count per value of `pick`, for filter option labels. */
export function countBy<K extends string>(
    loops: readonly WorkViewLoop[],
    pick: (loop: WorkViewLoop) => K,
): Map<K, number> {
    const counts = new Map<K, number>();
    for (const loop of loops) counts.set(pick(loop), (counts.get(pick(loop)) ?? 0) + 1);
    return counts;
}

/** The meta dimension a row shows: whichever of repo/domain the list is NOT grouped by. */
export function otherDimension(loop: WorkViewLoop, groupBy: WorkViewGroupBy): string {
    return groupBy === "repo" ? loop.domain : loop.repo;
}
