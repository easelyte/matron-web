/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The chat's Tasks & decisions pane: a side panel beside the conversation, opened from the
 * checklist button in the chat header. A This chat / All switch picks whose items it lists; the
 * sections are Needs you, Tasks, Decisions and Done (see chatTaskSections). The "+" button opens a
 * small form that files a task, question or decision into this chat. Open tasks can be dragged into
 * a new order (or moved with Alt+Up / Alt+Down), which the journal's rank call records. A row opens
 * its item in the tracker. Below 700px wide the pane covers the chat, with its own close button.
 */

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "../client";
import { CloseIcon } from "../icons";
import type { ChatTasksState, Conversation, TrackerItem, TrackerItemCreate } from "../types";
import { chatTaskSections } from "./chat-tasks";
import { itemOriginTitle, kindLabel } from "./format";
import { ItemRow } from "./ItemRow";

const CREATABLE_KINDS: readonly TrackerItemCreate["kind"][] = ["task", "question", "decision"];
const TASK_DRAG_TYPE = "application/x-matron-task";
// Below this width the pane covers the chat (see tracker.pcss), so it takes focus like a sheet.
const OVERLAY_QUERY = "(max-width: 700px)";

export function ChatTasksPane({
    client,
    pane,
    convoId,
    conversations,
}: {
    client: MatronJournalClient;
    pane: ChatTasksState;
    convoId: string;
    conversations: Conversation[];
}): React.ReactElement {
    const scope = pane.allFor === convoId ? "all" : convoId;
    const isAll = scope === "all";
    const [creating, setCreating] = useState(false);
    const paneRef = useRef<HTMLElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);

    // Covering the chat, the pane takes focus on open and hands it back on close; beside the chat
    // it leaves focus where it was.
    useEffect(() => {
        if (!window.matchMedia?.(OVERLAY_QUERY).matches) return;
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        const pane = paneRef.current;
        return () => {
            const active = document.activeElement;
            const lost = !active || active === document.body || (pane?.contains(active) ?? false);
            if (lost && opener?.isConnected) opener.focus();
        };
    }, []);

    // Every conversation switch, scope switch and reopen reloads the list.
    useEffect(() => {
        void client.loadChatTasks();
    }, [client, scope, convoId]);

    // The form belongs to the chat it was opened in.
    useEffect(() => setCreating(false), [convoId]);

    // Shown only when it is this scope's list: a load for the previous one may still be on screen.
    const items = pane.scope === scope ? pane.items : undefined;
    const sections = useMemo(() => chatTaskSections(items ?? []), [items]);
    const originTitles = useMemo(() => {
        const map = new Map<string, string>();
        for (const convo of conversations) map.set(convo.id, convo.title.trim() || convo.id);
        return map;
    }, [conversations]);
    const originTitle = (item: TrackerItem): string =>
        originTitles.get(item.origin_convo_id) ?? itemOriginTitle(item) ?? "Another chat";
    const openItem = (num: number): void => client.openTrackerItem(num);

    const row = (item: TrackerItem, describedBy?: string): React.ReactElement => (
        <ItemRow
            key={item.id}
            describedBy={describedBy}
            item={item}
            scope={isAll ? "all" : "chat"}
            originTitle={originTitle(item)}
            currentConvoId={convoId}
            onOpen={openItem}
        />
    );

    const empty =
        sections.needsYou.length === 0 &&
        sections.tasks.length === 0 &&
        sections.decisions.length === 0 &&
        sections.done.length === 0;

    let body: React.ReactNode;
    if (pane.unsupported) {
        body = (
            <div className="mj_TrackerEmpty" role="status">
                <p className="mj_TrackerEmpty_title">Tracker not available</p>
                <p className="mj_TrackerEmpty_hint">Update the journal server to use items.</p>
            </div>
        );
    } else if (items === undefined) {
        body = pane.error ? (
            <div className="mj_TrackerEmpty" role="status">
                <p className="mj_TrackerEmpty_title">Couldn't load items</p>
                <button type="button" className="mj_TrackerTextButton" onClick={() => void client.loadChatTasks()}>
                    Try again
                </button>
            </div>
        ) : (
            <div className="mj_TrackerEmpty" role="status">
                <p className="mj_TrackerEmpty_title">Loading…</p>
            </div>
        );
    } else if (empty) {
        body = (
            <div className="mj_TrackerEmpty">
                <p className="mj_TrackerEmpty_title">Nothing tracked yet</p>
                <p className="mj_TrackerEmpty_hint">Questions, tasks and decisions the agent files appear here.</p>
            </div>
        );
    } else {
        body = (
            <>
                {sections.needsYou.length > 0 ? (
                    <section className="mj_TrackerSection" aria-label="Needs you">
                        <h2 className="mj_TrackerSection_header">Needs you</h2>
                        {sections.needsYou.map((item) => row(item))}
                    </section>
                ) : null}
                {sections.tasks.length > 0 ? (
                    <TaskSection client={client} tasks={sections.tasks} renderRow={row} />
                ) : null}
                {sections.decisions.length > 0 ? (
                    <section className="mj_TrackerSection" aria-label="Decisions">
                        <h2 className="mj_TrackerSection_header">Decisions</h2>
                        {sections.decisions.map((item) => row(item))}
                    </section>
                ) : null}
                {sections.done.length > 0 ? (
                    <section className="mj_TrackerSection" aria-label="Done">
                        <h2 className="mj_TrackerSection_header">Done</h2>
                        {sections.done.map((item) => row(item))}
                    </section>
                ) : null}
            </>
        );
    }

    return (
        <aside
            ref={paneRef}
            className="mj_ChatTasks"
            aria-label="Tasks and decisions"
            onKeyDown={(event) => {
                if (event.key !== "Escape" || event.defaultPrevented) return;
                if (!window.matchMedia?.(OVERLAY_QUERY).matches) return;
                event.preventDefault();
                client.toggleChatTasks(false);
            }}
        >
            <header className="mj_ChatTasks_header">
                <h1 className="mj_ChatTasks_title">Tasks &amp; decisions</h1>
                <button
                    ref={closeRef}
                    type="button"
                    className="mj_IconButton mj_ChatTasks_close"
                    aria-label="Close tasks and decisions"
                    title="Close"
                    onClick={() => client.toggleChatTasks(false)}
                >
                    <CloseIcon aria-hidden />
                </button>
            </header>
            <div className="mj_ChatTasks_toolbar">
                <div className="mj_TrackerInboxToggle mj_ChatTasks_scope" role="tablist" aria-label="Items to show">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={!isAll}
                        className={`mj_TrackerToggleTab${!isAll ? " mj_TrackerToggleTab_active" : ""}`}
                        onClick={() => client.setChatTasksScope("chat")}
                    >
                        This chat
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={isAll}
                        className={`mj_TrackerToggleTab${isAll ? " mj_TrackerToggleTab_active" : ""}`}
                        onClick={() => client.setChatTasksScope("all")}
                    >
                        All
                    </button>
                </div>
                {pane.loading && items !== undefined ? (
                    <span className="mj_TrackerPane_spinner" aria-label="Refreshing" />
                ) : null}
                <button
                    type="button"
                    className="mj_IconButton mj_ChatTasks_new"
                    aria-label="New item"
                    title="New item"
                    aria-expanded={creating}
                    disabled={pane.unsupported}
                    onClick={() => setCreating((open) => !open)}
                >
                    <PlusIcon />
                </button>
            </div>
            {pane.actionError ? (
                <div className="mj_TrackerErrorBanner mj_ChatTasks_banner" role="alert">
                    <span>{pane.actionError}</span>
                    <button
                        type="button"
                        className="mj_TrackerTextButton"
                        onClick={() => client.dismissChatTasksError()}
                    >
                        OK
                    </button>
                </div>
            ) : null}
            {pane.error && items !== undefined ? (
                <div className="mj_TrackerStaleNotice" role="status">
                    Couldn't refresh, so this list may be out of date.{" "}
                    <button type="button" className="mj_TrackerTextButton" onClick={() => void client.loadChatTasks()}>
                        Try again
                    </button>
                </div>
            ) : null}
            {creating ? <NewItemForm client={client} onDone={() => setCreating(false)} /> : null}
            <div className="mj_ChatTasks_body">{body}</div>
        </aside>
    );
}

