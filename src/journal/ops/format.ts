/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/* Number and time formatting for the Ops page. Pure; `now` is always passed in so tests and the
   shared minute clock agree. */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1024-based, one decimal under 10 of a unit, none above: "812 MB", "3.4 GB", "92 GB". */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = unit === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Compact counts: 950, 12.4k, 3.1M, 1.2B. */
export function formatCount(n: number): string {
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (abs < 1000) return String(Math.round(n));
    const steps: [number, string][] = [
        [1e9, "B"],
        [1e6, "M"],
        [1e3, "k"],
    ];
    for (const [size, suffix] of steps) {
        if (abs >= size) {
            const v = n / size;
            return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
        }
    }
    return String(n);
}

/** "$0.42", "$12.30", "$1,284". Cents under $100, whole dollars above. */
export function formatUsd(v: number): string {
    if (!Number.isFinite(v)) return "—";
    if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString("en-US")}`;
    return `$${v.toFixed(2)}`;
}

/** Duration in seconds → "45s", "12m", "3h 20m", "4d 6h". */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Past or future relative time: "just now", "4m ago", "in 2h", "3d ago". */
export function formatRelative(ms: number, now: number): string {
    const delta = ms - now;
    const abs = Math.abs(delta);
    if (abs < 45_000) return "just now";
    const text = formatDuration(abs / 1000).split(" ")[0];
    return delta < 0 ? `${text} ago` : `in ${text}`;
}

/** Timer interval in seconds → "every 15m", "hourly", "daily", "weekly". */
export function formatInterval(seconds: number | null): string | null {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
    if (seconds === 3600) return "hourly";
    if (seconds === 86_400) return "daily";
    if (seconds === 604_800) return "weekly";
    return `every ${formatDuration(seconds)}`;
}

/** Percent used of a total → integer 0..100, or null. */
export function usedPercent(free: number, total: number): number | null {
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100)));
}

/** "Session" → "5-hour"-style short names the bridge already sends are kept; only the Claude ids
 *  the bridge emits get friendlier labels on this page. */
export function limitLabel(id: string, label: string): string {
    if (id === "session") return "5-hour";
    if (id === "week_all") return "Week";
    const codex = /^Codex · (.+)$/.exec(label);
    if (codex) return codex[1];
    const week = /^Week \((.+)\)$/.exec(label);
    if (week) return `Week · ${week[1]}`;
    return label;
}

/** Severity → rank and tone. P0/P1 critical, P2 warn, else info. */
export function severityTone(severity: string): "critical" | "warn" | "info" {
    const s = severity.toUpperCase();
    if (s === "P0" || s === "P1" || s === "CRITICAL" || s === "HIGH" || s === "RED") return "critical";
    if (s === "P2" || s === "WARN" || s === "WARNING" || s === "MEDIUM" || s === "YELLOW") return "warn";
    return "info";
}
