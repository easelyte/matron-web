/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import type { FilesApiLike } from "../filesApi";
import { pickPreviewKind } from "../previewKind";
import { CodePreview } from "./CodePreview";
import { GenericPreview } from "./GenericPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { MediaPreview } from "./MediaPreview";
import { PdfPreview } from "./PdfPreview";
import { DownloadControl, PreviewStatus } from "./PreviewChrome";
import type { RendererProps } from "./types";
import { useAsyncResource } from "./useAsyncResource";

// Loads the file's metadata (cheap, no bytes), then dispatches to the matching renderer per
// pickPreviewKind. Two-step (meta → content) matches the API design: `is_text` from meta drives the
// text/binary split before any content fetch, and the meta `mtime` keys the content cache (F7).
export function FilePreview({
    api,
    path,
    filename,
}: {
    api: FilesApiLike;
    path: string;
    filename: string;
}): React.ReactElement {
    const meta = useAsyncResource((signal) => api.fileMeta(path, signal), `meta:${path}`);
    if (meta.status === "loading") return <PreviewStatus variant="loading">Loading…</PreviewStatus>;
    if (meta.status === "error")
        return (
            <PreviewStatus variant="error" onRetry={meta.reload}>
                {meta.error}
            </PreviewStatus>
        );

    const resolved = meta.data!;
    const props: RendererProps = { api, path, filename, meta: resolved };
    const kind = pickPreviewKind({ mime: resolved.mime, isText: resolved.isText, filename });
    const renderer = ((): React.ReactElement => {
        switch (kind) {
            case "markdown":
                return <MarkdownPreview {...props} />;
            case "code":
                return <CodePreview {...props} />;
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

    // ONE download affordance for EVERY resolved file, rendered here at the single dispatch point
    // rather than per-renderer. Download is a READ capability, so it is offered for any file type
    // (text, image, pdf, media, and unpreviewable) and is NOT gated on `writable`. It reuses the
    // canonical DownloadControl → useDownload primitive (visible uniform errors, in-flight disable),
    // so there is exactly one request-owning control per file — no duplicate button, no competing
    // busy state. The previously per-renderer controls (GenericPreview / TooLargePreview /
    // MediaError) are gone; their download fallback is this single control, which sits above every
    // renderer INCLUDING the too-large and load-error sub-states.
    return (
        <>
            <div className="mj_FilesPreview_downloadRow">
                <DownloadControl api={api} path={path} filename={filename} />
            </div>
            {renderer}
        </>
    );
}
