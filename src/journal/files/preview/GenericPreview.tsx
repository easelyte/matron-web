/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useState } from "react";

import { fileKindFromMime } from "../../types";
import { fileKindIcon } from "../icons";
import type { RendererProps } from "./types";
import { DownloadButton, metaLine } from "./PreviewChrome";

// Fallback for binary / unpreviewable files: the file-kind icon (reusing the app's file affordance
// set), the metadata line, and a download button.
export function GenericPreview({ api, path, filename, meta }: RendererProps): React.ReactElement {
    const [downloading, setDownloading] = useState(false);
    const KindIcon = fileKindIcon(fileKindFromMime(meta.mime));
    return (
        <div className="mj_FilesGeneric">
            <KindIcon className="mj_FilesGeneric_icon" />
            <p className="mj_FilesGeneric_name">{filename}</p>
            <p className="mj_FilesGeneric_note">{metaLine(meta)}</p>
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
