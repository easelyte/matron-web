/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * "Developer view" (named "Show the work" in the v6 handoff; renamed in design round 2) — the one
 * v6 thread setting (CONTRACTS 6). A per-operator client preference,
 * default OFF: the thread tucks each turn's steps into one turn card. ON renders
 * the thread exactly as before v6.
 */

import { useSyncExternalStore } from "react";

export const SHOW_THE_WORK_KEY = "matron.showTheWork";

const listeners = new Set<() => void>();

export function readShowTheWork(): boolean {
    try {
        return localStorage.getItem(SHOW_THE_WORK_KEY) === "true";
    } catch {
        return false;
    }
}

export function writeShowTheWork(value: boolean): void {
    try {
        if (value) localStorage.setItem(SHOW_THE_WORK_KEY, "true");
        else localStorage.removeItem(SHOW_THE_WORK_KEY);
    } catch {
        // Storage unavailable (private mode quota, disabled storage): the toggle still flips
        // for this tab through the in-memory override below.
    }
    override = value;
    for (const listener of listeners) listener();
}

// Last value written in this tab, so a failed storage write still takes effect here.
let override: boolean | undefined;

function snapshot(): boolean {
    return override ?? readShowTheWork();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    // Another tab flipped it: drop our override and re-read storage.
    const onStorage = (event: StorageEvent): void => {
        if (event.key !== SHOW_THE_WORK_KEY && event.key !== null) return;
        override = undefined;
        listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
    };
}

/** [showTheWork, setShowTheWork] — shared by every component, synced across tabs. */
export function useShowTheWork(): [boolean, (value: boolean) => void] {
    const value = useSyncExternalStore(subscribe, snapshot, () => false);
    return [value, writeShowTheWork];
}

/** Test seam: forget the in-tab override. */
export function resetShowTheWorkForTests(): void {
    override = undefined;
}
