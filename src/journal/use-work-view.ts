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
    // True while an underlying transport call is still outstanding. On Electron
    // that call is uncancellable, so this is latched until the call settles --
    // deliberately NOT until the UI deadline fires. See `run` below.
    const occupiedRef = useRef(false);

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
     * TRANSPORT OCCUPANCY IS NOT THE UI DEADLINE. These are two different
     * questions and conflating them reintroduces the very accumulation this
     * guards against:
     *
     *   - the UI deadline decides when to stop showing "Loading" and surface a
     *     timeout. It fires at `requestTimeoutMs`.
     *   - transport occupancy decides whether an UNCANCELLABLE call is still
     *     outstanding. On Electron the abort frees nothing, so the call can
     *     still be live long after the deadline rejected the race.
     *
     * Releasing occupancy when the deadline fires would let the next interval
     * tick start another uncancellable IPC while the first is still pending --
     * one more every tick, forever. So `occupiedRef` is latched until `call`
     * ITSELF settles, independently of the deadline.
     */
    const run = useCallback(
        (force: boolean) => {
            if (!force && occupiedRef.current) return;
            requestRef.current?.abort();
            const generation = ++generationRef.current;
            const controller = new AbortController();
            requestRef.current = controller;
            occupiedRef.current = true;

            const call = api.work(groupBy, controller.signal);
            // Occupancy is released ONLY here -- when the transport actually
            // settles -- not when the deadline below fires. The catch also
            // swallows a late transport failure that the race already rejected,
            // so it cannot surface as an unhandled rejection.
            void call.then(
                () => {
                    occupiedRef.current = false;
                },
                () => {
                    occupiedRef.current = false;
                },
            );

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
            occupiedRef.current = false;
        };
    }, [run, refreshIntervalMs]);

    return { state, refresh };
}
