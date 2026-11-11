/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "./client";
import { FILE_VIEWER_OPEN, type FileViewerTarget } from "./files-link";
import { FilePreview } from "./files/preview/FilePreview";
import { PreviewStatus } from "./files/preview/PreviewChrome";
import { CloseIcon } from "./icons";

/** A small event boundary keeps markdown and tracker links independent of app/client state. */
export function useFileViewerPanel(onOpen: () => void): {
    target?: FileViewerTarget;
    close: () => void;
} {
    const [target, setTarget] = useState<FileViewerTarget>();
    const close = useCallback(() => setTarget(undefined), []);
    useEffect(() => {
        const open = (event: Event): void => {
            onOpen();
            setTarget((event as CustomEvent<FileViewerTarget>).detail);
        };
        window.addEventListener(FILE_VIEWER_OPEN, open);
        return () => window.removeEventListener(FILE_VIEWER_OPEN, open);
    }, [onOpen]);
    return { target, close };
}

export function FileViewerPanel({
    client,
    target,
    onClose,
}: {
    client: MatronJournalClient;
    target: FileViewerTarget;
    onClose: () => void;
}): React.ReactElement {
    const api = useMemo(() => client.filesApi(), [client]);
    const closeRef = useRef<HTMLButtonElement>(null);
    const openerRef = useRef(target.opener);
    const name = target.path.slice(target.path.lastIndexOf("/") + 1) || target.path;
    useEffect(() => {
        openerRef.current = target.opener;
        closeRef.current?.focus({ preventScroll: true });
    }, [target]);
    useEffect(
        () => () => {
            if (openerRef.current.isConnected) openerRef.current.focus({ preventScroll: true });
        },
        [],
    );
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            // Defer to overlays above this panel, matching the markdown attachment panel.
            if (
                document.querySelector(
                    ".mj_MediaViewer_scrim, .mj_MediaBrowser_scrim, .mj_SubChatPane_covering, .mj_EventSource_scrim, .mj_UploadConfirm_scrim, .mj_NewSessionSheet, .mj_SettingsScrim, .mj_EventRowMenu, .mj_ConversationMenu, .mj_HeaderMenu, [role='menu']",
                )
            )
                return;
            event.preventDefault();
            onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <aside className="mj_MdPreview" aria-label={`Preview of ${name}`}>
            <header className="mj_MdPreview_header">
                <span className="mj_MdPreview_name" title={target.path}>
                    {name}
                </span>
                <div className="mj_MdPreview_actions">
                    <button
                        type="button"
                        className="mj_MdPreview_action"
                        onClick={() => {
                            onClose();
                            const slash = target.path.lastIndexOf("/");
                            client.openFilesView(target.path.slice(0, Math.max(1, slash)), target.path);
                        }}
                    >
                        Show in Files
                    </button>
                    <button
                        ref={closeRef}
                        type="button"
                        className="mj_MdPreview_close"
                        aria-label="Close preview"
                        title="Close"
                        onClick={onClose}
                    >
                        <CloseIcon aria-hidden />
                    </button>
                </div>
            </header>
            <div className="mj_FilesPane_preview">
                {api ? (
                    <FilePreview key={target.path} api={api} path={target.path} filename={name} />
                ) : (
                    <PreviewStatus variant="error">Not signed in</PreviewStatus>
                )}
            </div>
        </aside>
    );
}
