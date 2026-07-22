/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { CLAUDE_BRIDGE_COMMANDS, filterCommands, isCommandMode } from "../../../src/journal/slash-palette";

describe("CLAUDE_BRIDGE_COMMANDS", () => {
    it("contains the 22 operator-facing bridge commands", () => {
        expect(CLAUDE_BRIDGE_COMMANDS).toHaveLength(22);
    });
});

describe("filterCommands", () => {
    it("returns all commands for empty or prefix-only input", () => {
        expect(filterCommands(CLAUDE_BRIDGE_COMMANDS, "")).toEqual(CLAUDE_BRIDGE_COMMANDS);
        expect(filterCommands(CLAUDE_BRIDGE_COMMANDS, "/")).toEqual(CLAUDE_BRIDGE_COMMANDS);
    });

    it("matches command prefixes and excludes non-matches", () => {
        expect(filterCommands(CLAUDE_BRIDGE_COMMANDS, "/sta").map(({ trigger }) => trigger)).toEqual([
            "/start",
            "/status",
        ]);
        expect(filterCommands(CLAUDE_BRIDGE_COMMANDS, "/zzz")).toEqual([]);
    });

    it("accepts a bang prefix and matches case-insensitively", () => {
        expect(filterCommands(CLAUDE_BRIDGE_COMMANDS, "!STA").map(({ trigger }) => trigger)).toEqual([
            "/start",
            "/status",
        ]);
    });

    it("strips leading whitespace before filtering", () => {
        const withWhitespace = filterCommands(CLAUDE_BRIDGE_COMMANDS, "  !s");
        expect(withWhitespace).toEqual(filterCommands(CLAUDE_BRIDGE_COMMANDS, "!s"));
        expect(withWhitespace).not.toHaveLength(0);
    });
});

describe("isCommandMode", () => {
    it.each([
        ["/start", true],
        ["/start x", false],
        ["  !s", true],
        ["hello", false],
        ["/", true],
    ])("returns %s for %j", (input, expected) => {
        expect(isCommandMode(input)).toBe(expected);
    });
});
