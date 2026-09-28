/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The helper thread's activity (`.mj_Headlines`): inside a Claude subagent's or a Codex run's own
 * conversation, with Developer view OFF, the helper's steps read as a short list of plain-English
 * headlines instead of one collapsed turn card (operator decision 2026-09-26). Consecutive steps
 * of the same kind share a headline (headlines.ts); a headline opens onto its steps, and a step
 * onto its deep detail (the command and its output, the diff) — the one level with monospace.
 *
 * Default (2026-09-26): every headline is listed while the helper is running, the running one
 * carrying the spinner and the live line; once it is done the last HEADLINES_SHOWN (8) are
 * listed, with "Show all {n}" above them for the earlier ones.
 *
 * Expanded (operator decision 2026-09-28, `expanded`): the helper thread's newest turns open
 * with their work in view. Up to EXPANDED_HEADLINES_SHOWN headlines are listed, and the newest
 * EXPANDED_GROUPS_OPEN multi-step headlines start open onto their plain-English steps (each open
 * one lists HEADLINE_STEP_CAP steps before "Show all {k}"). The caps bound the DOM on long
 * threads. A headline the user opens or closes stays that way (rememberToggle): the default
 * never overrides a choice, across re-renders and remounts.
 */

import React, { useEffect, useId, useMemo, useState } from "react";

import { plainLine } from "./activity-text";
import { buildHeadlines, type Headline, headlineCount, visibleHeadlines } from "./headlines";
import { stepHeadline } from "./step-phrases";
import { formatElapsed, type Step, stepCount, type TurnItem } from "./turn-grouping";
import { V6Icon, type V6IconName } from "./v6-icons";

/** Expanded list: headlines listed before "Show all {n}" once the helper is done. */
export const EXPANDED_HEADLINES_SHOWN = 40;
/** Expanded list: the newest multi-step headlines that start open. */
export const EXPANDED_GROUPS_OPEN = 10;
/** An open multi-step headline lists this many steps before "Show all {k}" (as the turn card). */
export const HEADLINE_STEP_CAP = 12;

/*
 * The user's own toggles, keyed by list (persistKey) and headline. Module scope, so a choice
 * survives the list remounting (a conversation switch and back, a history reload), not only a
 * re-render. Bounded: the oldest choice is forgotten first.
 */
const REMEMBER_MAX = 1000;
const remembered = new Map<string, boolean>();

function rememberToggle(key: string, value: boolean): void {
    remembered.delete(key);
    remembered.set(key, value);
    if (remembered.size > REMEMBER_MAX) {
        const oldest = remembered.keys().next().value;
        if (oldest !== undefined) remembered.delete(oldest);
    }
}

/** Test seam: forget every remembered toggle. */
export function resetRememberedToggles(): void {
    remembered.clear();
}

const ICON: Record<Headline["icon"], V6IconName> = {
    file: "file",
    search: "search",
    pencil: "pencil",
    flask: "flask",
    shield: "shield",
    history: "history",
    branch: "branch",
    helper: "helper",
    globe: "globe",
    terminal: "terminal",
    dot: "dot",
};

export interface HeadlineListProps {
    /** The helper's steps and narration, in order (the running step excluded). */
    items: readonly TurnItem[];
    /** The step executing now, if one is. */
    running?: Step | null;
    /** The helper is working (running with or without a known step). */
    active: boolean;
    /** Live line while working with no known step ("Thinking…"). */
    liveText?: string;
    /** When the running step started (epoch ms): drives its elapsed counter. */
    runningSince?: number;
    /** Deep detail of one step: the tool output / diff card. */
    renderDetail: (step: Step) => React.ReactNode;
    /**
     * Open with the work in view (a helper thread's newest turns, Developer view off): more
     * headlines listed, the newest multi-step headlines open. Default: the compact list.
     */
    expanded?: boolean;
    /**
     * Scope of the remembered toggles: the conversation. A headline is remembered by its first
     * step's event, which survives history paging; Absent: toggles last as long as the mount.
     */
    persistKey?: string;
    /** The turn, for choices with no stable event behind them ("Show all", a raw-line headline). */
    turnKey?: string;
}

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

