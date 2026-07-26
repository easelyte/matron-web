/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    compactTokens,
    mergeSessionStatus,
    normalizePercent,
    resetDisplay,
    usageAccessibleLabel,
    usageBarLabel,
    usageLevel,
    usageOrderRank,
    usageShortLabel,
    worstLimit,
} from "../../../src/journal/status";

describe("journal session status presentation", () => {
    it("matches the Apple client's compact token and limit labels", () => {
        expect([
            compactTokens(999),
            compactTokens(265_400),
            compactTokens(1_000_000),
            compactTokens(1_500_000),
        ]).toEqual(["999", "265k", "1m", "1.5m"]);
        expect(usageBarLabel("Session")).toBe("Session");
        expect(usageBarLabel("Week (all models)")).toBe("Week");
        expect(usageBarLabel("Week (Sonnet 5)")).toBe("Sonnet 5");
    });

    it("bakes fixed short usage labels (v5 relabel map) with a per-model fallback", () => {
        // Label-only fallback path (no id) — older/cached frames.
        expect(usageShortLabel({ label: "Session" })).toBe("5h");
        expect(usageShortLabel({ label: "Week (all models)" })).toBe("wk");
        expect(usageShortLabel({ label: "Week" })).toBe("wk");
        expect(usageShortLabel({ label: "fable" })).toBe("fbl");
        // per-model weekly → 3-char model tag, never truncated in the 24px column
        expect(usageShortLabel({ label: "Week (Sonnet 5)" })).toBe("son");
        expect(usageShortLabel({ label: "Week (Opus 4.8)" })).toBe("opu");
        // unknown → heuristic fallback
        expect(usageShortLabel({ label: "Custom limit" })).toBe("Custom limit");
    });

    it("prefers the stable id for the short tag, retiring the relabel map", () => {
        // id wins over label; a mislabelled server label doesn't matter.
        expect(usageShortLabel({ id: "context", label: "anything" })).toBe("ctx");
        expect(usageShortLabel({ id: "session_5h", label: "Session" })).toBe("5h");
        expect(usageShortLabel({ id: "week_fable", label: "Week (Fable)" })).toBe("fbl");
        expect(usageShortLabel({ id: "week_all", label: "Week (all models)" })).toBe("wk");
        expect(usageShortLabel({ id: "host_cpu", label: "Host CPU" })).toBe("cpu");
        expect(usageShortLabel({ id: "host_ram", label: "Host RAM" })).toBe("ram");
        // week_<model> → first 3 chars of the slug, lowercase
        expect(usageShortLabel({ id: "week_sonnet_5", label: "Week (Sonnet 5)" })).toBe("son");
        expect(usageShortLabel({ id: "week_opus", label: "Week (Opus)" })).toBe("opu");
        // unknown id → fall through to the label heuristic
        expect(usageShortLabel({ id: "mystery", label: "Session" })).toBe("5h");
    });

    it("maps id → long accessible name, falling back to the raw label", () => {
        expect(usageAccessibleLabel({ id: "context", label: "context" })).toBe("context");
        expect(usageAccessibleLabel({ id: "session_5h", label: "Session" })).toBe("5-hour session");
        expect(usageAccessibleLabel({ id: "week_all", label: "Week (all models)" })).toBe("weekly, all models");
        expect(usageAccessibleLabel({ id: "week_fable", label: "Week (Fable)" })).toBe("weekly, Fable");
        expect(usageAccessibleLabel({ id: "host_cpu", label: "Host CPU" })).toBe("host CPU");
        expect(usageAccessibleLabel({ id: "host_ram", label: "Host RAM" })).toBe("host RAM");
        // unknown id + no id → raw label
        expect(usageAccessibleLabel({ id: "week_sonnet_5", label: "Week (Sonnet 5)" })).toBe("Week (Sonnet 5)");
        expect(usageAccessibleLabel({ label: "Session" })).toBe("Session");
    });

    it("ranks usage meters into the design's column-first grid order", () => {
        // id path: cpu/ram | ctx/5h | fbl/model,wk (host vitals lead, #529 follow-up)
        const byId = [
            { id: "host_ram", label: "Host RAM" },
            { id: "week_all", label: "Week (all models)" },
            { id: "week_sonnet_5", label: "Week (Sonnet 5)" },
            { id: "host_cpu", label: "Host CPU" },
            { id: "session_5h", label: "Session" },
            { id: "week_fable", label: "Week (Fable)" },
            { id: "context", label: "context" },
        ];
        // fbl and week_<model> both hold rank 4 → their relative order is the stable
        // input order (week_sonnet_5 precedes week_fable here).
        expect([...byId].sort((a, b) => usageOrderRank(a) - usageOrderRank(b)).map((m) => m.id)).toEqual([
            "host_cpu",
            "host_ram",
            "context",
            "session_5h",
            "week_sonnet_5",
            "week_fable",
            "week_all",
        ]);

        // Unknown ids sort last, after every known meter.
        expect(usageOrderRank({ id: "mystery", label: "Mystery" })).toBe(6);

        // label-only fallback path (frames lacking ids): host vitals never appear label-only
        // (they always carry ids), so ctx leads the fallback set → ctx/5h/model/wk.
        const byLabel = [
            { label: "Week (all models)" },
            { label: "Week (Sonnet 5)" },
            { label: "Session" },
            { label: "context" },
        ];
        expect([...byLabel].sort((a, b) => usageOrderRank(a) - usageOrderRank(b)).map((m) => m.label)).toEqual([
            "context",
            "Session",
            "Week (Sonnet 5)",
            "Week (all models)",
        ]);
    });

    it("formats nearby reset times as compact countdowns from ISO strings or epoch ms", () => {
        const now = Date.parse("2026-07-15T08:00:00Z");
        expect(resetDisplay("2026-07-15T08:00:30Z", undefined, now)).toBe("now");
        expect(resetDisplay("2026-07-15T08:45:00Z", undefined, now)).toBe("45m");
        expect(resetDisplay("2026-07-15T11:20:00Z", undefined, now)).toBe("3h20");
        expect(resetDisplay(undefined, "soon", now)).toBe("soon");
        // Epoch-ms (new bridge) is accepted identically to the ISO string above.
        expect(resetDisplay(Date.parse("2026-07-15T08:45:00Z"), undefined, now)).toBe("45m");
        expect(resetDisplay(Date.parse("2026-07-15T11:20:00Z"), undefined, now)).toBe("3h20");
        // Empty string / NaN fall back.
        expect(resetDisplay("", "later", now)).toBe("later");
        expect(resetDisplay(Number.NaN, "later", now)).toBe("later");
    });

    it("prefers the resets_at_ms epoch-ms field over the resets_at ISO string", () => {
        const now = Date.parse("2026-07-15T08:00:00Z");
        const ms = Date.parse("2026-07-15T08:45:00Z"); // → 45m
        // resets_at_ms (4th arg) wins even when resets_at points elsewhere.
        expect(resetDisplay("2026-07-15T11:20:00Z", undefined, now, ms)).toBe("45m");
        // ...and works when resets_at is absent entirely.
        expect(resetDisplay(undefined, undefined, now, ms)).toBe("45m");
        // Non-finite resets_at_ms is ignored → falls back to the resets_at string.
        expect(resetDisplay("2026-07-15T08:45:00Z", undefined, now, Number.NaN)).toBe("45m");
        // Neither field usable → fallback string.
        expect(resetDisplay(undefined, "soon", now, Number.NaN)).toBe("soon");
    });

    it("skips a finite-but-out-of-range resets_at_ms instead of throwing on Invalid Date", () => {
        const now = Date.parse("2026-07-15T08:00:00Z");
        // Number.MAX_VALUE is finite but builds an Invalid Date → Intl.format would throw.
        // The guard skips it and falls through to the valid resets_at ISO string.
        expect(() => resetDisplay("2026-07-15T08:45:00Z", "soon", now, Number.MAX_VALUE)).not.toThrow();
        expect(resetDisplay("2026-07-15T08:45:00Z", "soon", now, Number.MAX_VALUE)).toBe("45m");
        // No lower-priority date candidate → textual `resets` fallback, still no throw.
        expect(resetDisplay(undefined, "soon", now, Number.MAX_VALUE)).toBe("soon");
        // An out-of-range resets_at number is likewise skipped for the fallback.
        expect(resetDisplay(Number.MAX_VALUE, "soon", now)).toBe("soon");
    });

    it("uses the same green, amber, and red usage thresholds", () => {
        expect([usageLevel(49), usageLevel(50), usageLevel(84), usageLevel(85)]).toEqual([
            "low",
            "medium",
            "medium",
            "high",
        ]);
    });

    it("normalizes finite percentages without hiding unknown values", () => {
        expect(normalizePercent(NaN)).toBeNull();
        expect(normalizePercent(Infinity)).toBeNull();
        expect(normalizePercent(-Infinity)).toBeNull();
        expect(normalizePercent(-5)).toBe(0);
        expect(normalizePercent(150)).toBe(100);
        expect(normalizePercent(42.4)).toBe(42.4);
    });

    it("returns the first worst finite limit and ignores unknown values", () => {
        expect(worstLimit([])).toBeUndefined();
        expect(worstLimit([{ label: "unknown", percent: NaN }])).toBeUndefined();

        const mixed = [
            { label: "a", percent: NaN },
            { label: "b", percent: 10 },
        ];
        expect(worstLimit(mixed)).toBe(mixed[1]);

        const tied = [
            { label: "first", percent: 80 },
            { label: "second", percent: 80 },
        ];
        expect(worstLimit(tied)).toBe(tied[0]);
    });

    it("retains fields omitted by partial status updates", () => {
        expect(
            mergeSessionStatus(
                {
                    model: "claude-fable-5",
                    context: { tokens: 100, window: 1_000, pct: 10 },
                    email: "agent@example.com",
                },
                { limits: [{ label: "Session", percent: 39, resets: "soon" }] },
            ),
        ).toEqual({
            model: "claude-fable-5",
            context: { tokens: 100, window: 1_000, pct: 10 },
            limits: [{ label: "Session", percent: 39, resets: "soon" }],
            email: "agent@example.com",
        });
    });
});
