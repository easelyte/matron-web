/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Plain-English activity for the non-developer surfaces (Developer view OFF): the sidebar
 * preview line and the subagent cards.
 *
 * The bridge reports a Claude subagent's tool calls (and a few of the parent's) as ordinary
 * `text` events with a fixed emoji prefix — `🔧 \`cmd\``, `📖 path`, `🔍 pattern`,
 * `🌐 query`, `🔀 Subtask: …` (bridge lib/subagent-tool-format.js and index.js). A newer bridge
 * also attaches the structured call as `payload.step` ({ tool, command?, path?, pattern?, url?,
 * description? }); when present it wins, the text form is the fallback for older bridges and for
 * the server's snippet (which only ever carries the body).
 *
 * Everything here turns those into a turn-grouping Step, so the sentences come from the same
 * templates as the turn card (turn-grouping.ts): "Reading paths.py…", "Ran the tests".
 */

import { snippetText } from "./plain-text";
import { liveLine, type Step, stepSentence } from "./turn-grouping";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Tool names the bridge's `🔧 Name` fallback line carries (an identifier, not a command). */
const TOOL_NAME = /^[A-Za-z_][\w.:-]{0,79}$/;

/** A path the bridge prints for a Read: absolute (or home-relative), with no whitespace. */
const PATH = /^(?:\/|~\/|[A-Za-z]:\\)\S*$/;
/**
 * A search pattern: one token, or one carrying regex syntax prose does not use (an escape, an
 * alternation, `.*`, a character class, an anchor).
 */
const PATTERN = (value: string): boolean => !/\s/.test(value) || /\\|\||\.\*|\[[^\]]*\]|^\^|\$$/.test(value);

/**
 * The step a bridge tool-indicator line names, or null for prose.
 *
 * Deliberately strict, because the text form is only the fallback for a bridge that does not
 * attach `payload.step`: the whole body must be one indicator line whose argument has the shape
 * the bridge prints (a backticked command, a bare tool name, an absolute path, a pattern, a URL,
 * `Subtask:`). Agent prose that happens to open with the same emoji ("🔍 Found the root cause")
 * stays prose. The to-do list and a web search's free-text query are left as prose too: neither
 * can be told apart from a sentence. `partial` accepts a line the server cut at 120 characters (a
 * snippet can lose the closing backtick of a long command).
 */
