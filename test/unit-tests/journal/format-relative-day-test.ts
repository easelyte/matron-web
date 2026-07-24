/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

import { formatRelativeDay } from "../../../src/journal/components";

let originalTZ: string | undefined;

const formatClock = (timestamp: number): string =>
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));

const formatWeekday = (timestamp: number): string =>
    new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(timestamp));

const formatDate = (timestamp: number, includeYear = false): string =>
    new Intl.DateTimeFormat(
        undefined,
        includeYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" },
    ).format(new Date(timestamp));

describe("formatRelativeDay", () => {
    beforeAll(() => {
        originalTZ = process.env.TZ;
    });

    beforeEach(() => {
        process.env.TZ = "UTC";
    });

    afterEach(() => {
        if (originalTZ === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTZ;
        }
    });

    it("formats a same-day timestamp as a clock time", () => {
        const now = Date.UTC(2026, 2, 20, 12);
        const timestamp = Date.UTC(2026, 2, 20, 8, 30);

        expect(formatRelativeDay(timestamp, now)).toBe(formatClock(timestamp));
    });

    it.each([1, 6])("formats a timestamp %i calendar days ago as a weekday", (daysAgo) => {
        const now = Date.UTC(2026, 2, 20, 12);
        const timestamp = Date.UTC(2026, 2, 20 - daysAgo, 8, 30);

        expect(formatRelativeDay(timestamp, now)).toBe(formatWeekday(timestamp));
    });

    it("formats a timestamp exactly seven calendar days ago as a date", () => {
        const now = Date.UTC(2026, 2, 20, 12);
        const timestamp = Date.UTC(2026, 2, 13, 8, 30);

        expect(formatRelativeDay(timestamp, now)).toBe(formatDate(timestamp));
    });

    it("formats an older same-year timestamp without a year", () => {
        const now = Date.UTC(2026, 2, 20, 12);
        const timestamp = Date.UTC(2026, 1, 1, 8, 30);

        expect(formatRelativeDay(timestamp, now)).toBe(formatDate(timestamp));
    });

    it("formats a prior-year timestamp with its year", () => {
        const now = Date.UTC(2026, 2, 20, 12);
        const timestamp = Date.UTC(2025, 11, 31, 8, 30);

        expect(formatRelativeDay(timestamp, now)).toBe(formatDate(timestamp, true));
    });

    it("formats a future timestamp on the same day as a clock time", () => {
        const now = Date.UTC(2026, 2, 20, 12);
        const timestamp = Date.UTC(2026, 2, 20, 18, 30);

        expect(formatRelativeDay(timestamp, now)).toBe(formatClock(timestamp));
    });

    it("formats a timestamp on tomorrow or later as a date", () => {
        const now = Date.UTC(2026, 2, 20, 12);
        const timestamp = Date.UTC(2026, 2, 21, 8, 30);

        expect(formatRelativeDay(timestamp, now)).toBe(formatDate(timestamp));
        expect(formatRelativeDay(timestamp, now)).not.toBe(formatClock(timestamp));
    });

    it.each([Number.POSITIVE_INFINITY, Number.NaN])(
        "returns an empty string for non-finite timestamp %p",
        (timestamp) => {
            const now = Date.UTC(2026, 2, 20, 12);

            expect(formatRelativeDay(timestamp, now)).toBe("");
        },
    );

    it("returns an empty string without throwing for an invalid Date", () => {
        const now = Date.UTC(2026, 2, 20, 12);

        expect(() => formatRelativeDay(Number.MAX_VALUE, now)).not.toThrow();
        expect(formatRelativeDay(Number.MAX_VALUE, now)).toBe("");
    });

    it("treats seven calendar days across spring-forward as a dated label", () => {
        process.env.TZ = "America/New_York";
        const now = new Date(2026, 2, 15, 12).getTime();
        const timestamp = new Date(2026, 2, 8, 12).getTime();

        expect(formatRelativeDay(timestamp, now)).toBe(formatDate(timestamp));
        expect(formatRelativeDay(timestamp, now)).not.toBe(formatWeekday(timestamp));
    });
});
