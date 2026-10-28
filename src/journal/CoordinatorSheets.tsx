/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Coordinator's sheets, after the Mac's (MacCoordinatorChooserSheet, MacRoutinesSheet,
 * RoutinesListView, RoutineEditorView):
 *
 * - the chooser picks which conversation is the user's Coordinator (PUT /coordinator): the
 *   conversations with a search field and, across two or more boxes, the box filter, plus
 *   "New coordinator chat…", which starts a session and makes it the Coordinator;
 * - the Routines sheet lists the routines the journal fires into the Coordinator, each with what
 *   sets it off, its next and last fire, a pause switch and Run now; a row opens the editor,
 *   which also creates, runs and deletes. Nothing loads until it opens, so an older journal's
 *   404 stays on this sheet.
 *
 * Both reuse the new-session sheet's shell, portalled to <body>, and open one at a time: the
 * editor replaces the list inside the Routines sheet rather than stacking a second modal.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { MatronJournalClient } from "./client";
import { AlarmIcon, ComposeIcon, PlusCircleIcon, RefreshIcon, WarningTriangleIcon } from "./icons";
import { SheetHead, useSheetLifecycle } from "./PinDialogs";
import { pinChooserView } from "./pins";
import {
    type AllowanceTier,
    AllowanceTierRules,
    DEFAULT_ALLOWANCE_TIERS,
    type Routine,
    ROUTINE_TRIGGER_KINDS,
    normalizeRoutinePrompt,
    type RoutineDraft,
    routineLastFireFailed,
    routineOutcomeWords,
    RoutineRules,
    ROUTINES_CAPTION,
    ROUTINES_UNSUPPORTED,
    routineSchedulePreview,
    routineStatusLines,
    routineWhenWords,
    type RoutineTrigger,
    type RoutineTriggerKind,
    triggerThresholdLabel,
    triggerThresholdRange,
    triggerWords,
} from "./routines";
import { displayTitle } from "./SessionTag";
import type { ClientState, Conversation } from "./types";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

/**
 * A modal's focus, as in the Settings sheet: focus moves into the sheet on open (unless a field
 * already took it), Tab cycles inside it, and the opener gets focus back on close (or the modal
 * that replaced it, when there is one). `view` names
 * what the sheet shows; when it changes and focus fell out (the clicked control went away), the
 * sheet itself takes focus again.
 */
