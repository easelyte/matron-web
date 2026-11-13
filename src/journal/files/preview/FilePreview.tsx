/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect } from "react";

import type { FileMeta, FilesApiLike } from "../filesApi";
import { INLINE_TEXT_MAX } from "../limits";
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
import { type DownloadState, useDownload } from "./useDownload";

// Loads the file's metadata (cheap, no bytes), then dispatches to the matching renderer per
// pickPreviewKind. Two-step (meta → content) matches the API design: `is_text` from meta drives the
// text/binary split before any content fetch, and the meta `mtime` keys the content cache (F7).
//
// Every state — meta loading, meta error, and each resolved kind — renders the SAME header
// (PreviewToolbar) above it: file name + meta on the left, one action cluster on the right. There
// is exactly one download control per file (a READ capability, offered for every type and never
// gated on writes); Copy appears only for text kinds (markdown / code / plain text).
export function FilePreview({
    api,
    path,
    filename,
    onUnsupported,
}: {
    api: FilesApiLike;
    path: string;
    filename: string;
    onUnsupported?: (meta?: FileMeta) => void;
}): React.ReactElement {
    const meta = useAsyncResource((signal) => api.fileMeta(path, signal), `meta:${path}`);
    // ONE download controller for the whole preview lifetime (see PreviewToolbar's `download`).
    const download = useDownload(api, path, filename);
    useEffect(() => {
        if (meta.status === "error") onUnsupported?.();
        if (
            meta.status === "loaded" &&
            meta.data &&
            (meta.data.kind !== "file" || pickPreviewKind({ ...meta.data, filename }) === "generic")
        ) {
            onUnsupported?.(meta.data);
        }
    }, [meta.status, meta.data, filename, onUnsupported]);
    const onUnavailable = useCallback(() => onUnsupported?.(meta.data), [onUnsupported, meta.data]);
    if (meta.status !== "loaded") {
        return (
            <>
                <PreviewToolbar api={api} download={download} filename={filename} />
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
    const props: RendererProps = { api, path, filename, meta: resolved, onUnavailable };
    const kind = pickPreviewKind({ mime: resolved.mime, isText: resolved.isText, filename });
    if (kind === "markdown" || kind === "code")
        return <TextFilePreview {...props} download={download} markdown={kind === "markdown"} />;

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
            <PreviewToolbar api={api} download={download} filename={filename} meta={resolved} />
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
    download,
    markdown,
    onUnavailable,
}: RendererProps & {
    meta: FileMeta;
    download: DownloadState;
    markdown: boolean;
}): React.ReactElement {
    const text = useAsyncResource((signal) => api.textContent(path, signal), `text:${path}:${meta.mtime}`);
    useEffect(() => {
        if (text.status === "error" || (text.data?.length ?? 0) > INLINE_TEXT_MAX) onUnavailable?.();
    }, [text.status, text.data, onUnavailable]);
    return (
        <>
            <PreviewToolbar
                api={api}
                download={download}
                filename={filename}
                meta={meta}

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
