/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useMemo, useState } from "react";

import { copyText } from "../../clipboard";
import { highlightFile } from "../highlight";
import { INLINE_TEXT_MAX } from "../limits";
import { PreviewStatus } from "./PreviewChrome";
import { TooLargePreview } from "./TooLargePreview";
import type { RendererProps } from "./types";
import { useAsyncResource } from "./useAsyncResource";

// Standalone text/code viewer. Reuses the existing highlight.js path (same curated languages as the
// message renderer) → identical `hljs-*` theming. Not routed through markdown, so a file containing
// ``` fences renders faithfully. Shares the inline-render ceiling with markdown (F6).
export function CodePreview({ api, path, filename, meta }: RendererProps): React.ReactElement {
    const text = useAsyncResource((signal) => api.textContent(path, signal), `code:${path}:${meta.mtime}`);
    const [copyLabel, setCopyLabel] = useState("Copy");

    const source = text.data ?? "";
    const tooLarge = source.length > INLINE_TEXT_MAX;
    const highlighted = useMemo(
        () => (text.status === "loaded" && !tooLarge ? highlightFile(filename, source) : undefined),
        [text.status, tooLarge, filename, source],
    );

    if (text.status === "loading") return <PreviewStatus variant="loading">Loading…</PreviewStatus>;
    if (text.status === "error")
        return (
            <PreviewStatus variant="error" onRetry={text.reload}>
                {text.error}
            </PreviewStatus>
        );
    if (tooLarge) return <TooLargePreview api={api} path={path} filename={filename} />;

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
