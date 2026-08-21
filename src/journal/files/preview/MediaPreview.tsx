/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import { fileKindFromMime } from "../../types";
import { MediaError, PreviewStatus } from "./PreviewChrome";
import type { RendererProps } from "./types";
import { useAsyncResource } from "./useAsyncResource";

// <audio>/<video> on the blob URL. The server's /files/content supports Range/206, but a Bearer
// header can't ride a bare media `src`, so we play the fetched blob (browser seeks within it).
// Inline reads cap at 5 MB server-side; a larger media file 413s → error state offers download.
export function MediaPreview({ api, path, filename, meta }: RendererProps): React.ReactElement {
    const kind = fileKindFromMime(meta.mime);
    const src = useAsyncResource(
        (signal) => api.contentUrl(path, { disposition: "inline", mtime: meta.mtime, signal }),
        `media:${path}:${meta.mtime}`,
    );
    if (src.status === "loading") return <PreviewStatus variant="loading">Loading…</PreviewStatus>;
    if (src.status === "error")
        return <MediaError api={api} path={path} filename={filename} error={src.error} onRetry={src.reload} />;
    return (
        <div className="mj_FilesMedia">
            {kind === "audio" ? (
                <audio src={src.data} controls aria-label={filename} />
            ) : (
                <video src={src.data} controls aria-label={filename} />
            )}
        </div>
    );
}
