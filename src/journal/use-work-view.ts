/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkViewEnvelope, WorkViewGroupBy } from "./work-view";

export const WORK_VIEW_REFRESH_INTERVAL_MS = 20_000;
/**
 * Transport-independent deadline for a single Work request.
 *
 * The AbortController below frees a browser `fetch`, but Electron's
 * `journalRequest` IPC bridge observes no signal (see JournalApi.request), so an
 * aborted request can still be in flight on the desktop transport. Without a
 * deadline that settles regardless of transport, an IPC call that hangs leaves
 * the pane on "Loading Work..." forever while the interval stacks up one more
 * live request every tick. Same reasoning and same Promise.race shape as
 * MESSAGE_SEARCH_TIMEOUT_MS in client.ts.
 *
 * Kept below the refresh interval so a wedged request is always resolved before
 * the next tick is due.
 */
export const WORK_VIEW_REQUEST_TIMEOUT_MS = 15_000;

export type WorkViewLoadState = { status: "loading" } | WorkViewEnvelope | { status: "request_error"; error: Error };

export interface WorkViewData {
    state: WorkViewLoadState;
    refresh(): void;
}

export interface WorkViewLoader {
    work(groupBy: WorkViewGroupBy, signal?: AbortSignal): Promise<WorkViewEnvelope>;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error("Could not load Work.");
}

/** Keep a mounted Work surface fresh without allowing superseded responses to win. */
export function useWorkView(
    api: WorkViewLoader,
    groupBy: WorkViewGroupBy,
    refreshIntervalMs = WORK_VIEW_REFRESH_INTERVAL_MS,
    requestTimeoutMs = WORK_VIEW_REQUEST_TIMEOUT_MS,
): WorkViewData {
    const [state, setState] = useState<WorkViewLoadState>({ status: "loading" });
    const requestRef = useRef<AbortController | undefined>(undefined);
    const generationRef = useRef(0);
    const inFlightRef = useRef(false);

    /**
     * `force` distinguishes intent from housekeeping.
     *
     * The unattended interval passes `false`: it is backpressured, so a timer
     * tick can never stack a second live request on a transport that ignored
     * the abort. Focus and the caller-facing `refresh()` pass `true`: those are
     * the user asking for current data, and silently dropping them would leave
     * the pane stale for up to a whole interval with no feedback. Superseding is
     * safe because the abort + generation guard below already stops a late
     * response from overwriting a newer one.
     *
     * Note the interval guard is deliberately belt-and-braces: WORK_VIEW_REQUEST_
     * TIMEOUT_MS is shorter than WORK_VIEW_REFRESH_INTERVAL_MS, so every request
     * has already settled by the time the next tick is due.
     */
    const run = useCallback(
        (force: boolean) => {
            if (!force && inFlightRef.current) return;
            requestRef.current?.abort();
            const generation = ++generationRef.current;
            const controller = new AbortController();
            requestRef.current = controller;
            inFlightRef.current = true;

            const call = api.work(groupBy, controller.signal);
            // The deadline below rejects the race, not this promise; swallow its own
            // rejection so a late transport failure cannot surface as unhandled.
            void call.catch(() => undefined);

            let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<never>((_resolve, reject) => {
                timeoutTimer = setTimeout(() => {
                    reject(new Error("Work request timed out."));
                    // Still abort, so a transport that DOES observe the signal is freed.
                    controller.abort();
                }, requestTimeoutMs);
            });

            const settle = (apply: () => void) => {
                if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
                // Release the slot on every path, including a superseded generation,
                // or one stale response would wedge the loop permanently.
                inFlightRef.current = false;
                if (generationRef.current !== generation) return;
                apply();
            };

            void Promise.race([call, deadline]).then(
                (envelope) => settle(() => setState(envelope)),
                (error: unknown) => settle(() => setState({ status: "request_error", error: asError(error) })),
            );
        },
        [api, groupBy, requestTimeoutMs],
    );

    const refresh = useCallback(() => run(true), [run]);

    useEffect(() => {
        setState({ status: "loading" });
        run(true);
        const onInterval = () => run(false);
        const onFocus = () => run(true);
        const interval = window.setInterval(onInterval, refreshIntervalMs);
        window.addEventListener("focus", onFocus);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener("focus", onFocus);
            requestRef.current?.abort();
            // Unmount invalidates every outstanding generation, so a response
            // that lands after teardown can never setState on a dead component.
            generationRef.current += 1;
            inFlightRef.current = false;
        };
    }, [run, refreshIntervalMs]);

    return { state, refresh };
}
