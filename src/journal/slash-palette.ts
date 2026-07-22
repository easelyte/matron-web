/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { Session } from "./types";

export interface BotCommand {
    trigger: string;
    summary: string;
    argHint?: string;
}

// source: bridge lib/command-dispatch.js BRIDGE_COMMAND_NAMES + index.js !help text — resync on bridge command changes
export const CLAUDE_BRIDGE_COMMANDS: BotCommand[] = [
    {
        trigger: "/start",
        argHint: "[--claude|--codex] [--browser] [workdir]",
        summary: "Start a new session (creates a new room)",
    },
    { trigger: "/stop", summary: "Stop the current session" },
    { trigger: "/restart", summary: "Stop and immediately resume the session (--browser also accepted)" },
    {
        trigger: "/resume",
        argHint: "[--claude|--codex] <n|id>",
        summary: "Resume a session from that agent",
    },
    {
        trigger: "/sessions",
        argHint: "[--claude|--codex]",
        summary: "List past sessions for an agent",
    },
    {
        trigger: "/workdir",
        argHint: "[--claude|--codex] <path>",
        summary: "Start a session in a different directory",
    },
    { trigger: "/status", summary: "Show current session info" },
    { trigger: "/agent", summary: "Show the current agent" },
    {
        trigger: "/switch",
        argHint: "<claude|codex>",
        summary: "Hand this conversation to the other agent",
    },
    { trigger: "/working", summary: "Toggle tool call visibility" },
    { trigger: "/mcp", summary: "Show MCP server status" },
    { trigger: "/model", summary: "Show current model" },
    { trigger: "/effort", argHint: "[level]", summary: "Show or set effort level" },
    {
        trigger: "/mode",
        argHint: "[interactive|print]",
        summary: "Show or switch interactive vs non-interactive",
    },
    { trigger: "/login", summary: "Log in to your Anthropic account" },
    { trigger: "/logout", summary: "Log out of your Anthropic account" },
    { trigger: "/cost", summary: "Show session cost" },
    { trigger: "/usage", summary: "Show token usage" },
    { trigger: "/limits", summary: "Show subscription usage limits (session & weekly)" },
    { trigger: "/tools", summary: "List available tools" },
    { trigger: "/help", summary: "Show this help message" },
    { trigger: "!esc", summary: "Cancel the current turn without killing the session" },
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
    const normalized = token.replace(/^[‐‑‒–—―]+/, "--");
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

export function applyFolder(input: string, path: string): string {
    return input.replace(/\S*$/, () => path);
}

export function recentFolderArgument(text: string): string | null {
    const commandMatch = text.match(/^\s*[/!](start|workdir)(?:\s+(.*))?$/i);
    if (!commandMatch) return null;

    const command = commandMatch[1].toLowerCase() as ParsedFolderCommand["command"];
    const tokens = (commandMatch[2] ?? "").trim().split(/\s+/).filter(Boolean);
    while (tokens.length > 0 && isRecognizedFolderFlag(tokens[0])) tokens.shift();
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
