/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useCallback, useState } from "react";

import { JournalApiError } from "../../api";
import { type FilesApiLike, messageForFileStatus } from "../filesApi";

export interface DownloadState {
    download: () => void;
    busy: boolean;
    error?: string;
}

/**
 * Download-with-visible-errors (F5). A 403/404/413/network/timeout failure lands in `error` (uniform
 * status copy) instead of an unhandled rejection + a silently-reset button. Aborted/disposed drops
 * are ignored (the view is gone).
 */
export function useDownload(api: FilesApiLike | undefined, path: string, filename: string): DownloadState {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const download = useCallback(() => {
        if (!api) return;
        setBusy(true);
        setError(undefined);
        api.download(path, filename)
            .then(
                () => undefined,
                (err: unknown) => {
                    const code = err instanceof JournalApiError ? err.code : undefined;
                    if (code === "aborted" || code === "disposed") return;
                    const status = err instanceof JournalApiError ? err.status : undefined;
                    setError(
                        status !== undefined
                            ? messageForFileStatus(status, code)
                            : err instanceof Error
                              ? err.message
                              : "Download failed.",
                    );
                },
            )
            .finally(() => setBusy(false));
    }, [api, path, filename]);
    return { download, busy, error };
}
