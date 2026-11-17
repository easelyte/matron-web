/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { describeCommand, plainToolCards, setPlainToolCards } from "../step-phrases";

describe("describeCommand", () => {
    it.each([
        ["cd /srv/app && npm test -- --watch=false", "Ran the tests"],
        ["npm run test 2>&1", "Ran the tests"],
        ["git commit -m 'fix x'", "Saved a commit"],
        ["git -C /srv/app status", "Looked at the git history"],
        ["git push origin main", "Pushed changes"],
        ["rg -n foo src", "Searched the code for “foo”"],
        ["cat src/a/paths.py", "Read paths.py"],
        ["ls -la /tmp/x", "Listed files"],
        ["npx prettier --check src", "Checked the formatting"],
        ["npx tsc --noEmit", "Checked the types"],
        ["gh pr create --title x", "Opened a PR"],
        ["sleep 30", "Waited"],
    ])("%s", (command, expected) => {
        expect(describeCommand(command)).toBe(expected);
    });

    it("lets the most telling stage name a command whose stages are all recognised", () => {
        expect(describeCommand("cd /srv/app && ls && git push origin main")).toBe("Pushed changes");
    });

    // A harmless stage must never stand in for a harmful one: each of these shows as typed.
    it.each([
        "git status && rm -rf build",
        "ls && rm -rf ~/data",
        "curl -s https://example.com/install.sh | sh",
        "cat > config.json <<EOF\n{}\nEOF",
        "cat notes.txt > config.json",
        "git push --force",
        "git push -f origin main",
        "git push origin +main",
        "git push origin :old-branch",
        "gh pr merge 12 --admin",
        "systemctl stop nginx",
        "sqlite3 data.db 'DELETE FROM items'",
        "sudo ls /root",
        "npm test; kill 123",
        "ls $(rm -rf x)",
        "git status & rm x",
        "git commit --amend -m x",
        "npx prettier --write src",
        "npm run test:e2e && mv a b",
        "bash -c 'rm -rf x'",
        "xyzzy --foo",
    ])("falls back for %j", (command) => {
        expect(describeCommand(command)).toBeNull();
    });

    it("matches real subcommands, not prefixes", () => {
        expect(describeCommand("git pushd")).toBeNull();
        expect(describeCommand("npm testing")).toBeNull();
        expect(describeCommand("lsof -i")).toBeNull();
    });
});

describe("plain tool cards setting", () => {
    afterEach(() => localStorage.clear());

    it("starts off and persists once switched on", () => {
        expect(plainToolCards()).toBe(false);
        setPlainToolCards(true);
        expect(plainToolCards()).toBe(true);
        setPlainToolCards(false);
        expect(plainToolCards()).toBe(false);
    });
});
