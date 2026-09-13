/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Files pane — the operator-visible "consult files" surface (Matron File Explorer Phase 1b).
 * Two panes: left = breadcrumb + a VIRTUALIZED directory list (react-window; a repo directory is
 * thousands of entries); right = inline preview dispatched off the file's MIME + is_text.
 *
 * App-global state is minimal (ClientState.filesView = { open, path }); the current listing,
 * selection, and preview are pane-local, matching how the timeline is RoomView-local.
 *
 * Phase 2 adds writes (new folder / upload / rename / delete / edit), every one of them gated on
 * the server's `writable` flag for the CURRENT directory and funnelled through the single confirm
 * dialog in FileWriteDialog. When `writable` is false — writes disabled, dry-run, or a directory
 * outside MATRON_FILE_WRITE_ROOTS — not one write affordance is rendered, so the dormant default
 * deploy is byte-for-byte the Phase-1 read-only pane.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, type RowComponentProps } from "react-window";

import type { MatronJournalClient } from "../client";
import { ChevronRightIcon, CloseIcon, FileEditIcon, FileIcon, FolderIcon, TrashIcon, UploadTrayIcon } from "../icons";
import type { ClientState } from "../types";
import { FileWriteDialog } from "./FileWriteDialog";
import type { FileEntry, FileListing, FilesApiLike } from "./filesApi";
import { breadcrumb, humanizeMtime, humanizeSize, joinPath } from "./format";
import { INLINE_EDIT_MAX } from "./limits";
import { FilePreview } from "./preview/FilePreview";
import { PreviewStatus } from "./preview/PreviewChrome";
import { useAsyncResource } from "./preview/useAsyncResource";
import { useFileWrites } from "./useFileWrites";
import { isEditableText, type PendingWrite } from "./writeActions";

// The directory the pane opens at when it has no remembered path. The server must have this within
// MATRON_FILE_READ_ROOTS — it is the documented default read root.
const DEFAULT_FILES_PATH = "/root/.openclaw/workspace";
const ROW_HEIGHT = 40;

interface Selected {
    path: string;
    name: string;
    // Bumped on every click (even re-clicking the same file), so FilePreview remounts and re-reads
    // meta — an agent may have rewritten the file since it was last opened (F7).
    at: number;
}

interface RowData {
    entries: FileEntry[];
    // Selection is always within the current dir (cleared on any dir change), so a name compare
    // is unambiguous.
    selectedName?: string;
    /**
     * Server capability, NOT a local preference: true only when `GET /files/list` said this
     * directory is writable. False (or a Phase-1 server that omits the flag) renders no write
     * affordance at all, so the dormant/dry-run deploy is visually identical to the read-only pane.
     */
    writable: boolean;
    onOpenDir: (entry: FileEntry) => void;
    onSelectFile: (entry: FileEntry) => void;
    onRename: (entry: FileEntry) => void;
    onDelete: (entry: FileEntry) => void;
}

