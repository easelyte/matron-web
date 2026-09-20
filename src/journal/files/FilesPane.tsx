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
    // Deep-link freshness nonce (see the auto-preview effect). Folded into the listing key so a deep
    // link ALWAYS re-runs listDir for the target directory before we select — even when the pane is
    // already browsing that directory with a stale listing (an agent may have just created the file).
    const [deepLinkNonce, setDeepLinkNonce] = useState<number | undefined>(undefined);

    const listingKey = `list:${dir}:${showHidden ? 1 : 0}:${deepLinkNonce ?? ""}`;
    const listing = useAsyncResource<FileListing>(
        (signal) => (api ? api.listDir(dir, showHidden, signal) : Promise.reject(new Error("Not signed in."))),
        listingKey,
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

    // ── Files deep link (#files=<abs>) auto-preview ─────────────────────────────────────────────
    // A bridge doc-handoff link opens the pane with filesView.targetFile = the absolute file path
    // and a per-invocation targetToken. Steps, fire-once per TOKEN (not per path, so re-clicking the
    // same link after browsing away is a fresh invocation, not a dedup no-op):
    //   1. Browse to the target's directory (setDir), and
    //   2. Force a FRESH listing for it by setting deepLinkNonce = the token — that nonce is part of
    //      the listing key, so the resource re-runs listDir even when we were already in that
    //      directory (the file may have just been created; a stale in-memory listing would miss it).
    //   3. Once dir === targetDir AND the listing keyed with THIS token's nonce has loaded, select
    //      the matching entry. We correlate by (dir, nonce) — the request identity — NOT by
    //      comparing listing.data.path to a lexically-derived directory string, because the server
    //      returns realpath-canonical paths that can differ from the requested path (symlinks,
    //      `..`), which would otherwise wedge a valid link forever. Re-keying flips the resource to
    //      "loading" before this effect observes it (the listing hook runs before this one), so a
    //      stale prior listing is never consumed — no wrong-file-edit hazard.
    const targetFile = state.filesView?.targetFile;
    const targetToken = state.filesView?.targetToken;
    const targetDir = useMemo(
        () => (targetFile ? targetFile.slice(0, Math.max(1, targetFile.lastIndexOf("/"))) : undefined),
        [targetFile],
    );
    const targetName = useMemo(
        () => (targetFile ? targetFile.slice(targetFile.lastIndexOf("/") + 1) : undefined),
        [targetFile],
    );
    const deepLinkTokenRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        if (!targetFile || !targetDir || targetToken === undefined) return;
        if (deepLinkTokenRef.current === targetToken) return; // already handled this invocation
        // Steps 1-2: get to the target dir AND request a fresh listing keyed to this token.
        if (dir !== targetDir || deepLinkNonce !== targetToken) {
            setSelected(undefined);
            if (dir !== targetDir) setDir(targetDir);
            if (deepLinkNonce !== targetToken) setDeepLinkNonce(targetToken);
            return;
        }
        // Step 3: consume ONLY the listing produced by the CURRENT request key. After Step 2 re-keys
        // the resource, useAsyncResource schedules its "loading" transition in a passive effect, so
        // for one commit `listing` still holds the PRIOR key's loaded payload — consuming it here
        // would select a stale (possibly different-directory) entry. Gating on
        // `listing.key === listingKey` waits for the fresh response tied to this exact request.
        if (listing.status !== "loaded" || !listing.data || listing.key !== listingKey) return;
        deepLinkTokenRef.current = targetToken; // handled (found or not) — do not retry this token
        const entry = listing.data.entries.find((candidate) => candidate.name === targetName && candidate.kind !== "dir");
        if (entry) setSelected({ path: joinPath(listing.data.path, entry.name), name: entry.name, at: Date.now() });
    }, [targetFile, targetToken, targetDir, targetName, dir, deepLinkNonce, listingKey, listing.status, listing.data, listing.key]);

    // ── Writes (Phase 2) ──────────────────────────────────────────────────────────────────────
    // `writable` is whatever the SERVER said for THIS directory. Writes off, dry-run, or a dir
    // outside the write-roots ⇒ false ⇒ nothing below renders. The client never infers it.
    const writable = listing.data?.writable === true;
    const listingPath = listing.data?.path ?? dir;
    const reload = listing.reload;
    // A write can remove or rename the previewed file, so the selection is dropped on every
    // successful mutation and the listing is re-read from the server (no optimistic row patching).
    //
    // This re-read is also the RECONCILIATION BARRIER after an unresolved write (a delete whose
    // outcome is unknown, or an uncertain write the operator backed out of). It holds because
    // `writable` above is DERIVED from the current listing rather than cached: reloading clears
    // `listing.data`, so `writable` goes false and every write affordance — toolbar, row actions,
    // the preview's Edit — unmounts until a fresh listing lands. No new write can be started
    // against the stale directory state the operator was just told to go and check. If the re-read
    // FAILS the affordances stay down and the pane shows its error + Retry, which is the safe way
    // round. Covered by "no write can be started while the reconciling listing is still in flight".
    const onWritten = useCallback(() => {
        setSelected(undefined);
        reload();
    }, [reload]);
    // The same barrier, handed to the hook: a suspended upload queue may only be re-offered once a
    // fresh listing has landed for THIS directory and it is still writable. `writable` is already
    // false while the reconciling re-read is in flight, and stays false if it fails or comes back
    // without the capability, so the queue is released by exactly the condition that restores every
    // other write affordance.
    // The listing's status goes through UNCOLLAPSED. A parked upload queue treats loading, error
    // and loaded-but-read-only as three different things (wait, wait-with-a-retry, and over), and
    // flattening any two of them either strands the queue or throws it away. A reload puts the
    // resource back into `loading`, which is exactly the window the barrier exists to cover.
    const directory = useMemo(
        () => ({ status: listing.status, writable, path: listingPath }),
        [listing.status, writable, listingPath],
    );
    const writes = useFileWrites(api, onWritten, directory);
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
            {/* While a write dialog is up the rest of the pane is INERT (the same treatment the
                app gives its own upload modal). Without it, `aria-modal` is a lie: a keyboard or
                assistive-tech user could reach "Close files" behind the scrim and unmount the pane
                mid-delete, throwing away the outcome, the refresh, and the trash path. */}
            <div className="mj_FilesPane_top" inert={writes.state ? true : undefined}>
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

            <div className="mj_FilesPane_body" inert={writes.state ? true : undefined}>
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
