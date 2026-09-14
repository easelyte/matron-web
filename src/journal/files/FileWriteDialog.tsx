/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The one modal every Files-pane write passes through (Phase 2, T-3.2). It reuses the shipped
 * upload-confirm shell (`mj_UploadConfirm*` — scrim, card, header, footer) so a write confirm is
 * visually the same object the operator already knows from sending an attachment, and so the app's
 * Escape ladder (which defers to `.mj_UploadConfirm_scrim`) keeps working unchanged.
 *
 * It is deliberately NOT wired to `client.stagedUploads`: that queue is conversation-bound
 * (`convoId` + confirmStagedFile posts the file INTO the chat as an attachment). A Files-pane
 * upload writes to a directory on disk and posts nothing, so it reuses the SHAPE, not the pipeline.
 *
 * Every phase rule lives in writeActions.writeReducer; this component only renders the phase and
 * collects the operator's input (new name / edited text).
 */

import React, { useEffect, useRef, useState } from "react";

import { CloseIcon, FileIcon, FolderIcon, TrashIcon, UploadTrayIcon } from "../icons";
import { readEditableText, type EditableText, type FilesApiLike } from "./filesApi";
import { humanizeSize } from "./format";
import { INLINE_EDIT_MAX } from "./limits";
import { PreviewStatus } from "./preview/PreviewChrome";
import { useAsyncResource } from "./preview/useAsyncResource";
import {
    canDismiss,
    confirmLabelFor,
    destinationFor,
    isDestructive,
    nameIsSubmittable,
    recoveryNote,
    titleFor,
    uploadHead,
    type PendingWrite,
    type WriteState,
} from "./writeActions";

export interface WriteInput {
    name?: string;
    content?: string;
    /**
     * For an edit: the bytes the editor was seeded with. The hook re-reads the file immediately
     * before saving and refuses if it no longer matches, so a draft that went stale while the
     * dialog sat open cannot silently replace newer content.
     */
    baseline?: string;
}

function HeaderIcon({ pending }: { pending: PendingWrite }): React.ReactElement {
    const className = "mj_UploadConfirm_uploadIcon";
    if (pending.kind === "delete") return <TrashIcon className={className} aria-hidden />;
    if (pending.kind === "upload") return <UploadTrayIcon className={className} aria-hidden />;
    if (pending.kind === "mkdir") return <FolderIcon className={className} aria-hidden />;
    return <FileIcon className={className} aria-hidden />;
}

/** Name-taking writes: new folder, rename, upload-as. */
function NameField({
    pending,
    value,
    onChange,
    disabled,
    label,
}: {
    pending: PendingWrite;
    value: string;
    onChange: (next: string) => void;
    disabled: boolean;
    label: string;
}): React.ReactElement {
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, []);
    const destination = destinationFor(pending, value);
    return (
        <label className="mj_FileWrite_field">
            <span className="mj_FileWrite_label">{label}</span>
            <input
                ref={input}
                className="mj_FileWrite_input"
                type="text"
                value={value}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => onChange(event.target.value)}
            />
            {/* The resolved absolute destination, so "where does this land" is never a guess. */}
            <span className="mj_FileWrite_dest" title={destination ?? undefined}>
                {destination ?? "Enter a name."}
            </span>
        </label>
    );
}

function UploadBody({
    pending,
    file,
    name,
    onName,
    disabled,
}: {
    pending: PendingWrite;
    file: File;
    name: string;
    onName: (next: string) => void;
    disabled: boolean;
}): React.ReactElement {
    return (
        <>
            <div className="mj_UploadConfirm_fileMeta mj_FileWrite_fileMeta">
                <FileIcon className="mj_UploadConfirm_fileIcon" aria-hidden />
                <span className="mj_UploadConfirm_fileName">{file.name}</span>
                <span className="mj_FileSize">{humanizeSize(file.size)}</span>
            </div>
            <NameField pending={pending} value={name} onChange={onName} disabled={disabled} label="Save as" />
        </>
    );
}