export function indicatorStep(body: string, id = "indicator", partial = false): Step | null {
    const text = body.trim();
    if (!text || text.includes("\n")) return null;
    const make = (tool: string, input: Step["input"]): Step => ({ kind: "step", id, tool, input, status: "ok" });
    let match: RegExpExecArray | null;
    if ((match = /^🔧 `([^`]+)`$/u.exec(text))) return make("Bash", { command: match[1] });
    if (partial && (match = /^🔧 `([^`]+)$/u.exec(text))) return make("Bash", { command: match[1] });
    if ((match = /^🔧 (\S+)$/u.exec(text)) && TOOL_NAME.test(match[1])) return make(match[1], {});
    if ((match = /^📖 (\S.*)$/u.exec(text)) && PATH.test(match[1])) return make("Read", { path: match[1] });
    if ((match = /^🔍 (\S.*)$/u.exec(text)) && PATTERN(match[1])) return make("Grep", { pattern: match[1] });
    if ((match = /^🌐 (https?:\/\/\S+)$/u.exec(text))) return make("WebFetch", { url: match[1] });
    if ((match = /^🔀 (?:Nested s|S)ubtask: (\S.*)$/u.exec(text)))
        return make("Task", { description: match[1].replace(/…$/u, "") });
    return null;
}

/** The structured `payload.step` a newer bridge attaches to an indicator line, as a Step. */
export function payloadStep(value: unknown, id = "indicator"): Step | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const tool = asString(raw.tool).trim();
    if (!tool || !TOOL_NAME.test(tool)) return null;
    const input: Step["input"] = {};
    for (const key of ["command", "path", "pattern", "url", "description"] as const) {
        const field = asString(raw[key]);
        if (field) input[key] = field;
    }
    return { kind: "step", id, tool, input, status: "ok" };
}

/** A `$ command` snippet (the client's own tool_output snippet when the output is absent). */
function dollarStep(text: string): Step | null {
    const match = /^\$\s+(\S[^\n]*)$/.exec(text.trim());
    return match ? { kind: "step", id: "snippet", tool: "Bash", input: { command: match[1] }, status: "ok" } : null;
}

/**
 * One-line prose from markdown: inline markers dropped, fenced code removed, whitespace folded.
 * A server snippet is already flattened and cut at 120 characters, so it is often not
 * well-formed markdown; stray `**` and backticks from the cut are dropped too.
 */
export function plainLine(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?(```|$)/g, " ")
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
        .replace(/(^|\s)#{1,6}\s+/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\*\*|`/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

const DIAGNOSTIC =
    /\(\d+,\d+\): (?:error|warning)|\berror TS\d+|Traceback \(most recent call|npm ERR!|^\s*at \S+ \(|\bexit(?:ed)? (?:code|status) \d+/m;
const GREP_HIT = /(?:^|\s)[\w./-]+\.\w+:\d+(?::\d+)?(?:[:\s]|$)/;

/**
 * Does a snippet read as a command's output rather than a sentence? Conservative: a compiler or
 * runtime diagnostic, JSON, or dense punctuation; for a Codex session also `file.ts:12` grep hits
 * (its prose rarely looks like that, its tool output often does).
 */
export function looksLikeOutput(snippet: string, codex = false): boolean {
    const text = snippet.trim();
    if (text.length < 8) return false;
    if (/^[[{]\s*["{[]/.test(text)) return true;
    if (DIAGNOSTIC.test(text)) return true;
    if (codex && GREP_HIT.test(text)) return true;
    const symbols = text.replace(/[^{}[\]();=<>|$\\]/g, "").length;
    return text.length >= 24 && symbols / text.length > 0.12;
}

/** Present-progressive while running ("Reading paths.py…"), past tense once done ("Read paths.py"). */
export function activitySentence(step: Step, running: boolean): string {
    return running ? liveLine(step) : stepSentence(step);
}

export interface PreviewSource {
    snippet: string;
    session_state: string;
    /** Client-side: the last message event's step, when it was one (database.ts). */
    last_step?: { tool: string; input: Step["input"] } | null;
    /** Which backend runs it (client.workerKind), when known. */
    worker?: "claude" | "codex" | null;
}

/**
 * The sidebar preview line with Developer view OFF: never a command line or code. A tool call
 * reads as its activity sentence; anything else is the last message as one line of prose.
 */
export function previewLine(conversation: PreviewSource): string {
    const running = conversation.session_state === "running";
    const known = conversation.last_step;
    if (known && typeof known.tool === "string") {
        return activitySentence(
            { kind: "step", id: "last", tool: known.tool, input: known.input ?? {}, status: "ok" },
            running,
        );
    }
    const snippet = conversation.snippet ?? "";
    const step = indicatorStep(snippet, "snippet", true) ?? dollarStep(snippet);
    if (step) return activitySentence(step, running);
    // The server's placeholder for a message it has no text for.
    if (snippet.trim() === "[diff]") return running ? "Changing a file…" : "Changed a file";
    if (snippet.trim() === "[tool_output]") return running ? "Running a command…" : "Ran a command";
    // A tool_output's snippet is the command's OUTPUT, which the server hands back as the row's
    // snippet. With no recorded step (after a snapshot) the row cannot know it was output, so
    // anything that reads as output — a diagnostic, a stack, JSON, grep hits — or anything at all
    // from a running Codex session is described instead of printed.
    if (looksLikeOutput(snippet, conversation.worker === "codex")) return running ? "Working…" : "Ran a command";
    if (running && conversation.worker === "codex") return "Working…";
    return snippetText(snippet);
}
