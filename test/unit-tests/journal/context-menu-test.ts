/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { clampToViewport, nextMenuIndex } from "../../../src/journal/context-menu";

test("clamp keeps an in-bounds menu unchanged", () => {
    expect(clampToViewport(100, 100, 200, 150, 1000, 800)).toEqual({ left: 100, top: 100 });
});
test("clamp pulls a right/bottom overflow inside with 8px margin", () => {
    expect(clampToViewport(950, 780, 200, 150, 1000, 800)).toEqual({ left: 1000 - 200 - 8, top: 800 - 150 - 8 });
});
test("clamp floors at 8px on the top/left", () => {
    expect(clampToViewport(-50, -50, 100, 100, 1000, 800)).toEqual({ left: 8, top: 8 });
});
test("nextMenuIndex cycles forward and wraps", () => {
    expect(nextMenuIndex(-1, 1, 3)).toBe(0);
    expect(nextMenuIndex(2, 1, 3)).toBe(0);
});
test("nextMenuIndex cycles backward and wraps", () => {
    expect(nextMenuIndex(-1, -1, 3)).toBe(2);
    expect(nextMenuIndex(0, -1, 3)).toBe(2);
});
