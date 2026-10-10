/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// The preview header: the file's name + metadata on the left and ONE cohesive action cluster on
// the right (Edit · Copy · Download). Every action is an equal-size icon button with a tooltip and
// an aria-label; Download is the filled primary (it is offered for every file), the rest are quiet
// secondaries. Action errors surface on a single line under the header, never inside the row, so
// the row itself never wraps or reflows.

import React, { useCallback, useEffect, useRef, useState } from "react";

import { copyText } from "../../clipboard";
import { CheckIcon, ClipboardIcon, DownloadIcon, FileEditIcon } from "../../icons";
import type { FileMeta, FilesApiLike } from "../filesApi";
import { metaLine } from "./PreviewChrome";
import type { DownloadState } from "./useDownload";

/** How long the Copy button shows its "copied" check before reverting. */
export const COPIED_FEEDBACK_MS = 1500;

/**
 * What the Copy button copies: the full text of the file, from the same read the preview renders.
 * Absent ⇒ no Copy button (images, PDF, media, unpreviewable files).
 */
export interface CopySource {
    status: "loading" | "loaded" | "error";
    text?: string;
    /** HTTP status of a failed read (413 ⇒ too large for the inline read path). */
    errorStatus?: number;
}

/** Why Copy is unavailable, or undefined when it is ready. Exported for tests. */
export function copyUnavailableReason(source: CopySource): string | undefined {
    if (source.status === "loading") return "Loading the file…";
    if (source.status === "error") {
        return source.errorStatus === 413
            ? "Too large to copy. Download it instead."
            : "Couldn't read this file to copy it.";
    }
    return undefined;
}

function useCopy(text: string | undefined): {
    copy: () => void;
    copied: boolean;
    error?: string;
    announcement: string;
} {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [announcement, setAnnouncement] = useState("");
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);
    const copy = useCallback(() => {
        if (text === undefined) return;
        setError(undefined);
        // copyText calls navigator.clipboard.writeText FIRST, synchronously inside this click, so
        // Safari's user-activation requirement holds; it falls back to execCommand on an insecure
        // (plain-http) origin where the async clipboard API does not exist.
        void copyText(text).then((ok) => {
            if (!mounted.current) return;
            if (timer.current) clearTimeout(timer.current);
            if (ok) {
                setCopied(true);
                setAnnouncement("Copied to clipboard");
                timer.current = setTimeout(() => {
                    setCopied(false);
                    setAnnouncement("");
                }, COPIED_FEEDBACK_MS);
            } else {
                setCopied(false);
                setAnnouncement("");
                setError("Couldn't copy to the clipboard. Select the text and copy it manually.");
            }
        });
    }, [text]);
    return { copy, copied, error, announcement };
}

export function PreviewToolbar({
    api,
    download,
    filename,
    meta,
    copySource,
    onEdit,
}: {
    api: FilesApiLike | undefined;
    /**
     * The download controller, owned by FilePreview ABOVE every state branch. The header is
     * re-rendered as metadata and text resolve; owning the request here would drop an in-flight
     * download's busy state and error on that transition and re-enable the button mid-request.
     */
    download: DownloadState;
    filename: string;
    /** Resolved metadata, when it has loaded (the header renders before it does). */
    meta?: FileMeta;
    copySource?: CopySource;
    /** Present only when the server said the file's directory is writable and it is editable text. */
    onEdit?: () => void;
}): React.ReactElement {
    const copyReady = copySource?.status === "loaded" ? (copySource.text ?? "") : undefined;
    const copy = useCopy(copyReady);
    const copyBlocked = copySource ? copyUnavailableReason(copySource) : undefined;

    return (
        <>
            <div className="mj_FilesPreview_header">
                <div className="mj_FilesPreview_heading">
                    <span className="mj_FilesPreview_name" title={filename}>
                        {filename}
                    </span>
                    {meta ? <span className="mj_FilesPreview_meta">{metaLine(meta)}</span> : null}
                </div>
                <div className="mj_FilesPreview_actions" role="group" aria-label="File actions">
                    {onEdit ? (
                        <button
                            type="button"
                            className="mj_FilesAction mj_FilesPreview_edit"
                            aria-label={`Edit ${filename}`}
                            title="Edit"
                            onClick={onEdit}
                        >
                            <FileEditIcon aria-hidden />
                        </button>
                    ) : null}
                    {copySource ? (
                        <button
                            type="button"
                            className={`mj_FilesAction mj_FilesAction_copy${copy.copied ? " mj_FilesAction_done" : ""}`}
                            // aria-disabled (not `disabled`) so the tooltip explaining WHY still shows
                            // on hover and the reason is still announced to assistive tech.
                            aria-disabled={copyBlocked ? true : undefined}
                            aria-label={copy.copied ? "Copied" : copyBlocked ? `Copy: ${copyBlocked}` : "Copy contents"}
                            title={copy.copied ? "Copied" : (copyBlocked ?? "Copy contents")}
                            onClick={copyBlocked ? undefined : copy.copy}
                        >
                            {copy.copied ? <CheckIcon aria-hidden /> : <ClipboardIcon aria-hidden />}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="mj_FilesAction mj_FilesAction_primary mj_FilesAction_download"
                        aria-label={download.busy ? `Downloading ${filename}` : `Download ${filename}`}
                        title={download.busy ? "Downloading…" : "Download"}
                        aria-busy={download.busy ? true : undefined}
                        disabled={download.busy || !api}
                        onClick={download.download}
                    >
                        <DownloadIcon aria-hidden />
                    </button>
                </div>
            </div>
            <span className="mj_FilesPreview_live" role="status" aria-live="polite">
                {copy.announcement}
            </span>
            {download.error ? (
                <p className="mj_FilesPreview_actionError mj_FilesPreview_downloadError" role="alert">
                    {download.error}
                </p>
            ) : null}
            {copy.error ? (
                <p className="mj_FilesPreview_actionError mj_FilesPreview_copyError" role="alert">
                    {copy.error}
                </p>
            ) : null}
        </>
    );
}