function FileRow({
    index,
    style,
    entries,
    selectedName,
    writable,
    onOpenDir,
    onSelectFile,
    onRename,
    onDelete,
}: RowComponentProps<RowData>): React.ReactElement {
    const entry = entries[index];
    const isDir = entry.kind === "dir";
    const selected = !isDir && entry.name === selectedName;
    return (
        // The row is a flex SHELL, not a bare button, so the write affordances can be real sibling
        // buttons (nesting a button inside the row button would be invalid + untappable). They are
        // always visible when writable rather than hover-revealed: the primary client is a phone,
        // where there is no hover state to reveal anything.
        <div style={style} className="mj_FilesRow_shell">
            <button
                type="button"
                className={`mj_FilesRow${isDir ? " mj_FilesRow_dir" : ""}${selected ? " mj_FilesRow_selected" : ""}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => (isDir ? onOpenDir(entry) : onSelectFile(entry))}
            >
                <span className="mj_FilesRow_icon">{isDir ? <FolderIcon /> : <FileIcon />}</span>
                <span className="mj_FilesRow_name">{entry.name}</span>
                {isDir ? (
                    <ChevronRightIcon className="mj_FilesRow_chevron" />
                ) : (
                    <>
                        <span className="mj_FilesRow_size">{humanizeSize(entry.size)}</span>
                        {/* The action buttons claim the width the mtime column used to hold, and a
                            truncated FILENAME is worse than a hidden timestamp (the mtime is still
                            on the preview's meta line). Dropped only in the writable layout. */}
                        {writable ? null : <span className="mj_FilesRow_mtime">{humanizeMtime(entry.mtime)}</span>}
                    </>
                )}
            </button>
            {writable ? (
                <span className="mj_FilesRow_actions">
                    <button
                        type="button"
                        className="mj_FilesRow_action"
                        aria-label={`Rename ${entry.name}`}
                        title="Rename"
                        onClick={() => onRename(entry)}
                    >
                        <FileEditIcon />
                    </button>
                    <button
                        type="button"
                        className="mj_FilesRow_action mj_FilesRow_action_danger"
                        aria-label={`Delete ${entry.name}`}
                        title="Delete"
                        onClick={() => onDelete(entry)}
                    >
                        <TrashIcon />
                    </button>
                </span>
            ) : null}
        </div>
    );
}

/** Identity of a pending write, used to remount the dialog when the target changes. */
function pendingKey(pending: PendingWrite): string {
    switch (pending.kind) {
        case "mkdir":
            return `mkdir:${pending.dir}`;
        case "rename":
            return `rename:${pending.path}`;
        case "delete":
            return `delete:${pending.path}`;
        case "edit":
            return `edit:${pending.path}`;
        case "upload":
            return `upload:${pending.dir}:${pending.index}`;
    }
}

export function FilesPane({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const api = useMemo<FilesApiLike | undefined>(() => client.filesApi(), [client]);
    const [dir, setDir] = useState(() => state.filesView?.path ?? DEFAULT_FILES_PATH);
    const [selected, setSelected] = useState<Selected | undefined>(undefined);
    const [showHidden, setShowHidden] = useState(false);

    const listing = useAsyncResource<FileListing>(
        (signal) => (api ? api.listDir(dir, showHidden, signal) : Promise.reject(new Error("Not signed in."))),
        `list:${dir}:${showHidden ? 1 : 0}`,
    );

    // Keep app-global filesView.path in sync with the server-normalized path so a reopen returns
    // here. Runs only after a successful listing (never persists a path the server rejected).
    useEffect(() => {
        if (listing.status === "loaded" && listing.data) client.setFilesPath(listing.data.path);
    }, [client, listing.status, listing.data]);

    const openDir = useCallback((entry: FileEntry) => {
        setSelected(undefined);
        setDir((current) => joinPath(current, entry.name));
    }, []);
    const selectFile = useCallback(
        (entry: FileEntry) => setSelected({ path: joinPath(dir, entry.name), name: entry.name, at: Date.now() }),
        [dir],
    );

    // ── Writes (Phase 2) ──────────────────────────────────────────────────────────────────────
    // `writable` is whatever the SERVER said for THIS directory. Writes off, dry-run, or a dir
    // outside the write-roots ⇒ false ⇒ nothing below renders. The client never infers it.
    const writable = listing.data?.writable === true;
    const listingPath = listing.data?.path ?? dir;
    const reload = listing.reload;
    // A write can remove or rename the previewed file, so the selection is dropped on every
    // successful mutation and the listing is re-read from the server (no optimistic row patching).
    const onWritten = useCallback(() => {
        setSelected(undefined);
        reload();
    }, [reload]);
    const writes = useFileWrites(api, onWritten);
    const { begin } = writes;
    const fileInput = useRef<HTMLInputElement>(null);

    const onRename = useCallback(
        (entry: FileEntry) =>
            begin({
                kind: "rename",
                dir: listingPath,
                path: joinPath(listingPath, entry.name),
                name: entry.name,
                isDir: entry.kind === "dir",
            }),
        [begin, listingPath],
    );
    const onDelete = useCallback(
        (entry: FileEntry) =>
            begin({
                kind: "delete",
                path: joinPath(listingPath, entry.name),
                name: entry.name,
                isDir: entry.kind === "dir",
            }),
        [begin, listingPath],
    );
    const onPickFiles = useCallback(
        (files: FileList | null) => {
            const picked = files ? [...files] : [];
            if (picked.length > 0) begin({ kind: "upload", dir: listingPath, files: picked, index: 0 });
        },
        [begin, listingPath],
    );

    const selectedEntry = useMemo(
        () => listing.data?.entries.find((entry) => entry.name === selected?.name),
        [listing.data?.entries, selected?.name],
    );
    const canEditSelected = writable && selectedEntry !== undefined && isEditableText(selectedEntry, INLINE_EDIT_MAX);

    // Breadcrumb spans root → path ONLY (never above the read-root jail, F4). Falls back to the
    // path as its own root before the first listing loads (single crumb, nothing above).
    const crumbs = useMemo(
        () => breadcrumb(listing.data?.root ?? listing.data?.path ?? dir, listing.data?.path ?? dir),
        [listing.data?.root, listing.data?.path, dir],
    );
    const rowData = useMemo<RowData>(
        () => ({
            entries: listing.data?.entries ?? [],
            selectedName: selected?.name,
            writable,
            onOpenDir: openDir,
            onSelectFile: selectFile,
            onRename,
            onDelete,
        }),
        [listing.data?.entries, selected?.name, writable, openDir, selectFile, onRename, onDelete],
    );

    return (
        <div className="mj_FilesPane">
            <div className="mj_FilesPane_top">
                <button
                    type="button"
                    className="mj_IconButton mj_FilesPane_close"
                    aria-label="Close files"
                    onClick={() => client.closeFilesView()}
                >
                    <CloseIcon />
                </button>
                <h1 className="mj_FilesPane_title">Files</h1>
                <label className="mj_FilesPane_hidden">
                    <input
                        type="checkbox"
                        checked={showHidden}
                        onChange={(event) => setShowHidden(event.target.checked)}
                    />
                    Show hidden
                </label>
            </div>

            <div className="mj_FilesPane_body">
                <div className="mj_FilesPane_nav">
                    <nav className="mj_FilesBreadcrumb" aria-label="Path">
                        {crumbs.map((crumb, index) => (
                            <React.Fragment key={crumb.path}>
                                {index > 0 ? <span className="mj_FilesBreadcrumb_sep">/</span> : null}
                                <button
                                    type="button"
                                    className="mj_FilesBreadcrumb_seg"
                                    disabled={crumb.path === (listing.data?.path ?? dir)}
                                    onClick={() => {
                                        setSelected(undefined);
                                        setDir(crumb.path);
                                    }}
                                >
                                    {crumb.label}
                                </button>
                            </React.Fragment>
                        ))}
                    </nav>

                    {/* Write toolbar — mounted ONLY when the server reported this directory
                        writable. With writes disabled (or in dry-run) the pane below is the
                        unchanged Phase-1 read-only browser, down to the DOM. */}
                    {writable ? (
                        <div className="mj_FilesToolbar">
                            <button
                                type="button"
                                className="mj_FilesToolbar_button"
                                onClick={() => writes.begin({ kind: "mkdir", dir: listingPath })}
                            >
                                <FolderIcon />
                                <span>New folder</span>
                            </button>
                            <button
                                type="button"
                                className="mj_FilesToolbar_button"
                                onClick={() => fileInput.current?.click()}
                            >
                                <UploadTrayIcon />
                                <span>Upload</span>
                            </button>
                            <input
                                ref={fileInput}
                                className="mj_FilesToolbar_file"
                                type="file"
                                multiple
                                aria-hidden="true"
                                tabIndex={-1}
                                onChange={(event) => {
                                    onPickFiles(event.target.files);
                                    // Reset so re-picking the SAME file still fires a change event.
                                    event.target.value = "";
                                }}
                            />
                        </div>
                    ) : null}

                    <div className="mj_FilesPane_list">
                        {listing.status === "loading" ? (
                            <PreviewStatus variant="loading">Loading…</PreviewStatus>
                        ) : listing.status === "error" ? (
                            <PreviewStatus variant="error" onRetry={listing.reload}>
                                {listing.error}
                            </PreviewStatus>
                        ) : rowData.entries.length === 0 ? (
                            <PreviewStatus variant="empty">This folder is empty.</PreviewStatus>
                        ) : (
                            <List
                                className="mj_FilesList"
                                rowComponent={FileRow}
                                rowCount={rowData.entries.length}
                                rowHeight={ROW_HEIGHT}
                                rowProps={rowData}
                            />
                        )}
                    </div>

                    {listing.data?.truncated ? (
                        <p className="mj_FilesPane_truncated">Showing the first entries — this folder is large.</p>
                    ) : null}

                    {/* Outcome of the last write (trash destination, already-gone, dry-run). Stays
                        until dismissed or the next write starts — a delete's recovery path is the
                        one thing worth being able to read twice. */}
                    {writes.notice ? (
                        <p className="mj_FilesPane_notice" role="status">
                            <span>{writes.notice}</span>
                            <button
                                type="button"
                                className="mj_FilesPane_noticeClose"
                                aria-label="Dismiss"
                                onClick={writes.dismissNotice}
                            >
                                <CloseIcon />
                            </button>
                        </p>
                    ) : null}
                </div>

                <div className="mj_FilesPane_preview">
                    {canEditSelected && selected ? (
                        <div className="mj_FilesPreview_bar">
                            <button
                                type="button"
                                className="mj_FilesPreview_edit"
                                onClick={() => writes.begin({ kind: "edit", path: selected.path, name: selected.name })}
                            >
                                <FileEditIcon />
                                <span>Edit</span>
                            </button>
                        </div>
                    ) : null}
                    {selected && api ? (
                        <FilePreview
                            key={`${selected.path}:${selected.at}`}
                            api={api}
                            path={selected.path}
                            filename={selected.name}
                        />
                    ) : (
                        <PreviewStatus variant="empty">Select a file to preview it.</PreviewStatus>
                    )}
                </div>
            </div>

            {writes.state ? (
                <FileWriteDialog
                    // Keyed by the pending TARGET, so opening a second rename (or the next queued
                    // upload) remounts with a fresh name field instead of inheriting the last one.
                    key={pendingKey(writes.state.pending)}
                    state={writes.state}
                    api={api}
                    onSubmit={writes.submit}
                    onCancel={writes.cancel}
                />
            ) : null}
        </div>
    );
}
