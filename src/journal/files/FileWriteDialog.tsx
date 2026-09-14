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
    isUnresolved,
    nameIsSubmittable,
    recoveryNote,
    titleFor,
    uploadHead,
    type PendingWrite,
    type WriteInput,
    type WriteState,
} from "./writeActions";

// WriteInput lives in the pure machine now (the machine has to be able to HOLD one — see
// WriteState.replay). Re-exported here so the dialog stays its documented home for callers.
export type { WriteInput };

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
    const scrim = useRef<HTMLDivElement>(null);

    // An attempt whose outcome is unknown pins its payload (writeActions.WriteState.replay): the
    // retry must be a byte-for-byte replay, so the fields show what WILL be sent and refuse edits.
    // Cancel is the way out, and it re-reads the directory first.
    const bound = state.replay;
    const locked = busy || bound !== undefined;
    const nameValue = bound?.name ?? name;
    const draftValue = bound !== undefined ? (bound.content ?? draft) : draft;

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
            if (focusable.length === 0) {
                // Mid-request EVERY control is disabled, so there is nothing inside the card to
                // cycle. Returning here would hand Tab back to the browser and let focus walk out
                // to the app behind the scrim — where activating a room closes the files view and
                // unmounts this dialog while the request is still on the wire, discarding its
                // outcome, the refresh and the trash location. Hold focus on the card instead.
                event.preventDefault();
                card.current.focus();
                return;
            }
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
            (card.current.querySelector<HTMLElement>("button:not([disabled])") ?? card.current).focus();
        }
        // Mount only — later focus moves belong to the operator.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Disabling the control that HAS focus blurs it to <body>, which puts focus outside the modal
    // for the whole of a slow request. Catch it on the transition into `mutating` and park focus on
    // the card, so the trap above has an anchor and a screen reader is not dumped back to the app.
    useEffect(() => {
        if (!busy || !card.current) return;
        if (!card.current.contains(document.activeElement)) card.current.focus();
    }, [busy]);

    // `aria-modal` is a CLAIM; this is what makes it true. The pane marks its own sections inert,
    // but the pane is not the whole app — the conversation sidebar is its SIBLING, and reaching a
    // room from there closes the files view out from under an in-flight write. Walk the ancestor
    // chain and inert everything that is not on the path to this dialog. Anything already inert
    // (the app's own upload modal does the same thing) is left alone, and therefore left set.
    useEffect(() => {
        const node = scrim.current;
        if (!node) return;
        const marked: HTMLElement[] = [];
        for (let step: HTMLElement | null = node; step && step !== document.body; step = step.parentElement) {
            for (const sibling of step.parentElement?.children ?? []) {
                if (sibling === step || !(sibling instanceof HTMLElement)) continue;
                if (sibling.hasAttribute("inert")) continue;
                sibling.setAttribute("inert", "");
                marked.push(sibling);
            }
        }
        return () => {
            for (const element of marked) element.removeAttribute("inert");
        };
        // Mount/unmount only: the dialog is keyed by its target, so a new target remounts it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const destructive = isDestructive(pending);
    const note = recoveryNote(pending);
    const preflight =
        head && head.size === 0 ? "That file is empty." : head && !nameValue.trim() ? "Enter a file name." : undefined;
    const canConfirm = ((): boolean => {
        if (busy) return false;
        switch (pending.kind) {
            case "mkdir":
            case "rename":
            case "upload":
                return !preflight && nameIsSubmittable(pending, nameValue);
            case "edit":
                return draftValue !== undefined && draftValue.length <= INLINE_EDIT_MAX;
            case "delete":
                return true;
        }
    })();

    const submit = (): void => {
        if (!canConfirm) return;
        // A bound retry re-sends the pinned payload verbatim. The hook enforces this too; sending
        // it from here as well keeps what the dialog SHOWS and what goes on the wire the same thing.
        if (bound) return onSubmit(bound);
        onSubmit(pending.kind === "edit" ? { content: draft, baseline } : { name });
    };

    return (
        <div
            ref={scrim}
            className="mj_UploadConfirm_scrim"
            role="dialog"
            aria-modal="true"
            aria-label={titleFor(pending)}
            onMouseDown={(event) => {
                // Backdrop click dismisses under the same rule as Escape.
                if (event.target === event.currentTarget && canDismiss(state)) onCancel();
            }}
        >
            {/* tabIndex -1 so the card itself can hold focus when every control inside it is
                disabled — without it there is nothing in the modal to focus mid-request. */}
            <div className="mj_UploadConfirm mj_UploadConfirm_queue mj_FileWrite" ref={card} tabIndex={-1}>
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
                            value={nameValue}
                            onChange={setName}
                            disabled={locked}
                            label="Folder name"
                        />
                    ) : null}
                    {pending.kind === "rename" ? (
                        <NameField
                            pending={pending}
                            value={nameValue}
                            onChange={setName}
                            disabled={locked}
                            label={pending.isDir ? "Folder name" : "File name"}
                        />
                    ) : null}
                    {pending.kind === "upload" && head ? (
                        <UploadBody pending={pending} file={head} name={nameValue} onName={setName} disabled={locked} />
                    ) : null}
                    {pending.kind === "edit" ? (
                        <EditBody
                            api={api}
                            path={pending.path}
                            draft={draftValue}
                            onDraft={setDraft}
                            onLoaded={setBaseline}
                            disabled={locked}
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
                    {isUnresolved(state) ? (
                        <p className="mj_FileWrite_bound">
                            It may already have gone through, so trying again re-sends exactly the same request instead
                            of making a second one. To change anything, cancel and start again — the folder is re-read
                            first. If a replay stops being safe, this closes and re-reads it for you.
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
