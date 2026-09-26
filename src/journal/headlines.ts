/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Headlines for a helper's own thread (a Claude subagent or a Codex run, Developer view OFF):
 * the helper's activity as a short list of plain-English lines, in the order it happened —
 *
 *     Read 4 files in anton/core
 *     Searched the code for “commit_loop_store”
 *     Ran the tests: 134 passed
 *     Edited paths.py and watchdog.py
 *     Opened a PR
 *
 * Consecutive steps of the same kind fold into one headline; narration between them ends the
 * run. Pure: no React. The phrases come from step-phrases.ts (the categoriser the sidebar
 * preview shares).
 */

import { indicatorStep } from "./activity-text";
import {
    describeStep,
    fileLabel,
    folderLabel,
    looksRaw,
    PHRASE_ICON,
    type Phrase,
    type PhraseKey,
} from "./step-phrases";
import { type GroupIcon, type GroupStatus, type Step, type TurnItem } from "./turn-grouping";

export interface Headline {
    type: "headline";
    id: string;
    key: PhraseKey;
    icon: GroupIcon;
    steps: Step[];
    /** The phrase of each step, in order (the rows under an opened headline). */
    phrases: Phrase[];
    status: GroupStatus;
    text: string;
    /** Test / check outcome, shown after ": " ("134 passed"). */
    outcome: string;
}

export interface HeadlineNote {
    type: "note";
    id: string;
    text: string;
}

export type HeadlineEntry = Headline | HeadlineNote;

/** Done threads show this many headlines before "Show all". Running threads show every one. */
export const HEADLINES_SHOWN = 8;

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const quoted = (value: string): string => `“${value}”`;

