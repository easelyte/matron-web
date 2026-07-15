/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    compactTokens,
    mergeSessionStatus,
    resetDisplay,
    usageBarLabel,
    usageLevel,
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

    it("formats nearby reset times as compact countdowns", () => {
        const now = Date.parse("2026-07-15T08:00:00Z");
        expect(resetDisplay("2026-07-15T08:00:30Z", undefined, now)).toBe("now");
        expect(resetDisplay("2026-07-15T08:45:00Z", undefined, now)).toBe("45m");
        expect(resetDisplay("2026-07-15T11:20:00Z", undefined, now)).toBe("3h20");
        expect(resetDisplay(undefined, "soon", now)).toBe("soon");
    });

    it("uses the same green, amber, and red usage thresholds", () => {
        expect([usageLevel(49), usageLevel(50), usageLevel(79), usageLevel(80)]).toEqual([
            "low",
            "medium",
            "medium",
            "high",
        ]);
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
