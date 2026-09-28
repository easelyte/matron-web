/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The "Under the hood" activity-grouping algorithm (redesign v6, GENERATIVE-SYSTEM §1).
 *
 * A TypeScript port of docs/design/redesign-v6/src/model.js → CLASSES, groupTurn, stepSentence,
 * liveLine, changedFiles. Pure: no DOM, no React, no client. Input is the card's content for
 * one operator turn — steps and narration, in the order they happened (turn-assembly.ts builds
 * that from journal events). Break-throughs never reach this module.
 *
 * Every string produced here is a CLIENT TEMPLATE (§ CONTRACTS 1): the design supplies none of
 * them, the agent supplies only its narration.
 */

/** "stopped": the command never reported an exit (killed, or the session died under it). */
export type StepStatus = "ok" | "failed" | "running" | "stopped";

export interface StepInput {
    /** File path (Read / Edit / Write / diff events). Full path; sentences use the basename. */
    path?: string;
    /** Shell command (Bash / Codex `shell`). */
    command?: string;
    /** Search pattern (Grep / Glob). */
    pattern?: string;
    /** URL (WebFetch / Browser). */
    url?: string;
    /** Helper task description (Task / Agent). */
    description?: string;
    /** Free-form qualifier shown only in deep detail ("lines 200–260"). */
    note?: string;
}

export interface Step {
    kind: "step";
    id: string;
    /** Tool name as the agent reported it: Bash, Read, Edit, Write, apply_patch, shell, … */
    tool: string;
    input: StepInput;
    status: StepStatus;
    /** Exit code of a command; null = the process never reported one (killed). */
    exit?: number | null;
    /** Duration in ms, when known. */
    ms?: number;
    /** Line counts of a change step. */
    added?: number;
    removed?: number;
    /** Change step created the file rather than editing it. */
    newFile?: boolean;
    /** Opaque back-reference for renderers (the journal event). Never read here. */
    source?: unknown;
}

export interface Narration {
    kind: "narration";
    text: string;
}

export type TurnItem = Step | Narration;

export type ActivityClass =
    "look" | "search" | "change" | "test" | "check" | "history" | "git" | "helper" | "web" | "run" | "other";

export type GroupIcon =
    "file" | "search" | "pencil" | "flask" | "shield" | "history" | "branch" | "helper" | "globe" | "terminal" | "dot";

export type GroupStatus = "ok" | "recovered" | "failed" | "running" | "stopped";

export interface Group {
    type: "group";
    /** Stable within a turn: `${class}-${seqIndex}-${segmentIndex}` (same scheme as model.js). */
    id: string;
    key: ActivityClass;
    icon: GroupIcon;
    steps: Step[];
    status: GroupStatus;
    sentence: string;
    /** Appended after ": " in the row. Empty when the class carries no outcome text. */
    outcomeText: string;
}

export interface NarrationEntry {
    type: "narration";
    text: string;
}

export type SequenceEntry = Group | NarrationEntry;

export interface ChangedFile {
    path: string;
    name: string;
    added: number;
    removed: number;
    /** The LAST change step for this path — its deep view (decision §7.4). */
    stepId: string;
}

const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command", "container.exec"]);

/** True for a step whose `input.command` is a shell command line. */
export function isShellStep(step: Pick<Step, "tool">): boolean {
    return SHELL_TOOLS.has(step.tool);
}

/**
 * The command a shell step actually runs, stripped of the wrappers agents put around it so the
 * `^`-anchored class rules see the real program: Codex's `bash -lc '…'`, a leading
 * `cd <dir> &&`, and leading `VAR=value` assignments.
 */
export function normalizeCommand(raw: string): string {
    let cmd = raw.trim();
    for (let guard = 0; guard < 8; guard += 1) {
        const before = cmd;
        const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(cmd);
        if (wrapped) cmd = wrapped[2].trim();
        cmd = cmd.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
        cmd = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
        if (cmd === before) break;
    }
    return cmd;
}

/** The (normalized) command of a shell step, "" for every other tool. */
export function commandOf(step: Pick<Step, "tool" | "input">): string {
    return isShellStep(step) ? normalizeCommand(String(step.input.command ?? "")) : "";
}

