/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useMemo, useState } from "react";

import { copyText } from "../../clipboard";
import { CODE_RENDER_MAX, highlightFile } from "../highlight";
import type { RendererProps } from "./types";
import { DownloadButton, PreviewStatus } from "./PreviewChrome";
import { useAsyncResource } from "./useAsyncResource";

// Standalone text/code viewer. Reuses the existing highlight.js path (same curated languages as
// the message renderer) → identical `hljs-*` theming. Not routed through markdown, so a file
// containing ``` fences renders faithfully.
export function CodePreview({ api, path, filename }: RendererProps): React.ReactElement {
    const text = useAsyncResource(() => api.textContent(path), `code:${path}`);
    const [copyLabel, setCopyLabel] = useState("Copy");
    const [downloading, setDownloading] = useState(false);

    const source = text.data ?? "";
    const tooLarge = source.length > CODE_RENDER_MAX;
    const highlighted = useMemo(
        () => (text.status === "loaded" && !tooLarge ? highlightFile(filename, source) : undefined),
        [text.status, tooLarge, filename, source],
    );

    if (text.status === "loading") return <PreviewStatus variant="loading">Loading…</PreviewStatus>;
    if (text.status === "error") return <PreviewStatus variant="error">{text.error}</PreviewStatus>;

    if (tooLarge) {
        return (
            <div className="mj_FilesGeneric">
                <p className="mj_FilesGeneric_note">This file is too large to preview inline.</p>
                <DownloadButton
                    busy={downloading}
                    onDownload={() => {
                        setDownloading(true);
                        void api.download(path, filename).finally(() => setDownloading(false));
                    }}
                />
            </div>
        );
    }

    async function handleCopy(): Promise<void> {
        const ok = await copyText(source);
        setCopyLabel(ok ? "Copied" : "Copy failed");
        setTimeout(() => setCopyLabel("Copy"), 1500);
    }

    return (
        <div className="mj_FilesCode">
            <div className="mj_FilesCode_header">
                {highlighted?.language ? <span className="mj_FilesCode_lang">{highlighted.language}</span> : null}
                <button className="mj_FilesCode_copy" type="button" onClick={() => void handleCopy()}>
                    {copyLabel}
                </button>
            </div>
            <pre className="mj_FilesCode_pre">
                <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted?.html ?? "" }} />
            </pre>
        </div>
    );
}
