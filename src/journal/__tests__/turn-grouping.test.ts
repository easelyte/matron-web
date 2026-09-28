/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The "Under the hood" grouping algorithm, checked against the redesign-v6 fixtures
 * (docs/design/redesign-v6/src/model.js) and the HANDOFF §3 acceptance sentences.
 */

import {
    changedFiles,
    classify,
    formatDuration,
    formatElapsed,
    type Group,
    groupRowText,
    groupTurn,
    liveLine,
    normalizeCommand,
    passingRerun,
    type Step,
    stepCount,
    stepRowSentences,
    stepSentence,
    stepsOf,
    type TurnItem,
    turnIssues,
} from "../turn-grouping";

const S = (id: string, tool: string, input: Step["input"], o: Partial<Step> = {}): Step => ({
    kind: "step",
    id,
    tool,
    input,
    status: "ok",
    ms: 3000,
    ...o,
});
const N = (text: string): TurnItem => ({ kind: "narration", text });

// Turn 1 of the design fixtures: narration + 11 steps (4 reads over 3 files, 2 searches,
// git log, 1 edit +18 −6, tests pass, tsc exit 2 → tsc exit 0).
const T1: TurnItem[] = [
    N("Let me read the sheet component first."),
    S("t1s1", "Read", { path: "src/journal/components.tsx" }),
    S("t1s2", "Read", { path: "src/journal/client.ts" }),
    S("t1s3", "Grep", { pattern: "startSessionRpc" }),
    S("t1s4", "Read", { path: "src/bridge/journal-rpc.js" }),
    S("t1s5", "Grep", { pattern: "default_model" }),
    S("t1s6", "Bash", { command: "git log --oneline -8 -- src/journal/components.tsx" }, { exit: 0 }),
    S("t1s7", "Read", { path: "src/journal/components.tsx", note: "lines 200–260" }),
    S("t1s8", "Edit", { path: "src/journal/components.tsx" }, { added: 18, removed: 6 }),
    S("t1s9", "Bash", { command: "pnpm vitest run src/journal/__tests__/new-session-sheet.test.tsx" }, { exit: 0 }),
    S("t1s10", "Bash", { command: "pnpm tsc --noEmit" }, { status: "failed", exit: 2 }),
    S("t1s11", "Bash", { command: "pnpm tsc --noEmit" }, { exit: 0 }),
];

const groupsOf = (seq: ReturnType<typeof groupTurn>): Group[] =>
    seq.filter((entry): entry is Group => entry.type === "group");

describe("groupTurn — HANDOFF §3 acceptance (turn 1)", () => {
    it("reproduces the §5 group sentences in narration order", () => {
        const seq = groupTurn(T1);
        expect(seq[0]).toEqual({ type: "narration", text: "Let me read the sheet component first." });
        expect(groupsOf(seq).map(groupRowText)).toEqual([
            "Looked through 3 files",
            "Searched the code 2×",
            "Checked the history",
            "Changed 1 file",
            "Ran the tests: passed",
            "Checked the types: failed once, then passed",
        ]);
    });

    it("counts steps, not narration, and formats the collapsed meta", () => {
        const steps = stepsOf(T1);
        expect(stepCount(steps.length)).toBe("11 steps");
        expect(stepCount(1)).toBe("1 step");
        expect(formatDuration(192_000)).toBe("3m 12s");
    });

    it("flags the turn as having issues (amber dot) because a step failed along the way", () => {
        expect(turnIssues(T1)).toBe(true);
        expect(turnIssues(T1.filter((item) => item.kind !== "step" || item.status !== "failed"))).toBe(false);
    });

    it("marks the type-check group recovered and the others ok", () => {
        const groups = groupsOf(groupTurn(T1));
        expect(groups.map((group) => group.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "recovered"]);
        expect(groups.map((group) => group.steps.length)).toEqual([4, 2, 1, 1, 1, 2]);
        expect(groups.map((group) => group.icon)).toEqual(["file", "search", "history", "pencil", "flask", "shield"]);
    });

    it("gives groups stable ids in the model.js scheme", () => {
        const ids = groupsOf(groupTurn(T1)).map((group) => group.id);
        expect(ids).toEqual(["look-1-0", "search-1-1", "history-1-2", "change-1-3", "test-1-4", "check-1-5"]);
    });

    it("appends 'again' to a repeated step sentence and nothing else", () => {
        const [, , , , , check] = groupsOf(groupTurn(T1));
        expect(stepRowSentences(check.steps)).toEqual(["Checked the types", "Checked the types again"]);
        const [look] = groupsOf(groupTurn(T1));
        expect(stepRowSentences(look.steps)).toEqual([
            "Read components.tsx",
            "Read client.ts",
            "Read journal-rpc.js",
            "Read components.tsx",
        ]);
    });

    it("sums the changed-files block per path and points at the last diff", () => {
        expect(changedFiles(T1)).toEqual([
            { path: "src/journal/components.tsx", name: "components.tsx", added: 18, removed: 6, stepId: "t1s8" },
        ]);
    });

    it("finds the passing rerun of a failed command in the same group", () => {
        const [, , , , , check] = groupsOf(groupTurn(T1));
        expect(passingRerun(check.steps[0], check.steps)?.id).toBe("t1s11");
        expect(passingRerun(check.steps[1], check.steps)).toBeUndefined();
    });
});

