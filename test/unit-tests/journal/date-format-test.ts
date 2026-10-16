/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { dateTimeFormat } from "../../../src/journal/date-format";

describe("dateTimeFormat", () => {
    const when = new Date(Date.UTC(2026, 8, 14, 15, 30));

    it("reuses one formatter for the same locale and options", () => {
        const first = dateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
        expect(dateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).toBe(first);
    });

    it("keeps formatters for different options or locales apart", () => {
        const short = dateTimeFormat("en-US", { weekday: "short" });
        expect(dateTimeFormat("en-US", { weekday: "long" })).not.toBe(short);
        expect(dateTimeFormat("de-DE", { weekday: "short" })).not.toBe(short);
    });

    it("formats exactly as a new Intl.DateTimeFormat does", () => {
        const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
        expect(dateTimeFormat("en-GB", options).format(when)).toBe(
            new Intl.DateTimeFormat("en-GB", options).format(when),
        );
        expect(dateTimeFormat(undefined, { weekday: "long" }).format(when)).toBe(
            new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(when),
        );
    });

    it("builds a fresh formatter after the time zone offset changes", () => {
        const offset = jest.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
        const before = dateTimeFormat(undefined, { hour: "numeric" });
        offset.mockReturnValue(-120);
        expect(dateTimeFormat(undefined, { hour: "numeric" })).not.toBe(before);
        offset.mockRestore();
    });
});
