/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The journal-pin sheets the sidebar row menu and the chat header "⋯" menu open: "Pin to
 * sidebar…" / "Edit pin…" (label + optional emoji) and "Move pin…" (pick another conversation,
 * narrowed by title and, across two or more boxes, by box).
 * Both reuse the new-session sheet's shell, portalled to <body> so a header's stacking context
 * can never clip the scrim.
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { MatronJournalClient } from "./client";
import { clampPinLabel, PIN_LABEL_MAX, pinChooserView, pinLabelFromTitle } from "./pins";
import { displayTitle } from "./SessionTag";
import { type ClientState, type Conversation, conversationTitle } from "./types";

export type PinDialogTarget = { kind: "edit"; convoId: string } | { kind: "move"; convoId: string };

export function PinDialog({
    client,
    state,
    target,
    onClose,
}: {
    client: MatronJournalClient;
    state: ClientState;
    target: PinDialogTarget;
    onClose: () => void;
}): React.ReactElement {
    const sheet =
        target.kind === "edit" ? (
            <PinEditSheet client={client} state={state} convoId={target.convoId} onClose={onClose} />
        ) : (
            <MovePinSheet client={client} state={state} convoId={target.convoId} onClose={onClose} />
        );
    return createPortal(sheet, document.body);
}

export function SheetHead({
    id,
    title,
    onClose,
}: {
    id: string;
    title: string;
    onClose: () => void;
}): React.ReactElement {
    return (
        <div className="mj_NewSessionSheet_head">
            <h2 className="mj_UploadConfirm_title" id={id}>
                {title}
            </h2>
            <button type="button" className="mj_NewSessionSheet_close" aria-label="Close" onClick={onClose}>
                <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="M18 6 6 18M6 6l12 12" />
                </svg>
            </button>
        </div>
    );
}

/** Escape closes the sheet; the mounted flag keeps a late response from touching an unmounted sheet. */
export function useSheetLifecycle(onClose: () => void): React.RefObject<boolean> {
    const mountedRef = useRef(true);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        mountedRef.current = true;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onCloseRef.current();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => {
            mountedRef.current = false;
            document.removeEventListener("keydown", onKeyDown);
        };
    }, []);
    return mountedRef;
}

function PinEditSheet({
    client,
    state,
    convoId,
    onClose,
}: {
    client: MatronJournalClient;
    state: ClientState;
    convoId: string;
    onClose: () => void;
}): React.ReactElement {
    const existing = state.journalPins?.find((pin) => pin.convo_id === convoId);
    const conversation = state.conversations.find((candidate) => candidate.id === convoId);
    const [label, setLabel] = useState(
        () => existing?.label ?? pinLabelFromTitle(conversation ? conversationTitle(conversation) : ""),
    );
    const [emoji, setEmoji] = useState(() => existing?.emoji ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const mountedRef = useSheetLifecycle(onClose);
    const trimmed = clampPinLabel(label);

    const save = async (): Promise<void> => {
        if (saving || !trimmed) return;
        setSaving(true);
        setError(undefined);
        const failure = await client.savePin(convoId, { label: trimmed, emoji: emoji.trim() });
        if (!mountedRef.current) return;
        setSaving(false);
        if (failure) setError(failure);
        else onClose();
    };

    return (
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-labelledby="mj-pin-sheet-title">
            <form
                className="mj_UploadConfirm mj_NewSessionSheet mj_PinSheet"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                }}
            >
                <SheetHead id="mj-pin-sheet-title" title={existing ? "Edit pin" : "Pin to sidebar"} onClose={onClose} />
                {conversation && <p>{displayTitle(conversation)}</p>}
                <div>
                    <label htmlFor="mj-pin-label">Label</label>
                    <input
                        id="mj-pin-label"
                        type="text"
                        value={label}
                        maxLength={PIN_LABEL_MAX}
                        autoFocus
                        autoComplete="off"
                        onChange={(event) => setLabel(event.target.value)}
                    />
                </div>
                <div>
                    <label htmlFor="mj-pin-emoji">Emoji (optional)</label>
                    <input
                        id="mj-pin-emoji"
                        type="text"
                        value={emoji}
                        maxLength={16}
                        autoComplete="off"
                        placeholder="Shows the label's first letter when empty"
                        onChange={(event) => setEmoji(event.target.value)}
                    />
                </div>
                {error && (
                    <p className="mj_UploadConfirm_error" role="alert">
                        {error}
                    </p>
                )}
                <div className="mj_UploadConfirm_actions">
                    <button type="button" onClick={onClose}>
                        Cancel
                    </button>
                    <button type="submit" className="mj_UploadConfirm_send" disabled={saving || !trimmed}>
                        {existing ? "Save" : "Pin"}
                    </button>
                </div>
            </form>
        </div>
    );
}

function MovePinSheet({
    client,
    state,
    convoId,
    onClose,
}: {
    client: MatronJournalClient;
    state: ClientState;
    convoId: string;
    onClose: () => void;
}): React.ReactElement {
    const pin = state.journalPins?.find((candidate) => candidate.convo_id === convoId);
    const [query, setQuery] = useState("");
    const [box, setBox] = useState<string | null>(null);
    const [moving, setMoving] = useState(false);
    const [error, setError] = useState<string>();
    const mountedRef = useSheetLifecycle(onClose);
    const pinned = new Set(state.journalPins?.map((candidate) => candidate.convo_id) ?? []);
    // Top-level, unarchived, not already pinned: the conversations a pin can sensibly point at.
    const eligible = state.conversations.filter(
        (conversation: Conversation) =>
            !conversation.parent_convo_id && !state.archivedIds.has(conversation.id) && !pinned.has(conversation.id),
    );
    const view = pinChooserView(eligible, state.agents, query, box);
    // The chosen box has no candidates left (pinned, archived or gone): drop it, so All stays in
    // force rather than the old box coming back if a conversation on it reappears.
    if (box !== null && view.box === null) setBox(null);
    const candidates = view.conversations;

    const move = async (toConvoId: string): Promise<void> => {
        if (moving) return;
        setMoving(true);
        setError(undefined);
        const failure = await client.movePin(convoId, toConvoId);
        if (!mountedRef.current) return;
        setMoving(false);
        if (failure) setError(failure);
        else onClose();
    };

    return (
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-labelledby="mj-pin-move-title">
            <div className="mj_UploadConfirm mj_NewSessionSheet mj_PinSheet">
                <SheetHead id="mj-pin-move-title" title="Move pin" onClose={onClose} />
                {pin && <p>Point “{pin.label}” at another conversation.</p>}
                <div>
                    <label htmlFor="mj-pin-move-search">Conversation</label>
                    <input
                        id="mj-pin-move-search"
                        type="text"
                        value={query}
                        autoFocus
                        autoComplete="off"
                        placeholder="Search"
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
                {candidates.length === 0 ? (
                    <p>No conversations to move the pin to.</p>
                ) : (
                    <div role="list" aria-label="Conversations" className="mj_PinSheet_list">
                        {candidates.map((conversation) => (
                            <button
                                key={conversation.id}
                                type="button"
                                role="listitem"
                                disabled={moving}
                                onClick={() => void move(conversation.id)}
                            >
                                {displayTitle(conversation)}
                            </button>
                        ))}
                    </div>
                )}
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
        </div>
    );
}