describe("groupTurn — segments, outcomes and the running step", () => {
    it("never merges steps across narration", () => {
        const seq = groupTurn([
            S("a", "Read", { path: "a.ts" }),
            N("Now the tests."),
            S("b", "Read", { path: "b.ts" }),
            S("c", "Bash", { command: "pnpm test" }),
        ]);
        expect(seq.map((entry) => (entry.type === "group" ? groupRowText(entry) : `“${entry.text}”`))).toEqual([
            "Read a.ts",
            "“Now the tests.”",
            "Read b.ts",
            "Ran the tests: passed",
        ]);
    });

    it("reports a group whose last step failed as failed, in red, not recovered", () => {
        const seq = groupTurn([S("a", "Bash", { command: "pnpm vitest run" }, { status: "failed", exit: 1 })]);
        const [group] = groupsOf(seq);
        expect(group.status).toBe("failed");
        expect(groupRowText(group)).toBe("Ran the tests: failed");
    });

    it("counts repeated failures before a pass", () => {
        const steps = [0, 1, 2].map((i) =>
            S(`t${i}`, "Bash", { command: "pnpm vitest run" }, { status: i < 2 ? "failed" : "ok" }),
        );
        expect(groupRowText(groupsOf(groupTurn(steps))[0])).toBe("Ran the tests: failed 2×, then passed");
    });

    it("gives a recovered non-test group the screen-reader outcome and no visible amber text class", () => {
        const [group] = groupsOf(
            groupTurn([
                S("a", "Bash", { command: "pnpm build" }, { status: "failed", exit: 1 }),
                S("b", "Bash", { command: "pnpm build" }),
            ]),
        );
        expect(group.status).toBe("recovered");
        expect(group.outcomeText).toBe("one step failed, then worked");
        expect(group.sentence).toBe("Ran 2 commands");
    });

    it("turns the running group's sentence into the live line without its ellipsis", () => {
        const running = S("r", "Bash", { command: "pnpm vitest run src/journal" }, { status: "running" });
        const seq = groupTurn([S("a", "Read", { path: "src/journal/client.ts" })], running);
        const groups = groupsOf(seq);
        expect(groups[1].status).toBe("running");
        expect(groups[1].sentence).toBe("Running the tests");
        expect(groups[1].outcomeText).toBe("");
        expect(liveLine(running)).toBe("Running the tests…");
    });

    it("never reports a command with no exit as passed", () => {
        const [group] = groupsOf(
            groupTurn([S("a", "Bash", { command: "pnpm vitest run" }, { status: "stopped", exit: null })]),
        );
        expect(group.status).toBe("stopped");
        expect(groupRowText(group)).toBe("Ran the tests: stopped");
        expect(turnIssues([S("a", "Bash", { command: "sleep 9" }, { status: "stopped" })])).toBe(true);
    });

    it("keeps a git command a git step whatever its message says", () => {
        expect(classify(S("a", "Bash", { command: "git commit -m 'fix lint and tests'" })).key).toBe("git");
        expect(classify(S("a", "Bash", { command: "git log --grep=vitest" })).key).toBe("history");
    });

    it("uses 'the code style' for lint-only check groups", () => {
        const [group] = groupsOf(groupTurn([S("a", "Bash", { command: "pnpm lint" })]));
        expect(groupRowText(group)).toBe("Checked the code style: passed");
    });
});

