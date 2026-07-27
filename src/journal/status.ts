/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type SessionStatus } from "./types";

export function normalizePercent(p: number): number | null {
    return Number.isFinite(p) ? Math.min(Math.max(p, 0), 100) : null;
}

export function worstLimit(
    limits: NonNullable<SessionStatus["limits"]>,
): NonNullable<SessionStatus["limits"]>[number] | undefined {
    let worst: NonNullable<SessionStatus["limits"]>[number] | undefined;
    let worstPercent = -Infinity;

    for (const limit of limits) {
        const percent = normalizePercent(limit.percent);
        if (percent !== null && percent > worstPercent) {
            worst = limit;
            worstPercent = percent;
        }
    }

    return worst;
}

export function compactTokens(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;

    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${millions.toLocaleString("en-US", { maximumFractionDigits: 1 })}m`;
}

export function usageBarLabel(label: string): string {
    const trimmed = label.trim();
    const match = trimmed.match(/\(([^()]*)\)$/);
    if (!match) return trimmed;

    const parenthesized = match[1].trim();
    if (!parenthesized) return trimmed;
    return parenthesized.toLocaleLowerCase() === "all models" ? trimmed.slice(0, match.index).trim() : parenthesized;
}

// v5 usage relabel map (design-tokens components.usageMeter.labelMap): the bridge
// sends long limit labels ("Session", "Week (all models)", "fable") that truncate in
// the 24px meter column. Bake fixed short strings client-side; unknown labels fall
// through to the usageBarLabel() heuristic so a new limit still renders a sensible tag.
const USAGE_SHORT_LABELS: Record<string, string> = {
    context: "ctx",
    Session: "5h",
    "Week (all models)": "wk",
    Week: "wk",
    fable: "fbl",
};

const WEEK_PER_MODEL = /^Week \((.+)\)$/i;

// A limit-ish argument: the label/short-tag/rank/a11y functions prefer the stable `id`
// when present and fall back to the human `label` for older/cached frames.
export type UsageMeterLike = { id?: string; label: string };

// Canonical id → short tag. Owns the id path; retires the label relabel-map for it.
const USAGE_ID_SHORT_LABELS: Record<string, string> = {
    context: "ctx",
    session_5h: "5h",
    week_fable: "fbl",
    week_all: "wk",
    host_cpu: "cpu",
    host_ram: "ram",
};

// Canonical id → grid rank. Column-first 3×2: col1 [cpu,ram], col2 [ctx,5h],
// col3 [fbl/model, wk]. Host vitals lead (leftmost column, #529 follow-up). Per-model
// weekly (`week_<slug>`) shares rank 4 with fbl.
const USAGE_ID_RANKS: Record<string, number> = {
    host_cpu: 0,
    host_ram: 1,
    context: 2,
    session_5h: 3,
    week_fable: 4,
    week_all: 5,
};

// Canonical id → long accessible name. Unknown ids fall back to the raw `label`.
const USAGE_ID_LONG_LABELS: Record<string, string> = {
    context: "context",
    session_5h: "5-hour session",
    week_all: "weekly, all models",
    week_fable: "weekly, Fable",
    host_cpu: "host CPU",
    host_ram: "host RAM",
};

const WEEK_ID = /^week_(.+)$/;

// Label-only short tag (fallback when no `id`): the pre-v5 relabel-map heuristic.
function usageShortLabelFromLabel(label: string): string {
    const trimmed = label.trim();
    const mapped = USAGE_SHORT_LABELS[trimmed];
    if (mapped) return mapped;
    // Per-model weekly limits ("Week (Sonnet 5)", "Week (Opus 4.8)") occupy the design's
    // model-weekly slot; abbreviate to a 3-char tag so they fit the 24px meter column
    // instead of truncating ("Son…"). "all models" is the aggregate week (handled above).
    const perModel = trimmed.match(WEEK_PER_MODEL);
    if (perModel && perModel[1].trim().toLocaleLowerCase() !== "all models") {
        return perModel[1].trim().slice(0, 3).toLocaleLowerCase();
    }
    return usageBarLabel(trimmed);
}

export function usageShortLabel(meter: UsageMeterLike): string {
    if (meter.id) {
        const mapped = USAGE_ID_SHORT_LABELS[meter.id];
        if (mapped) return mapped;
        // `week_<model>` (not week_all / week_fable, both mapped above) → 3-char model tag.
        const week = meter.id.match(WEEK_ID);
        if (week) return week[1].slice(0, 3).toLocaleLowerCase();
        // Unknown id → fall through to the label heuristic below.
    }
    return usageShortLabelFromLabel(meter.label);
}

// Long accessible name (SR): keyed off `id` when present, else the raw server `label`.
export function usageAccessibleLabel(meter: UsageMeterLike): string {
    if (meter.id) {
        const mapped = USAGE_ID_LONG_LABELS[meter.id];
        if (mapped) return mapped;
    }
    return meter.label;
}

// Canonical column-first grid order. The bridge sends limits in arbitrary order, so
// normalise before rendering; prefer the stable `id`, fall back to the label heuristic.
export function usageOrderRank(meter: UsageMeterLike): number {
    if (meter.id) {
        const rank = USAGE_ID_RANKS[meter.id];
        if (rank !== undefined) return rank;
        if (WEEK_ID.test(meter.id)) return 4; // per-model weekly shares the fbl column
        return 6; // unknown id sorts last
    }
    const trimmed = meter.label.trim();
    if (trimmed === "ctx" || trimmed === "context") return 2;
    if (trimmed === "Session") return 3;
    if (trimmed === "Week" || /^Week \(all models\)$/i.test(trimmed)) return 5;
    if (WEEK_PER_MODEL.test(trimmed)) return 4;
    return 6;
}

export function usageLevel(percent: number): "low" | "medium" | "high" {
    // Redesign-v4 thresholds: <50 green, 50–84 amber, ≥85 red.
    if (percent < 50) return "low";
    if (percent < 85) return "medium";
    return "high";
}

// Host-vitals staleness threshold. The bridge samples host cpu/ram on a 15s cadence but
// only PUBLISHES on turn-end (and replays the last frame verbatim to new viewers), so on an
// idle conversation a host reading can be minutes/hours old while displaying as current.
// 60s = 4× the 15s sample cadence: comfortably past one publish window without flapping on a
// single skipped tick. Only meters carrying `sampled_at_ms` (host_cpu / host_ram) are aged;
// ctx/5h/wk/fbl have none → never stale.
export const HOST_VITALS_STALE_MS = 60_000;

// Age (ms) of a meter's last real sample, or null when the meter carries no `sampled_at_ms`
// (older bridge, or a non-host meter → no staleness logic). Clamped at 0 so a sample stamped
// slightly ahead of the client clock never reports a negative age.
export function sampleAgeMs(sampledAtMs: number | undefined, now: number): number | null {
    if (sampledAtMs === undefined || !Number.isFinite(sampledAtMs)) return null;
    return Math.max(0, now - sampledAtMs);
}

// True when a host reading is old enough to be misleading if shown as live.
export function isSampleStale(sampledAtMs: number | undefined, now: number): boolean {
    const age = sampleAgeMs(sampledAtMs, now);
    return age !== null && age > HOST_VITALS_STALE_MS;
}

// Human age for the accessible name / hover title, e.g. "3m ago", "2h ago", "1d ago".
// Called only for stale samples (age > 60s), so sub-minute rendering is unreachable; the
// "just now" arm is a defensive floor, not a real display state.
export function formatSampleAge(ageMs: number): string {
    if (ageMs < 60_000) return "just now";
    if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m ago`;
    if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))}h ago`;
    return `${Math.floor(ageMs / (24 * 60 * 60_000))}d ago`;
}

export function resetDisplay(
    resetsAt: string | number | undefined,
    fallback: string | undefined,
    now = Date.now(),
    resetsAtMs?: number,
): string {
    // Try reset candidates in priority order: the NEW epoch-ms field (`resets_at_ms`), then
    // `resets_at` (ISO string, or a number belt-and-suspenders). A candidate that yields an
    // out-of-range Date (e.g. Number.MAX_VALUE → Invalid Date, which Intl.format throws a
    // RangeError on) is SKIPPED so a usable lower-priority candidate — or the textual
    // `resets` fallback — still wins instead of crashing the UsageCluster render.
    for (const candidate of [resetsAtMs, resetsAt] as Array<string | number | undefined>) {
        if (candidate === undefined || candidate === null || candidate === "") continue;
        const ms = typeof candidate === "number" ? candidate : Date.parse(candidate);
        // Number.isFinite rejects NaN; the Date round-trip rejects finite-but-out-of-range
        // epochs (|ms| > 8.64e15 → getTime() is NaN) before they reach Intl formatting.
        if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) continue;
        return renderReset(ms, now);
    }
    return fallback ?? "";
}

function renderReset(resetTime: number, now: number): string {
    const interval = resetTime - now;
    if (interval < 60_000) return "now";

    const totalMinutes = Math.floor(interval / 60_000);
    if (interval < 60 * 60_000) return `${totalMinutes}m`;
    if (interval < 6 * 60 * 60_000) {
        return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, "0")}`;
    }

    const date = new Date(resetTime);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
    const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true })
        .format(date)
        .replaceAll(" ", "")
        .toLocaleLowerCase();
    return `${weekday} ${hour}`;
}

export function mergeSessionStatus(current: SessionStatus | undefined, update: SessionStatus): SessionStatus {
    return {
        model: update.model ?? current?.model,
        workdir: update.workdir ?? current?.workdir,
        context: update.context ?? current?.context,
        limits: update.limits ?? current?.limits,
        email: update.email ?? current?.email,
    };
}
