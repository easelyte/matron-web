/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { Session, SessionStatus } from "./types";

/**
 * One pickable argument for a slash command: a flag (`--browser`) or a value (`interactive`).
 * `conflictsWith` lists lowercased tokens that hide it once on the line — mutual exclusion is two
 * entries naming each other (`--claude` / `--codex`), a dependency is one-way (`--browser` is
 * Claude-only, so `--codex` hides it) — so the palette never builds a line the bridge refuses.
 */
export interface ArgSuggestion {
    value: string;
    label?: string;
    summary?: string;
    conflictsWith?: string[];
}

export interface BotCommand {
    trigger: string;
    summary: string;
    argHint?: string;
    argSuggestions?: ArgSuggestion[];
    /** The session's own list (status frame `model_options` / `effort_levels`) supplies the values. */
    sessionArgSource?: "model_options" | "effort_levels";
}

const AGENT_FLAGS: ArgSuggestion[] = [
    { value: "--claude", summary: "Use the Claude agent", conflictsWith: ["--codex"] },
    { value: "--codex", summary: "Use the Codex agent", conflictsWith: ["--claude", "--browser"] },
];
const BROWSER_FLAG: ArgSuggestion = {
    value: "--browser",
    summary: "Add browser tools (chrome-devtools MCP)",
    conflictsWith: ["--codex"],
};

// The Mac composer's catalog (and its argument offers), checked against the bridge's command
// names and !help text — resync on bridge command changes. /context and /compact are not bridge
// commands: they pass through to the agent's own terminal.
export const CLAUDE_BRIDGE_COMMANDS: BotCommand[] = [
    {
        trigger: "/start",
        summary: "Start a new session",
        argHint: "[--claude|--codex] [--browser] [--model alias] [workdir]",
        argSuggestions: [...AGENT_FLAGS, BROWSER_FLAG],
    },
    { trigger: "/stop", summary: "Stop the current session" },
    {
        trigger: "/restart",
        summary: "Stop and immediately resume the session",
        argHint: "[--force] [--browser]",
        argSuggestions: [{ value: "--force", summary: "Restart immediately, even mid-turn" }, BROWSER_FLAG],
    },
    {
        trigger: "/resume",
        summary: "Resume a previous session",
        argHint: "[--claude|--codex] [n|id]",
        argSuggestions: AGENT_FLAGS,
    },
    { trigger: "/sessions", summary: "List past sessions", argHint: "[--claude|--codex]", argSuggestions: AGENT_FLAGS },
    {
        trigger: "/workdir",
        summary: "Start a session in a different directory",
        argHint: "[--claude|--codex] <path>",
        argSuggestions: AGENT_FLAGS,
    },
    { trigger: "/status", summary: "Show current session info" },
    { trigger: "/agent", summary: "Show the current agent" },
    {
        trigger: "/switch",
        summary: "Hand this conversation to the other coding agent",
        argHint: "<claude|codex>",
        argSuggestions: [
            { value: "claude", summary: "Hand over to Claude" },
            { value: "codex", summary: "Hand over to Codex" },
        ],
    },
    { trigger: "/working", summary: "Toggle tool call visibility" },
    { trigger: "/mcp", summary: "Show MCP server status" },
    { trigger: "/model", summary: "Show or switch the model", argHint: "[alias]", sessionArgSource: "model_options" },
    { trigger: "/effort", summary: "Show or set effort level", argHint: "[level]", sessionArgSource: "effort_levels" },
    {
        trigger: "/mode",
        summary: "Show or switch interactive vs print",
        argHint: "[interactive|print]",
        argSuggestions: [
            { value: "interactive", summary: "Interactive TUI mode" },
            { value: "print", summary: "Non-interactive print mode" },
        ],
    },
    { trigger: "/cost", summary: "Show session cost" },
    { trigger: "/usage", summary: "Show token usage" },
    { trigger: "/limits", summary: "Show subscription usage limits" },
    { trigger: "/tools", summary: "List available tools" },
    { trigger: "/context", summary: "Show what's using the context window" },
    { trigger: "/compact", summary: "Compact the conversation to free context", argHint: "[instructions]" },
    { trigger: "/login", summary: "Log in to your Anthropic account" },
    { trigger: "/logout", summary: "Log out of your Anthropic account" },
    {
        trigger: "/timer",
        summary: "Send a message to this chat later",
        argHint: "<duration> <message> | cancel <id|all>",
        argSuggestions: [{ value: "cancel", summary: "Cancel a pending timer" }],
    },
    // The rescue keystrokes are bang-only on the bridge: a typed "/esc" would reach the agent's
    // terminal as a junk command, so the palette completes the bang form ("/es" still finds it).
    { trigger: "!esc", summary: "Cancel the current turn" },
    { trigger: "!enter", summary: "Press Enter in the agent's terminal" },
    { trigger: "/help", summary: "Show command help" },
];

