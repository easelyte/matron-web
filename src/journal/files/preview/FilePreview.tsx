/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import type { FileMeta, FilesApiLike } from "../filesApi";
import { pickPreviewKind } from "../previewKind";
import { CodeView } from "./CodePreview";
import { GenericPreview } from "./GenericPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownView } from "./MarkdownPreview";
import { MediaPreview } from "./MediaPreview";
import { PdfPreview } from "./PdfPreview";
import { PreviewStatus, TextResourceView } from "./PreviewChrome";
import { PreviewToolbar } from "./PreviewToolbar";
import type { RendererProps } from "./types";
import { useAsyncResource } from "./useAsyncResource";

// Loads the file's metadata (cheap, no bytes), then dispatches to the matching renderer per
// pickPreviewKind. Two-step (meta → content) matches the API design: `is_text` from meta drives the
// text/binary split before any content fetch, and the meta `mtime` keys the content cache (F7).
//
// Every state — meta loading, meta error, and each resolved kind — renders the SAME header
// (PreviewToolbar) above it: file name + meta on the left, one action cluster on the right. There
// is exactly one download control per file (a READ capability, offered for every type and never
// gated on `writable`); Edit appears only when the pane passes `onEdit` (server-writable, editable
// text); Copy appears only for text kinds (markdown / code / plain text).
export function FilePreview({
    api,
    path,
    filename,
    onEdit,
}: {
    api: FilesApiLike;
    path: string;
    filename: string;
    onEdit?: () => void;
}): React.ReactElement {
    const meta = useAsyncResource((signal) => api.fileMeta(path, signal), `meta:${path}`);
    if (meta.status !== "loaded") {
        return (
            <>
                <PreviewToolbar api={api} path={path} filename={filename} onEdit={onEdit} />
                {meta.status === "loading" ? (
                    <PreviewStatus variant="loading">Loading…</PreviewStatus>
                ) : (
                    <PreviewStatus variant="error" onRetry={meta.reload}>
                        {meta.error}
                    </PreviewStatus>
                )}
            </>
        );
    }

    const resolved = meta.data!;
    const props: RendererProps = { api, path, filename, meta: resolved };
    const kind = pickPreviewKind({ mime: resolved.mime, isText: resolved.isText, filename });
    if (kind === "markdown" || kind === "code")
        return <TextFilePreview {...props} markdown={kind === "markdown"} onEdit={onEdit} />;

    const renderer = ((): React.ReactElement => {
        switch (kind) {
            case "image":
                return <ImagePreview {...props} />;
            case "pdf":
                return <PdfPreview {...props} />;
            case "audio":
            case "video":
                return <MediaPreview {...props} />;
            default:
                return <GenericPreview {...props} />;
        }
    })();
    return (
        <>
            <PreviewToolbar api={api} path={path} filename={filename} meta={resolved} onEdit={onEdit} />
            {renderer}
        </>
    );
}

// A text file is read ONCE, here, and the same string feeds both the rendered view and the header's
// Copy action — so Copy always yields the full raw source (markdown source, not rendered HTML), even
// when the file is past the inline-render ceiling and the view shows the too-large card instead.
function TextFilePreview({
    api,
    path,
    filename,
    meta,
    markdown,
    onEdit,
}: RendererProps & { meta: FileMeta; markdown: boolean; onEdit?: () => void }): React.ReactElement {
    const text = useAsyncResource((signal) => api.textContent(path, signal), `text:${path}:${meta.mtime}`);
    return (
        <>
            <PreviewToolbar
                api={api}
                path={path}
                filename={filename}
                meta={meta}
                onEdit={onEdit}
                copySource={{ status: text.status, text: text.data, errorStatus: text.errorStatus }}
            />
            <TextResourceView text={text}>
                {(source) =>
                    markdown ? (
                        <MarkdownView filename={filename} source={source} />
                    ) : (
                        <CodeView filename={filename} source={source} />
                    )
                }
            </TextResourceView>
        </>
    );
}
