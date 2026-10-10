/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Helper-thread headlines (2026-09-26): the shared step categoriser (step-phrases.ts), the
 * headline list inside a helper's own thread, the sidebar preview line, and the helper's context
 * gauge. Regression-tested on a scrubbed sample of real helper traffic
 * (fixtures/helper-corpus.json): every step shape seen in three days of Claude subagents and
 * Codex runs, plus three whole helper threads, including the python3-heredoc thread that printed
 * raw `🔧 python3 - <<'EOF'` lines in the operator's report.
 *
 * Set HL_CORPUS=/path/to/corpus.jsonl to run the corpus checks on a full local extract instead.
 */

import fs from "node:fs";
import path from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { previewLine } from "../activity-text";
import { HeadlineList } from "../headline-list";
import { buildHeadlines, type Headline, headlineRowText, testCounts } from "../headlines";
import { helperContextStatus } from "../status";
import { describeCommand, describeStep, looksRaw, stepHeadline, stepLiveHeadline } from "../step-phrases";
import { assembleTurns, eventToStep } from "../turn-assembly";
import { type Step } from "../turn-grouping";
import type { JournalEvent, SessionStatus } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Corpus {
    shapes: JournalEvent[];
    threads: Record<string, JournalEvent[]>;
}

function loadCorpus(): { events: JournalEvent[]; threads: Record<string, JournalEvent[]> } {
    const fixture = JSON.parse(
        fs.readFileSync(path.join(__dirname, "fixtures", "helper-corpus.json"), "utf8"),
    ) as Corpus;
    const local = process.env.HL_CORPUS;
    if (local && fs.existsSync(local)) {
        const events = fs
            .readFileSync(local, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { event: JournalEvent }).event);
        return { events, threads: fixture.threads };
    }
    return { events: [...fixture.shapes, ...Object.values(fixture.threads).flat()], threads: fixture.threads };
}

const CORPUS = loadCorpus();

/**
 * Why a line reads as raw machine text, or null when it reads as a sentence. Independent of
 * looksRaw (the guard under test): quoted search terms are set aside first, since a search term
 * is the one agent-supplied fragment a phrase may carry.
 */
