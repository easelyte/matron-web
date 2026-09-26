/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The subagent card (`.mj_SubagentCard`): one per helper a turn started — a Claude subagent
 * (the Agent / Task tool) or a Codex exec run — rendered in the parent's thread right after the
 * turn card. It is the v6 "helper started" break-through (GENERATIVE-SYSTEM §6) grown into a
 * card with the turn card's geometry: one summary row in every state (status glyph, name, the
 * live line or `{n} steps · {duration}`, the worker), opening to the result and the helper's
 * own steps, grouped by the same turn-grouping templates.
 *
 * Claude and Codex helpers share this one presentation. With Developer view OFF nothing here
 * shows a command line, code or JSON: steps read as sentences and the result as one clamped
 * paragraph of prose. Developer view ON shows the raw step lines and the full result markdown.
 *
 * Data: the child conversation (state, outcome, created_at, title) plus its journal events,
 * read from the local store (every live frame lands there) and topped up once from the server.
 */

import React, { useEffect, useId, useMemo, useState } from "react";

import { plainLine } from "./activity-text";
import { assembleTurns, isOperatorEvent } from "./turn-assembly";
import { TurnCard } from "./turn-card";
import { formatDuration, formatElapsed, liveLine, type Step, stepCount, stepsOf, type TurnItem } from "./turn-grouping";
import { type Conversation, type JournalEvent } from "./types";
import { V6Icon } from "./v6-icons";

export type SubagentStatus = "running" | "done" | "failed" | "stopped" | "idle";
export type SubagentKind = "claude" | "codex" | null;

export interface SubagentView {
    status: SubagentStatus;
    /** Card content: the helper's steps and narration, in order (the running step excluded). */
    items: TurnItem[];
    steps: Step[];
    /** The step executing now (a Claude helper reports a call when it starts). */
    running: Step | null;
    /** The helper's final message (markdown), once it has finished. */
    result: string;
    /** The latest narration while running, as one sentence. */
    liveNarration: string;
    startedAt: number;
    /** ms from the helper's first activity to its last (or to `now` while running). */
    durationMs: number;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export function subagentStatus(conversation: Pick<Conversation, "session_state" | "session_outcome">): SubagentStatus {
    if (conversation.session_state === "running") return "running";
    if (conversation.session_state !== "done") return "idle";
    if (conversation.session_outcome === "failed") return "failed";
    if (conversation.session_outcome === "interrupted") return "stopped";
    // completed, or a legacy child from before outcomes were recorded; anything else is unknown.
    if (conversation.session_outcome === "completed" || conversation.session_outcome == null) return "done";
    return "idle";
}

/** First sentence of a narration, trimmed to 90 characters (the turn card's live-line rule). */
function firstSentence(text: string): string {
    const flat = plainLine(text);
    const sentence = /^(.+?[.!?…])(\s|$)/.exec(flat)?.[1] ?? flat;
    return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
}

/** Pure: the card's model from the child conversation and its events. */
export function subagentView(
    child: Pick<Conversation, "session_state" | "session_outcome" | "created_at" | "last_ts" | "id">,
    events: readonly JournalEvent[],
    kind: SubagentKind,
    now: number,
): SubagentView {
    const status = subagentStatus(child);
    const own = events.filter((event) => event.convo_id === child.id);
    const turns = assembleTurns(own);
    const items: TurnItem[] = turns.flatMap((turn) => turn.items);
    const lastTurn = turns.at(-1);
    const lastAgentEvent = [...own].reverse().find((event) => !isOperatorEvent(event));
    const lastAnswer = lastTurn?.answer.at(-1);
    const answerText = lastAnswer ? asString(lastAnswer.payload.body) : "";

    let running: Step | null = null;
    let liveNarration = "";
    if (status === "running") {
        const lastItem = items.at(-1);
        // A Claude helper publishes each call as it starts, so a trailing step is the one running
        // now. Codex publishes a command when it finishes, so its last step is already done.
        if (lastItem?.kind === "step" && kind !== "codex" && lastAnswer === undefined) {
            items.pop();
            running = { ...lastItem, status: "running" };
        }
        if (answerText) liveNarration = firstSentence(answerText);
    }

    const firstTs = own[0]?.ts;
    const startedAt = Math.min(child.created_at || Number.POSITIVE_INFINITY, firstTs ?? Number.POSITIVE_INFINITY);
    const start = Number.isFinite(startedAt) ? startedAt : now;
    const end = status === "running" ? now : Math.max(lastAgentEvent?.ts ?? 0, child.last_ts ?? 0, start);
    return {
        status,
        items,
        steps: stepsOf(items),
        running,
        result: status === "running" ? "" : answerText,
        liveNarration,
        startedAt: start,
        durationMs: Math.max(0, end - start),
    };
}

/** Ticks once a second while `active`. */
function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return now;
}

