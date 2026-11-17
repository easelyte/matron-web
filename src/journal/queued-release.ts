/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type JournalEvent } from "./types";

export type ReleasedAction = "send" | "cancel" | "expired";

/**
 * How each queued message was settled, keyed by item id, from the bridge's `prompt_reply`
 * events of kind `queued_release`. `expired` means the bridge abandoned the queue (for example
 * across a restart) without sending the message. A real decision (send or cancel) always wins
 * over `expired`, whichever arrives first, so a repeated expiry can never overwrite what
 * actually happened.
 */
export function foldReleasedActions(events: readonly JournalEvent[]): Map<string, ReleasedAction> {
    const actions = new Map<string, ReleasedAction>();
    for (const event of events) {
        if (event.type !== "prompt_reply" || event.payload.kind !== "queued_release") continue;
        const released = event.payload.released;
        const action = event.payload.action;
        if (!Array.isArray(released)) continue;
        if (action !== "send" && action !== "cancel" && action !== "expired") continue;
        for (const releasedId of released) {
            if (typeof releasedId !== "string" || !releasedId) continue;
            const previous = actions.get(releasedId);
            if (action === "expired" && previous !== undefined) continue;
            actions.set(releasedId, action);
        }
    }
    return actions;
}