function PlusIcon(): React.ReactElement {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
        </svg>
    );
}

/**
 * The open tasks, in rank order. Each row can be dragged to a new place; a line shows where it will
 * land. Alt+Up / Alt+Down on a focused row moves it by one, for the keyboard.
 */
function TaskSection({
    client,
    tasks,
    renderRow,
}: {
    client: MatronJournalClient;
    tasks: TrackerItem[];
    renderRow: (item: TrackerItem, describedBy?: string) => React.ReactElement;
}): React.ReactElement {
    const hintId = useId();
    const listRef = useRef<HTMLDivElement>(null);
    // The task a keyboard move was made on: once the list redraws in its new order, focus goes back
    // to its row (React may have moved that row's node, which drops focus in some browsers).
    const refocus = useRef<string | null>(null);
    useLayoutEffect(() => {
        const id = refocus.current;
        if (!id) return;
        refocus.current = null;
        const wrap = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? []).find(
            (el) => el.dataset.taskId === id,
        );
        // Only if focus was dropped, never taken from somewhere the user has moved on to.
        const active = document.activeElement;
        const dropped = !active || active === document.body || (listRef.current?.contains(active) ?? false);
        if (wrap && dropped && !wrap.contains(active)) wrap.querySelector<HTMLElement>("button")?.focus();
    }, [tasks]);
    const [dragging, setDragging] = useState<string | null>(null);
    // Where the dragged task would land: before the task at this index (tasks.length = the end).
    const [dropAt, setDropAt] = useState<number | null>(null);
    const movable = tasks.length > 1;

    // A drop before `slot` (an index in the full list) is index slot - 1 once the task is lifted
    // out from above it.
    const drop = (id: string, slot: number): void => {
        const from = tasks.findIndex((task) => task.id === id);
        if (from < 0) return;
        void client.moveChatTask(id, slot > from ? slot - 1 : slot);
    };
    const reset = (): void => {
        setDragging(null);
        setDropAt(null);
    };

    return (
        <section className="mj_TrackerSection" aria-label="Tasks">
            <h2 className="mj_TrackerSection_header">Tasks</h2>
            {movable ? (
                <p id={hintId} className="mj_SrOnly">
                    Alt+Up and Alt+Down move the focused task.
                </p>
            ) : null}
            <div
                ref={listRef}
                className="mj_ChatTasks_taskList"
                onDragOver={(event) => {
                    if (!dragging || !event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                    if (!dragging || !event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
                    event.preventDefault();
                    const id = event.dataTransfer.getData(TASK_DRAG_TYPE) || dragging;
                    if (dropAt !== null) drop(id, dropAt);
                    reset();
                }}
            >
                {tasks.map((task, index) => (
                    <div
                        key={task.id}
                        className={`mj_ChatTasks_task${dragging === task.id ? " mj_ChatTasks_task_dragging" : ""}${
                            dropAt === index ? " mj_ChatTasks_task_dropBefore" : ""
                        }${dropAt === tasks.length && index === tasks.length - 1 ? " mj_ChatTasks_task_dropAfter" : ""}`}
                        data-task-id={task.id}
                        draggable={movable}
                        title={movable ? "Drag to reorder" : undefined}
                        onDragStart={(event) => {
                            event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
                            event.dataTransfer.effectAllowed = "move";
                            setDragging(task.id);
                        }}
                        onDragOver={(event) => {
                            if (!dragging) return;
                            const box = event.currentTarget.getBoundingClientRect();
                            const after = event.clientY > box.top + box.height / 2;
                            setDropAt(after ? index + 1 : index);
                        }}
                        onDragEnd={reset}
                        onKeyDown={(event) => {
                            if (!movable || !event.altKey) return;
                            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                            event.preventDefault();
                            const next = event.key === "ArrowUp" ? index - 1 : index + 1;
                            if (next < 0 || next >= tasks.length) return;
                            refocus.current = task.id;
                            void client.moveChatTask(task.id, next);
                        }}
                    >
                        {renderRow(task, movable ? hintId : undefined)}
                    </div>
                ))}
            </div>
        </section>
    );
}

/**
 * The create form: kind, title and Markdown details, with Cancel and Add. Add stays off until there
 * is a title; a refusal is said beside the form, which keeps what was typed.
 */
function NewItemForm({ client, onDone }: { client: MatronJournalClient; onDone: () => void }): React.ReactElement {
    const [kind, setKind] = useState<TrackerItemCreate["kind"]>("task");
    const [title, setTitle] = useState("");
    const [details, setDetails] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const titleRef = useRef<HTMLInputElement>(null);
    // One key per draft: a retry of the same draft reuses it, so the journal dedupes a create that
    // landed but whose answer was lost. Any edit makes it a new draft with a new key.
    const draftKey = useRef<string>(crypto.randomUUID());
    // Only a real change does: re-tapping the selected kind keeps the draft (and its key).
    const edit =
        <T,>(current: T, set: (value: T) => void) =>
        (value: T): void => {
            if (value === current) return;
            draftKey.current = crypto.randomUUID();
            set(value);
        };
    const titleId = useId();
    const detailsId = useId();

    useEffect(() => titleRef.current?.focus(), []);

    const submit = async (): Promise<void> => {
        if (busy || !title.trim()) return;
        setBusy(true);
        setError(null);
        const outcome = await client.createChatItem({ kind, title, body: details }, draftKey.current);
        setBusy(false);
        if (outcome.ok) onDone();
        else setError(outcome.reason);
    };

    return (
        <form
            className="mj_ChatTasks_form"
            aria-label="New item"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
            onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                onDone();
            }}
        >
            <div className="mj_TrackerSegment mj_ChatTasks_kind" role="group" aria-label="Kind">
                {CREATABLE_KINDS.map((option) => (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={kind === option}
                        disabled={busy}
                        onClick={() => edit(kind, setKind)(option)}
                    >
                        {kindLabel(option)}
                    </button>
                ))}
            </div>
            <label className="mj_SrOnly" htmlFor={titleId}>
                Title
            </label>
            <input
                ref={titleRef}
                id={titleId}
                type="text"
                className="mj_TrackerInput"
                placeholder="Title"
                value={title}
                maxLength={200}
                disabled={busy}
                onChange={(event) => edit(title, setTitle)(event.target.value)}
            />
            <label className="mj_SrOnly" htmlFor={detailsId}>
                Details
            </label>
            <textarea
                id={detailsId}
                className="mj_TrackerTextarea mj_ChatTasks_details"
                placeholder="Details (Markdown)"
                value={details}
                disabled={busy}
                rows={3}
                onChange={(event) => edit(details, setDetails)(event.target.value)}
            />
            {error ? (
                <p className="mj_TrackerMemoryForm_error" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="mj_TrackerConfirm_actions">
                <button type="button" className="mj_TrackerTextButton" disabled={busy} onClick={onDone}>
                    Cancel
                </button>
                <button type="submit" className="mj_TrackerButton" disabled={busy || !title.trim()}>
                    {busy ? "Adding…" : "Add"}
                </button>
            </div>
        </form>
    );
}
