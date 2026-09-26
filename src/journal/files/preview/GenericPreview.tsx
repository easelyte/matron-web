/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import { fileKindFromMime } from "../../types";
import { fileKindIcon } from "../icons";
import { metaLine } from "./PreviewChrome";
import type { RendererProps } from "./types";

// Fallback for binary / unpreviewable files: the file-kind icon (reusing the app's file affordance
// set), the file name, and the metadata line. The download affordance is rendered once by
// FilePreview (the single dispatch point), not here — so every file type gets an identical control.
export function GenericPreview({ filename, meta }: RendererProps): React.ReactElement {
    const KindIcon = fileKindIcon(fileKindFromMime(meta.mime));
    return (
        <div className="mj_FilesGeneric">
            <KindIcon className="mj_FilesGeneric_icon" />
            <p className="mj_FilesGeneric_name">{filename}</p>
            <p className="mj_FilesGeneric_note">{metaLine(meta)}</p>
        </div>
    );
}
