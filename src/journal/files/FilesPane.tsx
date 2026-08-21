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
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { List, type RowComponentProps } from "react-window";

import type { MatronJournalClient } from "../client";
import { ChevronRightIcon, CloseIcon, FileIcon, FolderIcon } from "../icons";
import type { ClientState } from "../types";
import type { FileEntry, FileListing, FilesApiLike } from "./filesApi";
import { breadcrumb, humanizeMtime, humanizeSize, joinPath } from "./format";
import { FilePreview } from "./preview/FilePreview";
import { PreviewStatus } from "./preview/PreviewChrome";
import { useAsyncResource } from "./preview/useAsyncResource";

// The directory the pane opens at when it has no remembered path. The server must have this within
// MATRON_FILE_READ_ROOTS — it is the documented default read root.
const DEFAULT_FILES_PATH = "/root/.openclaw/workspace";
const ROW_HEIGHT = 40;

interface Selected {
    path: string;
    name: string;
}

interface RowData {
    entries: FileEntry[];
    // Selection is always within the current dir (cleared on any dir change), so a name compare
    // is unambiguous.
    selectedName?: string;
    onOpenDir: (entry: FileEntry) => void;
    onSelectFile: (entry: FileEntry) => void;
}

function FileRow({
    index,
    style,
    entries,
    selectedName,
    onOpenDir,
    onSelectFile,
}: RowComponentProps<RowData>): React.ReactElement {
    const entry = entries[index];
    const isDir = entry.kind === "dir";
    const selected = !isDir && entry.name === selectedName;
    return (
        <button
            type="button"
            style={style}
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
                    <span className="mj_FilesRow_mtime">{humanizeMtime(entry.mtime)}</span>
                </>
            )}
        </button>
    );
}

export function FilesPane({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const api = useMemo<FilesApiLike | undefined>(() => client.filesApi(), [client]);
    const [dir, setDir] = useState(() => state.filesView?.path ?? DEFAULT_FILES_PATH);
    const [selected, setSelected] = useState<Selected | undefined>(undefined);
    const [showHidden, setShowHidden] = useState(false);

    const listing = useAsyncResource<FileListing>(
        () => (api ? api.listDir(dir, showHidden) : Promise.reject(new Error("Not signed in."))),
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
        (entry: FileEntry) => setSelected({ path: joinPath(dir, entry.name), name: entry.name }),
        [dir],
    );

    const crumbs = useMemo(() => breadcrumb(listing.data?.path ?? dir), [listing.data?.path, dir]);
    const rowData = useMemo<RowData>(
        () => ({
            entries: listing.data?.entries ?? [],
            selectedName: selected?.name,
            onOpenDir: openDir,
            onSelectFile: selectFile,
        }),
        [listing.data?.entries, selected?.name, openDir, selectFile],
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

                    <div className="mj_FilesPane_list">
                        {listing.status === "loading" ? (
                            <PreviewStatus variant="loading">Loading…</PreviewStatus>
                        ) : listing.status === "error" ? (
                            <PreviewStatus variant="error">{listing.error}</PreviewStatus>
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
                </div>

                <div className="mj_FilesPane_preview">
                    {selected && api ? (
                        <FilePreview api={api} path={selected.path} filename={selected.name} />
                    ) : (
                        <PreviewStatus variant="empty">Select a file to preview it.</PreviewStatus>
                    )}
                </div>
            </div>
        </div>
    );
}
