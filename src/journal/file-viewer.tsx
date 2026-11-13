/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "./client";
import { FILE_VIEWER_OPEN, filesDeepLinkHash, viewerFilePath, type FileViewerTarget } from "./files-link";
import type { FileMeta } from "./files/filesApi";
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
        const fromHash = (): void => {
            const path = viewerFilePath(window.location.href);
            if (!path || !filesDeepLinkHash(window.location.href)) return;
            onOpen();
            setTarget({ path, opener: document.body });
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
        };
        fromHash();
        window.addEventListener("hashchange", fromHash);
        window.addEventListener(FILE_VIEWER_OPEN, open);
        return () => {
            window.removeEventListener(FILE_VIEWER_OPEN, open);
            window.removeEventListener("hashchange", fromHash);
        };
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
    const fallbackOpened = useRef(false);
    useEffect(() => {
        fallbackOpened.current = false;
    }, [target]);
    const openInBrowser = useCallback(
        (meta?: FileMeta): void => {
            if (fallbackOpened.current) return;
            // Signed bridge links remain usable by the browser. Hash links need authenticated bytes;
            // opening their original URL would open another Matron tab.
            if (target.href && !filesDeepLinkHash(target.href)) {
                fallbackOpened.current = true;
                window.open(target.href, "_blank", "noopener,noreferrer");
                onClose();
            } else if (api) {
                fallbackOpened.current = true;
                void api
                    .contentUrl(target.path, { mtime: meta?.mtime ?? 0, disposition: "attachment" })
                    .then((url) => {
                        window.open(url, "_blank", "noopener,noreferrer");
                        onClose();
                    })
                    .catch(() => {
                        fallbackOpened.current = false;
                    });
            }
        },
        [api, target, onClose],
    );
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
            <div className="mj_FileViewer_preview">
                {api ? (
                    <FilePreview
                        key={target.path}
                        api={api}
                        path={target.path}
                        filename={name}
                        onUnsupported={openInBrowser}
                    />
                ) : (
                    <PreviewStatus variant="error">Not signed in</PreviewStatus>
                )}
            </div>
        </aside>
    );
}
