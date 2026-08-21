/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useState } from "react";

import type { RendererProps } from "./types";
import { DownloadButton, PreviewStatus } from "./PreviewChrome";
import { useAsyncResource } from "./useAsyncResource";

// Browser-native PDF embed on the blob URL first (Chrome/desktop have a built-in viewer). The
// <object> fallback children render where inline embedding is unavailable (notably iOS Safari),
// giving a download affordance instead. pdf.js/react-pdf deliberately NOT added (deferred).
export function PdfPreview({ api, path, filename }: RendererProps): React.ReactElement {
    const src = useAsyncResource(() => api.contentUrl(path, "inline"), `pdf:${path}`);
    const [downloading, setDownloading] = useState(false);
    if (src.status === "loading") return <PreviewStatus variant="loading">Loading PDF…</PreviewStatus>;
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
        <div className="mj_FilesPdf">
            <object data={src.data} type="application/pdf" aria-label={filename}>
                <div className="mj_FilesGeneric">
                    <p className="mj_FilesGeneric_note">This browser can't display the PDF inline.</p>
                    <DownloadButton
                        busy={downloading}
                        onDownload={() => {
                            setDownloading(true);
                            void api.download(path, filename).finally(() => setDownloading(false));
                        }}
                    />
                </div>
            </object>
        </div>
    );
}
