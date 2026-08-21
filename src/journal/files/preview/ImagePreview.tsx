/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useState } from "react";

import type { RendererProps } from "./types";
import { DownloadButton, PreviewStatus } from "./PreviewChrome";
import { useAsyncResource } from "./useAsyncResource";

// Blob-URL <img>, mirroring the AuthenticatedMedia Bearer-fetch approach. The object URL is owned
// by FilesApi's cache and revoked on teardown, so no per-component revoke.
export function ImagePreview({ api, path, filename }: RendererProps): React.ReactElement {
    const src = useAsyncResource(() => api.contentUrl(path, "inline"), `img:${path}`);
    const [downloading, setDownloading] = useState(false);
    if (src.status === "loading") return <PreviewStatus variant="loading">Loading image…</PreviewStatus>;
    if (src.status === "error") {
        return (
            <div className="mj_FilesGeneric">
                <p className="mj_FilesGeneric_note">{src.error}</p>
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
    return (
        <div className="mj_FilesImage">
            <img src={src.data} alt={filename} />
        </div>
    );
}
