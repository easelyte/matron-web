/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    applyCommand,
    applyFolder,
    CLAUDE_BRIDGE_COMMANDS,
    filterCommands,
    folderCompletionPartial,
    isCommandMode,
    recentFolderArgument,
} from "../../../src/journal/slash-palette";

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

describe("folderCompletionPartial", () => {
    it.each([
        ["/start ", ""],
        ["/workdir /op", "/op"],
        ["/start --claude /op", "/op"],
        ["/start --claude --browser /o", "/o"],
        ["/start --browser /op", "/op"],
        ["/start --agent=codex /op", "/op"],
        ["/START --claude /op", "/op"],
        ["/START /op", "/op"],
        ["/Workdir /o", "/o"],
        ["/start --claude", null],
        ["/start --CLAUDE /op", null],
        ["/start --claud /op", null],
        ["/workdir --bogus /op", null],
        ["/stop /z", null],
        ["/start a b", null],
    ])("parses %j as %j", (input, expected) => {
        expect(folderCompletionPartial(input)).toBe(expected);
    });
});

describe("applyCommand", () => {
    it.each([
        ["/start", "/start "],
        ["!esc", "!esc "],
    ])("applies %j as %j", (trigger, expected) => {
        expect(applyCommand(trigger)).toBe(expected);
    });
});

describe("applyFolder", () => {
    it.each([
        ["/start /op", "/opt/x", "/start /opt/x"],
        ["/start --claude /op", "/opt/x", "/start --claude /opt/x"],
        ["/workdir /srv/My", "/srv/My Project", "/workdir /srv/My Project"],
    ])("applies %j to %j as %j", (input, path, expected) => {
        expect(applyFolder(input, path)).toBe(expected);
    });
});

describe("recentFolderArgument", () => {
    it.each([
        ["/start /opt/x", "/opt/x"],
        ["/workdir /srv/My Project", "/srv/My Project"],
        ["/start /srv/My Project", "/srv/My"],
        ["/start --claude /a b c", "/a"],
        ["/workdir --claude /a b c", "/a b c"],
        ["/start --agent=codex /z", "/z"],
        ["/start --CLAUDE /op", "--CLAUDE"],
        ["/workdir --bogus /op", "--bogus /op"],
        ["/start now", null],
        ["/start fresh", null],
        ["!start now", null],
        ["/start --claude", null],
        ["/stop /z", null],
    ])("extracts %j from %j", (input, expected) => {
        expect(recentFolderArgument(input)).toBe(expected);
    });
});