function joinList(items: string[], more = 0, noun = ""): string {
    if (more > 0) return `${items.join(", ")} and ${more} more${noun ? ` ${noun}` : ""}`;
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A sentence's first word lowercased to follow "and", unless it is an acronym ("PR", "CI"). */
function lowerFirst(text: string): string {
    return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** The deepest folder every path shares ("" when they share none). */
function commonFolder(paths: string[]): string {
    const split = paths.map((path) => path.replace(/\/[^/]*$/, "").split("/"));
    const first = split[0] ?? [];
    let n = 0;
    while (n < first.length && split.every((parts) => parts[n] === first[n])) n += 1;
    const shared = first.slice(0, n).join("/");
    return shared.split("/").filter(Boolean).length ? shared : "";
}

/** The pass / fail counts a test run printed (jest, vitest, pytest, node --test), when present. */
export function testCounts(output: string): { passed: number; failed: number } | null {
    const tail = output.slice(-4000);
    const pick = (re: RegExp): number | null => {
        let last: number | null = null;
        for (const match of tail.matchAll(re)) last = Number(match[1]);
        return last;
    };
    // jest "Tests:       2 failed, 134 passed, 136 total"; vitest "Tests  2 failed | 134 passed (136)";
    // pytest "== 2 failed, 134 passed in 3.2s =="; node --test "# pass 134" / "# fail 2".
    const passed = pick(/(\d+) passed\b/g) ?? pick(/^# pass (\d+)/gm);
    const failed = pick(/(\d+) failed\b/g) ?? pick(/^# fail (\d+)/gm);
    if (passed === null && failed === null) return null;
    return { passed: passed ?? 0, failed: failed ?? 0 };
}

function stepOutput(step: Step): string {
    const source = step.source as { type?: string; payload?: Record<string, unknown> } | undefined;
    const output = source?.type === "tool_output" ? source.payload?.output : undefined;
    return typeof output === "string" ? output : "";
}

function testOutcome(steps: Step[]): string {
    // The latest run is authoritative: an earlier run's counts never speak for a later retry.
    const last = steps[steps.length - 1];
    const counts = testCounts(stepOutput(last));
    if (counts) {
        const parts: string[] = [];
        if (counts.failed) parts.push(`${counts.failed} failed`);
        if (counts.passed || !counts.failed) parts.push(`${counts.passed} passed`);
        return parts.join(", ");
    }
    if (last.status === "failed") return "failed";
    if (last.status === "stopped") return "stopped";
    return last.status === "ok" && last.exit === 0 ? "passed" : "";
}

function status(steps: Step[]): GroupStatus {
    const last = steps[steps.length - 1];
    if (last.status === "running") return "running";
    if (last.status === "stopped") return "stopped";
    const failed = steps.some((step) => step.status === "failed");
    if (!failed) return "ok";
    return last.status === "ok" ? "recovered" : "failed";
}

const TIMES = (n: number): string => `${n}×`;

/**
 * Kinds that read as "running commands" to a person skimming: consecutive steps across these
 * fold into one headline ("Ran 4 commands"), each step keeping its own phrase one click deeper
 * ("Ran a Python script", "Queried the journal database"). Reading, searching, editing, tests,
 * checks and the ship steps (commit, push, PR, deploy) keep headlines of their own.
 */
const COMMAND_KINDS: ReadonlySet<PhraseKey> = new Set([
    "script",
    "db",
    "sync",
    "branch",
    "history",
    "files",
    "process",
    "service",
    "logs",
    "install",
    "api",
    "wait",
    "image",
    "screenshot",
    "command",
    "other",
]);

/** The headline family a step's kind belongs to. */
export function familyOf(key: PhraseKey): PhraseKey {
    if (key === "list" || key === "search") return "read";
    return COMMAND_KINDS.has(key) ? "command" : key;
}

/** The headline sentence of a run of same-kind steps. */
export function headlineText(key: PhraseKey, phrases: Phrase[]): string {
    const n = phrases.length;
    if (n === 1) return phrases[0].past;
    const distinct = [...new Set(phrases.map((p) => p.past))];
    const targets = [...new Set(phrases.map((p) => p.target).filter((t): t is string => Boolean(t)))];
    switch (key) {
        case "read": {
            // Reading, listing and searching fold into one headline when they interleave.
            const searched = phrases.filter((p) => p.key === "search");
            if (searched.length === n) return headlineText("search", phrases);
            if (searched.length) {
                const rest = phrases.filter((p) => p.key !== "search");
                const first = lowerFirst(headlineText("read", rest));
                const terms = [...new Set(searched.map((p) => p.target).filter((t): t is string => Boolean(t)))];
                const search =
                    searched.length === 1
                        ? terms.length
                            ? `searched the code for ${quoted(terms[0])}`
                            : "searched the code"
                        : `searched the code ${TIMES(searched.length)}`;
                return `${first[0].toUpperCase()}${first.slice(1)}${first.includes(" and ") ? "," : " and"} ${search}`;
            }
            // Listing folders folds into reading ("Looked through 4 files and 2 folders").
            const listed = phrases.filter((p) => p.key === "list").length;
            if (listed && listed < n) {
                const reads = n - listed;
                const read = new Set(phrases.filter((p) => p.key === "read").map((p) => p.target ?? "")).size;
                const files = Math.max(1, Math.min(reads, read || reads));
                return `Looked through ${files} ${plural(files, "file", "files")} and ${listed} ${plural(listed, "folder", "folders")}`;
            }
            if (listed === n) return headlineText("list", phrases);
            const files = targets.length;
            if (files <= 1 && distinct.length === 1) return `${distinct[0]}${n > 1 ? ` ${TIMES(n)}` : ""}`;
            if (files === 0) return `Read ${n} files`;
            if (files <= 2 && files === n) return `Read ${joinList(targets.map((t) => fileLabel(t)))}`;
            const folder = commonFolder(targets);
            return folder ? `Read ${files} files in ${folderLabel(folder)}` : `Read ${files} files`;
        }
        case "search": {
            const terms = targets.slice(0, 2).map(quoted);
            if (!terms.length) return `Searched the code ${TIMES(n)}`;
            return `Searched the code for ${joinList(terms, Math.max(0, targets.length - 2))}`;
        }
        case "list":
            if (targets.length === 1)
                return distinct.length === 1 ? distinct[0] : `Looked through ${folderLabel(targets[0])}`;
            return targets.length ? `Looked through ${targets.length} folders` : "Looked through the files";
        case "edit": {
            const names = [...new Set(targets.map((t) => fileLabel(t)))];
            const created = phrases.every((p) => /^(Created|Wrote) /.test(p.past));
            const verb = created ? "Created" : "Edited";
            if (!names.length) return `${verb} files`;
            return names.length > 3
                ? `${verb} ${joinList(names.slice(0, 2), names.length - 2, "files")}`
                : `${verb} ${joinList(names)}`;
        }
        case "test":
            return n > 1 ? `Ran the test suite ${TIMES(n)}` : "Ran the test suite";
        case "helper":
            return `Started ${n} helpers`;
        case "script":
            return distinct.length === 1 ? `${distinct[0]} ${TIMES(n)}` : `Ran ${n} scripts`;
        case "web": {
            if (distinct.length === 1) return `${distinct[0]} ${TIMES(n)}`;
            const searches = phrases.filter((p) => /^Searched the web/.test(p.past)).length;
            if (searches === n) return `Searched the web ${TIMES(n)}`;
            return `Looked at ${n} web pages`;
        }
        case "wait":
            return "Waited";
        case "command": {
            const kinds = new Set(phrases.map((p) => p.key));
            if (kinds.size === 1) {
                const only = phrases[0].key;
                if (only !== "command" && only !== "other") return headlineText(only, phrases);
            }
            if (distinct.length === 1) return `${distinct[0]} ${TIMES(n)}`;
            return `Ran ${n} commands`;
        }
        default:
            break;
    }
    if (distinct.length === 1) return `${distinct[0]} ${TIMES(n)}`;
    if (distinct.length === 2) return `${distinct[0]} and ${lowerFirst(distinct[1])}`;
    return KEY_SUMMARY[key];
}

const KEY_SUMMARY: Record<PhraseKey, string> = {
    read: "Read files",
    list: "Looked through the files",
    search: "Searched the code",
    edit: "Edited files",
    test: "Ran the tests",
    check: "Checked the code",
    format: "Formatted the code",
    build: "Built the app",
    install: "Installed dependencies",
    deploy: "Deployed",
    pr: "Worked on the PR",
    ci: "Checked the PR and CI",
    github: "Worked on GitHub",
    commit: "Saved commits",
    push: "Pushed the branch",
    branch: "Updated the branch",
    sync: "Fetched the latest code",
    history: "Checked the repository",
    review: "Asked Codex",
    service: "Checked the services",
    logs: "Read the service logs",
    db: "Queried a database",
    script: "Ran scripts",
    web: "Looked at web pages",
    api: "Called APIs",
    files: "Organised files",
    wait: "Waited",
    screenshot: "Took screenshots",
    image: "Processed images",
    process: "Checked what's running",
    helper: "Started helpers",
    tracker: "Updated the tracker",
    message: "Sent messages",
    todo: "Updated the to-do list",
    skill: "Used skills",
    env: "Checked the environment",
    command: "Ran commands",
    other: "Did other steps",
};

/** Kinds that fold into their neighbour's run instead of making a headline of their own. */
const MINOR: ReadonlySet<PhraseKey> = new Set(["env", "todo"]);

/**
 * Items → headlines, in order. Consecutive steps of the same kind make one headline; narration
 * ends the run (it is shown between headlines as one plain line). A to-do update or an
 * environment check folds into the run around it rather than splitting it.
 */
export function buildHeadlines(items: readonly TurnItem[], running?: Step | null): HeadlineEntry[] {
    const out: HeadlineEntry[] = [];
    let current: Headline | null = null;
    const close = (): void => {
        if (current) out.push(finish(current));
        current = null;
    };
    const all: TurnItem[] = running ? [...items, { ...running, status: "running" }] : [...items];
    all.forEach((raw, index) => {
        // Narration that reads as machine text (an indicator line the grammar could not take, a
        // pasted command) is never printed: it joins the steps as the command it most likely is.
        const item: TurnItem =
            raw.kind === "narration" && looksRaw(raw.text)
                ? (indicatorStep(raw.text, `raw-${index}`, true) ?? {
                      kind: "step",
                      id: `raw-${index}`,
                      tool: "Bash",
                      // The text itself stays one click deeper (the step detail), never in a row.
                      input: { command: "", description: raw.text },
                      status: "ok",
                  })
                : raw;
        if (item.kind === "narration") {
            close();
            out.push({ type: "note", id: `note-${index}`, text: item.text });
            return;
        }
        const p = describeStep(item);
        const family = familyOf(p.key);
        if (current && (current.key === family || (MINOR.has(p.key) && item.status !== "running"))) {
            current.steps.push(item);
            current.phrases.push(p);
            return;
        }
        if (current && MINOR.has(current.key) && current.steps.every((s) => s.status !== "running")) {
            // A lone to-do / environment run adopts the kind that follows it.
            current.key = family;
            current.steps.push(item);
            current.phrases.push(p);
            return;
        }
        close();
        current = {
            type: "headline",
            id: `h-${item.id}`,
            key: family,
            icon: PHRASE_ICON[family],
            steps: [item],
            phrases: [p],
            status: "ok",
            text: "",
            outcome: "",
        };
    });
    close();
    return out;
}

function finish(headline: Headline): Headline {
    // Folded minor steps do not name the headline: the run's own kind does.
    const own = headline.phrases.filter((p) => familyOf(p.key) === headline.key);
    const phrases = own.length ? own : headline.phrases;
    const key = own.length ? headline.key : familyOf(phrases[0].key);
    headline.key = key;
    // A command run of one kind keeps that kind's icon (a database query, a screenshot).
    const kinds = new Set(phrases.map((p) => p.key));
    headline.icon = PHRASE_ICON[kinds.size === 1 ? phrases[0].key : key];
    headline.status = status(headline.steps);
    const ownSteps = headline.steps.filter((_, i) => familyOf(headline.phrases[i].key) === key);
    if (headline.status === "running") {
        headline.text = headline.phrases[headline.phrases.length - 1].live;
    } else {
        headline.text = headlineText(key, phrases);
    }
    if ((key === "test" || key === "check") && headline.status !== "running") {
        headline.outcome = key === "test" ? testOutcome(ownSteps) : checkOutcome(ownSteps);
    } else if (headline.status === "failed") {
        headline.outcome = "failed";
    } else if (headline.status === "stopped") {
        headline.outcome = "stopped";
    } else if (headline.status === "recovered") {
        headline.outcome = "worked on a retry";
    }
    return headline;
}

function checkOutcome(steps: Step[]): string {
    const last = steps[steps.length - 1];
    if (last.status === "failed") return "problems found";
    if (last.status === "stopped") return "stopped";
    return last.exit === 0 ? "clean" : "";
}

/** The row text: the sentence, then ": outcome" when there is one. */
export function headlineRowText(headline: Headline): string {
    return headline.outcome ? `${headline.text}: ${headline.outcome}` : headline.text;
}

/** Headline count (notes excluded). */
export function headlineCount(entries: readonly HeadlineEntry[]): number {
    return entries.filter((entry) => entry.type === "headline").length;
}

/**
 * The entries shown before "Show all": every one while running; once done, the last
 * HEADLINES_SHOWN headlines (with the notes between them).
 */
export function visibleHeadlines(
    entries: readonly HeadlineEntry[],
    running: boolean,
    showAll: boolean,
): {
    shown: HeadlineEntry[];
    hidden: number;
} {
    if (running || showAll) return { shown: [...entries], hidden: 0 };
    let seen = 0;
    let start = entries.length;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].type === "headline") {
            if (seen === HEADLINES_SHOWN) break;
            seen += 1;
        }
        start = i;
    }
    const hidden = headlineCount(entries.slice(0, start));
    return { shown: entries.slice(start), hidden };
}
