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
 */

import React, { useEffect, useId, useMemo, useState } from "react";

import { plainLine } from "./activity-text";
import { buildHeadlines, type Headline, headlineCount, visibleHeadlines } from "./headlines";
import { stepHeadline } from "./step-phrases";
import { formatElapsed, type Step, stepCount, type TurnItem } from "./turn-grouping";
import { V6Icon, type V6IconName } from "./v6-icons";

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
}: HeadlineListProps): React.ReactElement {
    const baseId = useId();
    const [showAll, setShowAll] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
    const [deep, setDeep] = useState<string | null>(null);
    const now = useNow(Boolean(running));

    const entries = useMemo(() => buildHeadlines(items, running ?? null), [items, running]);
    const { shown, hidden } = visibleHeadlines(entries, active, showAll);
    const total = headlineCount(entries);

    const toggle = (id: string): void =>
        setOpen((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const elapsedS = running && runningSince !== undefined ? Math.max(0, Math.floor((now - runningSince) / 1000)) : 0;

    return (
        <section className="mj_Headlines" aria-label="Helper activity">
            {hidden > 0 && (
                <button type="button" className="mj_TurnCard_more mj_Headlines_more" onClick={() => setShowAll(true)}>
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
                    const isOpen = single ? deep === entry.steps[0].id : open.has(entry.id);
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
                                    {entry.steps.map((step, index) => {
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