export function basename(path: string | undefined): string {
    return (
        String(path ?? "")
            .split(/[\\/]/)
            .filter(Boolean)
            .pop() || "file"
    );
}

function host(url: string | undefined): string {
    try {
        return new URL(String(url)).host || String(url ?? "");
    } catch {
        return String(url ?? "");
    }
}

interface ClassRule {
    key: ActivityClass;
    icon: GroupIcon;
    test: (step: Step) => boolean;
}

/** A git invocation: its arguments (a commit message saying "lint") never make it a test or check. */
const isGitCommand = (step: Step): boolean => /^git\s/.test(commandOf(step));

const CHANGE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "file_change"]);

/** Activity classes, first match wins (GENERATIVE-SYSTEM §1 table). */
export const CLASSES: readonly ClassRule[] = [
    {
        key: "look",
        icon: "file",
        test: (s) =>
            ["Read", "NotebookRead"].includes(s.tool) || /^(cat|head|tail|sed -n|less|wc)\b/.test(commandOf(s)),
    },
    {
        key: "search",
        icon: "search",
        test: (s) => ["Grep", "Glob", "Search"].includes(s.tool) || /^(rg|grep|find|fd|ls)\b/.test(commandOf(s)),
    },
    { key: "change", icon: "pencil", test: (s) => CHANGE_TOOLS.has(s.tool) },
    {
        key: "test",
        icon: "flask",
        test: (s) =>
            !isGitCommand(s) &&
            /\b(vitest|jest|pytest|playwright|go test|cargo test|(pnpm|npm|yarn) (run )?test)\b/.test(commandOf(s)),
    },
    {
        key: "check",
        icon: "shield",
        test: (s) => !isGitCommand(s) && /\b(tsc|typecheck|eslint|oxlint|mypy|ruff|lint)\b/.test(commandOf(s)),
    },
    { key: "history", icon: "history", test: (s) => /^git (log|show|blame|diff|status)\b/.test(commandOf(s)) },
    {
        key: "git",
        icon: "branch",
        test: (s) => /^git (push|commit|switch|checkout|merge|rebase|pull|add)\b/.test(commandOf(s)),
    },
    { key: "helper", icon: "helper", test: (s) => ["Task", "Agent"].includes(s.tool) },
    { key: "web", icon: "globe", test: (s) => ["WebFetch", "WebSearch", "Browser"].includes(s.tool) },
    { key: "run", icon: "terminal", test: (s) => isShellStep(s) },
    { key: "other", icon: "dot", test: () => true },
];

export function classify(step: Step): ClassRule {
    // The last rule matches everything, so find() never misses.
    return CLASSES.find((rule) => rule.test(step))!;
}

const isLint = (step: Step): boolean => /lint/.test(commandOf(step));

/** Past-tense sentence for one step (a row in an opened group). */
export function stepSentence(step: Step): string {
    const c = classify(step).key;
    const i = step.input;
    if (step.tool === "Read") return `Read ${basename(i.path)}`;
    if (step.tool === "Grep") return `Searched for ${i.pattern ?? ""}`.trim();
    if (step.tool === "Glob") return `Looked for files named ${i.pattern ?? ""}`.trim();
    if (c === "change")
        return (step.tool === "Write" && step.newFile !== false) || step.newFile
            ? `Created ${basename(i.path)}`
            : `Changed ${basename(i.path)}`;
    if (c === "test") return "Ran the tests";
    if (c === "check") return isLint(step) ? "Checked the code style" : "Checked the types";
    if (c === "history") return /^git log\b/.test(commandOf(step)) ? "Checked the history" : "Looked at what changed";
    if (c === "git") {
        const cmd = commandOf(step);
        return /^git push\b/.test(cmd)
            ? "Pushed the branch"
            : /^git commit\b/.test(cmd)
              ? "Saved a commit"
              : "Updated the branch";
    }
    if (c === "helper") return `Asked a helper to ${i.description ?? "help"}`;
    if (step.tool === "Browser") return `Took a screenshot of ${host(i.url)}`;
    if (c === "web") return `Opened ${host(i.url)}`;
    if (c === "look") return `Read ${basename(i.path ?? lastArg(commandOf(step)))}`;
    if (c === "search") return "Searched the code";
    if (c === "run") return "Ran a command";
    return "Did a step";
}