describe("shell reads", () => {
    it("counts distinct files across cat / sed -n / head reads", () => {
        const [group] = groupsOf(
            groupTurn([
                S("a", "Bash", { command: "sed -n '1,200p' src/journal/components.tsx" }),
                S("b", "Bash", { command: "cat src/journal/client.ts" }),
                S("c", "Bash", { command: "head -n 40 src/journal/components.tsx" }),
            ]),
        );
        expect(group.sentence).toBe("Looked through 2 files");
        expect(stepRowSentences(group.steps)).toEqual(["Read components.tsx", "Read client.ts", "Read components.tsx"]);
    });
});

describe("classify — Claude tools and Codex (decision §7.3)", () => {
    const keyOf = (tool: string, input: Step["input"]): string => classify(S("x", tool, input)).key;

    it("maps apply_patch and Codex file_change to change", () => {
        expect(keyOf("apply_patch", { path: "src/a.ts" })).toBe("change");
        expect(keyOf("file_change", {})).toBe("change");
    });

    it("classifies shell by its command, unwrapping bash -lc and leading cd", () => {
        expect(keyOf("shell", { command: "bash -lc 'pnpm vitest run'" })).toBe("test");
        expect(keyOf("Bash", { command: '/bin/bash -lc "git log --oneline -3"' })).toBe("history");
        expect(keyOf("Bash", { command: "cd /repo && rg startSession src" })).toBe("search");
        expect(keyOf("Bash", { command: "CI=1 FORCE_COLOR=0 git push origin HEAD" })).toBe("git");
        expect(keyOf("Bash", { command: "sed -n '1,40p' src/a.ts" })).toBe("look");
        expect(keyOf("Bash", { command: "node scripts/gen.mjs" })).toBe("run");
    });

    it("sends unknown tools to other and web tools to web", () => {
        expect(keyOf("mcp__tracker__item_create", {})).toBe("other");
        expect(keyOf("WebSearch", {})).toBe("web");
        expect(keyOf("Task", { description: "triage" })).toBe("helper");
    });

    it("normalizeCommand leaves a plain command alone", () => {
        expect(normalizeCommand("pnpm tsc --noEmit")).toBe("pnpm tsc --noEmit");
        expect(normalizeCommand("  bash -lc 'cd /x && ls -la'  ")).toBe("ls -la");
    });
});

