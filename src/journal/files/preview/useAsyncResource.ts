/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useCallback, useEffect, useState } from "react";

import { JournalApiError } from "../../api";
import { messageForFileStatus } from "../filesApi";

export interface AsyncResource<T> {
    status: "loading" | "loaded" | "error";
    data?: T;
    error?: string;
    /** HTTP status when the error was a server denial (403/413/404) — lets a renderer branch. */
    errorStatus?: number;
    /** Re-run the loader (retry after a transient failure). */
    reload: () => void;
}

/**
 * Load an async resource whenever `key` changes, with real cancellation: the loader receives an
 * AbortSignal that fires on unmount / key change (so a slow response never writes into a superseded
 * view AND the underlying fetch is aborted). Aborted / disposed rejections are dropped silently
 * (the view is gone); real failures map to the uniform file-denial copy and are retryable.
 */
export function useAsyncResource<T>(loader: (signal: AbortSignal) => Promise<T>, key: string): AsyncResource<T> {
    const [tick, setTick] = useState(0);
    const [resource, setResource] = useState<Omit<AsyncResource<T>, "reload">>({ status: "loading" });
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        setResource({ status: "loading" });
        loader(controller.signal).then(
            (data) => {
                if (!cancelled) setResource({ status: "loaded", data });
            },
            (error: unknown) => {
                if (cancelled) return;
                const code = error instanceof JournalApiError ? error.code : undefined;
                // Superseded (key changed) or torn down (sign-out) — not a user-facing error.
                if (code === "aborted" || code === "disposed") return;
                const status = error instanceof JournalApiError ? error.status : undefined;
                const message =
                    status !== undefined
                        ? messageForFileStatus(status, code)
                        : error instanceof Error
                          ? error.message
                          : "Something went wrong.";
                setResource({ status: "error", error: message, errorStatus: status });
            },
        );
        return () => {
            cancelled = true;
            controller.abort();
        };
        // `key`/`tick` are the intentional deps: callers encode identity into `key`, `tick` forces a
        // retry. The loader closure is re-read on each of those exactly when the target changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, tick]);
    const reload = useCallback(() => setTick((value) => value + 1), []);
    return { ...resource, reload };
}
