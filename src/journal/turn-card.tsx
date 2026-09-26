/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The turn card (redesign v6, `.mj_TurnCard`): one per operator turn that has at least one
 * step, collapsed by default. See docs/design/redesign-v6/HANDOFF.md §4 and
 * GENERATIVE-SYSTEM.md §1-§8. The row carries no visible title (operator decision 2026-09-26,
 * HANDOFF §7a): running is a spinner + the live line, done is the step summary + chevron.
 *
 * The collapsed summary is ONE row in every state (done, running, slow, waiting, stopped), so
 * a turn finishing never moves the thread. Monospace and exit codes appear only in the deep
 * detail, which reuses the tool / diff card markup handed in by the caller (renderDetail).
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { List, type RowComponentProps } from "react-window";

import {
    changedFiles,
    classify,
    formatDuration,
    formatElapsed,
    type Group,
    groupTurn,
    liveLine,
    passingRerun,
    type Step,
    stepCount,
    stepRowSentences,
    stepsOf,
    type TurnItem,
    turnIssues,
} from "./turn-grouping";
import { V6Icon, type V6IconName } from "./v6-icons";

/** The live line changes at most once per interval; a newer text replaces a queued one (§2). */
export const LIVE_MIN_INTERVAL_MS = 1200;
/** Cross-fade of the outgoing and incoming live line (--mj-live-xfade). */
export const LIVE_XFADE_MS = 240;
/** The elapsed counter appears once the current step passes this (--mj-live-elapsed-after). */
export const LIVE_ELAPSED_AFTER_S = 10;
/** A step at or past this turns the line amber and shows Stop (--mj-slow-after). */
export const SLOW_AFTER_S = 300;
/** Group step lists show this many rows before "Show all {k}". */
export const STEP_CAP = 12;
/** Changed-files block shows this many rows before "Show all {n} files". */
export const FILE_CAP = 5;
/** An opened list longer than this virtualizes (§4). */
export const VIRTUALIZE_AFTER = 200;
const STEP_ROW_HEIGHT = 28;

export type TurnCardMode = "done" | "running" | "waiting" | "stopped";

export interface TurnCardProps {
    turnKey: string;
    items: readonly TurnItem[];
    mode: TurnCardMode;
    /** The step executing now (running mode). Joins its group as the last row. */
    running?: Step | null;
    /** Live line override (the agent's latest narration, "Thinking…"); default: the step template. */
    liveText?: string;
    /** When the current step started (epoch ms) — drives the elapsed counter and slow state. */
    runningSince?: number;
    /** Turn duration for the done meta (decision §7.5: from the operator message). */
    durationMs: number;
    /** Interrupt the current step. Absent → no Stop control (the bridge has no interrupt yet). */
    onStop?: () => void;
    /** The deep-detail body of one step: the existing tool / diff card markup. */
    renderDetail: (step: Step) => React.ReactNode;
    /** Narration body (the agent's markdown). Default: plain text. */
    renderNarration?: (text: string) => React.ReactNode;
}

const GROUP_STATUS_LABEL: Record<Group["status"], string> = {
    ok: "done",
    recovered: "failed, then fixed",
    failed: "failed",
    running: "in progress",
    stopped: "stopped",
};

/** Ticks once a second while `active`, so elapsed counters stay current. */
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

/**
 * The live line with its cadence rule: at most one change per LIVE_MIN_INTERVAL_MS, newest
 * text wins (a stale queued text is skipped, never played as a backlog), and the outgoing text
 * stays briefly for the cross-fade.
 */
