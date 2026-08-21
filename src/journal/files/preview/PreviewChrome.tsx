/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Shared presentational chrome for the Files-pane preview renderers: status placeholders (loading
// / error / empty, with an optional Retry), the metadata sub-line, and the download affordance
// (with visible errors). Keeps every renderer's non-content states visually identical and native.

import React from "react";

import { DownloadIcon } from "../../icons";
import type { FileMeta, FilesApiLike } from "../filesApi";
import { humanizeMtime, humanizeSize } from "../format";
import { useDownload } from "./useDownload";

export function PreviewStatus({
    variant,
    children,
    onRetry,
}: {
    variant: "loading" | "error" | "empty";
    children: React.ReactNode;
    onRetry?: () => void;
}): React.ReactElement {
    return (
        <div
            className={`mj_FilesPreview_status mj_FilesPreview_status_${variant}`}
            role={variant === "error" ? "alert" : "status"}
        >
            {variant === "loading" ? <span className="mj_FilesPreview_spinner" aria-hidden="true" /> : null}
            <span>{children}</span>
            {variant === "error" && onRetry ? (
                <button className="mj_FilesRetry" type="button" onClick={onRetry}>
                    Retry
                </button>
            ) : null}
        </div>
    );
}

export function metaLine(meta: FileMeta): string {
    const parts = [humanizeSize(meta.size)];
    const when = humanizeMtime(meta.mtime);
    if (when) parts.push(when);
    if (meta.mime) parts.push(meta.mime);
    return parts.join(" · ");
}

// Error state for media renderers (image/pdf/media): the uniform message + a download fallback
// (a 413 too-large media 413s inline → download works) + Retry.
export function MediaError({
    api,
    path,
    filename,
    error,
    onRetry,
}: {
    api: FilesApiLike | undefined;
    path: string;
    filename: string;
    error: React.ReactNode;
    onRetry: () => void;
}): React.ReactElement {
    return (
        <div className="mj_FilesGeneric" role="alert">
            <p className="mj_FilesGeneric_note">{error}</p>
            <DownloadControl api={api} path={path} filename={filename} />
            <button className="mj_FilesRetry" type="button" onClick={onRetry}>
                Retry
            </button>
        </div>
    );
}

// Download button + visible error (F5). Encapsulates useDownload so every renderer gets identical
// download behaviour and error surfacing.
export function DownloadControl({
    api,
    path,
    filename,
    label = "Download",
}: {
    api: FilesApiLike | undefined;
    path: string;
    filename: string;
    label?: string;
}): React.ReactElement {
    const { download, busy, error } = useDownload(api, path, filename);
    return (
        <>
            <button className="mj_FilesDownload" type="button" onClick={download} disabled={busy || !api}>
                <DownloadIcon />
                <span>{busy ? "Downloading…" : label}</span>
            </button>
            {error ? (
                <p className="mj_FilesDownload_error" role="alert">
                    {error}
                </p>
            ) : null}
        </>
    );
}