describe("step sentences and live lines (GENERATIVE-SYSTEM §1 templates)", () => {
    it("writes past-tense step sentences from the basename only", () => {
        expect(stepSentence(S("a", "Read", { path: "/very/long/path/to/file.tsx" }))).toBe("Read file.tsx");
        expect(stepSentence(S("a", "Write", { path: "src/new.ts" }))).toBe("Created new.ts");
        expect(stepSentence(S("a", "Write", { path: "src/old.ts" }, { newFile: false }))).toBe("Changed old.ts");
        expect(stepSentence(S("a", "Bash", { command: "git commit -m x" }))).toBe("Saved a commit");
        expect(stepSentence(S("a", "Bash", { command: "git push" }))).toBe("Pushed the branch");
        expect(stepSentence(S("a", "Bash", { command: "git diff --stat" }))).toBe("Looked at what changed");
        expect(stepSentence(S("a", "Task", { description: "review the diff" }))).toBe(
            "Asked a helper to review the diff",
        );
        expect(stepSentence(S("a", "Browser", { url: "http://localhost:5173/#/new" }))).toBe(
            "Took a screenshot of localhost:5173",
        );
    });

    it("writes present-progressive live lines", () => {
        expect(liveLine(S("a", "Read", { path: "src/bridge/journal-rpc.js" }))).toBe("Reading journal-rpc.js…");
        expect(liveLine(S("a", "Grep", { pattern: "default_model" }))).toBe("Searching for default_model…");
        expect(liveLine(S("a", "Bash", { command: "pnpm tsc --noEmit" }))).toBe("Checking the types…");
        expect(liveLine(S("a", "Task", { description: "triage failing tests" }))).toBe(
            "Asking a helper to triage failing tests…",
        );
        expect(liveLine(S("a", "Bash", { command: "node x.mjs" }))).toBe("Working…");
    });

    it("formats durations and elapsed counters", () => {
        expect(formatDuration(42_000)).toBe("42s");
        expect(formatDuration(2_890_000)).toBe("48m 10s");
        expect(formatDuration(3_900_000)).toBe("1h 05m");
        expect(formatElapsed(42)).toBe("42s");
        expect(formatElapsed(64)).toBe("1m 04s");
    });
});

describe("the 210-step stress turn", () => {
    function make210(): TurnItem[] {
        const files: string[] = [];
        const dirs = [
            "src/journal",
            "src/journal/files",
            "src/journal/tracker",
            "src/bridge",
            "src/contracts",
            "test/unit",
        ];
        for (let i = 0; i < 96; i++) files.push(`${dirs[i % dirs.length]}/module-${String(i + 1).padStart(2, "0")}.ts`);
        const items: TurnItem[] = [N("I’ll map every caller of the RPC layer before changing anything.")];
        let n = 0;
        const id = (): string => `x${++n}`;
        for (let i = 0; i < 140; i++) items.push(S(id(), "Read", { path: files[i % 96] }));
        for (let i = 0; i < 30; i++) items.push(S(id(), "Grep", { pattern: "rpc" }));
        items.push(N("Now moving the calls onto the new client."));
        for (let i = 0; i < 12; i++)
            items.push(S(id(), "Edit", { path: files[(i * 7) % 96] }, { added: 3, removed: 1 }));
        items.push(N("Running everything to be sure."));
        for (let i = 0; i < 8; i++)
            items.push(
                S(id(), "Bash", { command: "pnpm vitest run" }, { status: i === 1 || i === 4 ? "failed" : "ok" }),
            );
        for (let i = 0; i < 6; i++)
            items.push(S(id(), "Bash", { command: "pnpm tsc --noEmit" }, { status: i === 0 ? "failed" : "ok" }));
        for (const command of [
            "pnpm build",
            "pnpm format",
            "node scripts/gen-contracts.mjs",
            "pnpm build",
            "ls dist",
            "du -sh dist",
        ])
            items.push(S(id(), "Bash", { command }));
        for (const command of [
            "git status",
            "git diff --stat",
            "git log --oneline -3",
            "git add -A",
            "git commit -m x",
            "git push",
        ])
            items.push(S(id(), "Bash", { command }));
        for (const description of ["review the RPC migration", "update the contract docs"])
            items.push(S(id(), "Task", { description }));
        return items;
    }

    it("still groups into a short, readable sequence", () => {
        const items = make210();
        expect(stepsOf(items)).toHaveLength(210);
        const text = groupTurn(items).map((entry) => (entry.type === "group" ? groupRowText(entry) : "¶"));
        expect(text).toEqual([
            "¶",
            "Looked through 96 files",
            "Searched the code 30×",
            "¶",
            "Changed 12 files",
            "¶",
            "Ran the tests: failed 2×, then passed",
            "Checked the types: failed once, then passed",
            "Ran 5 commands",
            "Searched the code",
            "Checked the history 3×",
            "Updated the branch 3×",
            "Asked 2 helpers",
        ]);
    });
});