export function useLiveText(text: string): { current: string; leaving?: string; generation: number } {
    const [state, setState] = useState<{ current: string; leaving?: string; generation: number }>({
        current: text,
        generation: 0,
    });
    const lastChangeRef = useRef(0);
    const pendingRef = useRef<number | undefined>(undefined);
    const leaveRef = useRef<number | undefined>(undefined);

    useEffect(() => {
        if (text === state.current) {
            if (pendingRef.current !== undefined) window.clearTimeout(pendingRef.current);
            pendingRef.current = undefined;
            return;
        }
        const wait = Math.max(0, LIVE_MIN_INTERVAL_MS - (Date.now() - lastChangeRef.current));
        if (pendingRef.current !== undefined) window.clearTimeout(pendingRef.current);
        pendingRef.current = window.setTimeout(() => {
            pendingRef.current = undefined;
            lastChangeRef.current = Date.now();
            setState((previous) => ({ current: text, leaving: previous.current, generation: previous.generation + 1 }));
            if (leaveRef.current !== undefined) window.clearTimeout(leaveRef.current);
            leaveRef.current = window.setTimeout(() => {
                leaveRef.current = undefined;
                setState((previous) => ({ ...previous, leaving: undefined }));
            }, LIVE_XFADE_MS);
        }, wait);
    }, [text, state.current]);

    useEffect(
        () => () => {
            if (pendingRef.current !== undefined) window.clearTimeout(pendingRef.current);
            if (leaveRef.current !== undefined) window.clearTimeout(leaveRef.current);
        },
        [],
    );
    return state;
}