function useModalFocus(sheetRef: React.RefObject<HTMLElement | null>, view: string): void {
    useEffect(() => {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const onKey = (event: KeyboardEvent): void => {
            const sheet = sheetRef.current;
            if (event.key !== "Tab" || !sheet) return;
            const focusable = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const inside = focusable.includes(document.activeElement as HTMLElement);
            if (event.shiftKey && (document.activeElement === first || !inside)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            // Handed over to another modal (the chooser's new chat): focus goes into that one,
            // not to the opener under it.
            const next = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
            if (next) next.querySelector<HTMLElement>(FOCUSABLE)?.focus();
            else if (opener?.isConnected) opener.focus();
        };
    }, [sheetRef]);
    useEffect(() => {
        const sheet = sheetRef.current;
        if (sheet && !sheet.contains(document.activeElement)) sheet.focus();
    }, [sheetRef, view]);
}

// ── Chooser ───────────────────────────────────────────────────────────────────────────────────

export function CoordinatorChooserSheet({
    client,
    state,
    initialError,
    onClose,
    onNewChat,
}: {
    client: MatronJournalClient;
    state: ClientState;
    /** A failure to show on open (the new chat started but did not become the Coordinator). */
    initialError?: string;
    onClose: () => void;
    /** "New coordinator chat…": the parent runs the new-session sheet and stores the result. */
    onNewChat: () => void;
}): React.ReactElement {
    const [query, setQuery] = useState("");
    const [box, setBox] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | undefined>(initialError);
    const mountedRef = useSheetLifecycle(onClose);
    const sheetRef = useRef<HTMLDivElement>(null);
    useModalFocus(sheetRef, "chooser");
    const current = state.coordinatorConvoId ?? null;
    // Top-level and unarchived: the conversations the Mac's chat list offers.
    const eligible = state.conversations.filter(
        (conversation: Conversation) => !conversation.parent_convo_id && !state.archivedIds.has(conversation.id),
    );
    const view = pinChooserView(eligible, state.agents, query, box);
    if (box !== null && view.box === null) setBox(null);

    const pick = async (convoId: string): Promise<void> => {
        if (saving) return;
        setSaving(true);
        setError(undefined);
        const failure = await client.setCoordinator(convoId);
        if (!mountedRef.current) return;
        setSaving(false);
        if (failure) setError(failure);
        else onClose();
    };

    return createPortal(
        <div
            className="mj_UploadConfirm_scrim"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mj-coordinator-chooser-title"
        >
            <div
                ref={sheetRef}
                tabIndex={-1}
                className="mj_UploadConfirm mj_NewSessionSheet mj_PinSheet"
                data-testid="coordinator-chooser"
            >
                <SheetHead
                    id="mj-coordinator-chooser-title"
                    title="Choose the coordinator conversation"
                    onClose={onClose}
                />
                <p>The Coordinator hands out your work as missions, and the journal sends it your routines.</p>
                <div>
                    <label htmlFor="mj-coordinator-chooser-search">Conversation</label>
                    <input
                        id="mj-coordinator-chooser-search"
                        type="text"
                        value={query}
                        autoFocus
                        autoComplete="off"
                        placeholder="Search conversations"
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                {view.boxes.length > 0 && (
                    <div className="mj_ConversationListTabs mj_PinSheet_boxes" role="group" aria-label="Filter by box">
                        <button
                            type="button"
                            className={`mj_ConversationListTab${view.box === null ? " mj_ConversationListTab_active" : ""}`}
                            aria-pressed={view.box === null}
                            onClick={() => setBox(null)}
                        >
                            All
                        </button>
                        {view.boxes.map((option) => (
                            <button
                                key={option.name}
                                type="button"
                                className={`mj_ConversationListTab${view.box === option.name ? " mj_ConversationListTab_active" : ""}`}
                                aria-pressed={view.box === option.name}
                                onClick={() => setBox(view.box === option.name ? null : option.name)}
                            >
                                {option.name} {option.count}
                            </button>
                        ))}
                    </div>
                )}
                <div role="list" aria-label="Conversations" className="mj_PinSheet_list">
                    <button
                        type="button"
                        role="listitem"
                        className="mj_CoordinatorChooser_new"
                        disabled={saving}
                        onClick={onNewChat}
                    >
                        <span>
                            <ComposeIcon aria-hidden="true" /> New coordinator chat…
                        </span>
                    </button>
                    {view.conversations.map((conversation) => (
                        <button
                            key={conversation.id}
                            type="button"
                            role="listitem"
                            data-convo={conversation.id}
                            aria-current={conversation.id === current ? "true" : undefined}
                            disabled={saving}
                            onClick={() => void pick(conversation.id)}
                        >
                            <span>{displayTitle(conversation)}</span>
                            {conversation.id === current && (
                                <span className="mj_CoordinatorChooser_current">Current Coordinator</span>
                            )}
                        </button>
                    ))}
                </div>
                {view.conversations.length === 0 && <p>No conversations match.</p>}
                {error && (
                    <p className="mj_UploadConfirm_error" role="alert">
                        {error}
                    </p>
                )}
                <div className="mj_UploadConfirm_actions">
                    <button type="button" onClick={onClose}>
                        Cancel
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

// ── Routines ──────────────────────────────────────────────────────────────────────────────────

type EditorTarget = { kind: "new" } | { kind: "existing"; id: string };

export function RoutinesSheet({
    client,
    onClose,
}: {
    client: MatronJournalClient;
    onClose: () => void;
}): React.ReactElement {
    const routines = useSyncExternalStore(client.subscribe, () => client.getSnapshot().routines);
    const [editing, setEditing] = useState<EditorTarget | null>(null);
    const [message, setMessage] = useState<string>();
    const [now, setNow] = useState(() => Date.now());
    // The row an editor was opened from gets focus back when the editor closes.
    const [returnTo, setReturnTo] = useState<string>();
    const sheetRef = useRef<HTMLDivElement>(null);
    // Escape steps back out of the editor before it closes the sheet.
    useSheetLifecycle(() => (editing ? setEditing(null) : onClose()));
    useModalFocus(sheetRef, editing ? `edit:${editing.kind === "new" ? "" : editing.id}` : "list");
    useEffect(() => {
        if (editing || !returnTo) return;
        const rows = sheetRef.current?.querySelectorAll<HTMLElement>("[data-routine-id]") ?? [];
        [...rows]
            .find((row) => row.dataset.routineId === returnTo)
            ?.querySelector<HTMLElement>(".mj_RoutineRow_main")
            ?.focus();
        setReturnTo(undefined);
    }, [editing, returnTo]);

    useEffect(() => client.watchRoutines(), [client]);
    // "Next: today at 18:30" and "Last: 5m ago" move on while the sheet is open.
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);

    const list = routines?.list;
    const supported = routines?.unsupported !== true;
    const busy = routines?.busyIds ?? new Set<string>();

    const setEnabled = async (routine: Routine, enabled: boolean): Promise<void> => {
        setMessage(undefined);
        const failure = await client.setRoutineEnabled(routine.id, enabled);
        if (failure) setMessage(failure);
    };
    const run = async (routine: Routine): Promise<void> => {
        setMessage(undefined);
        const failure = await client.runRoutine(routine.id);
        setMessage(failure ?? `Sent “${routine.title}” to the Coordinator.`);
    };

    let body: React.ReactNode;
    if (editing) {
        const routine = editing.kind === "existing" ? list?.find((row) => row.id === editing.id) : undefined;
        body =
            editing.kind === "existing" && !routine ? (
                <div className="mj_RoutinesSheet_body">
                    <p>Routine not found. It may have been deleted on another device.</p>
                    <div className="mj_UploadConfirm_actions">
                        <button type="button" onClick={() => setEditing(null)}>
                            Back
                        </button>
                    </div>
                </div>
            ) : (
                <RoutineEditor
                    key={routine?.id ?? "new"}
                    client={client}
                    routine={routine}
                    onDone={() => setEditing(null)}
                />
            );
    } else if (!supported) {
        body = <p className="mj_RoutinesSheet_note">{ROUTINES_UNSUPPORTED}</p>;
    } else if (list) {
        body = (
            <div className="mj_RoutinesSheet_body">
                {list.length === 0 && (
                    <p className="mj_RoutinesSheet_note">No routines yet. Add one, or ask your Coordinator to.</p>
                )}
                <ul className="mj_RoutinesSheet_list" aria-label="Routines">
                    {list.map((routine) => (
                        <RoutineRow
                            key={routine.id}
                            routine={routine}
                            busy={busy.has(routine.id)}
                            now={now}
                            onEdit={() => {
                                setMessage(undefined);
                                setReturnTo(routine.id);
                                setEditing({ kind: "existing", id: routine.id });
                            }}
                            onSetEnabled={(enabled) => void setEnabled(routine, enabled)}
                            onRun={() => void run(routine)}
                        />
                    ))}
                </ul>
                <p className="mj_RoutinesSheet_caption">{ROUTINES_CAPTION}</p>
                {routines?.error && <p className="mj_RoutinesSheet_note">Couldn&apos;t refresh: {routines.error}</p>}
            </div>
        );
    } else if (routines?.error) {
        body = (
            <div className="mj_RoutinesSheet_body">
                <p className="mj_UploadConfirm_error" role="alert">
                    Couldn&apos;t load routines: {routines.error}
                </p>
                <div className="mj_UploadConfirm_actions">
                    <button type="button" onClick={() => void client.loadRoutines()}>
                        Try again
                    </button>
                </div>
            </div>
        );
    } else {
        body = <p role="status">Loading routines…</p>;
    }

    return createPortal(
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-labelledby="mj-routines-title">
            <div
                ref={sheetRef}
                tabIndex={-1}
                className="mj_UploadConfirm mj_NewSessionSheet mj_RoutinesSheet"
                data-testid="routines-sheet"
            >
                <div className="mj_NewSessionSheet_head">
                    <h2 className="mj_UploadConfirm_title" id="mj-routines-title">
                        Routines
                    </h2>
                    {!editing && (
                        <>
                            {routines?.loading && list && (
                                <span className="mj_RoutinesSheet_spinner" role="status">
                                    Refreshing…
                                </span>
                            )}
                            <button
                                type="button"
                                className="mj_NewSessionSheet_close"
                                aria-label="Refresh"
                                title="Refresh"
                                onClick={() => void client.loadRoutines()}
                            >
                                <RefreshIcon width={16} height={16} />
                            </button>
                            {supported && (
                                <button
                                    type="button"
                                    className="mj_NewSessionSheet_close"
                                    aria-label="New routine"
                                    title="New routine"
                                    data-action="new-routine"
                                    onClick={() => {
                                        setMessage(undefined);
                                        setEditing({ kind: "new" });
                                    }}
                                >
                                    <PlusCircleIcon width={16} height={16} />
                                </button>
                            )}
                        </>
                    )}
                </div>
                {body}
                {message && !editing && (
                    <p className="mj_RoutinesSheet_message" role="status">
                        {message}
                    </p>
                )}
                {!editing && (
                    <div className="mj_UploadConfirm_actions">
                        <button type="button" className="mj_UploadConfirm_send" onClick={onClose}>
                            Done
                        </button>
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}

function RoutineRow({
    routine,
    busy,
    now,
    onEdit,
    onSetEnabled,
    onRun,
}: {
    routine: Routine;
    busy: boolean;
    now: number;
    onEdit: () => void;
    onSetEnabled: (enabled: boolean) => void;
    onRun: () => void;
}): React.ReactElement {
    const failed = routineLastFireFailed(routine.last_outcome);
    const outcome = routineOutcomeWords(routine.last_outcome);
    return (
        <li
            className="mj_RoutineRow"
            data-routine={routine.name}
            data-routine-id={routine.id}
            data-paused={!routine.enabled || undefined}
        >
            {/* No aria-label: the row's words (when, next, last, a failed fire) are the button's name. */}
            <button type="button" className="mj_RoutineRow_main" onClick={onEdit} title={`Edit ${routine.title}`}>
                <span className="mj_RoutineRow_title">
                    {routine.title}
                    {!routine.enabled && <span className="mj_RoutineRow_paused">Paused</span>}
                </span>
                <span className="mj_RoutineRow_name">{routine.name}</span>
                <span className="mj_RoutineRow_when">
                    {routine.trigger ? <WarningTriangleIcon aria-hidden="true" /> : <AlarmIcon aria-hidden="true" />}
                    {routineWhenWords(routine)}
                </span>
                {routineStatusLines(routine, now).map((line) => (
                    <span key={line} className="mj_RoutineRow_status">
                        {line}
                    </span>
                ))}
                {failed && outcome && <span className="mj_RoutineRow_failed">{outcome}</span>}
            </button>
            <div className="mj_RoutineRow_actions">
                <button
                    type="button"
                    role="switch"
                    className="mj_SettingsSheet_switch"
                    aria-checked={routine.enabled}
                    aria-label={`${routine.title}: ${routine.enabled ? "active" : "paused"}`}
                    title={routine.enabled ? "Pause" : "Resume"}
                    disabled={busy}
                    onClick={() => onSetEnabled(!routine.enabled)}
                />
                <button type="button" className="mj_RoutineRow_run" disabled={busy} onClick={onRun}>
                    Run now
                </button>
            </div>
        </li>
    );
}

/** An allowance_expiring routine's tiers: rows of unused percent and hours left. */
function TierEditor({
    tiers,
    onChange,
}: {
    tiers: AllowanceTier[];
    onChange: (tiers: AllowanceTier[]) => void;
}): React.ReactElement {
    const set = (index: number, change: Partial<AllowanceTier>): void =>
        onChange(tiers.map((tier, i) => (i === index ? { ...tier, ...change } : tier)));
    return (
        <div className="mj_RoutineEditor_tiers">
            {tiers.map((tier, index) => (
                <div className="mj_RoutineEditor_threshold" key={index}>
                    <input
                        type="number"
                        aria-label={`Tier ${index + 1} unused percent`}
                        min={1}
                        max={99}
                        step={5}
                        value={Number.isFinite(tier.unusedPct) ? tier.unusedPct : ""}
                        onChange={(event) => set(index, { unusedPct: event.target.valueAsNumber })}
                    />
                    <span>% unused with</span>
                    <input
                        type="number"
                        aria-label={`Tier ${index + 1} hours left`}
                        min={1}
                        max={AllowanceTierRules.maxHours}
                        step={1}
                        value={Number.isFinite(tier.hoursLeft) ? tier.hoursLeft : ""}
                        onChange={(event) => set(index, { hoursLeft: event.target.valueAsNumber })}
                    />
                    <span>h left</span>
                    {tiers.length > 1 && (
                        <button
                            type="button"
                            className="mj_RoutineEditor_tierRemove"
                            aria-label={`Remove tier ${index + 1}`}
                            onClick={() => onChange(tiers.filter((_, i) => i !== index))}
                        >
                            Remove
                        </button>
                    )}
                </div>
            ))}
            {tiers.length < AllowanceTierRules.maxTiers && (
                <button
                    type="button"
                    className="mj_RoutineEditor_tierAdd"
                    onClick={() => onChange([...tiers, { unusedPct: 25, hoursLeft: 2 }])}
                >
                    Add tier
                </button>
            )}
        </div>
    );
}

// ── Editor ────────────────────────────────────────────────────────────────────────────────────

const CRON_LABELS = ["Minute", "Hour", "Day", "Month", "Weekday"];
const DEFAULT_CRON = ["0", "9", "*", "*", "1-5"];

type Mode = "schedule" | "trigger";

interface EditorDraft {
    name: string;
    title: string;
    prompt: string;
    tz: string;
    mode: Mode;
    cron: string[];
    triggerKind: RoutineTriggerKind;
    threshold: number;
    /** An allowance_expiring routine's reset window, kept as it is: the editor changes the percent. */
    window: Pick<RoutineTrigger, "fromHours" | "toHours">;
    /** An allowance_expiring routine's tiers; absent on one saved with a single threshold. */
    tiers?: AllowanceTier[];
    enabled: boolean;
}

function draftTrigger(draft: EditorDraft): RoutineTrigger {
    if (draft.triggerKind !== "allowance_expiring") return { kind: draft.triggerKind, threshold: draft.threshold };
    return draft.tiers
        ? { kind: draft.triggerKind, threshold: draft.tiers[0]?.unusedPct ?? 0, tiers: draft.tiers }
        : { kind: draft.triggerKind, threshold: draft.threshold, ...draft.window };
}

function initialDraft(routine: Routine | undefined): EditorDraft {
    if (!routine) {
        return {
            name: "",
            title: "",
            prompt: "",
            tz: RoutineRules.defaultZone,
            mode: "schedule",
            cron: DEFAULT_CRON,
            triggerKind: "context_over",
            threshold: 40,
            window: {},
            enabled: true,
        };
    }
    const cron = (routine.schedule ?? "").trim().split(/\s+/);
    return {
        name: routine.name,
        title: routine.title,
        prompt: routine.prompt,
        tz: routine.tz,
        mode: routine.trigger ? "trigger" : "schedule",
        cron: cron.length === 5 ? cron : DEFAULT_CRON,
        triggerKind: routine.trigger?.kind ?? "context_over",
        threshold: routine.trigger?.threshold ?? 40,
        window: { fromHours: routine.trigger?.fromHours, toHours: routine.trigger?.toHours },
        tiers: routine.trigger?.tiers,
        enabled: routine.enabled,
    };
}

/** What saving sends. `enabled` rides only on a create: on an edit the list's switch owns it. */
function editorRoutineDraft(draft: EditorDraft, isNew: boolean): RoutineDraft {
    const out: RoutineDraft = { title: draft.title, prompt: draft.prompt, tz: draft.tz };
    if (draft.mode === "schedule") out.schedule = draft.cron.map((field) => field.trim()).join(" ");
    else out.trigger = draftTrigger(draft);
    if (isNew) out.enabled = draft.enabled;
    return out;
}

function RoutineEditor({
    client,
    routine,
    onDone,
}: {
    client: MatronJournalClient;
    routine: Routine | undefined;
    onDone: () => void;
}): React.ReactElement {
    const isNew = routine === undefined;
    const [draft, setDraft] = useState<EditorDraft>(() => initialDraft(routine));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [note, setNote] = useState<string>();
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const update = (change: Partial<EditorDraft>): void => setDraft((current) => ({ ...current, ...change }));
    const schedule = draft.cron.map((field) => field.trim()).join(" ");
    const trigger = draftTrigger(draft);
    const range = triggerThresholdRange(draft.triggerKind);

    const save = async (): Promise<void> => {
        if (busy) return;
        setBusy(true);
        setNote(undefined);
        const failure = await client.saveRoutine(routine?.id, draft.name, editorRoutineDraft(draft, isNew));
        setBusy(false);
        if (failure) setError(failure);
        else onDone();
    };
    const run = async (): Promise<void> => {
        if (!routine || busy) return;
        setBusy(true);
        const failure = await client.runRoutine(routine.id);
        setBusy(false);
        setNote(failure ?? "Sent to the Coordinator.");
    };
    const remove = async (): Promise<void> => {
        if (!routine || busy) return;
        setBusy(true);
        const failure = await client.deleteRoutine(routine.id);
        setBusy(false);
        setConfirmingDelete(false);
        if (failure) setError(failure);
        else onDone();
    };

    return (
        <form
            className="mj_RoutineEditor"
            // The journal's rules run on save with a reason; the browser's own number checks would
            // silently block a threshold off the arrows' step (40 with min 1, step 5).
            noValidate
            aria-label={routine ? `Edit ${routine.title}` : "New routine"}
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <fieldset disabled={busy}>
                <div className="mj_RoutineEditor_heading">
                    <h3>{routine?.title ?? "New routine"}</h3>
                    {routine && <span className="mj_RoutineRow_name">{routine.name}</span>}
                </div>
                {isNew && (
                    <div>
                        <label htmlFor="mj-routine-name">Name</label>
                        <input
                            id="mj-routine-name"
                            type="text"
                            className="mj_RoutineEditor_mono"
                            value={draft.name}
                            placeholder="weekly-review"
                            autoComplete="off"
                            spellCheck={false}
                            autoFocus
                            onChange={(event) => update({ name: event.target.value })}
                        />
                        <p className="mj_RoutineEditor_help">
                            Lowercase letters, digits and dashes. It can&apos;t be changed later.
                        </p>
                    </div>
                )}
                <div>
                    <label htmlFor="mj-routine-title">Title</label>
                    <input
                        id="mj-routine-title"
                        type="text"
                        value={draft.title}
                        placeholder="Weekly review"
                        onChange={(event) => update({ title: event.target.value })}
                    />
                </div>
                <div>
                    <label htmlFor="mj-routine-prompt">Prompt</label>
                    <textarea
                        id="mj-routine-prompt"
                        rows={4}
                        value={draft.prompt}
                        placeholder="What the Coordinator should do when this fires"
                        onChange={(event) => update({ prompt: event.target.value })}
                    />
                    <p className="mj_RoutineEditor_help mj_RoutineEditor_count">
                        {normalizeRoutinePrompt(draft.prompt).length}/{RoutineRules.promptMaxLength}
                    </p>
                </div>
                {isNew && (
                    <div>
                        <span className="mj_RoutineEditor_label" id="mj-routine-mode">
                            Runs
                        </span>
                        <div className="mj_TrackerSegment" role="group" aria-labelledby="mj-routine-mode">
                            {(["schedule", "trigger"] as const).map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    aria-pressed={draft.mode === mode}
                                    onClick={() => update({ mode })}
                                >
                                    {mode === "schedule" ? "On a schedule" : "When something happens"}
                                </button>
                            ))}
                        </div>
                        <p className="mj_RoutineEditor_help">
                            A routine stays scheduled or triggered: this can&apos;t be changed later.
                        </p>
                    </div>
                )}
                {draft.mode === "schedule" ? (
                    <div>
                        <span className="mj_RoutineEditor_label">Schedule</span>
                        <div className="mj_RoutineEditor_cron">
                            {CRON_LABELS.map((label, index) => (
                                <span key={label} className="mj_RoutineEditor_cronField">
                                    <input
                                        type="text"
                                        aria-label={label}
                                        className="mj_RoutineEditor_mono"
                                        value={draft.cron[index]}
                                        spellCheck={false}
                                        onChange={(event) => {
                                            const cron = [...draft.cron];
                                            cron[index] = event.target.value;
                                            update({ cron });
                                        }}
                                    />
                                    <span aria-hidden="true">{label}</span>
                                </span>
                            ))}
                        </div>
                        <p className="mj_RoutineEditor_preview" data-testid="routine-schedule-preview">
                            {routineSchedulePreview(schedule)}
                        </p>
                        <label htmlFor="mj-routine-tz">Time zone</label>
                        <input
                            id="mj-routine-tz"
                            type="text"
                            value={draft.tz}
                            placeholder={RoutineRules.defaultZone}
                            spellCheck={false}
                            onChange={(event) => update({ tz: event.target.value })}
                        />
                        <p className="mj_RoutineEditor_help">
                            Five cron fields, in the time zone above. It may fire at most every{" "}
                            {RoutineRules.minGapMinutes} minutes.
                        </p>
                    </div>
                ) : (
                    <div>
                        <label htmlFor="mj-routine-trigger">Trigger</label>
                        <select
                            id="mj-routine-trigger"
                            value={draft.triggerKind}
                            onChange={(event) => {
                                const kind = event.target.value as RoutineTriggerKind;
                                if (kind === draft.triggerKind) return;
                                const initial = ROUTINE_TRIGGER_KINDS.find((option) => option.kind === kind)?.initial;
                                update({
                                    triggerKind: kind,
                                    threshold: initial ?? draft.threshold,
                                    // A new allowance trigger starts in tiers, the form the journal suggests.
                                    tiers: kind === "allowance_expiring" ? [...DEFAULT_ALLOWANCE_TIERS] : undefined,
                                });
                            }}
                        >
                            {ROUTINE_TRIGGER_KINDS.map((option) => (
                                <option key={option.kind} value={option.kind}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                        {draft.tiers ? (
                            <TierEditor tiers={draft.tiers} onChange={(tiers) => update({ tiers })} />
                        ) : (
                            <div className="mj_RoutineEditor_threshold">
                                <input
                                    type="number"
                                    aria-label={draft.triggerKind === "stalled" ? "Minutes" : "Percent"}
                                    min={range.min}
                                    max={range.max}
                                    step={range.step}
                                    value={Number.isFinite(draft.threshold) ? draft.threshold : ""}
                                    onChange={(event) => update({ threshold: event.target.valueAsNumber })}
                                />
                                <span>{triggerThresholdLabel(trigger)}</span>
                            </div>
                        )}
                        <p className="mj_RoutineEditor_preview">{triggerWords(trigger)}</p>
                        <p className="mj_RoutineEditor_help">
                            It fires once for each session or box that crosses the line, at most every{" "}
                            {RoutineRules.minGapMinutes} minutes.
                        </p>
                    </div>
                )}
                {isNew && (
                    <label className="mj_RoutineEditor_check">
                        <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(event) => update({ enabled: event.target.checked })}
                        />
                        Active
                    </label>
                )}
                {error && (
                    <p className="mj_UploadConfirm_error" role="alert">
                        {error}
                    </p>
                )}
                {note && <p role="status">{note}</p>}
                {confirmingDelete ? (
                    <div className="mj_RoutineEditor_confirm" role="group" aria-label="Delete this routine?">
                        <p>Delete this routine? The Coordinator stops receiving it. This can&apos;t be undone.</p>
                        <div className="mj_UploadConfirm_actions">
                            <button type="button" onClick={() => setConfirmingDelete(false)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="mj_RoutineEditor_delete"
                                data-action="confirm-delete"
                                onClick={() => void remove()}
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="mj_UploadConfirm_actions">
                        {routine && (
                            <button
                                type="button"
                                className="mj_RoutineEditor_delete mj_RoutineEditor_leading"
                                data-action="delete-routine"
                                onClick={() => setConfirmingDelete(true)}
                            >
                                Delete routine
                            </button>
                        )}
                        {routine && (
                            <button type="button" data-action="run-routine" onClick={() => void run()}>
                                Run now
                            </button>
                        )}
                        <button type="button" onClick={onDone}>
                            Cancel
                        </button>
                        <button type="submit" className="mj_UploadConfirm_send" data-action="save-routine">
                            {busy ? "Saving…" : "Save"}
                        </button>
                    </div>
                )}
            </fieldset>
        </form>
    );
}
