/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import type { FilesApiLike } from "../filesApi";
import { DownloadControl } from "./PreviewChrome";

// Shared "too large to preview inline" card (F6) — used by BOTH markdown and code once a text file
// exceeds INLINE_TEXT_MAX, and anywhere else inline render is refused. Offers download instead.
export function TooLargePreview({
    api,
    path,
    filename,
    note = "This file is too large to preview inline.",
}: {
    api: FilesApiLike | undefined;
    path: string;
    filename: string;
    note?: string;
}): React.ReactElement {
    return (
        <div className="mj_FilesGeneric">
            <p className="mj_FilesGeneric_note">{note}</p>
            <DownloadControl api={api} path={path} filename={filename} />
        </div>
    );
}
