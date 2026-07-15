/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type SessionStatus } from "./types";

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

export function usageLevel(percent: number): "low" | "medium" | "high" {
    if (percent < 50) return "low";
    if (percent < 80) return "medium";
    return "high";
}

export function resetDisplay(resetsAt: string | undefined, fallback: string | undefined, now = Date.now()): string {
    if (!resetsAt) return fallback ?? "";

    const resetTime = Date.parse(resetsAt);
    if (!Number.isFinite(resetTime)) return fallback ?? "";

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
        context: update.context ?? current?.context,
        limits: update.limits ?? current?.limits,
        email: update.email ?? current?.email,
    };
}
