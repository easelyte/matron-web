/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkViewEnvelope, WorkViewGroupBy } from "./work-view";

export const WORK_VIEW_REFRESH_INTERVAL_MS = 20_000;

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
): WorkViewData {
    const [state, setState] = useState<WorkViewLoadState>({ status: "loading" });
    const requestRef = useRef<AbortController | undefined>(undefined);
    const generationRef = useRef(0);

    const refresh = useCallback(() => {
        requestRef.current?.abort();
        const generation = ++generationRef.current;
        const controller = new AbortController();
        requestRef.current = controller;

        void api.work(groupBy, controller.signal).then(
            (envelope) => {
                if (controller.signal.aborted || generationRef.current !== generation) return;
                setState(envelope);
            },
            (error: unknown) => {
                if (controller.signal.aborted || generationRef.current !== generation) return;
                setState({ status: "request_error", error: asError(error) });
            },
        );
    }, [api, groupBy]);

    useEffect(() => {
        setState({ status: "loading" });
        refresh();
        const interval = window.setInterval(refresh, refreshIntervalMs);
        window.addEventListener("focus", refresh);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener("focus", refresh);
            requestRef.current?.abort();
        };
    }, [refresh, refreshIntervalMs]);

    return { state, refresh };
}
