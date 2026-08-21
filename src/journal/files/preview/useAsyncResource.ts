/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useEffect, useState } from "react";

import { JournalApiError } from "../../api";
import { messageForFileStatus } from "../filesApi";

export interface AsyncResource<T> {
    status: "loading" | "loaded" | "error";
    data?: T;
    error?: string;
    /** HTTP status when the error was a server denial (403/413/404) — lets a renderer branch. */
    errorStatus?: number;
}

/**
 * Load an async resource whenever `key` changes, with cancellation on unmount / key change so a
 * slow response never writes into a superseded view (mirrors the client's selection-epoch guard).
 * Errors are mapped to the uniform file-denial copy.
 */
export function useAsyncResource<T>(loader: () => Promise<T>, key: string): AsyncResource<T> {
    const [resource, setResource] = useState<AsyncResource<T>>({ status: "loading" });
    useEffect(() => {
        let cancelled = false;
        setResource({ status: "loading" });
        loader().then(
            (data) => {
                if (!cancelled) setResource({ status: "loaded", data });
            },
            (error: unknown) => {
                if (cancelled) return;
                const status = error instanceof JournalApiError ? error.status : undefined;
                const message =
                    status !== undefined
                        ? messageForFileStatus(status)
                        : error instanceof Error
                          ? error.message
                          : "Something went wrong.";
                setResource({ status: "error", error: message, errorStatus: status });
            },
        );
        return () => {
            cancelled = true;
        };
        // `key` is the intentional single dependency: callers encode identity (path + disposition)
        // into it so the loader closure is re-run exactly when the target changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return resource;
}
