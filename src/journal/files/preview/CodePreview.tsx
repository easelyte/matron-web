/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useMemo } from "react";

import { highlightFile } from "../highlight";
import { INLINE_TEXT_MAX } from "../limits";
import { TextResourceView } from "./PreviewChrome";
import { TooLargePreview } from "./TooLargePreview";
import type { RendererProps } from "./types";
import { useAsyncResource } from "./useAsyncResource";

// Standalone text/code viewer. Reuses the existing highlight.js path (same curated languages as the
// message renderer) → identical `hljs-*` theming. Not routed through markdown, so a file containing
// ``` fences renders faithfully. Shares the inline-render ceiling with markdown.
export function CodePreview({ api, path, filename, meta }: RendererProps): React.ReactElement {
    const text = useAsyncResource((signal) => api.textContent(path, signal), `code:${path}:${meta.mtime}`);
    return (
        <TextResourceView text={text}>{(source) => <CodeView filename={filename} source={source} />}</TextResourceView>
    );
}

/**
 * Pure render of already-loaded source. FilePreview loads a text file ONCE and hands the same text
 * to this view and to the header's Copy action, so what is copied is exactly what is shown.
 */
export function CodeView({ filename, source }: { filename: string; source: string }): React.ReactElement {
    const tooLarge = source.length > INLINE_TEXT_MAX;
    const highlighted = useMemo(
        () => (tooLarge ? undefined : highlightFile(filename, source)),
        [tooLarge, filename, source],
    );
    if (tooLarge) return <TooLargePreview />;
    return (
        <div className="mj_FilesCode">
            {highlighted?.language ? (
                <div className="mj_FilesCode_header">
                    <span className="mj_FilesCode_lang">{highlighted.language}</span>
                </div>
            ) : null}
            <pre className="mj_FilesCode_pre">
                <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted?.html ?? "" }} />
            </pre>
        </div>
    );
}