function rawReason(line: string): string | null {
    // A helper's task description is the agent's own prose, carried as-is.
    const text = line
        .replace(/“[^”]*”/g, "“…”")
        .replace(/^(Started|Starting) a helper: .*/, "$1 a helper")
        .replace(/https?:\/\/\S+/g, "a link");
    if (/[🔧📖🔍📋🔀]/u.test(text)) return "indicator emoji";
    if (text.includes("`")) return "backtick";
    if (text.includes("\n")) return "newline";
    if (/<</.test(text)) return "heredoc";
    if (/^\s*(import|from)\s+[\w.{*]+\s*(import\b|,|;|$)|import\s+(sqlite3|json|os|sys|re)\b/.test(text))
        return "import";
    if (/^\$ /.test(text)) return "shell prompt";
    if (/(^|\s)--?[a-zA-Z][\w-]*(=|\s|$)/.test(text)) return "flag";
    if (/\|\s*\w/.test(text)) return "pipe";
    if (/[;&]{1,2}\s/.test(text)) return "command separator";
    if (/\/[^\s/]+\/[^\s/]+\/[^\s/]+/.test(text)) return "deep path";
    if (/\b(python3?|node|psql|sqlite3|bash)\s+-/.test(text)) return "command line";
    if (text.length > 120) return "too long";
    return null;
}

const steps = (): Step[] =>
    CORPUS.events.map((event) => eventToStep(event)).filter((step): step is Step => step !== null);

describe("step categoriser on real helper traffic", () => {
    it("names at least 95% of real steps specifically, and never prints raw text", () => {
        const all = steps();
        expect(all.length).toBeGreaterThan(300);
        let specific = 0;
        const raw: string[] = [];
        for (const step of all) {
            const phrase = describeStep(step);
            if (!phrase.fallback) specific += 1;
            for (const line of [phrase.past, `${phrase.live}…`]) {
                const reason = rawReason(line);
                if (reason) raw.push(`${reason}: ${line}`);
            }
        }
        expect(raw).toEqual([]);
        expect(specific / all.length).toBeGreaterThanOrEqual(0.95);
    });

    it("reads inline scripts by what they do, never by their source", () => {
        const cases: Array<[string, string]> = [
            [
                "python3 - <<'EOF'\nimport sqlite3\nc=sqlite3.connect('/tmp/hl-audit/journal.db')\nEOF",
                "Queried the journal database",
            ],
            [
                "python3 - <<'EOF'\nimport sqlite3\nsrc=sqlite3.connect('file:/srv/matron/journal/data/matron.db?mode=r…",
                "Queried the journal database",
            ],
            ["python3 - <<'EOF'\nimport json\nprint(json.load(open('a.json')))\nEOF", "Ran a Python script"],
            ['python3 -c "import json; print(1)"', "Ran a Python script"],
            ["node -e 'console.log(require(\"os\").homedir())'", "Ran a Node script"],
            ["env -u HOME node -e 'console.log(1)'", "Ran a Node script"],
            ["psql \"$SUPABASE_DB_URL\" -c 'select 1'", "Queried a database"],
            ["sqlite3 -readonly data/matron.db 'select count(*) from events'", "Queried the journal database"],
            ["bash <<'EOF'\nset -e\nls\nEOF", "Ran a shell script"],
            ['cd /tmp/x && sed -i \'s/expect(screen.getByRole("button")).not.toB…', "Edited a file"],
        ];
        for (const [command, expected] of cases) expect(describeCommand(command).past).toBe(expected);
    });

    it("guards the preview against anything that still reads as machine text", () => {
        for (const line of [
            "🔧 python3 - <<'EOF' import sqlite3",
            "$ pnpm vitest run",
            "cd /tmp/wt && git status",
            "W=/tmp/x; cat $W/a.ts",
            "import sqlite3,json",
            "const x = require('y')",
            "/srv/matron/web/src/a.ts /srv/matron/web/src/b.ts",
        ])
            expect(looksRaw(line)).toBe(true);
        for (const line of ["Now build the corpus extractor.", "Read paths.py", "Fixed src/a.ts and ran the tests."])
            expect(looksRaw(line)).toBe(false);
    });
});

describe("helper thread headlines", () => {
    const thread = (name: string) => assembleTurns(CORPUS.threads[name]);
    const rows = (name: string): string[] =>
        thread(name).flatMap((turn) =>
            buildHeadlines(turn.items).map((entry) =>
                entry.type === "note" ? `note: ${entry.text}` : headlineRowText(entry as Headline),
            ),
        );

    it("the python3-heredoc thread: no raw line, scripts folded into the command runs", () => {
        const lines = rows("claude-heredoc");
        const headlines = lines.filter((line) => !line.startsWith("note: "));
        for (const line of headlines) expect(rawReason(line)).toBeNull();
        for (const line of lines) expect(line).not.toMatch(/🔧|<<|import sqlite3/u);
        expect(headlines).toContain("Queried the journal database 2×");
        expect(headlines.some((line) => /^Ran \d+ commands$/.test(line))).toBe(true);
        // Grouping: far fewer headlines than steps.
        const stepCount = thread("claude-heredoc").reduce((n, turn) => n + turn.items.length, 0);
        expect(headlines.length).toBeLessThan(stepCount / 1.5);
    });

    it("a Codex review run reads as a handful of headlines", () => {
        const headlines = rows("codex-review").filter((line) => !line.startsWith("note: "));
        expect(headlines.length).toBeLessThanOrEqual(5);
        for (const line of headlines) expect(rawReason(line)).toBeNull();
        expect(headlines[0]).toMatch(/^Looked through \d+ files and 1 folder, searched the code \d+×/);
    });

    it("every headline of every fixture thread reads as a sentence", () => {
        for (const name of Object.keys(CORPUS.threads))
            for (const line of rows(name).filter((row) => !row.startsWith("note: ")))
                expect(rawReason(line)).toBeNull();
    });

    it("folds reads and searches, names test outcomes, keeps edits apart", () => {
        let n = 0;
        const step = (tool: string, input: Step["input"], extra: Partial<Step> = {}): Step => ({
            kind: "step",
            id: `s${(n += 1)}`,
            tool,
            input,
            status: "ok",
            ...extra,
        });
        const out = (output: string, exit = 0): Partial<Step> => ({
            exit,
            source: { seq: 1, convo_id: "c", ts: 0, sender: "agent:x", type: "tool_output", payload: { output } },
        });
        const entries = buildHeadlines([
            step("Grep", { pattern: "WORKSPACE_ROOT" }),
            step("Read", { path: "/r/anton/core/paths.py" }),
            step("Read", { path: "/r/anton/core/watchdog.py" }),
            step("Bash", { command: "git status --short" }),
            step("Bash", { command: "python3 - <<'EOF'\nimport sqlite3\nEOF" }),
            step("Bash", { command: "ls /tmp" }),
            step("Bash", { command: "sleep 5" }),
            step("Edit", { path: "/r/anton/core/paths.py" }),
            step("Edit", { path: "/r/anton/core/watchdog.py" }),
            step("Bash", { command: "npx jest --runInBand" }, out("Tests:       134 passed, 134 total")),
        ]);
        expect(entries.map((entry) => (entry.type === "headline" ? headlineRowText(entry) : entry.text))).toEqual([
            "Read paths.py and watchdog.py, searched the code for “WORKSPACE_ROOT”",
            "Ran 2 commands",
            "Listed files in tmp",
            "Waited",
            "Edited paths.py and watchdog.py",
            "Ran the tests: 134 passed",
        ]);
        expect(testCounts("Tests  2 failed | 134 passed (136)")).toEqual({ passed: 134, failed: 2 });
    });

    it("reports a retry's own outcome, never an earlier run's counts", () => {
        const run = (id: string, output: string, status: Step["status"], exit: number): Step => ({
            kind: "step",
            id,
            tool: "Bash",
            input: { command: "npx jest" },
            status,
            exit,
            source: { seq: 1, convo_id: "c", ts: 0, sender: "agent:x", type: "tool_output", payload: { output } },
        });
        const [entry] = buildHeadlines([run("a", "Tests: 134 passed", "ok", 0), run("b", "boom", "failed", 1)]);
        expect(entry.type === "headline" && headlineRowText(entry)).toBe("Ran the test suite 2×: failed");
    });

    it("keeps a sentence that names a few files as prose", () => {
        expect(looksRaw("Updated src/a.ts, src/b.ts, and src/c.ts.")).toBe(false);
        expect(previewLine({ snippet: "Updated src/a.ts, src/b.ts, and src/c.ts.", session_state: "done" })).toBe(
            "Updated src/a.ts, src/b.ts, and src/c.ts.",
        );
    });

    it("a path listing behind a heading still reads as raw", () => {
        expect(looksRaw("Paths: src/a.ts src/b.ts src/c.ts.")).toBe(true);
        expect(looksRaw("Updated src/a.ts, src/b.ts, src/c.ts.")).toBe(false);
    });

    it("a legacy web-search line reads as a search, in the headlines and the sidebar", () => {
        const [entry] = buildHeadlines([{ kind: "narration", text: "🌐 matron release notes" }]);
        expect(entry.type === "headline" && headlineRowText(entry)).toBe("Searched the web for “matron release notes”");
        expect(previewLine({ snippet: "🌐 matron release notes", session_state: "done" })).toBe("Searched the web");
        // Prose that happens to open with the globe stays prose.
        const [prose] = buildHeadlines([{ kind: "narration", text: "🌐 The docs say otherwise." }]);
        expect(prose).toMatchObject({ type: "note" });
    });

    it("narration that reads as machine text joins the steps instead of printing", () => {
        const entries = buildHeadlines([
            { kind: "narration", text: "🔧 python3 - <<'EOF' import sqlite3,json c=sqlite3.connect('/tmp/j.db')" },
            { kind: "narration", text: "Now build the corpus extractor." },
        ]);
        expect(entries[0]).toMatchObject({ type: "headline", key: "command" });
        expect(entries[1]).toMatchObject({ type: "note", text: "Now build the corpus extractor." });
    });
});

describe("HeadlineList (rendered, Developer view off)", () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it("renders the heredoc thread as plain headlines: no raw line, no heading, no pre", async () => {
        const [turn] = assembleTurns(CORPUS.threads["claude-heredoc"]);
        await act(async () =>
            root.render(<HeadlineList items={turn.items} active={false} renderDetail={() => <pre>detail</pre>} />),
        );
        const list = container.querySelector(".mj_Headlines");
        expect(list).not.toBeNull();
        expect(list?.textContent).not.toMatch(/🔧|<<|import sqlite3|python3/u);
        expect(list?.querySelector("h1, h2, h3, h4, h5, h6, pre, code")).toBeNull();
        const rowTexts = [...container.querySelectorAll(".mj_Headline_row .mj_TurnCard_sentence")].map(
            (node) => node.textContent ?? "",
        );
        expect(rowTexts.length).toBeGreaterThan(3);
        // A finished thread lists its last headlines; "Show all" opens the earlier ones.
        const more = container.querySelector<HTMLButtonElement>(".mj_Headlines_more");
        expect(more?.textContent).toMatch(/^Show all \d+$/);
        await act(async () => more!.click());
        // A grouped headline opens onto its steps, each phrased on its own.
        const grouped = [...container.querySelectorAll<HTMLButtonElement>(".mj_Headline_row")].find((button) =>
            /Ran \d+ commands/.test(button.textContent ?? ""),
        );
        expect(grouped).toBeDefined();
        await act(async () => grouped!.click());
        const inner = [...container.querySelectorAll(".mj_TurnCard_steps .mj_TurnCard_name")].map(
            (node) => node.textContent,
        );
        expect(inner.length).toBeGreaterThan(1);
        for (const text of inner) expect(rawReason(text ?? "")).toBeNull();
    });
});

