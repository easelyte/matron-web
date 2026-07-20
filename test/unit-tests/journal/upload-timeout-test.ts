/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { uploadTimeoutMsFor } from "../../../src/journal/client";

describe("uploadTimeoutMsFor", () => {
    it("uses the 60s base for small files", () => {
        expect(uploadTimeoutMsFor(0)).toBe(60_000);
        expect(uploadTimeoutMsFor(1_000_000)).toBe(60_000); // 1MB -> base
    });
    it("scales past the base so a 50MB upload on a slow uplink cannot deterministically time out", () => {
        // 50MB over ~5 Mbit/s transfers in ~84s — the old fixed 60s always failed it.
        const ms = uploadTimeoutMsFor(50 * 1024 * 1024);
        expect(ms).toBeGreaterThan(84_000);
    });
    it("caps a huge file at 15 minutes (still bounds a stuck upload)", () => {
        expect(uploadTimeoutMsFor(512 * 1024 * 1024)).toBe(15 * 60_000);
    });
    it("treats non-finite/negative sizes as the base (no NaN deadline)", () => {
        expect(uploadTimeoutMsFor(Number.NaN)).toBe(60_000);
        expect(uploadTimeoutMsFor(-5)).toBe(60_000);
    });
});
