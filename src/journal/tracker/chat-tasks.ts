/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Pure helpers behind the chat's Tasks & decisions pane: how its sections are drawn from the loaded
 * items, and what a drag of one task to a new place sends to the journal.
 */

import type { TrackerItem, TrackerRankChange } from "../types";
import { needsUser } from "./format";

export interface ChatTaskSections {
    needsYou: TrackerItem[];
    tasks: TrackerItem[];
    decisions: TrackerItem[];
    done: TrackerItem[];
}

/** How many closed items the Done section lists, newest first. */
export const CHAT_TASKS_DONE_LIMIT = 50;
/** How many closed items are read for Done: the journal's page is in last-change order, so a wider
 *  one leaves Done its latest-closed rows even when older items were touched since. */
export const CHAT_TASKS_DONE_FETCH = 200;

/** The task order: rank, then number. */
export function byRank(a: TrackerItem, b: TrackerItem): number {
    return a.rank - b.rank || a.num - b.num;
}

/**
 * The pane's sections. "Needs you" is every open item awaiting the user, of any kind, the latest
 * change first; a task in it is still listed under Tasks too. Tasks are the open tasks in rank
 * order (the order a drag changes), Decisions the open decisions newest first, Done the closed
 * items, the latest closed first.
 */
export function chatTaskSections(items: readonly TrackerItem[]): ChatTaskSections {
    return {
        needsYou: items.filter(needsUser).sort((a, b) => b.updated_at - a.updated_at),
        tasks: items.filter((item) => item.kind === "task" && item.state === "open").sort(byRank),
        decisions: items
            .filter((item) => item.kind === "decision" && item.state === "open")
            .sort((a, b) => b.created_at - a.created_at),
        done: items
            .filter((item) => item.state === "closed")
            .sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0))
            .slice(0, CHAT_TASKS_DONE_LIMIT),
    };
}

export interface TaskMove {
    /** The moved task with the rank it takes until the journal's own lands. */
    moved: TrackerItem;
    change: TrackerRankChange;
}

/**
 * A drag of task `itemId` to `toIndex` in `tasks` (rank order), counted in the list without it.
 * Null when the task is not there or the drop leaves the order as it was. A move to either end
 * sends a position; anywhere else names the new neighbours. The rank staged for the moved task
 * sits between theirs, so the list draws in its new order before the journal answers.
 */
export function planTaskMove(tasks: readonly TrackerItem[], itemId: string, toIndex: number): TaskMove | null {
    const from = tasks.findIndex((task) => task.id === itemId);
    if (from < 0) return null;
    const rest = tasks.filter((task) => task.id !== itemId);
    const target = Math.min(Math.max(toIndex, 0), rest.length);
    if (target === from || rest.length === 0) return null;
    const moving = tasks[from];
    let rank: number;
    let change: TrackerRankChange;
    if (target === 0) {
        rank = rest[0].rank - 1024;
        change = { position: "top" };
    } else if (target === rest.length) {
        rank = rest[rest.length - 1].rank + 1024;
        change = { position: "bottom" };
    } else {
        rank = (rest[target - 1].rank + rest[target].rank) / 2;
        change = { after: rest[target - 1].id, before: rest[target].id };
    }
    return { moved: { ...moving, rank }, change };
}
