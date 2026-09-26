/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

// Shared "too large to preview inline" card — used by BOTH markdown and code once a text file
// exceeds INLINE_TEXT_MAX, and anywhere else inline render is refused. The download affordance is
// rendered once by FilePreview above this card, so a too-large file is still downloadable.
export function TooLargePreview({
    note = "This file is too large to preview inline.",
}: {
    note?: string;
}): React.ReactElement {
    return (
        <div className="mj_FilesGeneric">
            <p className="mj_FilesGeneric_note">{note}</p>
        </div>
    );
}