/** The child's events, re-read whenever the child advances; one server top-up per session. */
function useChildEvents(
    loadEvents: (id: string, opts: { fetch?: boolean }) => Promise<JournalEvent[]>,
    childId: string,
    lastSeq: number,
): JournalEvent[] | null {
    const [events, setEvents] = useState<JournalEvent[] | null>(null);
    useEffect(() => {
        let live = true;
        loadEvents(childId, { fetch: true }).then(
            (loaded) => {
                if (live) setEvents(loaded);
            },
            () => {
                if (live) setEvents((current) => current ?? []);
            },
        );
        return () => {
            live = false;
        };
    }, [loadEvents, childId, lastSeq]);
    return events;
}

const KIND_LABEL: Record<NonNullable<SubagentKind>, string> = { claude: "Claude", codex: "Codex" };

const STATUS_WORD: Record<SubagentStatus, string> = {
    running: "Working",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
    idle: "Idle",
};

function StatusGlyph({ status }: { status: SubagentStatus }): React.ReactElement {
    if (status === "running") return <span className="mj_TurnCard_spinner" />;
    if (status === "done") return <V6Icon name="check" />;
    if (status === "failed") return <V6Icon name="x" className="mj_SubagentCard_failedIcon" />;
    if (status === "stopped") return <span className="mj_TurnCard_dot mj_TurnCard_dot_warn" />;
    return <span className="mj_TurnCard_dot mj_SubagentCard_dot_idle" />;
}

/** The raw line a step came from (Developer view): the command, path or indicator text. */
function rawStepLine(step: Step): string {
    const source = step.source as JournalEvent | undefined;
    if (source?.type === "tool_output") return `$ ${asString(source.payload.command) || step.tool}`;
    if (source?.type === "diff") {
        const path = asString(source.payload.display_path) || asString(source.payload.file_path);
        return `${asString(source.payload.tool) || "Edit"} ${path}`;
    }
    if (source?.type === "text") return asString(source.payload.body).trim();
    return step.input.command ?? step.input.path ?? step.input.pattern ?? step.input.url ?? step.tool;
}

export interface SubagentCardProps {
    child: Conversation;
    kind: SubagentKind;
    /** client.conversationEvents */
    loadEvents: (id: string, opts: { fetch?: boolean }) => Promise<JournalEvent[]>;
    /** Open the helper's own conversation. */
    onOpen: (id: string) => void;
    /** Deep detail of one step (the turn card's renderer: tool output / diff card). */
    renderDetail: (step: Step) => React.ReactNode;
    /** The result, as markdown (Developer view). */
    renderMarkdown: (text: string, key: string) => React.ReactNode;
    developerView: boolean;
    /** Body only, always open: the helper step's deep detail inside the turn card. */
    bodyOnly?: boolean;
}