describe("sidebar preview on real helper traffic (Developer view off)", () => {
    /** The server's snippet for an event (journal snippetOf): 120 characters of the body/output. */
    function snippets(event: JournalEvent): string[] {
        const p = event.payload as Record<string, unknown>;
        if (event.type === "text") return [String(p.body ?? "").slice(0, 120)];
        if (event.type === "tool_output") {
            const out: string[] = [`$ ${String(p.command ?? "")}`.slice(0, 120)];
            if (typeof p.output === "string" && p.output) out.push(p.output.slice(0, 120));
            return out;
        }
        if (event.type === "diff") return ["[diff]"];
        return [];
    }

    it("never prints raw command text, with or without the recorded step", () => {
        const failures: string[] = [];
        for (const event of CORPUS.events) {
            const step = eventToStep(event);
            for (const snippet of snippets(event)) {
                for (const session_state of ["running", "done"]) {
                    for (const worker of ["claude", "codex"] as const) {
                        // With the recorded step (the client saw the event): a phrase, strictly.
                        if (step) {
                            const line = previewLine({ snippet, session_state, worker, last_step: step });
                            const reason = rawReason(line);
                            if (reason) failures.push(`${reason}: ${line}  <=  ${snippet.slice(0, 60)}`);
                        }
                        // From the server snippet alone (after a snapshot, another device): never a
                        // command line, indicator, heredoc, code or path run. A command's output that
                        // reads as prose (the first line of a README) may print.
                        const line = previewLine({ snippet, session_state, worker });
                        const commandish = /^(🔧|📖|🔍|📋|\$ )/u.test(snippet);
                        const reason = commandish
                            ? rawReason(line)
                            : /🔧|<<|^\s*(import|from)\s+[\w.{*]+\s*(import\b|,|;|$)|import\s+(sqlite3|json|os|sys|re)\b|^\$ /u.test(
                                    line,
                                )
                              ? "raw"
                              : looksRaw(line)
                                ? "looks raw"
                                : null;
                        if (reason) failures.push(`${reason}: ${line}  <=  ${snippet.slice(0, 60)}`);
                    }
                }
            }
        }
        expect(failures.slice(0, 20)).toEqual([]);
    });

    it("phrases with the same categoriser as the headlines", () => {
        const step: Step = {
            kind: "step",
            id: "s",
            tool: "Bash",
            input: { command: "python3 - <<'EOF'\nimport sqlite3\nsqlite3.connect('/tmp/journal.db')\nEOF" },
            status: "ok",
        };
        expect(previewLine({ snippet: "", session_state: "done", last_step: step })).toBe(stepHeadline(step));
        expect(previewLine({ snippet: "", session_state: "running", last_step: step })).toBe(stepLiveHeadline(step));
        expect(stepHeadline(step)).toBe("Queried the journal database");
    });
});

describe("helper context gauge", () => {
    const status = (model: string, tokens: number, window: number): SessionStatus => ({
        model,
        context: { tokens, window, pct: Math.min(100, Math.round((tokens / window) * 100)) },
    });

    it("a subagent past 200k on the parent's 1M model reads against 1M, not a red 100%", () => {
        const child = status("claude-opus-5-5", 300_000, 200_000);
        expect(helperContextStatus(child, status("claude-opus-5-5[1m]", 500_000, 1_000_000))?.context).toEqual({
            tokens: 300_000,
            window: 1_000_000,
            pct: 30,
        });
        // Even without the parent's status: more tokens than the window proves the larger one.
        expect(helperContextStatus(child, undefined)?.context?.pct).toBe(30);
    });

    it("inherits the parent's window on the same family; another family keeps its own", () => {
        const parent = status("opus[1m]", 400_000, 1_000_000);
        expect(helperContextStatus(status("claude-opus-5-5", 150_000, 200_000), parent)?.context?.pct).toBe(15);
        expect(helperContextStatus(status("claude-haiku-4-5", 50_000, 200_000), parent)?.context?.pct).toBe(25);
        expect(
            helperContextStatus(status("claude-opus-5-5", 50_000, 200_000), status("claude-opus-5-5", 9, 200_000)),
        ).toEqual(status("claude-opus-5-5", 50_000, 200_000));
        expect(helperContextStatus(undefined, parent)).toBeUndefined();
    });
});