function EditBody({
    api,
    path,
    draft,
    onDraft,
    onLoaded,
    disabled,
}: {
    api: FilesApiLike | undefined;
    path: string;
    draft: string | undefined;
    onDraft: (next: string) => void;
    onLoaded: (content: string) => void;
    disabled: boolean;
}): React.ReactElement {
    // Load the CURRENT bytes at open time — the operator edits what is on disk right now, not a
    // stale preview. A failed read keeps the dialog in a refusing state (no empty-string save).
    const content = useAsyncResource<EditableText>(
        (signal) => (api ? readEditableText(api, path, signal) : Promise.reject(new Error("Not signed in."))),
        `edit:${path}`,
    );
    const loaded = content.data?.ok ? content.data.text : undefined;
    useEffect(() => {
        // Not valid UTF-8 → seed nothing, so `draft` stays undefined and Save stays genuinely
        // disabled; the refusal below is not merely cosmetic.
        if (content.status !== "loaded" || loaded === undefined) return;
        onLoaded(loaded);
        if (draft === undefined) onDraft(loaded);
        // Seeds the draft exactly once per load; later keystrokes own it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [content.status, loaded]);

    if (content.status === "loading") return <PreviewStatus variant="loading">Loading…</PreviewStatus>;
    if (content.status === "error") {
        return (
            <PreviewStatus variant="error" onRetry={content.reload}>
                {content.error}
            </PreviewStatus>
        );
    }
    // Strict decode said these bytes are not UTF-8 text. Editing them would write replacement
    // characters back over the original bytes, so refuse instead of offering a corrupting Save.
    if (content.data && !content.data.ok) {
        return (
            <PreviewStatus variant="error">
                This file isn&apos;t valid UTF-8 text, so it can&apos;t be edited here without corrupting it.
            </PreviewStatus>
        );
    }
    const value = draft ?? loaded ?? "";
    const tooLong = value.length > INLINE_EDIT_MAX;
    return (
        <label className="mj_FileWrite_field">
            <span className="mj_FileWrite_label">Contents</span>
            <textarea
                className="mj_FileWrite_textarea"
                value={value}
                disabled={disabled}
                spellCheck={false}
                onChange={(event) => onDraft(event.target.value)}
            />
            <span className={tooLong ? "mj_FileWrite_dest mj_FileWrite_dest_bad" : "mj_FileWrite_dest"}>
                {tooLong
                    ? `Too long to edit here — ${value.length.toLocaleString()} of ${INLINE_EDIT_MAX.toLocaleString()} characters.`
                    : `${value.length.toLocaleString()} characters`}
            </span>
        </label>
    );
}

export function FileWriteDialog({
    state,
    api,
    onSubmit,
    onCancel,
}: {
    state: WriteState;
    api: FilesApiLike | undefined;
    onSubmit: (input: WriteInput) => void;
    onCancel: () => void;
}): React.ReactElement {
    const { pending, phase, error } = state;
    const busy = phase === "mutating";
    const head = uploadHead(pending);
    const [name, setName] = useState(() => {
        if (pending.kind === "rename") return pending.name;
        if (pending.kind === "upload") return uploadHead(pending)?.name ?? "";
        return "";
    });
    const [draft, setDraft] = useState<string | undefined>(undefined);
    // The exact bytes the editor opened with (see WriteInput.baseline).
    const [baseline, setBaseline] = useState<string | undefined>(undefined);

    const card = useRef<HTMLDivElement>(null);

    // Escape closes — but only while the operator still owns the decision (canDismiss). A request
    // already on the wire is not cancellable, and the modal must not lie about that.
    //
    // Tab is TRAPPED inside the card for the same reason `aria-modal` is set: focus must not walk
    // out to the app behind the scrim, where activating something could unmount this dialog (and
    // the pane) while a destructive request is still in flight.
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.defaultPrevented) return;
            if (event.key === "Escape") {
                if (!canDismiss(state)) return;
                event.preventDefault();
                onCancel();
                return;
            }
            if (event.key !== "Tab" || !card.current) return;
            const focusable = [
                ...card.current.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
                ),
            ];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement as HTMLElement | null;
            const outside = !active || !card.current.contains(active);
            if (outside) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [state, onCancel]);

    // Pull focus in on mount for the dialogs with no text field of their own (delete), so the trap
    // has something inside the card to cycle and a screen reader lands on the dialog.
    useEffect(() => {
        if (card.current && !card.current.contains(document.activeElement)) {
            card.current.querySelector<HTMLElement>("button:not([disabled])")?.focus();
        }
        // Mount only — later focus moves belong to the operator.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const destructive = isDestructive(pending);
    const note = recoveryNote(pending);
    const preflight =
        head && head.size === 0 ? "That file is empty." : head && !name.trim() ? "Enter a file name." : undefined;
    const canConfirm = ((): boolean => {
        if (busy) return false;
        switch (pending.kind) {
            case "mkdir":
            case "rename":
            case "upload":
                return !preflight && nameIsSubmittable(pending, name);
            case "edit":
                return draft !== undefined && draft.length <= INLINE_EDIT_MAX;
            case "delete":
                return true;
        }
    })();

    const submit = (): void => {
        if (!canConfirm) return;
        onSubmit(pending.kind === "edit" ? { content: draft, baseline } : { name });
    };

    return (
        <div
            className="mj_UploadConfirm_scrim"
            role="dialog"
            aria-modal="true"
            aria-label={titleFor(pending)}
            onMouseDown={(event) => {
                // Backdrop click dismisses under the same rule as Escape.
                if (event.target === event.currentTarget && canDismiss(state)) onCancel();
            }}
        >
            <div className="mj_UploadConfirm mj_UploadConfirm_queue mj_FileWrite" ref={card}>
                <header className="mj_UploadConfirm_header">
                    <HeaderIcon pending={pending} />
                    <h2 className="mj_UploadConfirm_title">{titleFor(pending)}</h2>
                    {pending.kind === "upload" && pending.files.length > 1 ? (
                        <span className="mj_UploadConfirm_count">
                            {pending.index + 1} of {pending.files.length}
                        </span>
                    ) : null}
                    <span className="mj_UploadConfirm_headerSpacer" />
                    <button
                        type="button"
                        className="mj_UploadConfirm_close"
                        aria-label="Cancel"
                        disabled={busy}
                        onClick={onCancel}
                    >
                        <CloseIcon />
                    </button>
                </header>

                <div className="mj_UploadConfirm_body mj_FileWrite_body">
                    {pending.kind === "mkdir" ? (
                        <NameField
                            pending={pending}
                            value={name}
                            onChange={setName}
                            disabled={busy}
                            label="Folder name"
                        />
                    ) : null}
                    {pending.kind === "rename" ? (
                        <NameField
                            pending={pending}
                            value={name}
                            onChange={setName}
                            disabled={busy}
                            label={pending.isDir ? "Folder name" : "File name"}
                        />
                    ) : null}
                    {pending.kind === "upload" && head ? (
                        <UploadBody pending={pending} file={head} name={name} onName={setName} disabled={busy} />
                    ) : null}
                    {pending.kind === "edit" ? (
                        <EditBody
                            api={api}
                            path={pending.path}
                            draft={draft}
                            onDraft={setDraft}
                            onLoaded={setBaseline}
                            disabled={busy}
                        />
                    ) : null}
                    {pending.kind === "delete" ? (
                        <p className="mj_FileWrite_target">
                            <span className="mj_FileWrite_targetName">{pending.name}</span>
                            <span className="mj_FileWrite_targetPath">{pending.path}</span>
                        </p>
                    ) : null}

                    {note ? <p className="mj_FileWrite_note">{note}</p> : null}
                    {preflight ? (
                        <p className="mj_UploadConfirm_error" role="alert">
                            {preflight}
                        </p>
                    ) : null}
                    {error ? (
                        <p className="mj_UploadConfirm_error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </div>

                <div className="mj_UploadConfirm_footer mj_UploadConfirm_actions mj_FileWrite_actions">
                    <button type="button" className="mj_UploadConfirm_skip" disabled={busy} onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={
                            destructive
                                ? "mj_UploadConfirm_send mj_FileWrite_danger"
                                : "mj_UploadConfirm_send mj_FileWrite_confirm"
                        }
                        disabled={!canConfirm}
                        onClick={submit}
                    >
                        {busy ? "Working…" : confirmLabelFor(pending)}
                    </button>
                </div>
            </div>
        </div>
    );
}