const ICON_FOR: Record<Group["icon"], V6IconName> = {
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

interface DeepState {
    stepId: string;
    from: "files" | "group";
}

function StatusGlyph({ status }: { status: Group["status"] }): React.ReactElement {
    const label = GROUP_STATUS_LABEL[status];
    if (status === "ok") {
        return (
            <span className="mj_TurnCard_status mj_TurnCard_status_ok" role="img" aria-label={label}>
                <V6Icon name="check" />
            </span>
        );
    }
    if (status === "failed") {
        return (
            <span className="mj_TurnCard_status mj_TurnCard_status_failed" role="img" aria-label={label}>
                <V6Icon name="x" />
            </span>
        );
    }
    if (status === "running") {
        return (
            <span className="mj_TurnCard_status" role="img" aria-label={label}>
                <span className="mj_TurnCard_spinner" />
            </span>
        );
    }
    return (
        <span className="mj_TurnCard_status" role="img" aria-label={label}>
            <span className="mj_TurnCard_dot mj_TurnCard_dot_warn" />
        </span>
    );
}

export function TurnCard({
    turnKey,
    items,
    mode,
    running,
    liveText,
    runningSince,
    durationMs,
    onStop,
    renderDetail,
    renderNarration,
}: TurnCardProps): React.ReactElement {
    const baseId = useId();
    const bodyId = `${baseId}-body`;
    const statusId = `${baseId}-status`;
    const [open, setOpen] = useState(false);
    const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
    const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set());
    const [deep, setDeep] = useState<DeepState | null>(null);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
    const groupRowRefs = useRef(new Map<string, HTMLButtonElement>());
    const focusAfterRef = useRef<string | null>(null);

    const isRunning = mode === "running" && Boolean(running);
    const now = useNow(mode === "running");
    const elapsedS = isRunning && runningSince !== undefined ? Math.max(0, Math.floor((now - runningSince) / 1000)) : 0;
    const slow = isRunning && elapsedS >= SLOW_AFTER_S;
    const visualMode = mode === "running" ? (slow ? "slow" : "running") : mode;

    const sequence = useMemo(() => groupTurn(items, isRunning ? running : null), [items, isRunning, running]);
    const files = useMemo(() => changedFiles(items), [items]);
    const steps = useMemo(() => stepsOf(items), [items]);
    const allSteps = useMemo(() => (isRunning && running ? [...steps, running] : steps), [steps, isRunning, running]);
    const issues = turnIssues(items) || mode === "stopped";
    const n = steps.length;

    // Resolve choreography: glyph + meta fade in the same box when a run finishes on screen.
    const wasRunningRef = useRef(mode === "running");
    const [resolved, setResolved] = useState(false);
    useEffect(() => {
        if (wasRunningRef.current && mode !== "running") setResolved(true);
        // Work resumed in the same card (e.g. after answering a permission request): the fade
        // must not stay on, or its animation would replace the spinner's rotation.
        else if (mode === "running") setResolved(false);
        wasRunningRef.current = mode === "running";
    }, [mode]);

    const live = useLiveText(liveText ?? (isRunning && running ? liveLine(running) : "Working…"));

    // Deep detail closes → focus returns to the row that opened it.
    useLayoutEffect(() => {
        const key = focusAfterRef.current;
        if (!key) return;
        focusAfterRef.current = null;
        (rowRefs.current.get(key) ?? groupRowRefs.current.get(key))?.focus();
    });

    const toggleGroup = useCallback((groupId: string, container: HTMLElement | null) => {
        setOpenGroups((current) => {
            const next = new Set(current);
            if (next.has(groupId)) {
                next.delete(groupId);
                // Collapsing a group whose list holds focus returns focus to the group row.
                if (container?.contains(document.activeElement)) focusAfterRef.current = groupId;
            } else {
                next.add(groupId);
            }
            return next;
        });
    }, []);

    const openDeep = (stepId: string, from: DeepState["from"]): void => {
        setDeep((current) => (current && current.stepId === stepId && current.from === from ? null : { stepId, from }));
    };
    const closeDeep = (): void => {
        if (!deep) return;
        focusAfterRef.current = `${deep.from}:${deep.stepId}`;
        setDeep(null);
    };

    const onBodyKeyDown = (event: React.KeyboardEvent): void => {
        // Escape unwinds one layer: the deep detail. It never collapses the whole card.
        if (event.key === "Escape" && deep) {
            event.preventDefault();
            event.stopPropagation();
            closeDeep();
        }
    };

    const stepById = (id: string): Step | undefined => allSteps.find((step) => step.id === id);

    const renderDeep = (step: Step, from: DeepState["from"], groupSteps: readonly Step[]): React.ReactElement => {
        const change = classify(step).key === "change";
        const rerun = change ? undefined : passingRerun(step, groupSteps);
        const meta = change || step.ms === undefined ? "" : formatDuration(step.ms);
        return (
            <div className="mj_TurnCard_deep" data-kind={change ? "diff" : "command"}>
                <div className="mj_TurnCard_deepHead">
                    <button type="button" className="mj_TurnCard_back" onClick={closeDeep}>
                        <V6Icon name="chevL" />
                        {from === "files" ? "Back to files" : "Back to steps"}
                    </button>
                    {meta && <span className="mj_TurnCard_deepMeta">{meta}</span>}
                </div>
                {renderDetail(step)}
                {rerun && renderDetail(rerun)}
            </div>
        );
    };

    // ---- collapsed row ----
    let glyph: React.ReactNode;
    let meta: React.ReactNode;
    let srStatus: string;
    if (visualMode === "running" || visualMode === "slow") {
        glyph = <span className="mj_TurnCard_spinner" />;
        meta = (
            <>
                <span className="mj_TurnCard_live">
                    {live.leaving !== undefined && (
                        <span className="mj_TurnCard_liveText mj_TurnCard_liveText_leaving" aria-hidden="true">
                            {live.leaving}
                        </span>
                    )}
                    <span
                        key={live.generation}
                        className={`mj_TurnCard_liveText${live.generation > 0 ? " mj_TurnCard_liveText_entering" : ""}`}
                    >
                        {live.current}
                    </span>
                </span>
            </>
        );
        srStatus = `Working: ${live.current}`;
    } else if (visualMode === "waiting") {
        glyph = <span className="mj_TurnCard_dot mj_TurnCard_dot_wait" />;
        meta = (
            <>
                <span className="mj_TurnCard_live">
                    <span className="mj_TurnCard_liveText">Waiting for you</span>
                </span>
            </>
        );
        srStatus = "Waiting for you";
    } else if (visualMode === "stopped") {
        glyph = <span className="mj_TurnCard_dot mj_TurnCard_dot_warn" />;
        meta = (
            <>
                <span className="mj_TurnCard_stoppedLabel">Stopped</span>
                <span className="mj_TurnCard_sep mj_TurnCard_count_meta">·</span>
                <span className="mj_TurnCard_count_meta">{stepCount(n)}</span>
            </>
        );
        srStatus = `Stopped, ${stepCount(n)}`;
    } else {
        glyph = issues ? <span className="mj_TurnCard_dot mj_TurnCard_dot_warn" /> : <V6Icon name="check" />;
        meta = (
            <>
                <span className="mj_TurnCard_countLabel">{stepCount(n)}</span>
                <span className="mj_TurnCard_sep mj_TurnCard_elapsedTotal">·</span>
                <span className="mj_TurnCard_elapsedTotal">{formatDuration(durationMs)}</span>
            </>
        );
        srStatus = issues ? `Done with a problem along the way, ${stepCount(n)}` : `Done, ${stepCount(n)}`;
    }
    const showElapsed = (visualMode === "running" || visualMode === "slow") && elapsedS > LIVE_ELAPSED_AFTER_S;
    const showStop = visualMode === "slow" && Boolean(onStop);

    const row = (
        <div className="mj_TurnCard_row">
            <button
                ref={toggleRef}
                type="button"
                className="mj_TurnCard_toggle"
                aria-label={open ? "Hide steps" : "Show steps"}
                aria-describedby={statusId}
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpen((current) => !current)}
            >
                <span className="mj_TurnCard_glyph" aria-hidden="true">
                    {glyph}
                </span>
                <span className="mj_TurnCard_meta">
                    <span className="mj_TurnCard_statusRegion" role="status" aria-live="polite" aria-atomic="true">
                        <span className="mj_SrOnly" id={statusId}>
                            {srStatus}.{" "}
                        </span>
                        <span className="mj_TurnCard_metaVisible" aria-hidden="true">
                            {meta}
                        </span>
                    </span>
                    {showElapsed && (
                        <span className="mj_TurnCard_elapsedWrap" aria-hidden="true">
                            <span className="mj_TurnCard_sep">·</span>
                            <span className="mj_TurnCard_elapsed">{formatElapsed(elapsedS)}</span>
                        </span>
                    )}
                </span>
                <span className="mj_TurnCard_stopSpace" aria-hidden="true">
                    {showStop ? "Stop" : ""}
                </span>
                <V6Icon name="chev" className="mj_TurnCard_chevron" />
            </button>
            {showStop && (
                <button type="button" className="mj_TurnCard_stop" onClick={onStop}>
                    Stop
                </button>
            )}
        </div>
    );

    const className = ["mj_TurnCard", `mj_TurnCard_${visualMode}`, open ? "is-open" : "", resolved ? "is-resolved" : ""]
        .filter(Boolean)
        .join(" ");

    if (!open) {
        return (
            <section className={className} aria-label="Agent steps" data-turn={turnKey}>
                {row}
            </section>
        );
    }

    const fileCap = showAll.has("files") ? files.length : FILE_CAP;
    return (
        <section className={className} aria-label="Agent steps" data-turn={turnKey}>
            {row}
            <div className="mj_TurnCard_body" id={bodyId} onKeyDown={onBodyKeyDown}>
                {files.length > 0 && (
                    <div className="mj_TurnCard_changed">
                        <div className="mj_TurnCard_label">Changed files</div>
                        {files.slice(0, fileCap).map((file) => {
                            const key = `files:${file.stepId}`;
                            const isOpen = deep?.from === "files" && deep.stepId === file.stepId;
                            const step = stepById(file.stepId);
                            return (
                                <React.Fragment key={file.path}>
                                    <button
                                        ref={(node) => {
                                            if (node) rowRefs.current.set(key, node);
                                            else rowRefs.current.delete(key);
                                        }}
                                        type="button"
                                        className="mj_TurnCard_file"
                                        aria-expanded={isOpen}
                                        title={file.path}
                                        onClick={() => openDeep(file.stepId, "files")}
                                    >
                                        <span className="mj_TurnCard_icon" aria-hidden="true">
                                            <V6Icon name="file" />
                                        </span>
                                        <span className="mj_TurnCard_name">{file.name}</span>
                                        <span className="mj_TurnCard_counts">
                                            <span className="mj_TurnCard_add">+{file.added}</span>
                                            <span className="mj_TurnCard_del">−{file.removed}</span>
                                        </span>
                                        <V6Icon name="chevR" className="mj_TurnCard_go" />
                                    </button>
                                    {isOpen && step && renderDeep(step, "files", [step])}
                                </React.Fragment>
                            );
                        })}
                        {files.length > fileCap && (
                            <button
                                type="button"
                                className="mj_TurnCard_more"
                                onClick={() => setShowAll((current) => new Set(current).add("files"))}
                            >
                                Show all {files.length} files
                            </button>
                        )}
                    </div>
                )}
                {sequence.map((entry, index) => {
                    if (entry.type === "narration") {
                        return (
                            <div className="mj_TurnCard_narration" key={`n-${index}`}>
                                {renderNarration ? renderNarration(entry.text) : entry.text}
                            </div>
                        );
                    }
                    return (
                        <GroupBlock
                            key={entry.id}
                            group={entry}
                            open={openGroups.has(entry.id)}
                            showAll={showAll.has(entry.id)}
                            deep={deep?.from === "group" ? deep.stepId : null}
                            listId={`${baseId}-${entry.id}`}
                            onToggle={toggleGroup}
                            onShowAll={() => setShowAll((current) => new Set(current).add(entry.id))}
                            onOpenStep={(stepId) => openDeep(stepId, "group")}
                            registerGroupRow={(node) => {
                                if (node) groupRowRefs.current.set(entry.id, node);
                                else groupRowRefs.current.delete(entry.id);
                            }}
                            registerStepRow={(stepId, node) => {
                                const key = `group:${stepId}`;
                                if (node) rowRefs.current.set(key, node);
                                else rowRefs.current.delete(key);
                            }}
                            renderDeep={(step) => renderDeep(step, "group", entry.steps)}
                        />
                    );
                })}
                {(visualMode === "running" || visualMode === "slow") && (
                    <div className="mj_TurnCard_now" aria-hidden="true">
                        <span className="mj_TurnCard_glyph">
                            <span className="mj_TurnCard_spinner" />
                        </span>
                        <span>{live.current}</span>
                    </div>
                )}
            </div>
        </section>
    );
}

