/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Settings → Security → Email address (journal GET/PUT /account/email): where a reset link goes
 * when the user forgets their password. Changing or removing it needs the current password; a
 * wrong one is a 401 `bad_password`, shown on the form and never taken as an expired session.
 *
 * Settings → Users (admins, GET /users and PUT /users/:id/email): every account's address, which
 * an admin can set or clear without the user's password.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import { JournalApiError, knownErrorMessage } from "./api";
import { lockedOutMessage } from "./password-rules";
import type { MatronJournalClient } from "./client";
import { DeviceSheet } from "./DevicesSettings";
import type { AccountEmail, JournalUser } from "./types";

/** The sentence for a refused address change. */
export function emailFailure(error: unknown): string {
    if (error instanceof JournalApiError) {
        if (error.code === "locked_out" && typeof error.retryAfter === "number" && error.retryAfter > 0) {
            return lockedOutMessage(error.retryAfter);
        }
        const known =
            error.code === "bad_email" || error.code === "email_taken" || error.code === "bad_password"
                ? knownErrorMessage(error.code)
                : undefined;
        if (known) return known;
        if (error.status === 0) return "Couldn't reach the journal. Check your connection and try again.";
    }
    return error instanceof Error ? error.message : "Something went wrong.";
}

/** A quick shape check before sending; the journal has the last word. */
export function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// ── Settings → Security → Email address ─────────────────────────────────────────────────────

/** The Email address row. Hidden on a journal without /account/email (404). */
export function AccountEmailRow({ client }: { client: MatronJournalClient }): React.ReactElement | null {
    const [account, setAccount] = useState<AccountEmail>();
    const [missing, setMissing] = useState(false);
    const [error, setError] = useState<string>();
    const [editing, setEditing] = useState(false);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        client.accountEmail().then(
            (loaded) => {
                if (mounted.current) setAccount(loaded);
            },
            (failure: unknown) => {
                if (!mounted.current) return;
                if (failure instanceof JournalApiError && (failure.status === 404 || failure.status === 403)) {
                    setMissing(true);
                } else setError(`Couldn't load your email address: ${emailFailure(failure)}`);
            },
        );
        return () => {
            mounted.current = false;
        };
    }, [client]);

    if (missing || (!account && !error)) return null;
    if (!account) {
        return (
            <div className="mj_SettingsSheet_row" data-account-email="error">
                <span className="mj_SettingsSheet_error" role="alert">
                    {error}
                </span>
            </div>
        );
    }

    return (
        <>
            <div
                className="mj_SettingsSheet_row mj_SettingsSheet_switchRow"
                data-account-email={account.email ? "set" : "unset"}
            >
                <span className="mj_SettingsSheet_switchText">
                    <span>Email address</span>
                    <span className="mj_AccountEmail_value">{account.email ?? "Not set"}</span>
                    <span className="mj_SettingsSheet_help">
                        Used to reset your password if you forget it.
                        {!account.reset_by_email && " This journal can't send email yet."}
                    </span>
                </span>
                <button
                    type="button"
                    className="mj_SettingsSheet_clear"
                    data-action="account-email"
                    onClick={() => setEditing(true)}
                >
                    {account.email ? "Change…" : "Add…"}
                </button>
            </div>
            {editing && (
                <EmailSheet
                    title={account.email ? "Change Email Address" : "Add Email Address"}
                    current={account.email}
                    askPassword
                    save={(email, password) => client.setAccountEmail(password, email)}
                    onSaved={(email) => {
                        setAccount({ ...account, email });
                        setEditing(false);
                    }}
                    onClose={() => setEditing(false)}
                />
            )}
        </>
    );
}

// ── The sheet ────────────────────────────────────────────────────────────────────────────────

