/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Journal events → operator turns (redesign v6, "Show the work" OFF).
 *
 * A turn is the ordered journal events between one operator message and the next
 * (GENERATIVE-SYSTEM §1). Inside a turn every event lands in exactly one bucket:
 *
 *   steps      tool_output and diff events — the agent's own work (the card's rows)
 *   narration  agent text that arrives BEFORE the turn's last step (inside the card)
 *   answer     agent text AFTER the last step (prose below the card)
 *   breaks     break-throughs (§6): prompts, permission requests, images, files, tracker
 *              markers, spawn outcomes, unknown event types — rendered after the card
 *   notices    the bridge talking about the session (compaction, idle resume, queued sends,
 *              restarts) — one tertiary line each, outside the agent tile
 *   errors     a turn-ending error (session ended non-zero, couldn't resume) — .mj_TurnError
 *   peers      peer messages — their own rows, as today
 *
 * Pure; no React. The bridge publishes its notices as ordinary `text` events, so
 * bridgeTextKind() recognises them by an allowlist of the bridge's fixed wordings. That is a
 * stop-gap until the bridge marks them (see docs/design/redesign-v6/HANDOFF.md, bridge gaps).
 */

import { type JournalEvent } from "./types";
import { type Step, stepsOf, type TurnItem } from "./turn-grouping";

export type BridgeTextKind = "notice" | "error";

/** The bridge's own session notices, recognised by their fixed wordings. */
const NOTICE_PATTERNS: readonly RegExp[] = [
    /^🗜️?\s*(Context compacted|\/compact is already queued)/u,
    /^✅\s*Compacted\b/u,
    /^⏳\s*(Session was idle|A restart is pending)/u,
    /^⚡\s/u,
    /^🔄\s*Restarting\b/u,
    /^(Claude|Codex) session restarted\./,
    /^Waiting for turn to finish before restarting\b/,
    /^Session stopped\.$/,
    /^\[Session ended \(exit 0\)\]$/,
    /^👋\s/u,
    /^✅\s*(Allowed once|Always allowing)\b/u,
];

/** Turn-ending errors the bridge reports as text. */
const ERROR_PATTERNS: readonly RegExp[] = [
    /^\[Session ended \(exit (?!0\))-?\d+\)\]$/,
    /^⚠️?\s*(That conversation can no longer be found or resumed|Could not carry on|Could not deliver your (message|answer))/u,
    /^The session couldn[’']t resume\b/,
];

export function bridgeTextKind(body: string): BridgeTextKind | null {
    const text = body.trim();
    if (!text) return null;
    if (ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "error";
    if (NOTICE_PATTERNS.some((pattern) => pattern.test(text))) return "notice";
    return null;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export function isOperatorEvent(event: JournalEvent): boolean {
    return event.sender.startsWith("user:");
}

/**
 * An operator event that opens a new turn. An answer to the agent's own question
 * (`prompt_reply`) does not: the agent carries on with the same turn after it, so its steps stay
 * in the same card.
 */
export function isTurnBoundary(event: JournalEvent): boolean {
    return isOperatorEvent(event) && event.type !== "prompt_reply";
}

/** A Codex generic completed item the bridge publishes as a one-token code span (loop #772). */
const CODEX_ITEM_TEXT = /^`([A-Z][A-Za-z0-9 ]{0,79})`$/;

/** Body of an agent text event, or "" when it is not a plain agent text. */
function agentText(event: JournalEvent): string {
    if (event.type !== "text" || isOperatorEvent(event)) return "";
    if (asString(event.payload.fallback_for)) return "";
    return asString(event.payload.body);
}

/**
 * The step a journal event represents, or null. `previousTs` (the preceding event in the turn)
 * approximates the step's duration: the bridge publishes a command at completion and a diff at
 * tool-use time, and neither carries a start time.
 */
export function eventToStep(event: JournalEvent, previousTs?: number): Step | null {
    const payload = event.payload;
    const ms = previousTs !== undefined && event.ts > previousTs ? event.ts - previousTs : undefined;
    if (event.type === "tool_output") {
        const command = asString(payload.command) || asString(payload.tool_name);
        const exit =
            typeof payload.exit_code === "number" ? payload.exit_code : payload.exit_code === null ? null : undefined;
        const status = asString(payload.status);
        const failed =
            payload.denied === true ||
            (typeof exit === "number" && exit !== 0) ||
            status === "failed" ||
            status === "declined";
        return {
            kind: "step",
            id: `e${event.seq}`,
            // Codex's legacy exec transport reports file edits as a `file_change` tool_output.
            tool: command === "file_change" ? "file_change" : "Bash",
            input: { command },
            // exit_code null = the bridge never observed an exit (killed, or the session died
            // under the command): never report that as a pass.
            status: failed ? "failed" : exit === null ? "stopped" : "ok",
            exit,
            ms,
            source: event,
        };
    }
    if (event.type === "diff") {
        const path = asString(payload.display_path) || asString(payload.file_path);
        return {
            kind: "step",
            id: `e${event.seq}`,
            tool: asString(payload.tool) || "Edit",
            input: { path },
            status: "ok",
            added: typeof payload.added === "number" ? payload.added : undefined,
            removed: typeof payload.removed === "number" ? payload.removed : undefined,
            newFile: typeof payload.new_file === "boolean" ? payload.new_file : undefined,
            ms,
            source: event,
        };
    }
    const codexItem = CODEX_ITEM_TEXT.exec(agentText(event).trim());
    if (codexItem) {
        const name = codexItem[1];
        return {
            kind: "step",
            id: `e${event.seq}`,
            tool: /^web ?search$/i.test(name) ? "WebSearch" : name,
            input: {},
            status: "ok",
            ms,
            source: event,
        };
    }
    return null;
}

export interface Turn {
    /** Stable key: the seq of the turn's first event. */
    key: string;
    /** The operator event that opened the turn; absent for events before the first message. */
    operator?: JournalEvent;
    /** Every non-operator event of the turn, in order (the Show-the-work-ON rendering). */
    events: JournalEvent[];
    /** Card content: steps and narration, in order. */
    items: TurnItem[];
    breaks: JournalEvent[];
    /** The operator's answers to the agent's questions during the turn (`prompt_reply`). */
    replies: JournalEvent[];
    answer: JournalEvent[];
    errors: JournalEvent[];
    notices: JournalEvent[];
    peers: JournalEvent[];
    /** ms: operator message (decision §7.5) or the first event → the last event. */
    startTs: number;
    endTs: number;
}

export type ThreadRow =
    | { kind: "operator"; event: JournalEvent }
    | { kind: "turn"; turn: Turn }
    | { kind: "notice"; event: JournalEvent }
    | { kind: "peer"; event: JournalEvent };

type Classified =
    | { bucket: "step"; step: Step }
    | { bucket: "text"; text: string }
    | { bucket: "break" | "error" | "notice" | "peer" };

function classifyAgentEvent(event: JournalEvent, previousTs: number | undefined): Classified {
    if (event.type === "peer_message") return { bucket: "peer" };
    const step = eventToStep(event, previousTs);
    if (step) return { bucket: "step", step };
    if (event.type === "text") {
        const body = agentText(event);
        const kind = bridgeTextKind(body);
        if (kind === "error") return { bucket: "error" };
        if (kind === "notice") return { bucket: "notice" };
        return { bucket: "text", text: body };
    }
    return { bucket: "break" };
}

function emptyTurn(first: JournalEvent, operator?: JournalEvent): Turn {
    return {
        key: String(first.seq),
        operator,
        events: [],
        items: [],
        breaks: [],
        replies: [],
        answer: [],
        errors: [],
        notices: [],
        peers: [],
        startTs: first.ts,
        endTs: first.ts,
    };
}

/** Group visible journal events (already filtered by the timeline) into operator turns. */
export function assembleTurns(events: readonly JournalEvent[]): Turn[] {
    const turns: Turn[] = [];
    let current: Turn | null = null;
    // Per turn: the text events in order with their position relative to the steps, resolved
    // into narration vs answer once the turn's last step is known.
    let texts: Array<{ event: JournalEvent; text: string; itemIndex: number }> = [];
    let lastTs: number | undefined;

    const finish = (): void => {
        if (!current) return;
        const turn = current;
        const steps = stepsOf(turn.items);
        const lastStep = steps[steps.length - 1];
        const lastStepIndex = lastStep ? turn.items.indexOf(lastStep) : -1;
        // Walk texts backwards so splicing narration into items keeps earlier indexes valid.
        for (let index = texts.length - 1; index >= 0; index -= 1) {
            const entry = texts[index];
            if (entry.itemIndex <= lastStepIndex) {
                turn.items.splice(entry.itemIndex, 0, { kind: "narration", text: entry.text });
            } else {
                turn.answer.unshift(entry.event);
            }
        }
        texts = [];
        turns.push(turn);
        current = null;
    };

    for (const event of events) {
        if (isTurnBoundary(event)) {
            finish();
            current = emptyTurn(event, event);
            lastTs = event.ts;
            continue;
        }
        if (!current) current = emptyTurn(event);
        const turn = current;
        turn.events.push(event);
        // Duration ends at the turn's last own event: bridge notices and peers don't extend it.
        if (event.type !== "peer_message" && !(event.type === "text" && bridgeTextKind(agentText(event)) === "notice"))
            turn.endTs = Math.max(turn.endTs, event.ts);
        if (isOperatorEvent(event)) {
            turn.replies.push(event);
            lastTs = event.ts;
            continue;
        }
        const classified = classifyAgentEvent(event, lastTs);
        lastTs = event.ts;
        switch (classified.bucket) {
            case "step":
                turn.items.push(classified.step);
                break;
            case "text":
                // Narration sits before the step that follows it: remember where it arrived.
                texts.push({ event, text: classified.text, itemIndex: turn.items.length });
                break;
            case "break":
                turn.breaks.push(event);
                break;
            case "error":
                turn.errors.push(event);
                break;
            case "notice":
                turn.notices.push(event);
                break;
            case "peer":
                turn.peers.push(event);
                break;
        }
    }
    finish();
    return turns;
}

/**
 * The thread as rows: each turn's operator bubble, then its agent tile (only when it has
 * anything to show), then its notices and peer messages in the order they happened.
 */
export function threadRows(turns: readonly Turn[]): ThreadRow[] {
    const rows: ThreadRow[] = [];
    for (const turn of turns) {
        if (turn.operator) rows.push({ kind: "operator", event: turn.operator });
        if (
            turn.items.length ||
            turn.breaks.length ||
            turn.replies.length ||
            turn.answer.length ||
            turn.errors.length
        ) {
            rows.push({ kind: "turn", turn });
        }
        const trailing = [...turn.notices, ...turn.peers].sort((left, right) => left.seq - right.seq);
        for (const event of trailing) {
            rows.push(event.type === "peer_message" ? { kind: "peer", event } : { kind: "notice", event });
        }
    }
    return rows;
}