interface GroupBlockProps {
    group: Group;
    open: boolean;
    showAll: boolean;
    deep: string | null;
    listId: string;
    onToggle: (groupId: string, container: HTMLElement | null) => void;
    onShowAll: () => void;
    onOpenStep: (stepId: string) => void;
    registerGroupRow: (node: HTMLButtonElement | null) => void;
    registerStepRow: (stepId: string, node: HTMLButtonElement | null) => void;
    renderDeep: (step: Step) => React.ReactElement;
}

interface StepRowData {
    steps: readonly Step[];
    sentences: readonly string[];
    deep: string | null;
    onOpenStep: (stepId: string) => void;
    registerStepRow: (stepId: string, node: HTMLButtonElement | null) => void;
}

function StepRowButton({
    step,
    sentence,
    expanded,
    onOpenStep,
    registerStepRow,
}: {
    step: Step;
    sentence: string;
    expanded: boolean;
    onOpenStep: (stepId: string) => void;
    registerStepRow: (stepId: string, node: HTMLButtonElement | null) => void;
}): React.ReactElement {
    const isRunning = step.status === "running";
    const note =
        step.status === "failed" ? (
            <span className="mj_TurnCard_stepNote mj_TurnCard_stepNote_failed">failed</span>
        ) : step.status === "stopped" ? (
            <span className="mj_TurnCard_stepNote mj_TurnCard_stepNote_failed">stopped</span>
        ) : isRunning ? (
            <span className="mj_TurnCard_stepNote">now</span>
        ) : (
            <span />
        );
    return (
        <button
            ref={(node) => registerStepRow(step.id, node)}
            type="button"
            className="mj_TurnCard_step"
            aria-expanded={isRunning ? undefined : expanded}
            disabled={isRunning}
            onClick={() => onOpenStep(step.id)}
        >
            <span className="mj_TurnCard_name" title={step.input.path || step.input.command || ""}>
                {sentence}
            </span>
            {note}
            {isRunning ? <span /> : <V6Icon name="chevR" className="mj_TurnCard_go" />}
        </button>
    );
}

