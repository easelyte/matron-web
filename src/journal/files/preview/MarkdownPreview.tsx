/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import { MarkdownBody } from "../../markdown";
import { INLINE_TEXT_MAX } from "../limits";
import { PreviewStatus } from "./PreviewChrome";
import { TooLargePreview } from "./TooLargePreview";
import type { RendererProps } from "./types";
import { useAsyncResource } from "./useAsyncResource";

// Reuses the message renderer's MarkdownBody so a rendered .md file matches chat markdown exactly.
// Enforces the shared inline-render ceiling (F6): a multi-MB .md would stall a phone because
// MarkdownBody skips PARSING but still injects the raw payload as DOM text.
export function MarkdownPreview({ api, path, filename, meta }: RendererProps): React.ReactElement {
    const text = useAsyncResource((signal) => api.textContent(path, signal), `md:${path}:${meta.mtime}`);
    if (text.status === "loading") return <PreviewStatus variant="loading">Loading…</PreviewStatus>;
    if (text.status === "error")
        return (
            <PreviewStatus variant="error" onRetry={text.reload}>
                {text.error}
            </PreviewStatus>
        );
    const source = text.data ?? "";
    if (source.length > INLINE_TEXT_MAX) return <TooLargePreview api={api} path={path} filename={filename} />;
    // `mj_Markdown` inherits the message renderer's element styling; `mj_FilesMarkdown` adds
    // pane-scoped padding + a readable max measure.
    return (
        <div className="mj_Markdown mj_FilesMarkdown">
            <MarkdownBody text={source} label={filename} />
        </div>
    );
}
