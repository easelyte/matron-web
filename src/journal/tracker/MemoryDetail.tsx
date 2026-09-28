/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The memory editor — one form for an existing memory (name fixed, body/description/type editable,
 * delete behind a confirm) and for a new one (name editable). Validation mirrors the journal's
 * (kebab-case name ≤64, one-line description ≤200, body ≤8192 bytes) so a bad value is refused
 * with a reason before a request goes out. A save is PUT /memories/:name — the whole memory, so the
 * body is always sent back. Fetching + mutation live on the client.
 */

import React, { useState } from "react";

import type { MatronJournalClient } from "../client";
import { type Memory, type MemoryType, utf8Length } from "../types";
import { formatRelativeTime } from "./format";
import { memoryTypeLabel } from "./MemoriesList";

export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MEMORY_DESCRIPTION_MAX = 200;
export const MEMORY_BODY_MAX_BYTES = 8192;
const MEMORY_TYPES: MemoryType[] = ["feedback", "user", "project", "reference"];

/** The first validation failure for a memory form, or null when the fields are acceptable. */
export function memoryFormError(fields: { name: string; description: string; body: string }): string | null {
    if (!MEMORY_NAME_RE.test(fields.name)) {
        return "Name must be lowercase letters, digits and dashes (up to 64), starting with a letter or digit.";
    }
    const description = fields.description.trim();
    if (!description) return "Description is required.";
    if (description.length > MEMORY_DESCRIPTION_MAX) {
        return `Description must be at most ${MEMORY_DESCRIPTION_MAX} characters.`;
    }
    if (/[\r\n\u2028\u2029]/.test(description)) return "Description must be a single line.";
    if (utf8Length(fields.body) > MEMORY_BODY_MAX_BYTES) {
        return "Body must be at most 8 KB.";
    }
    return null;
}

export function MemoryDetail({
    memory,
    client,
    onBack,
}: {
    /** The memory being edited, or null for the new-memory form. */
    memory: Memory | null;
    client: MatronJournalClient;
    onBack: () => void;
}): React.ReactElement {
    const [name, setName] = useState(memory?.name ?? "");
    const [type, setType] = useState<MemoryType>(memory?.type ?? "feedback");
    const [description, setDescription] = useState(memory?.description ?? "");
    const [body, setBody] = useState(memory?.body ?? "");
    const [busy, setBusy] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isNew = memory === null;

    const save = async (): Promise<void> => {
        const problem = memoryFormError({ name, description, body });
        if (problem) {
            setError(problem);
            return;
        }
        // PUT is an upsert: a new-memory form must not silently replace a memory (an agent's, say)
        // that already has this name. Check the loaded list; the editor for it is one tap away.
        if (isNew && (client.getSnapshot().memories ?? []).some((existing) => existing.name === name)) {
            setError(`A memory named "${name}" already exists — open it from the list to change it.`);
            return;
        }
        setError(null);
        setBusy(true);
        const ok = await client.saveMemory(name, { description: description.trim(), body, type });
        setBusy(false);
        if (ok) {
            if (isNew) client.openTrackerMemory(name);
            else onBack();
        }
    };

    const remove = async (): Promise<void> => {
        if (!memory) return;
        setBusy(true);
        const ok = await client.deleteMemory(memory.name);
        setBusy(false);
        if (ok) onBack();
        else setConfirmingDelete(false);
    };

    return (
        <div className="mj_TrackerDetail mj_TrackerMemoryForm">
            <div className="mj_TrackerDetail_head">
                <button type="button" className="mj_TrackerTextButton" onClick={onBack}>
                    ‹ Memories
                </button>
            </div>
            <div className="mj_TrackerDetail_scroll">
                <header className="mj_TrackerSection">
                    <h2 className="mj_TrackerSection_header">{isNew ? "New memory" : memory.name}</h2>
                    {memory ? (
                        <p className="mj_TrackerCaption">
                            {memoryTypeLabel(memory.type)} · saved {formatRelativeTime(memory.created_at)} by{" "}
                            {memory.created_by === "user" ? "you" : "an agent"}, updated{" "}
                            {formatRelativeTime(memory.updated_at)} by{" "}
                            {memory.updated_by === "user" ? "you" : "an agent"}
                        </p>
                    ) : null}
                </header>

                <section className="mj_TrackerSection">
                    {isNew ? (
                        <label className="mj_TrackerMemoryForm_field">
                            <span className="mj_TrackerMemoryForm_label">Name</span>
                            <input
                                type="text"
                                className="mj_TrackerInput"
                                placeholder="avoid-eric-and-fatima"
                                value={name}
                                disabled={busy}
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </label>
                    ) : null}
                    <label className="mj_TrackerMemoryForm_field">
                        <span className="mj_TrackerMemoryForm_label">Type</span>
                        <select
                            className="mj_TrackerInput"
                            value={type}
                            disabled={busy}
                            onChange={(event) => setType(event.target.value as MemoryType)}
                        >
                            {MEMORY_TYPES.map((option) => (
                                <option key={option} value={option}>
                                    {memoryTypeLabel(option)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="mj_TrackerMemoryForm_field">
                        <span className="mj_TrackerMemoryForm_label">Description</span>
                        <input
                            type="text"
                            className="mj_TrackerInput"
                            placeholder="The rule, in one line — this is what the Coordinator reads"
                            value={description}
                            disabled={busy}
                            maxLength={MEMORY_DESCRIPTION_MAX}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </label>
                    <label className="mj_TrackerMemoryForm_field">
                        <span className="mj_TrackerMemoryForm_label">Notes</span>
                        <textarea
                            className="mj_TrackerTextarea"
                            placeholder="Why, and how to apply it (markdown)"
                            value={body}
                            disabled={busy}
                            onChange={(event) => setBody(event.target.value)}
                        />
                    </label>
                    {error ? (
                        <p className="mj_TrackerMemoryForm_error" role="alert">
                            {error}
                        </p>
                    ) : null}
                    <div className="mj_TrackerConfirm_actions">
                        <button
                            type="button"
                            className="mj_Btn mj_Btn_primary mj_TrackerButton"
                            disabled={busy}
                            onClick={() => void save()}
                        >
                            {busy ? "Saving…" : "Save"}
                        </button>
                    </div>
                </section>

                {memory ? (
                    <section className="mj_TrackerSection">
                        {confirmingDelete ? (
                            <div className="mj_TrackerConfirm">
                                <p className="mj_TrackerConfirm_title">Delete this memory?</p>
                                <div className="mj_TrackerConfirm_actions">
                                    <button
                                        type="button"
                                        className="mj_TrackerTextButton"
                                        disabled={busy}
                                        onClick={() => setConfirmingDelete(false)}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="mj_Btn mj_Btn_danger mj_TrackerButton mj_TrackerButton_danger"
                                        disabled={busy}
                                        onClick={() => void remove()}
                                    >
                                        {busy ? "Deleting…" : "Delete"}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="mj_TrackerTextButton mj_TrackerMemoryForm_delete"
                                disabled={busy}
                                onClick={() => setConfirmingDelete(true)}
                            >
                                Delete memory
                            </button>
                        )}
                    </section>
                ) : null}
            </div>
        </div>
    );
}