function VirtualStepRow({
    index,
    style,
    steps,
    sentences,
    deep,
    onOpenStep,
    registerStepRow,
}: RowComponentProps<StepRowData>): React.ReactElement {
    const step = steps[index];
    return (
        <div style={style} className="mj_TurnCard_virtualRow">
            <StepRowButton
                step={step}
                sentence={sentences[index]}
                expanded={deep === step.id}
                onOpenStep={onOpenStep}
                registerStepRow={registerStepRow}
            />
        </div>
    );
}

function GroupBlock({
    group,
    open,
    showAll,
    deep,
    listId,
    onToggle,
    onShowAll,
    onOpenStep,
    registerGroupRow,
    registerStepRow,
    renderDeep,
}: GroupBlockProps): React.ReactElement {
    const listRef = useRef<HTMLDivElement>(null);
    const k = group.steps.length;
    const sentences = useMemo(() => stepRowSentences(group.steps), [group.steps]);
    const cap = showAll ? k : STEP_CAP;
    const virtualize = showAll && k > VIRTUALIZE_AFTER;
    const deepStep = deep ? group.steps.find((step) => step.id === deep) : undefined;

    return (
        <div
            className={`mj_TurnCard_group mj_TurnCard_group_${group.status}${open ? " is-open" : ""}`}
            data-group={group.id}
        >
            <button
                ref={registerGroupRow}
                type="button"
                className="mj_TurnCard_groupRow"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => onToggle(group.id, listRef.current)}
            >
                <span className="mj_TurnCard_icon" aria-hidden="true">
                    <V6Icon name={ICON_FOR[group.icon]} />
                </span>
                <span className="mj_TurnCard_sentence">
                    {group.sentence}
                    {group.outcomeText && (group.key === "test" || group.key === "check") ? (
                        <span className="mj_TurnCard_outcome">: {group.outcomeText}</span>
                    ) : group.outcomeText ? (
                        <span className="mj_SrOnly">: {group.outcomeText}</span>
                    ) : null}
                </span>
                <StatusGlyph status={group.status} />
                <span className="mj_TurnCard_count">{stepCount(k)}</span>
                <V6Icon name="chev" className="mj_TurnCard_chevron" />
            </button>
            {open && (
                <div ref={listRef} id={listId}>
                    {virtualize ? (
                        <>
                            <List
                                className="mj_TurnCard_virtualList"
                                rowComponent={VirtualStepRow}
                                rowCount={k}
                                rowHeight={STEP_ROW_HEIGHT}
                                rowProps={{ steps: group.steps, sentences, deep, onOpenStep, registerStepRow }}
                                style={{ height: STEP_CAP * STEP_ROW_HEIGHT }}
                            />
                            {deepStep && renderDeep(deepStep)}
                        </>
                    ) : (
                        <ul className="mj_TurnCard_steps">
                            {group.steps.slice(0, cap).map((step, index) => (
                                <li key={step.id}>
                                    <StepRowButton
                                        step={step}
                                        sentence={sentences[index]}
                                        expanded={deep === step.id}
                                        onOpenStep={onOpenStep}
                                        registerStepRow={registerStepRow}
                                    />
                                    {deep === step.id && step.status !== "running" && renderDeep(step)}
                                </li>
                            ))}
                            {k > cap && (
                                <li>
                                    <button type="button" className="mj_TurnCard_more" onClick={onShowAll}>
                                        Show all {k}
                                    </button>
                                </li>
                            )}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

/** A turn-ending error (`.mj_TurnError`, role=alert): one critical row below the card. */
export function TurnErrorRow({ text }: { text: string }): React.ReactElement {
    return (
        <div className="mj_TurnError" role="alert">
            <V6Icon name="alert" />
            <span>{text}</span>
        </div>
    );
}

/** Display text of a bridge notice: first line, leading emoji and brackets dropped. */
export function noticeText(body: string): string {
    const first = body.trim().split("\n")[0] ?? "";
    return first
        .replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+/u, "")
        .replace(/^\[(.*)\]$/, "$1")
        .trim();
}
