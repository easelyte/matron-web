/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Settings → Security → Password (journal POST /password). A row with Change Password…, which
 * opens a sheet asking for the current password and the new one twice, with "Sign out of my other
 * devices" on by default. Agent boxes are never signed out, and this browser stays signed in.
 *
 * A wrong current password is a 401 `bad_password`: it is shown on the form like any other
 * refusal and never treated as an expired session. The passwords live only in the sheet's state
 * and go with it when it closes.
 */

import React, { useRef, useState } from "react";

import { JournalApiError, knownErrorMessage } from "./api";
import type { MatronJournalClient } from "./client";
import { DeviceSheet } from "./DevicesSettings";
import { lockedOutMessage, passwordProblem } from "./password-rules";

export { lockedOutMessage, newPasswordProblem, PASSWORD_MIN_LENGTH, passwordProblem } from "./password-rules";

/** The sentence for a failed change. */
export function changePasswordFailure(error: unknown): string {
    if (error instanceof JournalApiError) {
        if (error.code === "locked_out" && typeof error.retryAfter === "number" && error.retryAfter > 0) {
            return lockedOutMessage(error.retryAfter);
        }
        if (error.code === "bad_password" || error.code === "weak_password") return knownErrorMessage(error.code)!;
        if (error.status === 0) return "Couldn't reach the journal. Check your connection and try again.";
    }
    return error instanceof Error ? error.message : "Something went wrong.";
}

/** What the row says after a change. */
export function passwordChangedMessage(signedOut: number): string {
    if (signedOut <= 0) return "Password changed.";
    return `Password changed. Signed out of ${signedOut} other ${signedOut === 1 ? "device" : "devices"}.`;
}

/** The Password row of Settings → Security. `onChanged` runs after a change (to re-read Devices). */
export function ChangePassword({
    client,
    onChanged,
}: {
    client: MatronJournalClient;
    onChanged?: (signedOut: number) => void;
}): React.ReactElement {
    // Which sheet is open (each opening gets a new number), so a change that finishes after its
    // sheet was closed still reports, but never closes a sheet opened since.
    const [sheet, setSheet] = useState<number>();
    const opened = useRef(0);
    const [done, setDone] = useState<string>();

    return (
        <>
            <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow" data-change-password>
                <span className="mj_SettingsSheet_switchText">
                    <span>Password</span>
                    {done ? (
                        <span className="mj_SettingsSheet_help mj_ChangePassword_done" role="status">
                            {done}
                        </span>
                    ) : (
                        <span className="mj_SettingsSheet_help">Used to sign in on a new device.</span>
                    )}
                </span>
                <button
                    type="button"
                    className="mj_SettingsSheet_clear"
                    data-action="change-password"
                    onClick={() => {
                        setDone(undefined);
                        setSheet(++opened.current);
                    }}
                >
                    Change Password…
                </button>
            </div>
            {sheet !== undefined && (
                <ChangePasswordSheet
                    key={sheet}
                    client={client}
                    onClose={() => setSheet(undefined)}
                    onChanged={(signedOut) => {
                        setSheet((current) => (current === sheet ? undefined : current));
                        setDone(passwordChangedMessage(signedOut));
                        onChanged?.(signedOut);
                    }}
                />
            )}
        </>
    );
}

function ChangePasswordSheet({
    client,
    onClose,
    onChanged,
}: {
    client: MatronJournalClient;
    onClose: () => void;
    onChanged: (signedOut: number) => void;
}): React.ReactElement {
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirm, setConfirm] = useState("");
    const [signOutOthers, setSignOutOthers] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    const empty = !current || !next || !confirm;

    const submit = async (): Promise<void> => {
        if (busy || empty) return;
        const problem = passwordProblem(current, next, confirm);
        if (problem) {
            setError(problem);
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const result = await client.changePassword(current, next, signOutOthers);
            setCurrent("");
            setNext("");
            setConfirm("");
            onChanged(result.signed_out);
            return;
        } catch (failure) {
            setError(changePasswordFailure(failure));
            // Whatever went wrong, the current password is typed again; the new one stays.
            setCurrent("");
        }
        setBusy(false);
    };

    return (
        <DeviceSheet
            id="mj-change-password-title"
            title="Change Password"
            className="mj_ChangePasswordSheet"
            onClose={onClose}
            onSubmit={() => void submit()}
        >
            <div>
                <label htmlFor="mj-change-password-current">Current password</label>
                <input
                    id="mj-change-password-current"
                    type="password"
                    data-autofocus
                    autoComplete="current-password"
                    value={current}
                    onChange={(event) => setCurrent(event.target.value)}
                />
            </div>
            <div>
                <label htmlFor="mj-change-password-new">New password</label>
                <input
                    id="mj-change-password-new"
                    type="password"
                    autoComplete="new-password"
                    value={next}
                    onChange={(event) => setNext(event.target.value)}
                />
            </div>
            <div>
                <label htmlFor="mj-change-password-confirm">Confirm new password</label>
                <input
                    id="mj-change-password-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                />
            </div>
            <div className="mj_ChangePassword_signOut">
                <label className="mj_RecoveryCodes_saved">
                    <input
                        type="checkbox"
                        checked={signOutOthers}
                        data-sign-out-others
                        aria-describedby="mj-change-password-sign-out-help"
                        onChange={(event) => setSignOutOthers(event.target.checked)}
                    />
                    Sign out of my other devices
                </label>
                <p id="mj-change-password-sign-out-help" className="mj_ChangePassword_hint">
                    Your agent boxes stay connected.
                </p>
            </div>
            {error && (
                <p className="mj_UploadConfirm_error" role="alert">
                    {error}
                </p>
            )}
            <div className="mj_UploadConfirm_actions">
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
                <button type="submit" className="mj_UploadConfirm_send" disabled={busy || empty}>
                    Change Password
                </button>
            </div>
        </DeviceSheet>
    );
}
