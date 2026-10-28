/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { dateTimeFormat } from "./date-format";
import { type SessionStatus, type SessionStatusOption } from "./types";

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
    // Lowercase tolerance: a bridge may label the session limit "session" (post-#156).
    // Keep both so the label fallback (no `id`) still resolves either casing.
    session: "5h",
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
    session: "5h",
    week_fable: "fbl",
    week_all: "wk",
    host_cpu: "cpu",
    host_ram: "ram",
};

// Canonical id → grid rank. Column-first 3×2: col1 [cpu,ram], col2 [ctx,5h],
// col3 [fbl/model, wk]. Host vitals lead. Per-model
// weekly (`week_<slug>`) shares rank 4 with fbl.
const USAGE_ID_RANKS: Record<string, number> = {
    host_cpu: 0,
    host_ram: 1,
    context: 2,
    session: 3,
    week_fable: 4,
    week_all: 5,
};

// Canonical id → long accessible name. Unknown ids fall back to the raw `label`.
const USAGE_ID_LONG_LABELS: Record<string, string> = {
    context: "context",
    session: "5-hour session",
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
    // Mac thresholds (UsageMeter): <50 green, 50–79 amber, ≥80 red.
    if (percent < 50) return "low";
    if (percent < 80) return "medium";
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

/**
 * How long until a reset more than six hours off, for the box list ("in 30h", "in 3d 4h"), so
 * a box's week can be compared at a glance; "" when the reset is unknown or nearer (resetDisplay
 * already counts those down).
 */
export function resetCountdown(resetsAt: string | undefined, now = Date.now()): string {
    const ms = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
    if (!Number.isFinite(ms) || ms - now < 6 * 60 * 60_000) return "";
    const hours = Math.floor((ms - now) / (60 * 60_000));
    if (hours < 48) return `in ${hours}h`;
    const rest = hours % 24;
    return `in ${Math.floor(hours / 24)}d${rest ? ` ${rest}h` : ""}`;
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
    const weekday = dateTimeFormat("en-US", { weekday: "short" }).format(date);
    const hour = dateTimeFormat("en-US", { hour: "numeric", hour12: true })
        .format(date)
        .replaceAll(" ", "")
        .toLocaleLowerCase();
    return `${weekday} ${hour}`;
}

// True when a status update carries host CPU/RAM inside limits[] — the pre-#156 wire shape.
function suppliesLegacyHostMeters(update: SessionStatus): boolean {
    return Boolean(update.limits?.some((limit) => limit.id === "host_cpu" || limit.id === "host_ram"));
}

/**
 * `extras` across status updates. A frame that carries it wins. A frame without it is either
 * partial (keep the last known value) or a COMPLETE frame from a bridge that cannot report extras
 * (a rollback to a pre-extras build): that one must clear it, or a stale "browser tools on" would
 * outlive the process that had them. Every complete session frame from matron-bridge's
 * journalStatus carries `model_options` (an array, possibly empty); partial frames do not. When in
 * doubt this errs toward unknown (row hidden), never toward a false "on".
 */
function mergeExtras(current: SessionStatus | undefined, update: SessionStatus): string[] | undefined {
    if (update.extras !== undefined) return update.extras;
    if (Array.isArray((update as { model_options?: unknown }).model_options)) return undefined;
    return current?.extras;
}

// The /model and /effort offers are remote input. Absent (or anything that is not a list) says
// nothing, and an empty list is the agent offering nothing. A non-empty list with no readable
// entry is a garbled frame, not a statement, so it leaves the held list alone (as the desktop
// app's decoder does).
function mergeOptions(
    update: SessionStatusOption[] | undefined,
    current: SessionStatusOption[] | undefined,
): SessionStatusOption[] | undefined {
    if (!Array.isArray(update)) return current;
    const parsed = update.filter(
        (option): option is SessionStatusOption => typeof option?.value === "string" && option.value.trim() !== "",
    );
    return update.length === 0 || parsed.length > 0 ? parsed : current;
}

export function mergeSessionStatus(current: SessionStatus | undefined, update: SessionStatus): SessionStatus {
    return {
        model: update.model ?? current?.model,
        extras: mergeExtras(current, update),
        workdir: update.workdir ?? current?.workdir,
        context: update.context ?? current?.context,
        limits: update.limits ?? current?.limits,
        // Host vitals ride the status frame at top level; carry them through the same
        // last-known-wins merge as the other fields, or a partial frame (e.g. a limits-only
        // repaint) blanks the CPU/RAM meters until the next full one.
        //
        // The one exception is a producer switching back to the legacy contract: an update that
        // supplies host meters INSIDE limits[] and no top-level `vitals` is a bridge asserting
        // pre-#156 behaviour (a rollback, or one that never sent vitals). Retaining the previous
        // reading there would let it outlive the producer that made it and mask every newer
        // legacy sample indefinitely — the meters would freeze at their pre-rollback values.
        // Dropping it hands the meters back to limits[], whether or not those entries happen to
        // carry a `sampled_at_ms` to be ranked on. Note this cannot misfire during the forward
        // deploy window: a bridge that sends both still sets `update.vitals`, which is used.
        vitals: update.vitals ?? (suppliesLegacyHostMeters(update) ? undefined : current?.vitals),
        email: update.email ?? current?.email,
        // Effort is tri-state on the wire: a string sets it, an explicit null is the bridge
        // disowning the level it was tracking, and an absent key leaves the held value alone.
        effort: "effort" in update ? (update.effort ?? undefined) : current?.effort,
        model_options: mergeOptions(update.model_options, current?.model_options),
        effort_levels: mergeOptions(update.effort_levels, current?.effort_levels),
    };
}

const ONE_MILLION = 1_000_000;

/** The model family a model id or alias names ("opus", "sonnet"…), or the bare id. */
function modelFamily(model: string | undefined): string {
    const id = (model ?? "")
        .toLowerCase()
        .replace(/\[1m\]/g, "")
        .replace(/-\d{8}$/, "");
    return /\b(opus|sonnet|haiku|fable|mythos)\b/.exec(id.replace(/[-_]/g, " "))?.[1] ?? id;
}

/**
 * A helper's own context gauge (a Claude subagent's child conversation). Bridges up to
 * size a subagent's window from the bare API model id its transcript carries
 * (`claude-opus-5-5`), which never has the `[1m]` marker, so a subagent running in its
 * parent's 1M window read 200k and pinned the bar at 100% in red. Corrected here, from data
 * the frame already carries:
 *   - more tokens than the reported window proves the window is the larger one (1M);
 *   - a subagent on the parent's model family inherits the parent's (larger) window.
 * A different-family subagent (haiku under an opus[1m] parent) keeps its own window.
 */
export function helperContextStatus(
    child: SessionStatus | undefined,
    parent: SessionStatus | undefined,
): SessionStatus | undefined {
    const context = child?.context;
    if (!child || !context || !(context.tokens > 0)) return child;
    let window = context.window > 0 ? context.window : ONE_MILLION;
    if (context.tokens > window) window = ONE_MILLION;
    const parentWindow = parent?.context?.window ?? 0;
    if (parentWindow > window && (!child.model || modelFamily(child.model) === modelFamily(parent?.model)))
        window = parentWindow;
    if (window === context.window) return child;
    return {
        ...child,
        context: { tokens: context.tokens, window, pct: Math.min(100, Math.round((context.tokens / window) * 100)) },
    };
}

// "opus" / "opus · high": the session's model with its effort level beside it, as the Mac
// header's model line. An unknown effort adds nothing (no separator, no placeholder): the
// bridge publishes no effort rather than a guess, so absent is the normal state.
export function modelLine(model: string, effort: string | null | undefined): string {
    const level = effort?.trim();
    return level ? `${model} · ${level}` : model;
}

// Absolute context size (tokens) past which the chat offers to compact. Absolute, not a
// fraction of the window: the concern is cost, latency and recall at large sizes, which a
// 1M-window model shares. Same threshold as the Apple clients.
export const COMPACT_NUDGE_TOKENS = 400_000;

// No status frame yet, and exactly-at-threshold, do not nudge; strictly above does.
export function shouldNudgeCompact(context: SessionStatus["context"]): boolean {
    return context !== undefined && context.tokens > COMPACT_NUDGE_TOKENS;
}

export function compactNudgeTitle(tokens: number): string {
    return `Large conversation (${compactTokens(tokens)})`;
}

// Screen-reader variant of compactTokens: "265 thousand", "1.2 million".
export function spokenTokens(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)} thousand`;
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${millions.toLocaleString("en-US", { maximumFractionDigits: 1 })} million`;
}
