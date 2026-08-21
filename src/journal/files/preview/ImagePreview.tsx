/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import { MediaError, PreviewStatus } from "./PreviewChrome";
import type { RendererProps } from "./types";
import { useAsyncResource } from "./useAsyncResource";

// Blob-URL <img>, mirroring the AuthenticatedMedia Bearer-fetch approach. The object URL is owned by
// FilesApi's cache (keyed by mtime, revoked on dispose), so no per-component revoke.
export function ImagePreview({ api, path, filename, meta }: RendererProps): React.ReactElement {
    const src = useAsyncResource(
        (signal) => api.contentUrl(path, { disposition: "inline", mtime: meta.mtime, signal }),
        `img:${path}:${meta.mtime}`,
    );
    if (src.status === "loading") return <PreviewStatus variant="loading">Loading image…</PreviewStatus>;
    if (src.status === "error")
        return <MediaError api={api} path={path} filename={filename} error={src.error} onRetry={src.reload} />;
    return (
        <div className="mj_FilesImage">
            <img src={src.data} alt={filename} />
        </div>
    );
}
