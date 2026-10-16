/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/**
 * The working indicator at the foot of an item's thread: the same three dots a chat shows while
 * its agent is busy, driven by the item's own `working` block (the journal derives it from the
 * conversation that owns the item). "Working" while that session is mid-turn; "Starting" from the
 * moment the user writes on the item until the agent's turn begins.
 */

import React, { useEffect, useState } from "react";

import type { TrackerWorking } from "../types";

/** The indicator's label at `now`, or null when there is nothing to show. A queued state lapses at
 *  its `until`; a state this build does not know is not guessed at. */
export function workingLabel(working: TrackerWorking | null | undefined, now: number): string | null {
    if (!working) return null;
    if (working.until != null && now >= working.until) return null;
    if (working.state === "running") return "Working";
    if (working.state === "queued") return "Starting";
    return null;
}

// setTimeout takes a 32-bit delay; a longer one fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `workingLabel`, kept current: the journal says when a queued state lapses and nothing arrives
 *  to announce it, so the caller re-renders itself then. */
export function useWorkingLabel(working: TrackerWorking | null | undefined): string | null {
    const [, setLapsed] = useState(0);
    const until = working?.until ?? null;
    useEffect(() => {
        if (until == null) return undefined;
        const wait = until - Date.now();
        if (wait <= 0) return undefined;
        const timer = window.setTimeout(() => setLapsed((n) => n + 1), Math.min(wait, MAX_TIMER_MS));
        return () => window.clearTimeout(timer);
    }, [until]);
    return workingLabel(working, Date.now());
}

export function WorkingIndicator({ label }: { label: string | null }): React.ReactElement | null {
    if (!label) return null;
    return (
        <div className="mj_Activity mj_TrackerWorking" role="status">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            {label}
        </div>
    );
}