/** The last whitespace-separated argument of a command (the file of `cat x` / `head -n 5 x`). */
function lastArg(cmd: string): string {
    const parts = cmd.split(/\s+/).filter((part) => part && !part.startsWith("-"));
    return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** Present-progressive live line for the step that is running now (§2). */
export function liveLine(step: Step): string {
    const c = classify(step).key;
    const i = step.input;
    if (step.tool === "Read") return `Reading ${basename(i.path)}…`;
    if (step.tool === "Grep") return `Searching for ${i.pattern ?? ""}…`;
    if (step.tool === "Glob") return "Looking for files…";
    if (c === "search") return "Searching the code…";
    if (c === "look") return lastArg(commandOf(step)) ? `Reading ${basename(lastArg(commandOf(step)))}…` : "Reading…";
    if (c === "change") return `Changing ${basename(i.path)}…`;
    if (c === "test") return "Running the tests…";
    if (c === "check") return isLint(step) ? "Checking the code style…" : "Checking the types…";
    if (c === "history") return "Checking the history…";
    if (c === "git") return "Updating the branch…";
    if (c === "helper") return `Asking a helper to ${i.description ?? "help"}…`;
    if (c === "web") return "Looking at a web page…";
    return "Working…";
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

interface Outcome {
    status: GroupStatus;
    text: string;
}

function outcome(steps: Step[]): Outcome {
    const failed = steps.filter((step) => step.status === "failed").length;
    const last = steps[steps.length - 1];
    if (last.status === "running") return { status: "running", text: "" };
    // A command that never reported an exit is not a pass: it was stopped under the agent.
    if (last.status === "stopped") return { status: "stopped", text: "stopped" };
    if (!failed) return { status: "ok", text: "passed" };
    if (last.status === "ok") {
        return {
            status: "recovered",
            text: failed === 1 ? "failed once, then passed" : `failed ${failed}×, then passed`,
        };
    }
    return { status: "failed", text: "failed" };
}

/** The file a step touches: its path, or the file argument of a shell read (`cat x`, `sed -n … x`). */
export function stepPath(step: Step): string | undefined {
    if (step.input.path) return step.input.path;
    if (isShellStep(step) && classify(step).key === "look") return lastArg(commandOf(step)) || undefined;
    return undefined;
}

function distinctPaths(steps: Step[]): string[] {
    return [...new Set(steps.map(stepPath).filter((path): path is string => Boolean(path)))];
}

function groupSentence(key: ActivityClass, steps: Step[]): string {
    const k = steps.length;
    const paths = distinctPaths(steps);
    switch (key) {
        case "look":
            if (paths.length === 0) return k === 1 ? stepSentence(steps[0]) : `Looked through ${k} files`;
            return paths.length === 1 ? `Read ${basename(paths[0])}` : `Looked through ${paths.length} files`;
        case "search":
            return k === 1 ? "Searched the code" : `Searched the code ${k}×`;
        case "change": {
            const n = Math.max(paths.length, paths.length === 0 ? k : 0);
            return `Changed ${n} ${plural(n, "file", "files")}`;
        }
        case "test":
            return "Ran the tests";
        case "check":
            return steps.every(isLint) ? "Checked the code style" : "Checked the types";
        case "history":
            return k === 1 ? "Checked the history" : `Checked the history ${k}×`;
        case "git":
            return k === 1 ? stepSentence(steps[0]) : `Updated the branch ${k}×`;
        case "helper":
            return k === 1 ? `Asked a helper: ${steps[0].input.description ?? "a task"}` : `Asked ${k} helpers`;
        case "web":
            return k === 1 ? stepSentence(steps[0]) : `Looked at ${k} web pages`;
        case "run":
            return k === 1 ? "Ran a command" : `Ran ${k} commands`;
        default:
            return `Did ${k} other ${plural(k, "step", "steps")}`;
    }
}

/**
 * groupTurn(items, running?) → the card body's sequence of narration and groups.
 *
 * Rules (§1): narration closes the current segment and is emitted as connective text; inside a
 * segment steps merge by activity class, and groups are ordered by the first occurrence of
 * their class. Steps never merge across narration. `running`, when given, is the step that is
 * executing now; it joins its group as the last step and turns that group's sentence into the
 * live line.
 */
export function groupTurn(items: readonly TurnItem[], running?: Step | null): SequenceEntry[] {
    const seq: SequenceEntry[] = [];
    let segment: { map: Map<ActivityClass, Group>; order: ActivityClass[] } | null = null;
    const flush = (): void => {
        if (!segment) return;
        for (const key of segment.order) seq.push(segment.map.get(key)!);
        segment = null;
    };
    const all: TurnItem[] = running ? [...items, running] : [...items];
    for (const item of all) {
        if (item.kind === "narration") {
            flush();
            seq.push({ type: "narration", text: item.text });
            continue;
        }
        const rule = classify(item);
        if (!segment) segment = { map: new Map(), order: [] };
        let group = segment.map.get(rule.key);
        if (!group) {
            group = {
                type: "group",
                id: `${rule.key}-${seq.length}-${segment.order.length}`,
                key: rule.key,
                icon: rule.icon,
                steps: [],
                status: "ok",
                sentence: "",
                outcomeText: "",
            };
            segment.map.set(rule.key, group);
            segment.order.push(rule.key);
        }
        group.steps.push(item);
    }
    flush();
    for (const entry of seq) {
        if (entry.type !== "group") continue;
        const o = outcome(entry.steps);
        entry.status = o.status;
        entry.sentence = groupSentence(entry.key, entry.steps);
        entry.outcomeText =
            (entry.key === "test" || entry.key === "check") && o.status !== "running"
                ? o.text
                : o.status === "recovered"
                  ? "one step failed, then worked"
                  : o.status === "failed" || o.status === "stopped"
                    ? o.text
                    : "";
        if (o.status === "running") entry.sentence = liveLine(entry.steps[entry.steps.length - 1]).replace(/…$/, "");
    }
    return seq;
}

/** The row text of a group: sentence plus ": outcome" when there is one. */
export function groupRowText(group: Group): string {
    return group.outcomeText ? `${group.sentence}: ${group.outcomeText}` : group.sentence;
}

/**
 * Step-row sentences for an opened group, with the §1 repeat rule applied: a step whose
 * sentence equals the previous step's gets " again" appended. That is the only de-duplication.
 */
export function stepRowSentences(steps: readonly Step[]): string[] {
    return steps.map((step, index) => {
        const sentence = stepSentence(step);
        return index > 0 && stepSentence(steps[index - 1]) === sentence ? `${sentence} again` : sentence;
    });
}

export function stepsOf(items: readonly TurnItem[]): Step[] {
    return items.filter((item): item is Step => item.kind === "step");
}

/** Changed-files block: added/removed summed per path, the last change step as its deep view. */
export function changedFiles(items: readonly TurnItem[]): ChangedFile[] {
    const map = new Map<string, ChangedFile>();
    for (const step of stepsOf(items)) {
        if (classify(step).key !== "change" || !step.input.path) continue;
        const path = step.input.path;
        const file = map.get(path) ?? { path, name: basename(path), added: 0, removed: 0, stepId: step.id };
        file.added += step.added ?? 0;
        file.removed += step.removed ?? 0;
        file.stepId = step.id;
        map.set(path, file);
    }
    return [...map.values()];
}

/** Any step failed along the way — the done glyph turns amber (§ decisions: card glyph). */
export function turnIssues(items: readonly TurnItem[]): boolean {
    return stepsOf(items).some((step) => step.status === "failed" || step.status === "stopped");
}

/**
 * The deep view of a failed command also shows its passing rerun (decision §7.6): the NEXT ok
 * step in the same group with the same command.
 */
export function passingRerun(step: Step, groupSteps: readonly Step[]): Step | undefined {
    if (step.status !== "failed") return undefined;
    const index = groupSteps.indexOf(step);
    if (index < 0) return undefined;
    const cmd = commandOf(step);
    return groupSteps.slice(index + 1).find((next) => next.status === "ok" && commandOf(next) === cmd);
}

/** Card meta duration: `Ns` · `Nm SSs` · `Nh MMm` (§4). */
export function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Live-line elapsed counter: `42s` below a minute, `1m 04s` from 60s (§2). */
export function formatElapsed(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** `{n} steps` / `1 step`. */
export function stepCount(n: number): string {
    return `${n} ${plural(n, "step", "steps")}`;
}