export function filterCommands(commands: BotCommand[], input: string): BotCommand[] {
    const prefix = input.replace(/^\s+/, "").replace(/^[/!]/, "").toLowerCase();
    return commands.filter((command) => command.trigger.slice(1).toLowerCase().startsWith(prefix));
}

export function isCommandMode(input: string): boolean {
    const normalized = input.replace(/^\s+/, "");
    return (normalized.startsWith("/") || normalized.startsWith("!")) && normalized.split(/\s+/).length === 1;
}

interface ParsedFolderCommand {
    command: "start" | "workdir";
    partial: string;
}

// recognized flags mirror bridge lib/agent-backend.js extractAgentFlag + lib/mcp-config.js extractMcpExtraFlags — resync if the bridge adds flags
function isRecognizedFolderFlag(token: string): boolean {
    const normalized = normalizeLeadingDashes(token);
    return (
        normalized === "--claude" ||
        normalized === "--codex" ||
        normalized === "--browser" ||
        /^--agent=\S+$/.test(normalized)
    );
}

function parseFolderCommand(input: string): ParsedFolderCommand | null {
    const commandMatch = input.match(/^\s*([/!])(start|workdir)\s+/i);
    if (!commandMatch) return null;

    let rest = input.slice(commandMatch[0].length);
    while (rest.length > 0) {
        const flagMatch = rest.match(/^(\S+)\s+/);
        if (!flagMatch || !isRecognizedFolderFlag(flagMatch[1])) break;
        rest = rest.slice(flagMatch[0].length);
    }
    if (!/^(?!--)\S*$/.test(rest)) return null;

    return {
        command: commandMatch[2].toLowerCase() as ParsedFolderCommand["command"],
        partial: rest,
    };
}

/**
 * Return the partial folder token for a start/workdir command. After matching
 * the command case-insensitively, walk leading whitespace-delimited tokens and
 * skip only exact, case-sensitive bridge flags. The remaining value must be a
 * single token that does not start with `--`; otherwise completion is disabled.
 */
export function folderCompletionPartial(input: string): string | null {
    return parseFolderCommand(input)?.partial ?? null;
}

export function applyCommand(trigger: string): string {
    return `${trigger} `;
}

/** Phone keyboards turn a leading `--` into a dash character; the bridge reads it back as `--`. */
export function normalizeLeadingDashes(token: string): string {
    return token.replace(/^[‐‑‒–—―]+/, "--");
}

// A session-supplied list, deduplicated case-insensitively in the bridge's order (rows are keyed
// by value). Entries without a usable value are skipped: the list is remote input.
function sessionSuggestions(
    source: BotCommand["sessionArgSource"],
    status: SessionStatus | undefined,
): ArgSuggestion[] {
    const options = source ? status?.[source] : undefined;
    if (!Array.isArray(options)) return [];
    const seen = new Set<string>();
    const suggestions: ArgSuggestion[] = [];
    for (const option of options) {
        if (typeof option?.value !== "string" || !option.value.trim()) continue;
        const key = option.value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ value: option.value, label: typeof option.label === "string" ? option.label : undefined });
    }
    return suggestions;
}

/**
 * The argument rows for a fully typed command (either prefix) followed by whitespace: its static
 * suggestions plus the session's list, filtered by the trailing partial token. Flags compose, so a
 * flag stays offered until it, or one it conflicts with, is on the line — but only while no
 * positional token is down (the grammar is `[flags] [path]`). A plain value fills the one slot, so
 * it is offered only before any argument. A suggestion equal to the partial offers nothing.
 */
