/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import { MarkdownBody } from "../../markdown";
import type { RendererProps } from "./types";
import { PreviewStatus } from "./PreviewChrome";
import { useAsyncResource } from "./useAsyncResource";

// Reuses the message renderer's MarkdownBody so a rendered .md file matches chat markdown exactly
// (GFM, code fences, the same size/line guards).
export function MarkdownPreview({ api, path, filename }: RendererProps): React.ReactElement {
    const text = useAsyncResource(() => api.textContent(path), `md:${path}`);
    if (text.status === "loading") return <PreviewStatus variant="loading">Loading…</PreviewStatus>;
    if (text.status === "error") return <PreviewStatus variant="error">{text.error}</PreviewStatus>;
    // `mj_Markdown` inherits the message renderer's element styling (headings/lists/code/tables);
    // `mj_FilesMarkdown` adds pane-scoped padding + a readable max measure.
    return (
        <div className="mj_Markdown mj_FilesMarkdown">
            <MarkdownBody text={text.data ?? ""} label={filename} />
        </div>
    );
}