function StatusMark({ status }: { status: Headline["status"] }): React.ReactElement {
    if (status === "running")
        return (
            <span className="mj_TurnCard_status" role="img" aria-label="in progress">
                <span className="mj_TurnCard_spinner" />
            </span>
        );
    if (status === "failed")
        return (
            <span className="mj_TurnCard_status mj_TurnCard_status_failed" role="img" aria-label="failed">
                <V6Icon name="x" />
            </span>
        );
    if (status === "recovered" || status === "stopped")
        return (
            <span
                className="mj_TurnCard_status"
                role="img"
                aria-label={status === "stopped" ? "stopped" : "failed, then fixed"}
            >
                <span className="mj_TurnCard_dot mj_TurnCard_dot_warn" />
            </span>
        );
    return <span />;
}

export function HeadlineList({
    items,
    running,
    active,
    liveText,
    runningSince,
    renderDetail,
    expanded = false,
    persistKey,
    turnKey = "",
}: HeadlineListProps): React.ReactElement {
    const baseId = useId();
    // A headline's id is its first step's (`h-e{seq}`: a journal event, stable across history
    // pages). Anything else (a raw line's index, the list's own "Show all") is scoped to the turn.
    const scoped = (key: string): string => (/^[gs]:h-e\d+$/.test(key) ? key : `${turnKey}\u0000${key}`);
    const recall = (key: string): boolean | undefined =>
        persistKey === undefined ? undefined : remembered.get(`${persistKey}\u0000${scoped(key)}`);
    const keep = (key: string, value: boolean): void => {
        if (persistKey !== undefined) rememberToggle(`${persistKey}\u0000${scoped(key)}`, value);
    };
    const [showAll, setShowAllState] = useState(() => recall("all") ?? false);
    // The user's explicit choices only (id → open). Everything else follows the default.
    const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
    const [stepsAll, setStepsAll] = useState<ReadonlySet<string>>(() => new Set());
    const [deep, setDeep] = useState<string | null>(null);
    const now = useNow(Boolean(running));

    const entries = useMemo(() => buildHeadlines(items, running ?? null), [items, running]);
    const { shown, hidden } = visibleHeadlines(
        entries,
        active,
        showAll,
        expanded ? EXPANDED_HEADLINES_SHOWN : undefined,
    );
    const total = headlineCount(entries);

    // Expanded: the newest multi-step headlines start open.
    const openByDefault = useMemo(() => {
        const ids = new Set<string>();
        if (!expanded) return ids;
        for (let i = shown.length - 1; i >= 0 && ids.size < EXPANDED_GROUPS_OPEN; i -= 1) {
            const entry = shown[i];
            if (entry.type === "headline" && entry.steps.length > 1) ids.add(entry.id);
        }
        return ids;
    }, [expanded, shown]);

    const isGroupOpen = (id: string): boolean => choices.get(id) ?? recall(`g:${id}`) ?? openByDefault.has(id);

    const toggle = (id: string): void => {
        const next = !isGroupOpen(id);
        keep(`g:${id}`, next);
        setChoices((current) => new Map(current).set(id, next));
    };
    const setShowAll = (): void => {
        keep("all", true);
        setShowAllState(true);
    };
    const showAllSteps = (id: string): void => {
        keep(`s:${id}`, true);
        setStepsAll((current) => new Set(current).add(id));
    };

    const elapsedS = running && runningSince !== undefined ? Math.max(0, Math.floor((now - runningSince) / 1000)) : 0;

    return (
        <section className="mj_Headlines" aria-label="Helper activity">
            {hidden > 0 && (
                <button type="button" className="mj_TurnCard_more mj_Headlines_more" onClick={setShowAll}>
                    Show all {total}
                </button>
            )}
            <ol className="mj_Headlines_list">
                {shown.map((entry) => {
                    if (entry.type === "note") {
                        const text = plainLine(entry.text);
                        return text ? (
                            <li key={entry.id} className="mj_Headlines_note">
                                {text}
                            </li>
                        ) : null;
                    }
                    const single = entry.steps.length === 1;
                    const isRunning = entry.status === "running";
                    const listId = `${baseId}-${entry.id}`;
                    const isOpen = single ? deep === entry.steps[0].id : isGroupOpen(entry.id);
                    // Capped at HEADLINE_STEP_CAP rows: the first ones once done, the newest ones
                    // while running (so the "now" row stays in view), "Show all {k}" for the rest.
                    const allSteps = stepsAll.has(entry.id) || Boolean(recall(`s:${entry.id}`));
                    const groupSize = entry.steps.length;
                    const firstShown =
                        allSteps || groupSize <= HEADLINE_STEP_CAP || !isRunning ? 0 : groupSize - HEADLINE_STEP_CAP;
                    const lastShown = allSteps || isRunning ? groupSize : Math.min(groupSize, HEADLINE_STEP_CAP);
                    const stepsHidden = groupSize - (lastShown - firstShown);
                    const moreSteps = stepsHidden > 0 && (
                        <li>
                            <button type="button" className="mj_TurnCard_more" onClick={() => showAllSteps(entry.id)}>
                                Show all {groupSize}
                            </button>
                        </li>
                    );
                    const text = isRunning ? `${entry.text}…` : entry.text;
                    return (
                        <li
                            key={entry.id}
                            className={`mj_TurnCard_group mj_Headline mj_TurnCard_group_${entry.status}${isOpen ? " is-open" : ""}`}
                            data-headline={entry.key}
                        >
                            <button
                                type="button"
                                className="mj_TurnCard_groupRow mj_Headline_row"
                                aria-expanded={isRunning && single ? undefined : isOpen}
                                aria-controls={listId}
                                disabled={isRunning && single}
                                onClick={() => (single ? setDeep(isOpen ? null : entry.steps[0].id) : toggle(entry.id))}
                            >
                                <span className="mj_TurnCard_icon" aria-hidden="true">
                                    <V6Icon name={ICON[entry.icon]} />
                                </span>
                                <span className="mj_TurnCard_sentence">
                                    {text}
                                    {entry.outcome && <span className="mj_TurnCard_outcome">: {entry.outcome}</span>}
                                    {isRunning && elapsedS >= 10 && (
                                        <span className="mj_Headline_elapsed"> · {formatElapsed(elapsedS)}</span>
                                    )}
                                </span>
                                <StatusMark status={entry.status} />
                                <span className="mj_TurnCard_count">{single ? "" : stepCount(entry.steps.length)}</span>
                                {isRunning && single ? (
                                    <span />
                                ) : (
                                    <V6Icon name="chev" className="mj_TurnCard_chevron" />
                                )}
                            </button>
                            {isOpen && single && (
                                <div id={listId} className="mj_TurnCard_deep mj_Headline_deep">
                                    {renderDetail(entry.steps[0])}
                                </div>
                            )}
                            {isOpen && !single && (
                                <ul className="mj_TurnCard_steps" id={listId}>
                                    {isRunning && moreSteps}
                                    {entry.steps.slice(firstShown, lastShown).map((step, offset) => {
                                        const index = firstShown + offset;
                                        const sentence = stepHeadline(step);
                                        const again =
                                            index > 0 && stepHeadline(entry.steps[index - 1]) === sentence
                                                ? " again"
                                                : "";
                                        const stepRunning = step.status === "running";
                                        return (
                                            <li key={step.id}>
                                                <button
                                                    type="button"
                                                    className="mj_TurnCard_step"
                                                    aria-expanded={stepRunning ? undefined : deep === step.id}
                                                    disabled={stepRunning}
                                                    onClick={() => setDeep(deep === step.id ? null : step.id)}
                                                >
                                                    <span className="mj_TurnCard_name">
                                                        {sentence}
                                                        {again}
                                                    </span>
                                                    {step.status === "failed" || step.status === "stopped" ? (
                                                        <span className="mj_TurnCard_stepNote mj_TurnCard_stepNote_failed">
                                                            {step.status}
                                                        </span>
                                                    ) : stepRunning ? (
                                                        <span className="mj_TurnCard_stepNote">now</span>
                                                    ) : (
                                                        <span />
                                                    )}
                                                    {stepRunning ? (
                                                        <span />
                                                    ) : (
                                                        <V6Icon name="chevR" className="mj_TurnCard_go" />
                                                    )}
                                                </button>
                                                {deep === step.id && !stepRunning && (
                                                    <div className="mj_TurnCard_deep mj_Headline_deep">
                                                        {renderDetail(step)}
                                                    </div>
                                                )}
                                            </li>
                                        );
                                    })}
                                    {!isRunning && moreSteps}
                                </ul>
                            )}
                        </li>
                    );
                })}
                {active && !running && (
                    <li className="mj_TurnCard_now mj_Headlines_now">
                        <span className="mj_TurnCard_glyph" aria-hidden="true">
                            <span className="mj_TurnCard_spinner" />
                        </span>
                        <span role="status">{liveText || "Working…"}</span>
                    </li>
                )}
            </ol>
        </section>
    );
}
