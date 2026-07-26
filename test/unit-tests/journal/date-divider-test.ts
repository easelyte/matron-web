/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

import { formatDayDivider, sameCalendarDay } from "../../../src/journal/components";

// Local-component construction keeps these assertions timezone-independent: both the helper
// and the expectations read the same local calendar day.
const local = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h).getTime();

const longDate = (timestamp: number, includeYear = false): string =>
    new Intl.DateTimeFormat(
        undefined,
        includeYear ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "long" },
    ).format(new Date(timestamp));

const longWeekday = (timestamp: number): string =>
    new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(timestamp));

describe("date divider helpers", () => {
    describe("sameCalendarDay", () => {
        it("is true for two times on the same local day", () => {
            expect(sameCalendarDay(local(2026, 2, 20, 1), local(2026, 2, 20, 23))).toBe(true);
        });
        it("is false across a calendar-day boundary", () => {
            expect(sameCalendarDay(local(2026, 2, 20, 23), local(2026, 2, 21, 0))).toBe(false);
        });
    });

    describe("formatDayDivider", () => {
        it('labels today as "Today · <date>"', () => {
            const now = local(2026, 2, 20);
            const ts = local(2026, 2, 20, 8);
            expect(formatDayDivider(ts, now)).toBe(`Today · ${longDate(ts)}`);
        });
        it('labels yesterday as "Yesterday · <date>"', () => {
            const now = local(2026, 2, 20);
            const ts = local(2026, 2, 19, 8);
            expect(formatDayDivider(ts, now)).toBe(`Yesterday · ${longDate(ts)}`);
        });
        it("labels 2-6 days ago as a weekday joined to the date", () => {
            const now = local(2026, 2, 20);
            const ts = local(2026, 2, 17, 8);
            expect(formatDayDivider(ts, now)).toBe(`${longWeekday(ts)} · ${longDate(ts)}`);
        });
        it("labels older same-year timestamps as the bare date (no relative word)", () => {
            const now = local(2026, 2, 20);
            const ts = local(2026, 0, 3, 8);
            expect(formatDayDivider(ts, now)).toBe(longDate(ts));
        });
        it("includes the year for a prior-year timestamp", () => {
            const now = local(2026, 2, 20);
            const ts = local(2025, 10, 3, 8);
            expect(formatDayDivider(ts, now)).toBe(longDate(ts, true));
        });
        it("returns empty for a non-finite timestamp", () => {
            expect(formatDayDivider(Number.NaN, local(2026, 2, 20))).toBe("");
        });
    });
});
