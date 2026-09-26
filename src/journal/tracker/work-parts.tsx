/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Small presentational pieces shared by the Work list rows and the loop detail header.

import React from "react";

import { TaskGlyph } from "./glyphs";
import { statusLabel, type WorkLoopStatus } from "./work-format";

/** Status chip: tint + dot, never a solid fill. Shared by rows and the detail header. */
export function WorkStatusChip({ status }: { status: WorkLoopStatus }): React.ReactElement {
    return (
        <span className={`mj_WorkStatusChip mj_WorkStatusChip_${status}`}>
            <span className="mj_WorkStatusChip_dot" aria-hidden="true" />
            {statusLabel(status)}
        </span>
    );
}

/** The row/detail glyph, coloured by status (orange only when blocked). */
export function WorkGlyph({ status }: { status: WorkLoopStatus }): React.ReactElement {
    return (
        <span className={`mj_WorkGlyph mj_WorkGlyph_${status}`} aria-hidden="true">
            <TaskGlyph />
        </span>
    );
}
