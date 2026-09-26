/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Plain-English phrases for one agent step (Developer view OFF): the helper thread's headlines
 * and the sidebar preview line share this one categoriser.
 *
 * A step is a turn-grouping Step (a Claude tool call, a Codex command, a diff). Shell commands
 * are read the way a person would skim them: the command is split into its stages (`;`, `&&`,
 * `||`, pipes, newlines; quote-aware, heredoc bodies set aside), wrappers are peeled
 * (`cd x &&`, `VAR=…`, `systemd-run --scope …`, `bash -c "…"`, `git -C dir`), each stage is
 * classified, and the stage that says the most about intent wins (a test run beats the `cd`
 * before it, a commit beats the `git add`). Inline scripts are named by what they are (a Python
 * script, a database query), never printed.
 *
 * Every string produced here is a client template. Nothing here ever returns raw command text:
 * an unrecognised step falls back to a neutral "Worked on {file}" / "Ran {program}" phrase, and
 * the only agent-supplied fragments are a file's basename, a folder's last segments, a search
 * term (quoted, shortened), a host name and a helper's task description.
 */

import { basename, type GroupIcon, isShellStep, type Step } from "./turn-grouping";

export type PhraseKey =
    | "read"
    | "list"
    | "search"
    | "edit"
    | "test"
    | "check"
    | "format"
    | "build"
    | "install"
    | "deploy"
    | "pr"
    | "ci"
    | "github"
    | "commit"
    | "push"
    | "branch"
    | "sync"
    | "history"
    | "review"
    | "service"
    | "logs"
    | "db"
    | "script"
    | "web"
    | "api"
    | "files"
    | "wait"
    | "screenshot"
    | "image"
    | "process"
    | "helper"
    | "tracker"
    | "message"
    | "todo"
    | "skill"
    | "env"
    | "command"
    | "other";

export interface Phrase {
    key: PhraseKey;
    /** Past tense ("Read paths.py"). */
    past: string;
    /** Present progressive, no ellipsis ("Reading paths.py"). */
    live: string;
    /** What the phrase is about, for grouping sentences: a path, a search term, a folder. */
    target?: string;
    /** The phrase is the neutral fallback (the step was not recognised). */
    fallback?: boolean;
    /** Priority when a compound command has several stages (higher says more). */
    weight: number;
}

export const PHRASE_ICON: Record<PhraseKey, GroupIcon> = {
    read: "file",
    list: "search",
    search: "search",
    edit: "pencil",
    test: "flask",
    check: "shield",
    format: "shield",
    build: "terminal",
    install: "terminal",
    deploy: "branch",
    pr: "branch",
    ci: "shield",
    github: "branch",
    commit: "branch",
    push: "branch",
    branch: "branch",
    sync: "branch",
    history: "history",
    review: "helper",
    service: "terminal",
    logs: "file",
    db: "terminal",
    script: "terminal",
    web: "globe",
    api: "globe",
    files: "file",
    wait: "dot",
    screenshot: "globe",
    image: "file",
    process: "terminal",
    helper: "helper",
    tracker: "dot",
    message: "dot",
    todo: "dot",
    skill: "dot",
    env: "terminal",
    command: "terminal",
    other: "dot",
};

const WEIGHT: Record<PhraseKey, number> = {
    deploy: 100,
    pr: 92,
    push: 90,
    commit: 88,
    test: 85,
    check: 80,
    format: 78,
    build: 76,
    review: 75,
    install: 70,
    edit: 65,
    db: 60,
    branch: 58,
    sync: 55,
    ci: 52,
    github: 50,
    screenshot: 48,
    web: 47,
    api: 46,
    script: 45,
    service: 42,
    logs: 40,
    search: 35,
    read: 30,
    history: 28,
    files: 25,
    list: 22,
    image: 21,
    process: 20,
    helper: 60,
    tracker: 30,
    message: 30,
    todo: 10,
    skill: 30,
    wait: 8,
    env: 4,
    command: 3,
    other: 2,
};

function phrase(key: PhraseKey, past: string, live: string, target?: string, fallback = false): Phrase {
    return { key, past, live, target, fallback, weight: WEIGHT[key] };
}

// ---------------------------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------------------------

interface Simple {
    words: string[];
    /** Redirect targets written to (`> f`, `>> f`, `tee f` is handled by the program). */
    writes: string[];
    /** Body of a heredoc feeding this command, when there is one. */
    heredoc?: string;
    /** Position in its pipeline (0 = the producer). */
    pipeIndex: number;
}

/** Heredoc bodies set aside: `cmd <<'EOF'\n…\nEOF` → the command line plus its body. */
function splitHeredocs(raw: string): { text: string; bodies: string[] } {
    const lines = raw.split("\n");
    const out: string[] = [];
    const bodies: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const marker = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
        if (!marker) {
            out.push(line);
            continue;
        }
        const tag = marker[2];
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j += 1) {
            if (lines[j].trim() === tag) break;
            body.push(lines[j]);
        }
        // The heredoc's index rides on the line as a placeholder the tokenizer keeps.
        out.push(line.replace(marker[0], ` \u0000HEREDOC${bodies.length}\u0000 `));
        bodies.push(body.join("\n"));
        i = j;
    }
    return { text: out.join("\n"), bodies };
}

/**
 * Quote-aware split into simple commands. Separators: newline, `;`, `&`, `&&`, `||`, `|`.
 * `$(…)` and backticks are kept inside their word. Returns words with quotes removed.
 */
