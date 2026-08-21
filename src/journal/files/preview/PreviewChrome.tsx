/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Shared presentational chrome for the Files-pane preview renderers: status placeholders (loading
// / error / empty), the metadata sub-line, and the download affordance. Keeps every renderer's
// non-content states visually identical and native to the app.

import React from "react";

import { DownloadIcon } from "../../icons";
import type { FileMeta } from "../filesApi";
import { humanizeMtime, humanizeSize } from "../format";

export function PreviewStatus({
    variant,
    children,
}: {
    variant: "loading" | "error" | "empty";
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <div
            className={`mj_FilesPreview_status mj_FilesPreview_status_${variant}`}
            role={variant === "error" ? "alert" : "status"}
        >
            {variant === "loading" ? <span className="mj_FilesPreview_spinner" aria-hidden="true" /> : null}
            <span>{children}</span>
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

export function DownloadButton({
    label = "Download",
    onDownload,
    busy = false,
}: {
    label?: string;
    onDownload: () => void;
    busy?: boolean;
}): React.ReactElement {
    return (
        <button className="mj_FilesDownload" type="button" onClick={onDownload} disabled={busy}>
            <DownloadIcon />
            <span>{busy ? "Downloading…" : label}</span>
        </button>
    );
}
