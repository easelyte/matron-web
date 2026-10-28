/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

/**
 * Render a server search snippet, turning its `**…**` match markers into <mark> highlights.
 * The snippet is plain text (server-escaped), so we only split on the markers — no HTML is
 * interpreted. Unbalanced markers degrade to literal text rather than swallowing the rest.
 */
export function renderSnippet(snippet: string): React.ReactNode[] {
    const parts = snippet.split("**");
    return parts.map((part, index) =>
        // Odd segments sat between a matched pair of markers → highlight. If the count is even
        // (a dangling marker), the trailing odd segment is still highlighted, which is harmless.
        index % 2 === 1 ? (
            <mark key={index} className="mj_SearchHit_mark">
                {part}
            </mark>
        ) : (
            <React.Fragment key={index}>{part}</React.Fragment>
        ),
    );
}