function parseShell(raw: string): Simple[] {
    const { text, bodies } = splitHeredocs(raw);
    const result: Simple[] = [];
    let words: string[] = [];
    let quotedWords: boolean[] = [];
    let word = "";
    let hasWord = false;
    let wasQuoted = false;
    let pipeIndex = 0;
    let quote: "'" | '"' | "`" | null = null;
    let depth = 0;
    const endWord = (): void => {
        if (hasWord) {
            words.push(word);
            quotedWords.push(wasQuoted);
        }
        word = "";
        hasWord = false;
        wasQuoted = false;
    };
    const endCommand = (pipe: boolean): void => {
        endWord();
        if (words.length) result.push(toSimple(words, quotedWords, pipeIndex, bodies));
        words = [];
        quotedWords = [];
        pipeIndex = pipe ? pipeIndex + 1 : 0;
    };
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            // Inside double quotes a backslash escapes only $ ` " \ and a newline (bash).
            if (ch === "\\" && quote === '"' && i + 1 < text.length && /[$`"\\\n]/.test(text[i + 1])) {
                word += text[i + 1];
                i += 1;
            } else if (ch === quote) quote = null;
            else word += ch;
            continue;
        }
        if (depth > 0) {
            word += ch;
            if (ch === "(") depth += 1;
            else if (ch === ")") depth -= 1;
            continue;
        }
        if (ch === "\\" && i + 1 < text.length) {
            if (text[i + 1] !== "\n") word += text[i + 1];
            hasWord = true;
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            hasWord = true;
            wasQuoted = true;
            continue;
        }
        if (ch === "$" && text[i + 1] === "(") {
            word += "$(";
            hasWord = true;
            depth = 1;
            i += 1;
            continue;
        }
        if (ch === "#" && !hasWord && (i === 0 || /\s/.test(text[i - 1]))) {
            // A comment runs to the end of the line.
            while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
            continue;
        }
        if (ch === "\n" || ch === ";") {
            endCommand(false);
            continue;
        }
        if (ch === "&") {
            if (text[i + 1] === "&") i += 1;
            else if (text[i - 1] === ">" || text[i + 1] === ">") {
                word += ch;
                hasWord = true;
                continue;
            }
            endCommand(false);
            continue;
        }
        if (ch === "|") {
            if (text[i + 1] === "|") {
                i += 1;
                endCommand(false);
            } else endCommand(true);
            continue;
        }
        if (/\s/.test(ch)) {
            endWord();
            continue;
        }
        if ((ch === "(" || ch === ")" || ch === "{" || ch === "}") && !hasWord) {
            endWord();
            continue;
        }
        word += ch;
        hasWord = true;
    }
    endCommand(false);
    return result;
}

function toSimple(raw: string[], quoted: boolean[], pipeIndex: number, bodies: string[]): Simple {
    const words: string[] = [];
    const writes: string[] = [];
    let heredoc: string | undefined;
    for (let i = 0; i < raw.length; i += 1) {
        const w = raw[i];
        if (quoted[i]) {
            words.push(w);
            continue;
        }
        const doc = /^\u0000HEREDOC(\d+)\u0000$/.exec(w);
        if (doc) {
            heredoc = bodies[Number(doc[1])] ?? "";
            continue;
        }
        const redirect = /^(\d?>>?|&>>?)(.*)$/.exec(w);
        if (redirect) {
            const target = redirect[2] || raw[i + 1] || "";
            if (!redirect[2]) i += 1;
            if (target && !/^&\d$/.test(target) && !/^\/dev\//.test(target)) writes.push(target);
            continue;
        }
        if (/^\d?<$/.test(w)) {
            i += 1;
            continue;
        }
        if (/^\d?<[^<]/.test(w) || w === "<<<") continue;
        words.push(w);
    }
    return { words, writes, heredoc, pipeIndex };
}

const KEYWORDS = new Set([
    "do",
    "then",
    "else",
    "elif",
    "if",
    "while",
    "until",
    "!",
    "time",
    "exec",
    "command",
    "builtin",
]);
const CLOSERS = new Set(["done", "fi", "esac", "}", ")", "{", "("]);

/** Peel wrappers: assignments, sudo/timeout/nice/env/nohup/flock/systemd-run/xargs, keywords. */
function peel(words: string[], vars: Map<string, string[]>): string[] {
    let w = [...words];
    for (let guard = 0; guard < 12 && w.length; guard += 1) {
        const first = w[0];
        if (KEYWORDS.has(first)) {
            w = w.slice(1);
            continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
            w = w.slice(1);
            continue;
        }
        const name = first.replace(/^.*\//, "");
        if (name === "sudo" || name === "nohup" || name === "nice" || name === "stdbuf" || name === "unbuffer") {
            w = w.slice(1);
            while (w[0]?.startsWith("-")) w = w.slice(1);
            continue;
        }
        if (name === "env") {
            w = w.slice(1);
            while (w[0] && (w[0].startsWith("-") || /^[A-Za-z_]\w*=/.test(w[0])))
                w = w.slice(/^(-u|--unset|-C|--chdir|-S|--split-string)$/.test(w[0]) ? 2 : 1);
            continue;
        }
        if (name === "timeout") {
            w = w.slice(1);
            while (w[0]?.startsWith("-")) w = w.slice(1);
            w = w.slice(1);
            continue;
        }
        if (name === "flock") {
            w = w.slice(1);
            while (w[0]?.startsWith("-")) w = w.slice(1);
            w = w.slice(1);
            continue;
        }
        if (name === "xargs") {
            w = w.slice(1);
            while (w[0]?.startsWith("-")) w = w.slice(/^-[IdnLPsE]$/.test(w[0]) ? 2 : 1);
            continue;
        }
        if (name === "systemd-run") {
            w = w.slice(1);
            while (w[0]?.startsWith("-"))
                w = w.slice(
                    /^-[pEu]$/.test(w[0]) || /^--(property|setenv|unit|uid|gid|slice|working-directory)$/.test(w[0])
                        ? 2
                        : 1,
                );
            continue;
        }
        if (name === "npx" || name === "bunx") {
            w = w.slice(1);
            while (w[0]?.startsWith("-")) w = w.slice(/^--(prefix|package|p)$/.test(w[0]) || w[0] === "-p" ? 2 : 1);
            continue;
        }
        const variable = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(first);
        if (variable && vars.has(variable[1])) {
            w = [...vars.get(variable[1])!, ...w.slice(1)];
            continue;
        }
        break;
    }
    return w;
}

const PATHISH = /^(?:\/|~\/|\.\.?\/|\$\w+\/|[\w@.-]+\/)[^\s]*$|^[\w@.-]+\.[A-Za-z0-9]{1,6}$/;

function isPath(word: string | undefined): word is string {
    return Boolean(word) && PATHISH.test(word!) && !/^[\d,.$p;]+$/.test(word!) && !word!.includes("://");
}

/** Non-flag arguments; flags listed in `withValue` consume the next word. */
function args(words: string[], withValue: RegExp = /^$/): string[] {
    const out: string[] = [];
    for (let i = 1; i < words.length; i += 1) {
        const w = words[i];
        if (w === "--") {
            out.push(...words.slice(i + 1));
            break;
        }
        if (w.startsWith("-") && w.length > 1) {
            if (withValue.test(w) && !w.includes("=")) i += 1;
            continue;
        }
        out.push(w);
    }
    return out;
}

function lastPath(words: string[], withValue?: RegExp): string | undefined {
    return args(words, withValue).filter(isPath).pop();
}

function short(value: string, max = 40): string {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A search pattern made readable: escapes and anchors dropped; null when it is mostly syntax. */
export function readablePattern(pattern: string | undefined): string | null {
    if (!pattern) return null;
    let p = pattern
        .replace(/\\([|().[\]{}*+?^$\\/-])/g, "$1")
        .replace(/\\[bBwWsSdD]/g, "")
        .replace(/^\^|\$$/g, "")
        .replace(/^\.\*|\.\*$/g, "")
        .replace(/\(\?[:!=i]/g, "(")
        .replace(/\.[*+?]/g, " … ")
        .replace(/(\S)[*+?]/g, "$1")
        .replace(/\{\d+(,\d*)?\}/g, "")
        .trim();
    if (/^\((.*)\)$/.test(p) && !/[()]/.test(p.slice(1, -1))) p = p.slice(1, -1);
    // A shell variable inside the pattern (`"\b$s\b"` in a loop) says nothing on its own.
    if (!p || /\$\{?\w/.test(p)) return null;
    const symbols = p.replace(/[\w\s|.,:@/'"-]/g, "").length;
    if (symbols / p.length > 0.25) return null;
    p = p.replace(/\|/g, " | ");
    return short(p, 44);
}

const quote = (value: string): string => `“${value}”`;

/** A folder's last two segments ("anton/core"). */
export function folderLabel(path: string): string {
    const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
    const label = parts.slice(-2).join("/") || path;
    return /[()"'`=;<>{}[\]\s$\\*?]/.test(label) || /…$/u.test(label) ? "a folder" : label;
}

const TRIVIAL = new Set([
    "echo",
    "printf",
    "cd",
    "pwd",
    "export",
    "set",
    "unset",
    "source",
    ".",
    "true",
    "false",
    ":",
    "exit",
    "return",
    "which",
    "type",
    "hash",
    "shopt",
    "trap",
    "local",
    "declare",
    "readonly",
    "read",
    "test",
    "[",
    "[[",
    "]]",
    "]",
    "sort",
    "uniq",
    "cut",
    "tr",
    "wc",
    "head",
    "tail",
    "column",
    "fold",
    "paste",
    "rev",
    "tee",
    "cat",
    "grep",
    "rg",
    "sed",
    "awk",
    "jq",
    "xargs",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "mktemp",
    "seq",
    "clear",
    "wait",
    "let",
    "eval",
    "for",
    "case",
    "in",
    "esac",
    "select",
    "shift",
    "printenv",
    "whoami",
    "hostname",
    "id",
    "uname",
    "date",
    "env",
    "nl",
    "less",
    "more",
    "diff",
    "comm",
    "join",
    "base64",
    "sha256sum",
    "md5sum",
    "yes",
]);

const PY_DB = /\bsqlite3\b|\bpsycopg|\bpsql\b|\.execute\(|SELECT\s|\bduckdb\b/;
const JS_DB = /better-sqlite3|\bpg\b|\bsqlite\b|\.prepare\(|SELECT\s/;

/** "the journal database" when the query names the journal's store, else "a database". */
export function databaseLabel(text: string): string {
    return /journal|matron\.db/i.test(text) ? "the journal database" : "a database";
}

function dbPhrase(text: string): Phrase {
    const label = databaseLabel(text);
    return phrase("db", `Queried ${label}`, `Querying ${label}`);
}

function scriptPhrase(lang: "Python" | "Node" | "shell", body: string): Phrase {
    if ((lang === "Python" ? PY_DB : JS_DB).test(body)) return dbPhrase(body);
    if (/\bchromium\b|playwright|puppeteer|screenshot/.test(body))
        return phrase("screenshot", "Took screenshots", "Taking screenshots");
    if (/\bfrom PIL\b|\bImage\.open\b|\bsharp\(/.test(body))
        return phrase("image", "Processed an image", "Processing an image");
    if (/\brequests\.|urllib|fetch\(/.test(body) && !/\bopen\(/.test(body))
        return phrase("api", "Called an API", "Calling an API");
    // A script that rewrites a file (read, replace, write back): the file it edits names it.
    const writes =
        /\.write\(|write_text\(|writeFileSync\(|writeFile\(|open\([^)]*,\s*['"][wa]/.test(body) ||
        (/open\(\w+\)\.read\(\)|readFileSync\(/.test(body) && (/\.repl|\.sub\(/.test(body) || /…$/u.test(body)));
    if (writes) {
        const file = /['"`]((?:[\w.@~-]*\/)*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,6})['"`]/.exec(body)?.[1];
        return file
            ? editPhrase(file, false)
            : phrase("edit", "Edited files with a script", "Editing files with a script");
    }
    const article = lang === "shell" ? "a shell" : `a ${lang}`;
    return phrase("script", `Ran ${article} script`, `Running ${article} script`);
}

const SCRIPT_EXT = /\.(py|mjs|cjs|js|ts|sh|bash|rb|pl)$/;

const NPM_SCRIPT: Array<[RegExp, () => Phrase]> = [
    [/^(test|test:.*|vitest|jest|e2e|spec)$/, () => phrase("test", "Ran the tests", "Running the tests")],
    [/^(lint|lint:.*|eslint)$/, () => phrase("check", "Checked the code style", "Checking the code style")],
    [
        /^(typecheck|type-check|tsc|lint:types|types|check|check:.*)$/,
        () => phrase("check", "Checked the types", "Checking the types"),
    ],
    [/^(format|fmt|prettier|lint:fix)$/, () => phrase("format", "Formatted the code", "Formatting the code")],
    [/^(build|build:.*|compile|bundle)$/, () => phrase("build", "Built the app", "Building the app")],
    [/^(dev|start|serve|preview)$/, () => phrase("process", "Started the dev server", "Starting the dev server")],
    [/^(deploy|release)$/, () => phrase("deploy", "Deployed", "Deploying")],
];

function npmPhrase(all: string[]): Phrase {
    // Global flags before the subcommand (`pnpm --dir x build`, `npm --prefix x test`).
    let i = 1;
    while (i < all.length && all[i].startsWith("-"))
        i += /^(--dir|--prefix|-C|--filter|-F|--workspace|-w|--cwd)$/.test(all[i]) ? 2 : 1;
    const words = [all[0], ...all.slice(i)];
    const sub = words[1] ?? "";
    const rest = args(words).slice(1);
    if (/^(i|install|ci|add|remove|rm|update|up)$/.test(sub))
        return phrase("install", "Installed dependencies", "Installing dependencies");
    if (/^(t|test)$/.test(sub)) return phrase("test", "Ran the tests", "Running the tests");
    const script = sub === "run" || sub === "run-script" || sub === "exec" || sub === "x" ? (rest[0] ?? "") : sub;
    if (sub === "exec" || sub === "x" || sub === "dlx")
        return toolPhrase(rest, new Map()) ?? phrase("script", "Ran a script", "Running a script");
    for (const [re, make] of NPM_SCRIPT) if (re.test(script)) return make();
    if (/^(view|info|ls|list|outdated|why|audit|config|--version|-v)$/.test(sub))
        return phrase("env", "Checked the packages", "Checking the packages");
    return script
        ? phrase("script", `Ran the ${short(script, 24)} script`, `Running the ${short(script, 24)} script`)
        : phrase("script", "Ran a package script", "Running a package script");
}

function gitPhrase(all: string[]): Phrase {
    // `git -C dir`, `-c k=v`, `--no-pager`, `--git-dir=…` come before the subcommand.
    let i = 1;
    while (i < all.length && all[i].startsWith("-")) i += /^-[Cc]$/.test(all[i]) ? 2 : 1;
    const sub = all[i] ?? "";
    const words = all.slice(i);
    const a = args(words);
    switch (sub) {
        case "log":
        case "shortlog":
        case "reflog":
            return phrase("history", "Checked the history", "Checking the history");
        case "show":
            return phrase("history", "Looked at a commit", "Looking at a commit");
        case "diff":
            return phrase("history", "Looked at what changed", "Looking at what changed");
        case "status":
            return phrase("history", "Checked the branch status", "Checking the branch status");
        case "blame":
            return phrase(
                "history",
                `Checked who changed ${fileLabel(a[0])}`,
                `Checking who changed ${fileLabel(a[0])}`,
                a[0],
            );
        case "grep": {
            const pattern = readablePattern(a[0]);
            return pattern
                ? phrase(
                      "search",
                      `Searched the code for ${quote(pattern)}`,
                      `Searching the code for ${quote(pattern)}`,
                      pattern,
                  )
                : phrase("search", "Searched the code", "Searching the code");
        }
        case "commit":
            return phrase("commit", "Saved a commit", "Saving a commit");
        case "push":
            return phrase("push", "Pushed the branch", "Pushing the branch");
        case "pull":
        case "fetch":
            return phrase("sync", "Fetched the latest code", "Fetching the latest code");
        case "add":
            return phrase("branch", "Staged changes", "Staging changes");
        case "checkout":
            if (words.includes("--") || (a.length && a.every(isPath) && !words.includes("-b")))
                return phrase("branch", "Restored files", "Restoring files");
            return phrase("branch", "Switched branch", "Switching branch");
        case "switch":
            return phrase("branch", "Switched branch", "Switching branch");
        case "restore":
            return phrase("branch", "Restored files", "Restoring files");
        case "worktree":
            if (a[0] === "add") return phrase("branch", "Set up a worktree", "Setting up a worktree");
            if (a[0] === "remove" || a[0] === "prune")
                return phrase("branch", "Cleaned up a worktree", "Cleaning up a worktree");
            return phrase("history", "Checked the worktrees", "Checking the worktrees");
        case "branch":
            if (words.some((w) => /^-[dD]$|^--delete$/.test(w)))
                return phrase("branch", "Deleted a branch", "Deleting a branch");
            if (words.some((w) => /^-[mM]$/.test(w))) return phrase("branch", "Renamed a branch", "Renaming a branch");
            if (a.length && !words.some((w) => /^-(a|r|l|v|vv|-list|-show-current|-contains|-merged)$/.test(w)))
                return phrase("branch", "Created a branch", "Creating a branch");
            return phrase("history", "Checked the branches", "Checking the branches");
        case "merge":
            return phrase("branch", "Merged a branch", "Merging a branch");
        case "rebase":
            return phrase("branch", "Rebased the branch", "Rebasing the branch");
        case "cherry-pick":
            return phrase("branch", "Picked a commit", "Picking a commit");
        case "revert":
            return phrase("branch", "Reverted a commit", "Reverting a commit");
        case "stash":
            return phrase("branch", "Stashed changes", "Stashing changes");
        case "reset":
            return phrase("branch", "Reset the branch", "Resetting the branch");
        case "tag":
            return a.length
                ? phrase("branch", "Tagged a release", "Tagging a release")
                : phrase("history", "Checked the tags", "Checking the tags");
        case "rm":
            return phrase("branch", "Removed files", "Removing files");
        case "mv":
            return phrase("branch", "Moved files", "Moving files");
        case "clone":
            return phrase("sync", "Cloned a repository", "Cloning a repository");
        case "apply":
        case "am":
            return phrase("edit", "Applied a patch", "Applying a patch");
        case "remote":
        case "rev-parse":
        case "rev-list":
        case "merge-base":
        case "ls-files":
        case "ls-tree":
        case "ls-remote":
        case "cat-file":
        case "for-each-ref":
        case "describe":
        case "config":
        case "name-rev":
        case "check-ignore":
        case "symbolic-ref":
        case "count-objects":
        case "fsck":
        case "gc":
        case "notes":
        case "var":
        case "help":
        case "version":
        case "--version":
            return phrase("history", "Checked the repository", "Checking the repository");
        default:
            return phrase("history", "Checked the repository", "Checking the repository");
    }
}

function ghPhrase(words: string[]): Phrase {
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) i += /^-R$|^--repo$/.test(words[i]) ? 2 : 1;
    const group = words[i] ?? "";
    const action = words.slice(i + 1).find((w) => !w.startsWith("-")) ?? "";
    if (group === "pr") {
        switch (action) {
            case "create":
                return phrase("pr", "Opened a PR", "Opening a PR");
            case "merge":
                return phrase("pr", "Merged a PR", "Merging a PR");
            case "close":
                return phrase("pr", "Closed a PR", "Closing a PR");
            case "ready":
                return phrase("pr", "Marked the PR ready", "Marking the PR ready");
            case "comment":
            case "review":
                return phrase("pr", "Commented on the PR", "Commenting on the PR");
            case "edit":
                return phrase("pr", "Updated the PR", "Updating the PR");
            case "checks":
                return phrase("ci", "Checked the PR's CI", "Checking the PR's CI");
            case "checkout":
                return phrase("branch", "Checked out a PR", "Checking out a PR");
            case "diff":
                return phrase("ci", "Looked at the PR's changes", "Looking at the PR's changes");
            default:
                return phrase("ci", "Checked the PR", "Checking the PR");
        }
    }
    if (group === "run" || group === "workflow") {
        if (action === "rerun") return phrase("ci", "Re-ran CI", "Re-running CI");
        if (action === "watch") return phrase("ci", "Watched CI", "Watching CI");
        return phrase("ci", "Checked CI", "Checking CI");
    }
    if (group === "issue") {
        if (action === "create") return phrase("github", "Filed a GitHub issue", "Filing a GitHub issue");
        if (action === "comment") return phrase("github", "Commented on an issue", "Commenting on an issue");
        if (action === "close") return phrase("github", "Closed an issue", "Closing an issue");
        return phrase("github", "Checked GitHub issues", "Checking GitHub issues");
    }
    if (group === "api") {
        const write = words.some((w) => /^(-X|--method)$/.test(w)) && /POST|PATCH|PUT|DELETE/.test(words.join(" "));
        return write
            ? phrase("github", "Updated GitHub", "Updating GitHub")
            : phrase("github", "Queried GitHub", "Querying GitHub");
    }
    if (group === "repo") {
        if (action === "clone") return phrase("sync", "Cloned a repository", "Cloning a repository");
        if (action === "sync") return phrase("sync", "Synced the fork", "Syncing the fork");
        return phrase("github", "Looked at the repository", "Looking at the repository");
    }
    if (group === "release") return phrase("github", "Checked the releases", "Checking the releases");
    if (group === "search") return phrase("github", "Searched GitHub", "Searching GitHub");
    if (group === "auth") return phrase("env", "Checked the GitHub login", "Checking the GitHub login");
    return phrase("github", "Used GitHub", "Using GitHub");
}

function systemctlPhrase(words: string[]): Phrase {
    const a = args(words);
    const verb = a[0] ?? "";
    const unit = a.find((w, index) => index > 0 && !w.startsWith("-"));
    const name = unit ? unit.replace(/\.(service|timer|socket)$/, "") : "";
    if (/^(start|stop|restart|reload|try-restart|reload-or-restart|kill)$/.test(verb)) {
        const past = { start: "Started", stop: "Stopped", kill: "Stopped" }[verb] ?? "Restarted";
        const live = { start: "Starting", stop: "Stopping", kill: "Stopping" }[verb] ?? "Restarting";
        return phrase("service", `${past} ${name || "a service"}`, `${live} ${name || "a service"}`, name);
    }
    if (/^(enable|disable|mask|unmask|daemon-reload|edit|set-property|reset-failed|link)$/.test(verb))
        return phrase("service", "Updated the services", "Updating the services");
    if (verb === "list-timers") return phrase("service", "Checked the timers", "Checking the timers");
    return name
        ? phrase("service", `Checked ${name}`, `Checking ${name}`, name)
        : phrase("service", "Checked the services", "Checking the services");
}

/** Classify a command by its program; null for a trivial stage that says nothing. */
function commandPhrase(simple: Simple, vars: Map<string, string[]>, depth = 0): Phrase | null {
    const words = peel(simple.words, vars);
    if (!words.length || CLOSERS.has(words[0])) return writesPhrase(simple);
    const prog = words[0].replace(/^.*\//, "");
    const a = args(words);

    // A shell running a string: classify what it runs.
    if (/^(ba|z|da)?sh$/.test(prog)) {
        const c = words.indexOf("-c") >= 0 ? words.indexOf("-c") : words.findIndex((w) => /^-l?c$/.test(w));
        if (c >= 0 && words[c + 1] !== undefined && depth < 3) return describeCommand(words[c + 1], depth + 1);
        if (words.includes("-n")) return phrase("check", "Checked the script's syntax", "Checking the script's syntax");
        const file = a[0];
        if (file && SCRIPT_EXT.test(file)) return runFile(file);
        if (simple.heredoc !== undefined) return scriptPhrase("shell", simple.heredoc);
        return phrase("script", "Ran a shell script", "Running a shell script");
    }
    const tool = toolPhrase(words, vars, simple);
    if (tool) return tool;
    if (TRIVIAL.has(prog)) {
        // A write through a trivial program: `cat > f <<EOF`, `echo x >> f`, `tee f`.
        if (prog === "tee" && a.length) return editPhrase(a[a.length - 1], simple.heredoc !== undefined);
        const written = writesPhrase(simple);
        if (written) return written;
        return readPhrase(prog, words, simple);
    }
    if (SCRIPT_EXT.test(prog)) return runFile(words[0]);
    return null;
}

function writesPhrase(simple: Simple): Phrase | null {
    const target = simple.writes[0];
    if (!target) return null;
    // Output saved to a scratch file is not an edit: the command that produced it names the step.
    if (simple.heredoc === undefined && /^(\/tmp\/|\$)/.test(target))
        return { ...phrase("files", "Saved the output", "Saving the output"), weight: WEIGHT.env + 1 };
    return editPhrase(target, simple.heredoc !== undefined);
}

/** A file's name for a phrase; a name the 100-character cut left as a stub reads "a file". */
export function fileLabel(path: string | undefined): string {
    const name = basename(path);
    if (/[*?]/.test(name)) return "several files";
    // Code, not a name (a cut `sed` expression, a quoted argument): never printed.
    if (/[()"'`=;<>{}[\]\s$\\]/.test(name)) return "a file";
    // A name the 100-character cut left short reads "a file"; a longer stub keeps its ellipsis.
    return /^.{0,11}…$/u.test(name) ? "a file" : name;
}

function editPhrase(path: string, created: boolean): Phrase {
    const name = fileLabel(path);
    return created
        ? phrase("edit", `Wrote ${name}`, `Writing ${name}`, path)
        : phrase("edit", `Edited ${name}`, `Editing ${name}`, path);
}

function runFile(file: string): Phrase {
    const name = fileLabel(file);
    if (/deploy/.test(name)) return phrase("deploy", "Deployed", "Deploying");
    if (/safe-vitest|run[-_]tests?|test\.sh$/.test(name)) return phrase("test", "Ran the tests", "Running the tests");
    if (/^codex_/.test(name) || /codex[-_]review/.test(name)) return codexPhrase(name);
    if (/shoot|screenshot|contact[-_]sheet/.test(name))
        return phrase("screenshot", "Took screenshots", "Taking screenshots");
    return phrase("script", `Ran ${name}`, `Running ${name}`, file);
}

function codexPhrase(name: string): Phrase {
    return /review|adversarial/.test(name)
        ? phrase("review", "Asked Codex for a review", "Asking Codex for a review")
        : phrase("review", "Ran a Codex task", "Running a Codex task");
}

/** Reads through the common text tools: `cat f`, `sed -n 1,20p f`, `jq . f`, `grep x f`. */
function readPhrase(prog: string, words: string[], simple: Simple): Phrase | null {
    if (simple.pipeIndex > 0) return null;
    if (prog === "grep" || prog === "rg") return searchPhrase(words);
    if (prog === "echo" || prog === "printf") return null;
    if (prog === "diff" || prog === "comm") return phrase("read", "Compared files", "Comparing files");
    if (prog === "date") return null;
    let file: string | undefined;
    if (prog === "sed") {
        if (words.some((w) => /^-i/.test(w) || w === "--in-place")) {
            // The first operand is the sed script unless one came with -e / -f.
            const operands = args(words, /^-e$|^-f$/).slice(words.some((w) => w === "-e" || w === "-f") ? 0 : 1);
            const target = operands.filter(isPath).pop();
            return target ? editPhrase(target, false) : phrase("edit", "Edited a file", "Editing a file");
        }
        file = args(words, /^-e$|^-f$/)
            .slice(words.includes("-e") ? 0 : 1)
            .filter(isPath)
            .pop();
    } else if (prog === "awk" || prog === "jq") {
        file = args(words, /^-(f|v|F)$|^--(arg|argjson|slurpfile|rawfile)$/)
            .slice(1)
            .filter(isPath)
            .pop();
    } else if (["cat", "head", "tail", "nl", "less", "more", "wc", "base64", "sha256sum", "md5sum"].includes(prog)) {
        file = lastPath(words, /^-[nc]$/);
    }
    if (!file) return null;
    return phrase("read", `Read ${fileLabel(file)}`, `Reading ${fileLabel(file)}`, file);
}

const GREP_VALUE =
    /^-(e|f|g|t|T|A|B|C|m|d|D|E|j|M|r)$|^--(glob|type|type-not|max-count|context|after-context|before-context|include|exclude|exclude-dir|regexp|file|max-depth|threads|replace|sort|sortr|color|colors|iglob)$/;

function searchPhrase(words: string[]): Phrase {
    const explicit = words.findIndex((w) => w === "-e" || w === "--regexp");
    const a = args(words, GREP_VALUE);
    const pattern = explicit >= 0 ? words[explicit + 1] : a[0];
    const files = (explicit >= 0 ? a : a.slice(1)).filter((w) => isPath(w));
    // Searching a log or a data file reads as checking that file.
    if (files.length === 1 && /\.(log|txt|out|jsonl?|csv|ya?ml)$/.test(files[0]))
        return phrase("read", `Checked ${fileLabel(files[0])}`, `Checking ${fileLabel(files[0])}`, files[0]);
    if (words.includes("--files") || (words.includes("-l") && !pattern))
        return phrase("list", "Listed files", "Listing files");
    const readable = readablePattern(pattern);
    if (readable)
        return phrase(
            "search",
            `Searched the code for ${quote(readable)}`,
            `Searching the code for ${quote(readable)}`,
            readable,
        );
    // A pattern that is mostly syntax (`^#`, `\bP[0-9]+`): name the file it searched instead.
    const places = (explicit >= 0 ? a : a.slice(1)).filter((w) => !/[*?]/.test(w) && w !== ".");
    if (places.length === 1) {
        const label = /\.\w{1,6}$/.test(places[0]) ? fileLabel(places[0]) : folderLabel(places[0]);
        return { ...phrase("search", `Searched ${label}`, `Searching ${label}`), weight: WEIGHT.read - 1 };
    }
    if (places.length > 1)
        return {
            ...phrase("search", `Searched ${places.length} files`, `Searching ${places.length} files`),
            weight: WEIGHT.read - 1,
        };
    return { ...phrase("search", "Searched the code", "Searching the code"), weight: WEIGHT.read - 1 };
}

function listPhrase(prog: string, words: string[]): Phrase {
    if (prog === "find" || prog === "fd") {
        const nameAt = words.findIndex((w) => w === "-name" || w === "-iname" || w === "-path");
        const pattern = nameAt >= 0 ? words[nameAt + 1] : prog === "fd" ? args(words)[0] : undefined;
        if (pattern && !isPath(words[1] ?? "") === false && nameAt >= 0) {
            const readable = readablePattern(pattern.replace(/^\*|\*$/g, ""));
            if (readable)
                return phrase(
                    "list",
                    `Looked for files named ${quote(readable)}`,
                    `Looking for files named ${quote(readable)}`,
                    readable,
                );
        }
        if (pattern) {
            const readable = readablePattern(pattern.replace(/^\*|\*$/g, ""));
            if (readable)
                return phrase(
                    "list",
                    `Looked for files named ${quote(readable)}`,
                    `Looking for files named ${quote(readable)}`,
                    readable,
                );
        }
        const dir = args(words).find(isPath);
        return dir
            ? phrase("list", `Looked through ${folderLabel(dir)}`, `Looking through ${folderLabel(dir)}`, dir)
            : phrase("list", "Looked through the files", "Looking through the files");
    }
    const dirs = args(words, /^-(I|L|P)$/).filter((w) => w !== "." && isPath(w) && !/[*?]/.test(w));
    if (dirs.length === 1)
        return phrase(
            "list",
            `Listed files in ${folderLabel(dirs[0])}`,
            `Listing files in ${folderLabel(dirs[0])}`,
            dirs[0],
        );
    return phrase("list", "Listed files", "Listing files");
}

function urlHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "";
    }
}

function curlPhrase(words: string[]): Phrase {
    const url = words.find((w) => /^https?:\/\//.test(w)) ?? words.find((w) => /^(localhost|127\.0\.0\.1)/.test(w));
    const host = url ? urlHost(url.startsWith("http") ? url : `http://${url}`) : "";
    if (!host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) || /^\$/.test(host))
        return phrase("api", "Called the local API", "Calling the local API");
    if (/^api\.|\.api\./.test(host) || words.some((w) => /^-(X|H|d)$|^--(data|json|header|request)/.test(w)))
        return phrase("api", `Called ${host}`, `Calling ${host}`, host);
    return phrase("web", `Fetched ${host}`, `Fetching ${host}`, host);
}

/** Programs with their own phrase; null when the program is not one of them. */
function toolPhrase(words: string[], vars: Map<string, string[]>, simple?: Simple): Phrase | null {
    const prog = (words[0] ?? "").replace(/^.*\//, "");
    const a = args(words);
    const sub = a[0] ?? "";
    const has = (re: RegExp): boolean => words.some((w) => re.test(w));
    switch (prog) {
        case "git":
            return gitPhrase(words);
        case "gh":
            return ghPhrase(words);
        case "npm":
        case "pnpm":
        case "yarn":
        case "bun":
            return npmPhrase(words);
        case "vitest":
        case "jest":
        case "pytest":
        case "mocha":
        case "ava":
        case "tap":
            return phrase("test", "Ran the tests", "Running the tests");
        case "playwright":
            if (sub === "test") return phrase("test", "Ran the tests", "Running the tests");
            if (sub === "install") return phrase("install", "Installed the browsers", "Installing the browsers");
            return phrase("screenshot", "Took screenshots", "Taking screenshots");
        case "tsc":
        case "vue-tsc":
            return phrase("check", "Checked the types", "Checking the types");
        case "eslint":
        case "oxlint":
        case "stylelint":
        case "shellcheck":
        case "ruff":
        case "flake8":
        case "pylint":
        case "markdownlint":
            if (prog === "ruff" && sub === "format")
                return phrase("format", "Formatted the code", "Formatting the code");
            if (has(/^--fix$/)) return phrase("format", "Fixed the code style", "Fixing the code style");
            return phrase("check", "Checked the code style", "Checking the code style");
        case "mypy":
        case "pyright":
            return phrase("check", "Checked the types", "Checking the types");
        case "prettier":
        case "black":
        case "gofmt":
        case "rustfmt":
            return has(/^--(check|list-different)$|^-l$/)
                ? phrase("check", "Checked the formatting", "Checking the formatting")
                : phrase("format", "Formatted the code", "Formatting the code");
        case "webpack":
        case "vite":
        case "esbuild":
        case "rollup":
        case "next":
        case "make":
        case "cargo":
        case "go":
            if ((prog === "cargo" || prog === "go") && sub === "test")
                return phrase("test", "Ran the tests", "Running the tests");
            if (prog === "next" && sub === "dev")
                return phrase("process", "Started the dev server", "Starting the dev server");
            if (prog === "make" && /test/.test(sub)) return phrase("test", "Ran the tests", "Running the tests");
            return phrase("build", "Built the app", "Building the app");
        case "pip":
        case "pip3":
        case "uv":
        case "apt":
        case "apt-get":
        case "brew":
        case "corepack":
            if (prog === "uv" && sub === "run")
                return commandPhrase({ words: words.slice(2), writes: [], pipeIndex: 0 }, vars);
            return phrase("install", "Installed dependencies", "Installing dependencies");
        case "vercel":
            if (has(/^(--version|-v|--help|-h)$/) || sub === "help")
                return phrase("env", "Checked the Vercel CLI", "Checking the Vercel CLI");
            if (!sub || sub === "deploy" || has(/^--prod$/)) return phrase("deploy", "Deployed", "Deploying");
            return phrase("api", "Checked Vercel", "Checking Vercel");
        case "codex":
        case "claude":
            return prog === "codex" ? codexPhrase(a.join(" ")) : phrase("review", "Asked Claude", "Asking Claude");
        case "systemctl":
            return systemctlPhrase(words);
        case "journalctl":
            return phrase("logs", "Read the service logs", "Reading the service logs");
        case "psql":
        case "sqlite3":
        case "mysql":
        case "redis-cli":
        case "pg_dump":
        case "supabase":
            return dbPhrase(words.join(" "));
        case "curl":
        case "wget":
        case "http":
        case "xh":
            return curlPhrase(words);
        case "python":
        case "python3":
        case "python3.12":
        case "py": {
            const m = words.indexOf("-m");
            if (m >= 0) {
                const mod = words[m + 1] ?? "";
                if (mod.length < 3 || mod.endsWith("…")) return scriptPhrase("Python", "");
                if (/^(pytest|unittest)$/.test(mod)) return phrase("test", "Ran the tests", "Running the tests");
                if (/^(mypy|pyright)$/.test(mod)) return phrase("check", "Checked the types", "Checking the types");
                if (/^(ruff|flake8|pylint)$/.test(mod))
                    return phrase("check", "Checked the code style", "Checking the code style");
                if (mod === "py_compile" || mod === "compileall")
                    return phrase("check", "Checked the syntax", "Checking the syntax");
                if (mod === "json.tool") return null;
                if (mod === "pip") return phrase("install", "Installed dependencies", "Installing dependencies");
                if (mod === "http.server")
                    return phrase("process", "Started a local server", "Starting a local server");
                return phrase(
                    "script",
                    `Ran ${short(mod.split(".").pop() ?? mod, 30)}`,
                    `Running ${short(mod.split(".").pop() ?? mod, 30)}`,
                );
            }
            const c = words.indexOf("-c");
            if (c >= 0) return scriptPhrase("Python", words[c + 1] ?? "");
            const file = args(words, /^-[WX]$/)[0];
            if (!file || file === "-") return scriptPhrase("Python", simple?.heredoc ?? "");
            return runFile(file);
        }
        case "node":
        case "deno":
        case "tsx":
        case "ts-node": {
            if (has(/^--(version|check)$|^-[vc]$/))
                return phrase("check", "Checked the script's syntax", "Checking the script's syntax");
            if (has(/^--test$/)) return phrase("test", "Ran the tests", "Running the tests");
            const e = words.findIndex((w) => /^(-e|--eval|-p|--print)$/.test(w));
            if (e >= 0) return scriptPhrase("Node", words[e + 1] ?? "");
            const file = args(words, /^--(input-type|import|require|loader)$|^-r$/)[0];
            if (!file || file === "-") return scriptPhrase("Node", simple?.heredoc ?? "");
            return runFile(file);
        }
        case "rg":
        case "ag":
        case "ack":
        case "egrep":
        case "fgrep":
            return searchPhrase(words);
        case "grep":
            return simple && simple.pipeIndex > 0 ? null : searchPhrase(words);
        case "ls":
        case "find":
        case "fd":
        case "tree":
        case "exa":
        case "eza":
            return listPhrase(prog, words);
        case "mkdir":
            return phrase("files", "Made a folder", "Making a folder", a[0]);
        case "cp":
        case "install":
        case "rsync":
        case "scp": {
            const target = a[a.length - 1];
            const src = a.length > 1 ? a[0] : undefined;
            const label = src && !src.includes("*") ? fileLabel(src) : "files";
            if (prog === "scp") return phrase("files", "Copied files to another box", "Copying files to another box");
            return phrase("files", `Copied ${label}`, `Copying ${label}`, target);
        }
        case "mv":
            return phrase(
                "files",
                a.length > 2 ? "Moved files" : `Moved ${fileLabel(a[0])}`,
                a.length > 2 ? "Moving files" : `Moving ${fileLabel(a[0])}`,
                a[0],
            );
        case "rm":
        case "rmdir":
        case "shred":
            return phrase("files", "Cleaned up files", "Cleaning up files", a[0]);
        case "ln":
            return phrase("files", "Linked files", "Linking files", a[a.length - 1]);
        case "chmod":
        case "chown":
        case "chgrp":
            return phrase("files", "Changed file permissions", "Changing file permissions");
        case "touch":
            return phrase(
                "edit",
                `Created ${fileLabel(a[a.length - 1])}`,
                `Creating ${fileLabel(a[a.length - 1])}`,
                a[a.length - 1],
            );
        case "tar":
        case "zip":
        case "unzip":
        case "gzip":
        case "gunzip":
        case "zstd":
        case "xz":
            return /^(unzip|gunzip)$/.test(prog) || (has(/^-?[a-z]*x[a-z]*f?$/) && prog === "tar")
                ? phrase("files", "Unpacked files", "Unpacking files")
                : phrase("files", "Packed files", "Packing files");
        case "du":
        case "df":
        case "stat":
        case "file":
        case "identify":
            if (prog === "identify") return phrase("image", "Checked an image", "Checking an image");
            return phrase(
                "files",
                prog === "df" ? "Checked the disk space" : "Checked file sizes",
                prog === "df" ? "Checking the disk space" : "Checking file sizes",
            );
        case "sleep":
        case "wait":
            return phrase("wait", "Waited", "Waiting");
        case "ps":
        case "pgrep":
        case "top":
        case "htop":
        case "free":
        case "uptime":
        case "vmstat":
        case "lsof":
        case "ss":
        case "netstat":
        case "nproc":
            return phrase("process", "Checked what's running", "Checking what's running");
        case "kill":
        case "pkill":
        case "killall":
            return phrase("process", "Stopped a process", "Stopping a process");
        case "docker":
        case "podman":
            if (/^(ps|images|inspect|logs|stats)$/.test(sub))
                return phrase("process", "Checked the containers", "Checking the containers");
            if (sub === "build") return phrase("build", "Built a container", "Building a container");
            return phrase("process", "Ran a container", "Running a container");
        case "ssh":
            return phrase("process", "Ran a command on another box", "Running a command on another box");
        case "convert":
        case "magick":
        case "ffmpeg":
        case "ffprobe":
        case "cwebp":
        case "optipng":
        case "pngquant":
        case "exiftool":
        case "sips":
        case "pdftoppm":
        case "pdftotext":
        case "odiff":
            return phrase("image", "Processed an image", "Processing an image");
        case "chromium":
        case "chromium-browser":
        case "google-chrome":
        case "wkhtmltopdf":
            return phrase("screenshot", "Took screenshots", "Taking screenshots");
        case "dig":
        case "nslookup":
        case "host":
        case "ping":
        case "traceroute":
        case "tailscale":
        case "openssl":
        case "nc":
        case "ufw":
        case "iptables":
        case "nft":
            return phrase("process", "Checked the network", "Checking the network");
        case "nginx":
            return phrase("service", "Checked the web server", "Checking the web server");
        case "crontab":
        case "augenrules":
        case "auditctl":
        case "ausearch":
        case "loginctl":
        case "timedatectl":
        case "hostnamectl":
        case "update-alternatives":
            return phrase("service", "Checked the system settings", "Checking the system settings");
        case "perl":
            if (has(/^-[a-z]*i/)) {
                const target = lastPath(words, /^-e$/);
                return target ? editPhrase(target, false) : phrase("edit", "Edited a file", "Editing a file");
            }
            return phrase("script", "Ran a Perl script", "Running a Perl script");
        case "patch":
            return phrase("edit", "Applied a patch", "Applying a patch");
        case "apply_patch":
            return phrase("edit", "Edited files", "Editing files");
        case "until":
        case "while":
            return phrase("wait", "Waited", "Waiting");
        case "pg_isready":
            return phrase("db", "Checked the database is up", "Checking the database is up");
        case "pstree":
            return phrase("process", "Checked what's running", "Checking what's running");
        case "systemd-analyze":
            return phrase("service", "Checked the timer schedule", "Checking the timer schedule");
        case "cmp":
            return phrase("read", "Compared files", "Comparing files");
        case "pip-audit":
        case "npm-audit":
        case "osv-scanner":
            return phrase("check", "Checked the dependencies", "Checking the dependencies");
        default:
            if (/^codex_/.test(prog)) return codexPhrase(prog);
            return null;
    }
}

/**
 * The phrase for a whole shell command: every stage classified, the most telling one wins.
 * An unrecognised program falls back to "Ran {program}".
 */
export function describeCommand(command: string, depth = 0): Phrase {
    // The bridge cuts a subagent's command at 100 characters ("…"): the stage the cut lands in is
    // incomplete (a program name can be half a word), so it never names the step.
    const truncated = /…$/u.test(command);
    // The ellipsis stays on the cut word, so a half file name reads "Read regen…".
    const stages = parseShell(command);
    const lastStage = stages[stages.length - 1];
    const vars = new Map<string, string[]>();
    let best: Phrase | null = null;
    let unknown: string | null = null;
    let loopWait = false;
    const expand = (word: string): string =>
        word.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => {
            const value = vars.get(name);
            return value ? value.join(" ") : whole;
        });
    for (const original of stages) {
        // `G="git -C $W"` → `$G log` reads as `git log`; `W=/tmp/x; cat $W/a.ts` reads `/tmp/x/a.ts`.
        if (original.words.length && original.words.every((w) => /^[A-Za-z_]\w*=/.test(w))) {
            for (const w of original.words) {
                const [name, ...rest] = w.split("=");
                const value = expand(rest.join("=").trim());
                if (value && !value.startsWith("$(")) vars.set(name, value.split(/\s+/));
            }
            continue;
        }
        // `for s in a b c; do rg "$s" …`: the loop variable reads as its values.
        if (original.words[0] === "for" && original.words[2] === "in" && original.words.length > 3)
            vars.set(original.words[1], original.words.slice(3));
        const stage: Simple = {
            ...original,
            // A variable standing for a program with its flags (`$G log`) splits back into words.
            words: original.words.flatMap((w, i) =>
                i === 0 && /^\$\{?\w+\}?$/.test(w) ? expand(w).split(/\s+/) : [expand(w)],
            ),
            writes: original.writes.map(expand),
        };
        const first = peel(stage.words, vars)[0];
        if (first === "until" || first === "while") loopWait = true;
        const found = commandPhrase(stage, vars, depth);
        if (found) {
            if (!best || found.weight > best.weight) best = found;
            continue;
        }
        const words = peel(stage.words, vars);
        const prog = (words[0] ?? "").replace(/^.*\//, "");
        if (
            !unknown &&
            !(truncated && original === lastStage) &&
            stage.pipeIndex === 0 &&
            prog &&
            !TRIVIAL.has(prog) &&
            !KEYWORDS.has(prog) &&
            !CLOSERS.has(prog) &&
            /^[A-Za-z][\w.+-]{0,30}$/.test(prog)
        )
            unknown = prog;
    }
    if (best && loopWait && best.weight < WEIGHT.search) return phrase("wait", "Waited", "Waiting");
    if (best) return best;
    if (loopWait) return phrase("wait", "Waited", "Waiting");
    if (unknown) return phrase("other", `Ran ${unknown}`, `Running ${unknown}`, undefined, true);
    return phrase("env", "Checked the environment", "Checking the environment");
}

// ---------------------------------------------------------------------------------------------
// Non-shell tools
// ---------------------------------------------------------------------------------------------

const MCP_PHRASES: Array<[RegExp, PhraseKey, string, string]> = [
    [/__item_create$/, "tracker", "Filed a tracker item", "Filing a tracker item"],
    [/__item_comment$/, "tracker", "Commented on a tracker item", "Commenting on a tracker item"],
    [/__item_close$/, "tracker", "Closed a tracker item", "Closing a tracker item"],
    [/__item_(reopen|move|reorder)$/, "tracker", "Updated the tracker", "Updating the tracker"],
    [/__item_(get|list)$/, "tracker", "Checked the tracker", "Checking the tracker"],
    [/__milestone_post$/, "tracker", "Posted a milestone", "Posting a milestone"],
    [/__mission_(start|create|update|join|close)$/, "tracker", "Updated the mission", "Updating the mission"],
    [/__mission_get$/, "tracker", "Checked the mission", "Checking the mission"],
    [/__agent_message$|__agent_chat_send$/, "message", "Messaged another session", "Messaging another session"],
    [
        /__agent_chat_(start|invite|join|accept)$/,
        "message",
        "Opened a chat with another session",
        "Opening a chat with another session",
    ],
    [/__agent_chat_read$/, "message", "Read a chat", "Reading a chat"],
    [/__agent_(sessions|roster|boxes)$/, "message", "Checked the other sessions", "Checking the other sessions"],
    [/__agent_session_start$/, "helper", "Asked to start a session", "Asking to start a session"],
    [/__(send_attachment|show_file)$/, "message", "Shared a file", "Sharing a file"],
    [/__request_secret$/, "message", "Asked for a secret", "Asking for a secret"],
    [/__share_sensitive_data$/, "message", "Shared a secure link", "Sharing a secure link"],
    [/__reminder_(create|cancel|list)$/, "tracker", "Set a reminder", "Setting a reminder"],
    [/__restart_session$/, "process", "Restarted the session", "Restarting the session"],
    [/__redact_message$/, "message", "Removed a message", "Removing a message"],
    [/__take_screenshot$|__take_snapshot$/, "screenshot", "Took a screenshot", "Taking a screenshot"],
    [/__navigate_page$|__new_page$/, "web", "Opened a page", "Opening a page"],
    [
        /__(click|fill|hover|press_key|drag|fill_form|upload_file|evaluate_script)$/,
        "web",
        "Used the browser",
        "Using the browser",
    ],
    [/__list_deployments$|__get_deployment/, "api", "Checked the deployments", "Checking the deployments"],
    [/__deploy/, "deploy", "Deployed", "Deploying"],
];

function humanServer(tool: string): string {
    const server = /^mcp__([^_]+(?:[-_][^_]+)*?)__/.exec(tool)?.[1] ?? "a tool";
    return server.replace(/^claude_ai_/, "").replace(/[-_]/g, " ");
}

function toolStepPhrase(step: Step): Phrase {
    const i = step.input;
    const tool = step.tool;
    switch (tool) {
        case "Read":
        case "NotebookRead":
        case "read_file":
            return phrase("read", `Read ${fileLabel(i.path)}`, `Reading ${fileLabel(i.path)}`, i.path);
        case "Grep":
        case "Search":
        case "grep_search": {
            const readable = readablePattern(i.pattern);
            return readable
                ? phrase(
                      "search",
                      `Searched the code for ${quote(readable)}`,
                      `Searching the code for ${quote(readable)}`,
                      readable,
                  )
                : phrase("search", "Searched the code", "Searching the code");
        }
        case "Glob":
        case "LS":
        case "list_dir": {
            const readable = readablePattern((i.pattern ?? "").replace(/^(\*\*\/)+|\*\*?$/g, ""));
            return readable
                ? phrase(
                      "list",
                      `Looked for files named ${quote(readable)}`,
                      `Looking for files named ${quote(readable)}`,
                      readable,
                  )
                : phrase("list", "Looked for files", "Looking for files");
        }
        case "Edit":
        case "MultiEdit":
        case "Write":
        case "NotebookEdit":
        case "apply_patch":
        case "file_change":
        case "edit_file": {
            if (!i.path) return phrase("edit", "Edited files", "Editing files");
            const created = (tool === "Write" && step.newFile !== false) || step.newFile === true;
            return created
                ? phrase("edit", `Created ${fileLabel(i.path)}`, `Creating ${fileLabel(i.path)}`, i.path)
                : phrase("edit", `Edited ${fileLabel(i.path)}`, `Editing ${fileLabel(i.path)}`, i.path);
        }
        case "WebSearch":
        case "web_search": {
            const q = i.pattern ? short(i.pattern, 48) : "";
            return q
                ? phrase("web", `Searched the web for ${quote(q)}`, `Searching the web for ${quote(q)}`, q)
                : phrase("web", "Searched the web", "Searching the web");
        }
        case "WebFetch": {
            const host = urlHost(i.url ?? "");
            return host
                ? phrase("web", `Opened ${host}`, `Opening ${host}`, host)
                : phrase("web", "Opened a web page", "Opening a web page");
        }
        case "Browser":
            return phrase("screenshot", "Took a screenshot", "Taking a screenshot");
        case "Task":
        case "Agent": {
            const d = i.description ? short(i.description.replace(/…$/u, ""), 60) : "";
            return d
                ? phrase("helper", `Started a helper: ${d}`, `Starting a helper: ${d}`, d)
                : phrase("helper", "Started a helper", "Starting a helper");
        }
        case "TodoWrite":
        case "update_plan":
        case "TaskCreate":
        case "TaskUpdate":
            return phrase("todo", "Updated the to-do list", "Updating the to-do list");
        case "Skill":
            return phrase("skill", "Used a skill", "Using a skill");
        case "ToolSearch":
            return phrase("env", "Loaded more tools", "Loading more tools");
        case "SendMessage":
            return phrase("message", "Messaged a helper", "Messaging a helper");
        case "ListAgents":
            return phrase("message", "Checked the helpers", "Checking the helpers");
        case "TaskOutput":
        case "BashOutput":
            return phrase("wait", "Checked on a background job", "Checking on a background job");
        case "TaskStop":
        case "KillShell":
        case "KillBash":
            return phrase("process", "Stopped a background job", "Stopping a background job");
        case "Monitor":
            return phrase("wait", "Watched a background job", "Watching a background job");
        case "EnterWorktree":
            return phrase("branch", "Set up a worktree", "Setting up a worktree");
        case "ExitWorktree":
            return phrase("branch", "Left the worktree", "Leaving the worktree");
        case "ExitPlanMode":
            return phrase("todo", "Shared a plan", "Sharing a plan");
        case "AskUserQuestion":
            return phrase("message", "Asked you a question", "Asking you a question");
        case "view_image":
            return phrase("image", "Looked at an image", "Looking at an image");
        case "Reasoning":
        case "reasoning":
            return phrase("other", "Thought it through", "Thinking it through");
        default:
            break;
    }
    if (tool.startsWith("mcp__")) {
        for (const [re, key, past, live] of MCP_PHRASES) if (re.test(tool)) return phrase(key, past, live);
        const server = humanServer(tool);
        return phrase("other", `Used ${server}`, `Using ${server}`, undefined, true);
    }
    if (i.path)
        return phrase("other", `Worked on ${fileLabel(i.path)}`, `Working on ${fileLabel(i.path)}`, i.path, true);
    return phrase("other", "Worked on a step", "Working on a step", undefined, true);
}

/** The phrase for one step. */
export function describeStep(step: Step): Phrase {
    if (isShellStep(step)) {
        const command = String(step.input.command ?? "");
        if (command === "file_change") return phrase("edit", "Edited files", "Editing files");
        if (/^(apply_patch|reasoning|web_search|Reasoning)$/.test(command))
            return toolStepPhrase({ ...step, tool: command });
        if (!command.trim()) return phrase("other", "Ran a command", "Running a command", undefined, true);
        return describeCommand(command);
    }
    return toolStepPhrase(step);
}

/** Past-tense phrase of one step ("Read paths.py", "Queried a database"). */
export function stepHeadline(step: Step): string {
    return describeStep(step).past;
}

/** Present-progressive phrase of one step, with the ellipsis ("Reading paths.py…"). */
export function stepLiveHeadline(step: Step): string {
    return `${describeStep(step).live}…`;
}

// ---------------------------------------------------------------------------------------------
// Raw-text guard
// ---------------------------------------------------------------------------------------------

/**
 * Does a line read as raw machine text rather than a sentence? A tool-indicator prefix, a
 * heredoc, a shell-looking line (`$ cmd`, `cd x &&`, `VAR=…;`), code (`import x`, `const x =`),
 * or a line that is mostly paths and punctuation. The plain surfaces describe such a line
 * instead of printing it.
 */
export function looksRaw(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    // Several lines (a snippet of output): raw when any of its first lines is.
    const lines = t
        .split("\n", 6)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length > 1 && (looksRaw(lines[0]) || lines.filter((line) => looksRaw(line)).length >= 2)) return true;
    // A count then a path (`wc -l`, `du`): `467 src/journal/markdown.tsx`.
    if (/^\d+(\.\d+)?[KMG]?\s+\.{0,2}\/?[\w.@-]+\/\S/.test(t)) return true;
    if (/^(🔧|📖|🔍|🔀|📋)/u.test(t)) return true;
    if (/<<-?\s*['"]?[A-Za-z_]+['"]?/.test(t)) return true;
    if (/^\$\s+\S/.test(t)) return true;
    if (
        /^(cd|export|sudo|git|gh|npm|pnpm|npx|python3?|node|bash|sh|rg|grep|sed|awk|cat|curl|ls|find|mkdir|rm|cp|mv|systemctl|journalctl|psql|sqlite3)\s+\S/.test(
            t,
        ) &&
        /[-/$=|&;]/.test(t)
    )
        return true;
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*(;|&&)/.test(t)) return true;
    if (/^(import|from)\s+[\w.{},* ]+(\s+import\s|\s+from\s|;|$)/.test(t) && !/[.!?]$/.test(t)) return true;
    if (/^(const|let|var|function|def|class)\s+\w+\s*[=({:]/.test(t)) return true;
    // Listings and file heads: `ls -l`, a shebang, `grep -n` hits (`12: x`, `path/(a)/b.tsx:3:`).
    if (/^(total \d+$|[dl-][rwxsStT-]{9}\s)|^#!\//.test(t)) return true;
    if (/^\S+:\d+:|^\d+:(?!\d)/.test(t)) return true;
    // SQL: a comment line or a statement keyword run.
    if (
        /^--\s|^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SET|BEGIN|COMMIT|WITH|WHERE|FROM|REVOKE|GRANT)\s+[A-Za-z*("]/.test(
            t,
        )
    )
        return true;
    // A statement line (`x: string | null;`, `private a = b;`), a table row, shell substitution.
    if (/^[\w$.<>[\]]+(\?)?\s*[:=]\s*\S.*;$/.test(t) || /^(private|public|protected|readonly|export|static)\s/.test(t))
        return true;
    if (/\$\(|\[\s+"\$|\$\{\w/.test(t)) return true;
    // Source: a `//` comment, a directive (`"use client";`).
    if (/^\/\/\s|^\/\*|^["']use (client|server|strict)["']/.test(t)) return true;
    // A lone path (`/usr/bin/psql`, `/node_modules`, `src/a.ts`).
    if (/^[^\s:]*\/[^\s]*$/.test(t) && !/^https?:/.test(t)) return true;
    // A numbered listing (`nl -ba`, `cat -n`): the line number then a tab.
    if (/^\d+\t/.test(t) || (t.match(/^\s*\d+(\t|\s{2,})/gm)?.length ?? 0) >= 2) return true;
    // Command output: a grep hit (`src/a.ts:40:…`), a tool's error line (`rg: x: No such file`).
    if (/^\.{0,2}\/?[\w.@~-]+(\/[\w.@-]+)*\.\w{1,8}:\d+[:\s-]/.test(t)) return true;
    if (/^[\w.-]+: .{0,80}: (No such file|Permission denied|command not found|not found)/.test(t)) return true;
    // Source code: statements and blocks (`x.set(a, b); return x; }`, `}, [deps]);`, `() => {`).
    if (/\);\s*($|[\w.$]+\s*[(=])|;\s*(return|const|let|var)\b|;\s*[})]|^[}\])]|\)\s*=>|=>\s*[{(]/.test(t)) return true;
    const words = t.split(/\s+/);
    const pathish = words.filter((w) => /[/\\]/.test(w) && !/^https?:/.test(w)).length;
    // A run of paths (a listing), not a sentence that names a few files ("Updated a.ts, b.ts.").
    const sentence = /[.!?:]$/.test(t) && /^[A-Z][a-z]+\b/.test(t);
    if (!sentence && words.length >= 2 && pathish / words.length > 0.5) return true;
    // Mostly machine tokens: paths, flags, versions, identifiers (SNAKE_CASE, camelCase, a.b.c),
    // punctuation-bearing words. Prose keeps these to a word or two per sentence.
    // Inline code in backticks is markdown prose talking about code, not the code itself.
    if (words.length >= 4 && !sentence && !/`[^`]+`/.test(t)) {
        const machine = words.filter(
            (w) =>
                (/[/\\_=<>{}[\]()|$:;]/.test(w) &&
                    !/^https?:\/\/\S+$/.test(w) &&
                    !/^[(“"']?\w+[)”"',.:;!?]*$/.test(w)) ||
                /^--?\w/.test(w) ||
                /^\d+(\.\d+){1,}[,.)]?$/.test(w) ||
                /^[a-z]+[A-Z]\w*$/.test(w) ||
                /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(w) ||
                /^\w+\.\w+\.\w+/.test(w),
        ).length;
        if (machine / words.length >= 0.35) return true;
    }
    const symbols = t.replace(/[^{}[\]();=<>|$\\]/g, "").length;
    return t.length >= 24 && symbols / t.length > 0.12;
}
