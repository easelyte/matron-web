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
    folderSuggestions,
    isCommandMode,
    makeRecentFoldersStore,
    recentFolderArgument,
} from "../../../src/journal/slash-palette";

const session = {
    serverUrl: "https://journal.example.test/api",
    token: "token",
    deviceId: 1,
    userId: 42,
    username: "tester",
};
const storageKey = `matron_journal_recent_start_folders_v1:${encodeURIComponent(session.serverUrl)}:${session.userId}`;

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
        ["/start —claude /op", "/op"],
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
        ["/start /op", "/srv/$&", "/start /srv/$&"],
        ["/start /op", "/srv/$`", "/start /srv/$`"],
        ["/start /op", "/srv/$'", "/start /srv/$'"],
        ["/start /op", "/srv/$$", "/start /srv/$$"],
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
        ["/start —claude /op", "/op"],
        ["/workdir /srv/repo --codex", "/srv/repo"],
        ["/workdir --browser /srv/repo --codex", "/srv/repo"],
        ["/start /op --claude", "/op"],
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

describe("makeRecentFoldersStore", () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        localStorage.clear();
        warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        jest.restoreAllMocks();
    });

    it("deduplicates case-sensitively and moves an exact match to the front", () => {
        const store = makeRecentFoldersStore(session);
        store.record("/srv/App");
        store.record("/srv/app");
        expect(store.matches("")).toEqual(["/srv/app", "/srv/App"]);

        store.record("/srv/App");
        expect(store.matches("")).toEqual(["/srv/App", "/srv/app"]);
    });

    it("caps entries at 15 and drops the oldest", () => {
        const store = makeRecentFoldersStore(session);
        for (let index = 0; index < 16; index += 1) store.record(`/srv/${index}`);

        expect(store.matches("")).toHaveLength(15);
        expect(store.matches("")[0]).toBe("/srv/15");
        expect(store.matches("")).not.toContain("/srv/0");
    });

    it("matches prefixes case-insensitively in most-recent-first order", () => {
        const store = makeRecentFoldersStore(session);
        store.record("/opt/Alpha");
        store.record("/srv/other");
        store.record("/OPT/api");

        expect(store.matches("/opt/a")).toEqual(["/OPT/api", "/opt/Alpha"]);
    });

    it.each(["not-json", "{}", "null"])("degrades stored value %j to an empty list", (raw) => {
        localStorage.setItem(storageKey, raw);
        expect(makeRecentFoldersStore(session).matches("")).toEqual([]);
    });

    it("filters non-string entries from a stored array", () => {
        localStorage.setItem(storageKey, '["/a",1]');
        expect(makeRecentFoldersStore(session).matches("")).toEqual(["/a"]);
    });

    it("records safely on top of a wrong-shape stored value", () => {
        localStorage.setItem(storageKey, "{}");
        const store = makeRecentFoldersStore(session);

        expect(() => store.record("/new")).not.toThrow();
        expect(store.matches("")).toEqual(["/new"]);
    });

    it("returns an empty list when the key is absent", () => {
        expect(makeRecentFoldersStore(session).matches("")).toEqual([]);
    });

    it("does not throw when storage writes fail", () => {
        jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("quota exceeded");
        });

        expect(() => makeRecentFoldersStore(session).record("/new")).not.toThrow();
    });

    it("is a no-op without a session", () => {
        const store = makeRecentFoldersStore(undefined);
        expect(() => store.record("/new")).not.toThrow();
        expect(store.matches("")).toEqual([]);
        expect(localStorage.length).toBe(0);
    });

    it("round-trips values under the versioned session key", () => {
        makeRecentFoldersStore(session).record("/round-trip");
        expect(JSON.parse(localStorage.getItem(storageKey) ?? "null")).toEqual(["/round-trip"]);
        expect(makeRecentFoldersStore(session).matches("")).toEqual(["/round-trip"]);
    });
});

describe("folderSuggestions", () => {
    function storeWith(paths: string[]) {
        return { record: jest.fn(), matches: jest.fn(() => paths) };
    }

    it("returns no suggestions outside folder-command completion", () => {
        expect(folderSuggestions("hello", storeWith(["/srv/app"]))).toEqual([]);
    });

    it("does not re-inject a trailing agent flag through a recorded suggestion", () => {
        localStorage.clear();
        const store = makeRecentFoldersStore(session);
        const folder = recentFolderArgument("/workdir /srv/repo --codex");
        expect(folder).toBe("/srv/repo");
        if (folder !== null) store.record(folder);

        const suggestions = folderSuggestions("/workdir /srv/r", store);
        expect(suggestions).toEqual(["/srv/repo"]);
        expect(applyFolder("/workdir /srv/r", suggestions[0])).toBe("/workdir /srv/repo");
    });

    it("keeps a case-distinct sibling while removing the exact partial", () => {
        const store = storeWith(["/srv/App", "/srv/app"]);
        expect(folderSuggestions("/start /srv/App", store)).toEqual(["/srv/app"]);
        expect(store.matches).toHaveBeenCalledWith("/srv/App");
    });

    it("caps suggestions at eight", () => {
        const paths = Array.from({ length: 10 }, (_, index) => `/srv/${index}`);
        expect(folderSuggestions("/workdir /sr", storeWith(paths))).toEqual(paths.slice(0, 8));
    });

    it("excludes whitespace paths for start but retains them for workdir", () => {
        const paths = ["/srv/My Project", "/srv/api"];
        expect(folderSuggestions("/start /sr", storeWith(paths))).toEqual(["/srv/api"]);
        expect(folderSuggestions("/workdir /sr", storeWith(paths))).toEqual(paths);
    });
});