export function SubagentCard({
    child,
    kind,
    loadEvents,
    onOpen,
    renderDetail,
    renderMarkdown,
    developerView,
    bodyOnly = false,
}: SubagentCardProps): React.ReactElement {
    const baseId = useId();
    const bodyId = `${baseId}-body`;
    const [open, setOpen] = useState(bodyOnly);
    const events = useChildEvents(loadEvents, child.id, child.last_seq);
    const status = subagentStatus(child);
    const now = useNow(status === "running");
    const view = useMemo(() => subagentView(child, events ?? [], kind, now), [child, events, kind, now]);
    const name = child.title.trim() || "Helper";
    const n = view.steps.length + (view.running ? 1 : 0);

    const liveText =
        (view.running ? liveLine(view.running) : "") || view.liveNarration || (events ? "Thinking…" : "Starting…");
    let meta: string;
    if (status === "running") {
        meta = view.durationMs >= 10_000 ? `${liveText} · ${formatElapsed(view.durationMs / 1000)}` : liveText;
    } else {
        const parts = [stepCount(n), formatDuration(view.durationMs)];
        if (status !== "done") parts.unshift(STATUS_WORD[status]);
        meta = parts.join(" · ");
    }
    const srStatus = status === "running" ? `Working: ${liveText}` : meta;

    const resultText = view.result.trim();
    const body = (
        <div className="mj_SubagentCard_body" id={bodyId}>
            {resultText &&
                (developerView ? (
                    <div className="mj_SubagentCard_result">{renderMarkdown(resultText, `helper-${child.id}`)}</div>
                ) : (
                    <p className="mj_SubagentCard_result mj_SubagentCard_result_plain">{plainLine(resultText)}</p>
                ))}
            {developerView ? (
                n > 0 && (
                    <ul className="mj_SubagentCard_raw" aria-label="Helper steps">
                        {[...view.steps, ...(view.running ? [view.running] : [])].map((step) => (
                            <li key={step.id}>
                                <code>{rawStepLine(step)}</code>
                            </li>
                        ))}
                    </ul>
                )
            ) : n > 0 || status === "running" ? (
                <TurnCard
                    embedded
                    turnKey={`helper-${child.id}`}
                    items={view.items}
                    mode={status === "running" ? "running" : "done"}
                    running={view.running}
                    liveText={view.running ? undefined : liveText}
                    durationMs={view.durationMs}
                    renderDetail={renderDetail}
                    renderNarration={(text) => plainLine(text)}
                />
            ) : null}
            {events !== null && n === 0 && status !== "running" && !resultText && (
                <p className="mj_SubagentCard_empty">No steps recorded.</p>
            )}
            <div className="mj_SubagentCard_foot">
                <button type="button" className="mj_TurnCard_helperOpen" onClick={() => onOpen(child.id)}>
                    Open helper
                    <V6Icon name="chevR" />
                </button>
            </div>
        </div>
    );

    if (bodyOnly) {
        return (
            <div
                className={`mj_SubagentCard mj_SubagentCard_bodyOnly mj_SubagentCard_${status}`}
                data-helper={child.id}
            >
                <div className="mj_SubagentCard_head">
                    <span className="mj_TurnCard_glyph" aria-hidden="true">
                        <StatusGlyph status={status} />
                    </span>
                    <span className="mj_SubagentCard_name">{name}</span>
                    <span className="mj_SubagentCard_meta">{meta}</span>
                </div>
                {body}
            </div>
        );
    }

    return (
        <section
            className={`mj_TurnCard mj_SubagentCard mj_SubagentCard_${status}${open ? " is-open" : ""}`}
            aria-label={`Helper: ${name}`}
            data-helper={child.id}
        >
            <div className="mj_TurnCard_row">
                <button
                    type="button"
                    className="mj_TurnCard_toggle mj_SubagentCard_toggle"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={() => setOpen((current) => !current)}
                >
                    <span className="mj_TurnCard_glyph" aria-hidden="true">
                        <StatusGlyph status={status} />
                    </span>
                    <span className="mj_SubagentCard_text">
                        <span className="mj_SubagentCard_name">{name}</span>
                        <span className="mj_SubagentCard_meta" role="status" aria-live="polite" aria-atomic="true">
                            <span className="mj_SrOnly">{srStatus}</span>
                            <span aria-hidden="true">{meta}</span>
                        </span>
                    </span>
                    {kind ? <span className="mj_SubagentCard_kind">{KIND_LABEL[kind]}</span> : <span />}
                    <V6Icon name="chev" className="mj_TurnCard_chevron" />
                </button>
            </div>
            {open && body}
        </section>
    );
}

/**
 * Which of a turn's helpers a helper step names: the child titled with the step's description.
 * The bridge titles a Claude child from the same description, cut at 40 characters with "…".
 */
export function helperForStep(step: Step, helpers: readonly Conversation[]): Conversation | undefined {
    const description = (step.input.description ?? "").trim();
    if (!description) return undefined;
    const norm = (value: string): string => value.replace(/…$/u, "").trim().toLowerCase();
    const wanted = norm(description);
    return (
        helpers.find((child) => norm(child.title) === wanted) ??
        helpers.find((child) => {
            const title = norm(child.title);
            return title.length >= 12 && (wanted.startsWith(title) || title.startsWith(wanted));
        })
    );
}

/**
 * Anchor each child to the turn it was started in: the last turn that began at or before the
 * child's creation. A child older than the first loaded turn is left out while older history is
 * still unloaded (its turn is not on screen yet).
 */
export function helpersByTurn(
    turns: ReadonlyArray<{ key: string; startTs: number }>,
    children: readonly Conversation[],
    hasOlderHistory: boolean,
): Map<string, Conversation[]> {
    const map = new Map<string, Conversation[]>();
    if (!turns.length) return map;
    for (const child of [...children].sort((a, b) => a.created_at - b.created_at)) {
        let index = -1;
        for (let i = 0; i < turns.length; i += 1) if (turns[i].startTs <= child.created_at) index = i;
        if (index < 0) {
            if (hasOlderHistory) continue;
            index = 0;
        }
        const key = turns[index].key;
        map.set(key, [...(map.get(key) ?? []), child]);
    }
    return map;
}
