/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * A plain sentence for a shell command on a tool card ("Ran the tests"), or null.
 *
 * Deliberately conservative: a sentence is given only when EVERY stage of the command (split on
 * `&&`, `;`, `|`, newlines) is one the table recognises, so a harmless stage can never stand in
 * for a destructive one. Anything else returns null and the card shows the raw command: redirects
 * and heredocs, command substitution, background jobs, flags that force, rewrite or write
 * (`--force`, `--amend`, `--fix`, `-f` ...), and every program not in the table (rm, mv,
 * chmod, kill, sudo, a shell, a database client, curl). Stages match a real subcommand, not a
 * prefix. The only agent-supplied fragments are a file's basename and a quoted search term.
 */

const END = String.raw`(?=\s|$)`;
const PM = String.raw`(?:npm|pnpm|yarn)\s+(?:run\s+)?`;

/** [stage, sentence]; `{}` is replaced by what the stage names. */
const COMMANDS: [RegExp, string][] = [
    [new RegExp(String.raw`^git\s+push${END}`), "Pushed changes"],
    [new RegExp(String.raw`^git\s+commit${END}`), "Saved a commit"],
    [new RegExp(String.raw`^gh\s+pr\s+create${END}`), "Opened a PR"],
    [new RegExp(String.raw`^git\s+(?:status|diff|log|show)${END}`), "Looked at the git history"],
    [new RegExp(`^(?:${PM}test|(?:npx\\s+)?(?:jest|vitest|pytest))${END}`), "Ran the tests"],
    [new RegExp(`^(?:(?:npx\\s+)?tsc\\s+--noEmit|${PM}lint:types)${END}`), "Checked the types"],
    [new RegExp(`^(?:npx\\s+)?prettier\\s+--check${END}`), "Checked the formatting"],
    [new RegExp(`^${PM}build${END}`), "Built the project"],
    [new RegExp(`^(?:npm|pnpm|yarn)\\s+(?:install|ci)${END}`), "Installed packages"],
    [/^(?:cat|head|tail)\s/, "Read {}"],
    [/^(?:rg|grep)\s/, "Searched the code{}"],
    [/^ls(?:\s|$)/, "Listed files"],
    [/^sleep\s/, "Waited"],
];

/** Flags that force, rewrite or write: a command carrying one is never summarised. */
const RISKY = /(?:^|\s)(?:-f|-u|--(?:force\S*|admin|hard|amend|write|fix|no-verify))(?:\s|$|=)/;

const quoted = (text: string): string => ` for “${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;

/** The sentence for a shell command line, or null when it should be shown as typed. */
export function describeCommand(command: string): string | null {
    // Harmless redirects (`2>&1`, `>/dev/null`) go; any other redirect, heredoc, substitution or
    // background job means the command does more than it reads as.
    const text = command
        .replace(/\d?>&\d|\d?>\s*\/dev\/null/g, " ")
        .replace(/(["'])(?:\\.|(?!\1).)*\1/g, (q) => (q.length > 42 ? "''" : q));
    if (/[<>`$]|(?<!&)&(?!&)/.test(text)) return null;
    const stages = text
        .split(/&&|\|\||;|\||\n/)
        .map((s) => s.trim().replace(/^git\s+-C\s+\S+/, "git"))
        .filter(Boolean)
        .filter((s) => !/^cd\s+\S+$/.test(s));
    if (!stages.length) return null;
    let best = COMMANDS.length;
    let chosen = "";
    for (const stage of stages) {
        const rank = COMMANDS.findIndex(([re]) => re.test(stage));
        if (rank === -1 || RISKY.test(stage)) return null;
        // A push refspec can delete (`:branch`) or force (`+branch`) a remote branch.
        if (stage.startsWith("git push") && /\s[^\s-]*[+:]/.test(stage)) return null;
        if (rank < best) [best, chosen] = [rank, stage];
    }
    const sentence = COMMANDS[best][1];
    const args = chosen
        .split(/\s+/)
        .slice(1)
        .filter((a) => !a.startsWith("-"));
    if (sentence.startsWith("Read")) return args.length === 1 ? `Read ${args[0].split("/").pop()}` : "Read files";
    return sentence.replace("{}", args[0] ? quoted(args[0].replace(/^["']|["']$/g, "")) : "");
}

const PLAIN_KEY = "matron_journal_plain_tool_cards";
const listeners = new Set<() => void>();

/** Device setting, off by default: show the sentence on tool cards instead of the command. */
export const plainToolCards = (): boolean => {
    try {
        return localStorage.getItem(PLAIN_KEY) === "1";
    } catch {
        return false;
    }
};

export function setPlainToolCards(on: boolean): void {
    try {
        if (on) localStorage.setItem(PLAIN_KEY, "1");
        else localStorage.removeItem(PLAIN_KEY);
    } catch {
        // Storage unavailable: the setting just does not stick.
    }
    listeners.forEach((listener) => listener());
}

export const subscribePlainToolCards = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};
