/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * React binding for the Files write confirm machine (Phase 2, T-3.2/T-3.3). Owns the phase state,
 * performs the FilesApi call for whichever write is pending, and reports the outcome back through
 * the reducer. The pane above it stays declarative: it calls `begin(...)` from an affordance and
 * renders <FileWriteDialog> when `state` is set.
 *
 * Two guards that are NOT in the disabled attributes:
 *  - `inFlight` — a synchronous ref set before the first await, so two clicks landing in the same
 *    tick cannot both issue a destructive request (a `disabled` prop only takes effect after the
 *    re-render).
 *  - `alive` — the hook drops every outcome after unmount, so a slow delete that resolves once the
 *    pane is closed can never dispatch into a dead tree or fire a refresh.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { JournalApiError } from "../api";
import type { FilesApiLike } from "./filesApi";
import { messageForFileStatus, sanitizeFileName } from "./filesApi";
import { joinPath } from "./format";
import type { WriteInput } from "./FileWriteDialog";
import { advanceUpload, uploadHead, writeReducer, type PendingWrite, type WriteState } from "./writeActions";

export interface FileWrites {
    /** Undefined = idle (no dialog). */
    state: WriteState | undefined;
    begin: (pending: PendingWrite) => void;
    cancel: () => void;
    submit: (input: WriteInput) => void;
    /** Transient post-write line for the pane (dry-run, already-gone, trash destination). */
    notice: string | undefined;
    dismissNotice: () => void;
}

interface Outcome {
    next?: PendingWrite;
    notice?: string;
}

async function perform(api: FilesApiLike, pending: PendingWrite, input: WriteInput): Promise<Outcome> {
    switch (pending.kind) {
        case "mkdir": {
            const name = sanitizeFileName(input.name ?? "");
            if (!name) throw new JournalApiError("Enter a folder name.", 0, "invalid-name");
            const result = await api.mkdir(joinPath(pending.dir, name));
            return { notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "rename": {
            const name = sanitizeFileName(input.name ?? "");
            if (!name) throw new JournalApiError("Enter a name.", 0, "invalid-name");
            const result = await api.move(pending.path, joinPath(pending.dir, name));
            return { notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "upload": {
            const file = uploadHead(pending);
            if (!file) return {};
            const result = await api.upload(file, { targetDir: pending.dir, name: input.name });
            return { next: advanceUpload(pending), notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "edit": {
            // Always overwrite:true — the edit affordance only exists for a file that is already
            // there, and the server copies the prior version into .matron-trash/ before replacing.
            const result = await api.writeFile(pending.path, input.content ?? "", { overwrite: true });
            return { notice: result.dryRun ? DRY_RUN_NOTICE : undefined };
        }
        case "delete": {
            const result = await api.deleteEntry(pending.path, { confirm: true, recursive: pending.isDir });
            if (result.dryRun) return { notice: DRY_RUN_NOTICE };
            if (result.alreadyMissing) return { notice: `${pending.name} was already gone.` };
            return {
                notice: result.trashed
                    ? `${pending.name} moved to ${result.trashed}`
                    : `${pending.name} was moved to the server's trash.`,
            };
        }
    }
}

const DRY_RUN_NOTICE = "The server is in dry-run mode: it recorded the request and changed nothing.";

function describeFailure(error: unknown): string {
    if (error instanceof JournalApiError) {
        // A client-side refusal (bad name) carries its own message; server denials get the uniform,
        // reason-agnostic copy so the UI never leaks WHY a path was rejected.
        return error.status === 0 && error.code === "invalid-name"
            ? error.message
            : messageForFileStatus(error.status, error.code);
    }
    return error instanceof Error ? error.message : "Something went wrong.";
}

export function useFileWrites(api: FilesApiLike | undefined, onWritten: () => void): FileWrites {
    const [state, dispatch] = useReducer(writeReducer, undefined);
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const stateRef = useRef<WriteState | undefined>(undefined);
    stateRef.current = state;
    const inFlight = useRef(false);
    const alive = useRef(true);
    useEffect(
        () => () => {
            alive.current = false;
        },
        [],
    );

    const begin = useCallback((pending: PendingWrite) => {
        setNotice(undefined);
        dispatch({ type: "open", pending });
    }, []);
    const cancel = useCallback(() => dispatch({ type: "cancel" }), []);
    const dismissNotice = useCallback(() => setNotice(undefined), []);

    const submit = useCallback(
        (input: WriteInput) => {
            const current = stateRef.current;
            if (!current || current.phase !== "confirming") return;
            if (inFlight.current) return; // synchronous double-submit guard
            if (!api) {
                dispatch({ type: "failed", message: messageForFileStatus(401) });
                return;
            }
            inFlight.current = true;
            dispatch({ type: "submit" });
            void (async () => {
                try {
                    const outcome = await perform(api, current.pending, input);
                    if (!alive.current) return;
                    setNotice(outcome.notice);
                    dispatch({ type: "settled", next: outcome.next });
                    // Refresh AFTER the transition so the listing and the dialog agree; runs for
                    // every success, including mid-queue uploads.
                    onWritten();
                } catch (error) {
                    if (!alive.current) return;
                    dispatch({ type: "failed", message: describeFailure(error) });
                } finally {
                    inFlight.current = false;
                }
            })();
        },
        [api, onWritten],
    );

    return { state, begin, cancel, submit, notice, dismissNotice };
}