function EmailSheet({
    title,
    current,
    askPassword,
    who,
    save,
    onSaved,
    onClose,
}: {
    title: string;
    current: string | null;
    /** The user's own address needs their current password; an admin editing another doesn't. */
    askPassword: boolean;
    /** Whose address, for an admin editing someone else's. */
    who?: string;
    save: (email: string | null, password: string) => Promise<{ email: string | null }>;
    onSaved: (email: string | null) => void;
    onClose: () => void;
}): React.ReactElement {
    const [email, setEmail] = useState(current ?? "");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    const passwordMissing = askPassword && !password;
    const run = async (next: string | null): Promise<void> => {
        if (busy || passwordMissing) return;
        if (next !== null && !looksLikeEmail(next)) {
            setError("Enter a valid email address.");
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const result = await save(next === null ? null : next.trim(), password);
            setPassword("");
            onSaved(result.email);
            return;
        } catch (failure) {
            setError(emailFailure(failure));
            setPassword("");
        }
        setBusy(false);
    };

    return (
        <DeviceSheet
            id="mj-account-email-title"
            title={title}
            className="mj_AccountEmailSheet"
            onClose={onClose}
            onSubmit={() => void run(email)}
        >
            {who && <p>{`The address ${who}'s password reset links go to.`}</p>}
            <div>
                <label htmlFor="mj-account-email">Email address</label>
                <input
                    id="mj-account-email"
                    type="email"
                    data-autofocus
                    autoComplete={askPassword ? "email" : "off"}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="alice@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                />
            </div>
            {askPassword && (
                <div>
                    <label htmlFor="mj-account-email-password">Current password</label>
                    <input
                        id="mj-account-email-password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                    />
                </div>
            )}
            {error && (
                <p className="mj_UploadConfirm_error" role="alert">
                    {error}
                </p>
            )}
            <div className="mj_UploadConfirm_actions">
                {current && (
                    <button
                        type="button"
                        className="mj_AccountEmail_remove"
                        data-action="remove-email"
                        disabled={busy || passwordMissing}
                        onClick={() => void run(null)}
                    >
                        Remove
                    </button>
                )}
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
                <button
                    type="submit"
                    className="mj_UploadConfirm_send"
                    disabled={busy || passwordMissing || !email.trim() || email.trim() === current}
                >
                    Save
                </button>
            </div>
        </DeviceSheet>
    );
}

// ── Settings → Users (admins) ────────────────────────────────────────────────────────────────

/** Settings → Users: each account's email address. Only for admins; hidden otherwise. */
export function UsersSettings({ client }: { client: MatronJournalClient }): React.ReactElement | null {
    const [users, setUsers] = useState<JournalUser[]>();
    const [error, setError] = useState<string>();
    const [editing, setEditing] = useState<JournalUser>();
    const mounted = useRef(true);

    const refresh = useCallback(async (): Promise<void> => {
        try {
            const list = await client.listUsers();
            if (!mounted.current) return;
            setUsers([...list].sort((a, b) => a.name.localeCompare(b.name)));
            setError(undefined);
        } catch (failure) {
            if (mounted.current) setError(`Couldn't load users: ${emailFailure(failure)}`);
        }
    }, [client]);

    useEffect(() => {
        mounted.current = true;
        client.isAdmin().then(
            (admin) => {
                if (admin && mounted.current) void refresh();
            },
            () => undefined,
        );
        return () => {
            mounted.current = false;
        };
    }, [client, refresh]);

    if (!users && !error) return null;

    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-users">
            <h3 id="mj-settings-users" className="mj_SettingsSheet_groupTitle">
                Users
            </h3>
            {users && users.length > 0 && (
                <ul className="mj_SettingsSheet_rows mj_DevicesList">
                    {users.map((user) => (
                        <li key={user.id} className="mj_SettingsSheet_row mj_DevicesList_row" data-user={user.id}>
                            <span className="mj_DevicesList_text">
                                <span className="mj_DevicesList_name">
                                    {user.name}
                                    {user.is_admin && <span className="mj_DevicesList_self">Admin</span>}
                                </span>
                                <span className="mj_DevicesList_caption" data-user-email>
                                    {user.email ?? "No email address"}
                                </span>
                            </span>
                            <span className="mj_DevicesList_actions">
                                <button type="button" data-user-action="email" onClick={() => setEditing(user)}>
                                    Email…
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {error && (
                <p className="mj_SettingsSheet_error" role="alert">
                    {error}
                </p>
            )}
            {editing && (
                <EmailSheet
                    title={`Email Address for ${editing.name}`}
                    who={editing.name}
                    current={editing.email}
                    askPassword={false}
                    save={async (email) => {
                        const user = await client.setUserEmail(editing.id, email);
                        return { email: user ? user.email : email };
                    }}
                    onSaved={(email) => {
                        setUsers((list) => list?.map((user) => (user.id === editing.id ? { ...user, email } : user)));
                        setEditing(undefined);
                        void refresh();
                    }}
                    onClose={() => setEditing(undefined)}
                />
            )}
        </section>
    );
}