export function argSuggestions(input: string, commands: BotCommand[], status?: SessionStatus): ArgSuggestion[] {
    const match = input.match(/^[ \t]*[/!](\S+)(\s[\s\S]*)$/);
    if (!match) return [];
    const name = match[1].toLowerCase();
    const command = commands.find((candidate) => candidate.trigger.slice(1).toLowerCase() === name);
    if (!command) return [];

    const args = match[2];
    const partialStart = args.search(/\S*$/);
    const partial = normalizeLeadingDashes(args.slice(partialStart)).toLowerCase();
    const earlier = new Set(
        args
            .slice(0, partialStart)
            .split(/\s+/)
            .filter((token) => token.length > 0)
            .map((token) => normalizeLeadingDashes(token).toLowerCase()),
    );
    const positionalFilled = [...earlier].some((token) => !token.startsWith("--"));

    const pool = [...(command.argSuggestions ?? []), ...sessionSuggestions(command.sessionArgSource, status)];
    return pool.filter((suggestion) => {
        const value = suggestion.value.toLowerCase();
        if (value.startsWith("--")) {
            if (positionalFilled || earlier.has(value)) return false;
        } else if (earlier.size > 0) {
            return false;
        }
        if (suggestion.conflictsWith?.some((token) => earlier.has(token))) return false;
        return value.startsWith(partial) && value !== partial;
    });
}

/** Replaces the trailing partial token with the picked argument and a space, ready for the next. */
export function applyArgument(input: string, value: string): string {
    return input.replace(/\S*$/, () => `${value} `);
}

export function applyFolder(input: string, path: string): string {
    return input.replace(/\S*$/, () => path);
}

export function recentFolderArgument(text: string): string | null {
    const commandMatch = text.match(/^\s*[/!](start|workdir)(?:\s+(.*))?$/i);
    if (!commandMatch) return null;

    const command = commandMatch[1].toLowerCase() as ParsedFolderCommand["command"];
    const tokens = (commandMatch[2] ?? "")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0 && !isRecognizedFolderFlag(token));
    if (tokens.length === 0) return null;

    if (command === "start") {
        const path = tokens[0];
        return path === "now" || path === "fresh" ? null : path;
    }
    return tokens.join(" ");
}

export interface RecentFoldersStore {
    record(path: string): void;
    matches(prefix: string): string[];
}

const RECENT_FOLDERS_KEY_PREFIX = "matron_journal_recent_start_folders_v1";
const MAX_RECENT_FOLDERS = 15;

function parseRecentFolders(raw: string | null): string[] {
    if (raw === null) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn("matron: malformed recent folders value, ignoring");
        return [];
    }

    if (!Array.isArray(parsed)) {
        console.warn("matron: recent folders value not an array, ignoring");
        return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
}

/**
 * Persist folders used in attempted start/workdir commands. Recording follows
 * client outbox acceptance, not bridge-confirmed command success.
 */
export function makeRecentFoldersStore(session: Session | undefined): RecentFoldersStore {
    if (!session) {
        return {
            record: () => undefined,
            matches: () => [],
        };
    }

    const key = `${RECENT_FOLDERS_KEY_PREFIX}:${encodeURIComponent(session.serverUrl)}:${session.userId}`;

    return {
        record(path: string): void {
            try {
                const folders = parseRecentFolders(localStorage.getItem(key));
                const updated = [path, ...folders.filter((folder) => folder !== path)].slice(0, MAX_RECENT_FOLDERS);
                localStorage.setItem(key, JSON.stringify(updated));
            } catch {
                console.warn("matron: recent folders record failed (storage unavailable)");
            }
        },

        matches(prefix: string): string[] {
            try {
                const normalizedPrefix = prefix.toLowerCase();
                return parseRecentFolders(localStorage.getItem(key)).filter((folder) =>
                    folder.toLowerCase().startsWith(normalizedPrefix),
                );
            } catch {
                console.warn("matron: recent folders read failed (storage unavailable)");
                return [];
            }
        },
    };
}

export function folderSuggestions(input: string, store: RecentFoldersStore): string[] {
    const parsed = parseFolderCommand(input);
    if (!parsed) return [];

    return store
        .matches(parsed.partial)
        .filter((folder) => folder !== parsed.partial)
        .filter((folder) => parsed.command === "workdir" || !/\s/.test(folder))
        .slice(0, 8);
}
