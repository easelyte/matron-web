/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { copyText } from "../../../src/journal/clipboard";

test("copyText awaits clipboard and returns true", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
});

test("copyText falls back to execCommand on rejection and returns true", async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error("denied")) } });
    const exec = jest.fn().mockReturnValue(true);
    (document as any).execCommand = exec;
    await expect(copyText("hello")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelectorAll("textarea").length).toBe(0);
});

test("copyText returns false when both paths fail, without throwing, and cleans up the textarea", async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error("x")) } });
    (document as any).execCommand = jest.fn(() => {
        throw new Error("nope");
    });
    await expect(copyText("hello")).resolves.toBe(false);
    expect(document.querySelectorAll("textarea").length).toBe(0);
});
