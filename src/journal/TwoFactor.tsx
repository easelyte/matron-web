/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Two-factor sign-in (journal docs/protocol.md "Two-factor sign-in"): codes from an authenticator
 * app such as Google Authenticator or 1Password, and ten single-use recovery codes.
 *
 * - TwoFactorSignIn is the sign-in screen's second step. After a right password the journal hands
 *   back a five-minute ticket instead of a token, and this asks for a code (or a recovery code).
 *   When the journal requires two-factor of a user who has not set it up, it walks them through
 *   setup first, then shows their recovery codes before opening the app.
 * - SecuritySettings is Settings → Security: set it up, make new recovery codes, move to a new
 *   app, turn it off, and (admins) require it for everyone. Email address (AccountEmail.tsx)
 *   and Change Password… (ChangePassword.tsx) sit at the top of the same group.
 *
 * The secret and the recovery codes are only ever shown here, in the user's own browser.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import { JournalApiError } from "./api";
import type { HeldSignIn, MatronJournalClient, TwoFactorChallenge } from "./client";
import { AccountEmailRow } from "./AccountEmail";
import { ChangePassword } from "./ChangePassword";
import { copyText } from "./clipboard";
import { DeviceSheet, QrCode } from "./DevicesSettings";
import type { TwoFactorSetup, TwoFactorStatus } from "./types";

/** Fewer recovery codes than this left, and Settings suggests making a new set. */
export const RECOVERY_CODES_LOW = 3;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong.");

/** Whether a failed code step has used up its ticket: the user must type their password again. */
function ticketSpent(error: unknown): boolean {
    if (!(error instanceof JournalApiError)) return false;
    if (error.code === "two_factor_ticket_invalid" || error.code === "locked_out") return true;
    return error.code === "bad_code" && error.body?.ticket_valid === false;
}

/** The secret in groups of four, the way authenticator apps ask for it to be typed. */
export function groupedSecret(secret: string): string {
    return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

// ── Shared pieces ────────────────────────────────────────────────────────────────────────────

/** The QR code an authenticator app scans, with the key to type in for one that can't scan. */
export function SetupCode({ setup }: { setup: TwoFactorSetup }): React.ReactElement {
    const [copied, setCopied] = useState(false);
    return (
        <div className="mj_TwoFactorSetup">
            <QrCode value={setup.otpauth_uri} size={180} label="Two-factor setup QR code" />
            <p className="mj_TwoFactorSetup_hint">
                Scan this with your authenticator app, or type in the key. It shows up as{" "}
                <strong>{setup.issuer}</strong> ({setup.account}).
            </p>
            <p className="mj_TwoFactorSetup_secret" data-two-factor-secret>
                {groupedSecret(setup.secret)}
            </p>
            <div className="mj_TwoFactorSetup_actions">
                <button
                    type="button"
                    onClick={() => void copyText(setup.secret).then((ok) => setCopied(ok))}
                    data-action="copy-secret"
                >
                    {copied ? "Copied" : "Copy key"}
                </button>
                <a href={setup.otpauth_uri} data-action="open-authenticator">
                    Open in authenticator app
                </a>
            </div>
        </div>
    );
}

/** The recovery codes, shown once, with Copy and Download and an "I've saved them" check. */
export function RecoveryCodes({
    codes,
    doneLabel,
    onDone,
    busy = false,
}: {
    codes: string[];
    doneLabel: string;
    onDone: () => void;
    /** Done is pressed and its work is under way: the button stays disabled. */
    busy?: boolean;
}): React.ReactElement {
    const [saved, setSaved] = useState(false);
    const [copied, setCopied] = useState(false);
    const text = `Matron recovery codes\nEach code works once, in place of a code from your authenticator app.\n\n${codes.join("\n")}\n`;
    return (
        <div className="mj_RecoveryCodes">
            <p>
                Keep these somewhere safe, such as your password manager. Each one signs you in once if you lose your
                authenticator app. You won&apos;t see them again.
            </p>
            <ol className="mj_RecoveryCodes_list" data-recovery-codes>
                {codes.map((code) => (
                    <li key={code}>
                        <code>{code}</code>
                    </li>
                ))}
            </ol>
            <div className="mj_TwoFactorSetup_actions">
                <button
                    type="button"
                    data-action="copy-recovery-codes"
                    onClick={() => void copyText(codes.join("\n")).then((ok) => setCopied(ok))}
                >
                    {copied ? "Copied" : "Copy"}
                </button>
                <a
                    href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
                    download="matron-recovery-codes.txt"
                    data-action="download-recovery-codes"
                >
                    Download
                </a>
            </div>
            <label className="mj_RecoveryCodes_saved">
                <input
                    type="checkbox"
                    checked={saved}
                    data-recovery-saved
                    onChange={(event) => setSaved(event.target.checked)}
                />
                I&apos;ve saved these codes
            </label>
            <button type="button" className="mj_RecoveryCodes_done" disabled={!saved || busy} onClick={onDone}>
                {doneLabel}
            </button>
        </div>
    );
}

function CodeInput({
    id,
    value,
    onChange,
    allowRecovery,
    autoFocus = true,
}: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    /** Recovery codes have letters, so the field cannot be digits-only. */
    allowRecovery: boolean;
    autoFocus?: boolean;
}): React.ReactElement {
    return (
        <input
            id={id}
            type="text"
            inputMode={allowRecovery ? "text" : "numeric"}
            pattern={allowRecovery ? undefined : "[0-9 ]*"}
            autoComplete="one-time-code"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={allowRecovery ? 24 : 7}
            placeholder={allowRecovery ? "123456 or recovery code" : "123456"}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoFocus={autoFocus}
            data-autofocus={autoFocus ? true : undefined}
        />
    );
}

/**
 * Finishing a held sign-in, once: a second press while the first is still opening the app would
 * start a second session. A failure is shown and the button works again.
 */
function useFinish(): { finishing: boolean; error?: string; finish: (held: HeldSignIn) => void } {
    const [finishing, setFinishing] = useState(false);
    const [error, setError] = useState<string>();
    const inFlight = useRef(false);
    const finish = (held: HeldSignIn): void => {
        if (inFlight.current) return;
        inFlight.current = true;
        setFinishing(true);
        setError(undefined);
        held.finish().catch((failure: unknown) => {
            inFlight.current = false;
            setFinishing(false);
            setError(messageOf(failure));
        });
    };
    return { finishing, error, finish };
}

// ── Sign-in step ─────────────────────────────────────────────────────────────────────────────

/**
 * The second step of signing in. `onBack` returns to the password form, with a message when the
 * ticket is spent (too many wrong codes, locked out, or it timed out).
 */
export function TwoFactorSignIn({
    client,
    challenge,
    onBack,
}: {
    client: MatronJournalClient;
    challenge: TwoFactorChallenge;
    onBack: (message?: string) => void;
}): React.ReactElement {
    return challenge.kind === "code" ? (
        <CodeStep client={client} challenge={challenge} onBack={onBack} />
    ) : (
        <EnrolStep client={client} challenge={challenge} onBack={onBack} />
    );
}

function CodeStep({
    client,
    challenge,
    onBack,
}: {
    client: MatronJournalClient;
    challenge: TwoFactorChallenge;
    onBack: (message?: string) => void;
}): React.ReactElement {
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [held, setHeld] = useState<{ left: number } & HeldSignIn>();
    const finishing = useFinish();

    const submit = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();
        if (busy || !code.trim()) return;
        setBusy(true);
        setError(undefined);
        try {
            const result = await client.loginWithCode(challenge, code);
            if (result.usedRecoveryCode) {
                setHeld({ left: result.recoveryCodesLeft, finish: result.finish });
                setBusy(false);
                return;
            }
            await result.finish();
        } catch (failure) {
            if (ticketSpent(failure)) {
                onBack(
                    failure instanceof JournalApiError && failure.code === "bad_code"
                        ? "Too many wrong codes. Enter your password again."
                        : messageOf(failure),
                );
                return;
            }
            setError(messageOf(failure));
            setCode("");
            setBusy(false);
        }
    };

    if (held) {
        return (
            <div className="mj_LoginForm mj_TwoFactorStep" data-two-factor-step="recovery-used">
                <p className="mj_TwoFactorStep_text">
                    You signed in with a recovery code. You have{" "}
                    <strong>
                        {held.left} {held.left === 1 ? "code" : "codes"}
                    </strong>{" "}
                    left. Make a new set in Settings → Security.
                </p>
                {finishing.error && (
                    <div className="mj_Error mj_Login_error" role="alert">
                        {finishing.error}
                    </div>
                )}
                <button
                    className="mj_LoginSubmit"
                    type="button"
                    disabled={finishing.finishing}
                    onClick={() => finishing.finish(held)}
                >
                    Continue
                </button>
            </div>
        );
    }

    return (
        <form className="mj_LoginForm mj_TwoFactorStep" data-two-factor-step="code" onSubmit={(e) => void submit(e)}>
            <p className="mj_TwoFactorStep_text">Enter the 6-digit code from your authenticator app.</p>
            <label className="mj_LoginField" htmlFor="mj_LoginForm_code">
                <span className="mj_LoginField_label">Code</span>
                <CodeInput id="mj_LoginForm_code" value={code} onChange={setCode} allowRecovery />
            </label>
            <p className="mj_TwoFactorStep_hint">Lost your phone? Type one of your recovery codes instead.</p>
            {error && (
                <div className="mj_Error mj_Login_error" role="alert">
                    {error}
                </div>
            )}
            <button className="mj_LoginSubmit" type="submit" disabled={busy || !code.trim()}>
                {busy ? "Checking…" : "Verify"}
            </button>
            <button className="mj_TwoFactorStep_back" type="button" onClick={() => onBack()}>
                Back
            </button>
        </form>
    );
}

function EnrolStep({
    client,
    challenge,
    onBack,
}: {
    client: MatronJournalClient;
    challenge: TwoFactorChallenge;
    onBack: (message?: string) => void;
}): React.ReactElement {
    const [setup, setSetup] = useState<TwoFactorSetup>();
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [held, setHeld] = useState<{ codes: string[] } & HeldSignIn>();
    const finishing = useFinish();
    const onBackRef = useRef(onBack);
    onBackRef.current = onBack;

    useEffect(() => {
        let live = true;
        client.loginTwoFactorSetup(challenge).then(
            (loaded) => {
                if (live) setSetup(loaded);
            },
            (failure: unknown) => {
                if (live) onBackRef.current(messageOf(failure));
            },
        );
        return () => {
            live = false;
        };
    }, [client, challenge]);

    const submit = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();
        if (busy || !code.trim()) return;
        setBusy(true);
        setError(undefined);
        try {
            const result = await client.loginTwoFactorEnable(challenge, code);
            setHeld({ codes: result.recoveryCodes, finish: result.finish });
        } catch (failure) {
            if (ticketSpent(failure)) {
                onBack(
                    failure instanceof JournalApiError && failure.code === "bad_code"
                        ? "Too many wrong codes. Enter your password again."
                        : messageOf(failure),
                );
                return;
            }
            setError(messageOf(failure));
            setCode("");
        }
        setBusy(false);
    };

    if (held) {
        return (
            <div className="mj_LoginForm mj_TwoFactorStep" data-two-factor-step="recovery-codes">
                <p className="mj_TwoFactorStep_text">
                    <strong>Two-factor sign-in is on.</strong>
                </p>
                <RecoveryCodes
                    codes={held.codes}
                    doneLabel="Continue"
                    busy={finishing.finishing}
                    onDone={() => finishing.finish(held)}
                />
                {finishing.error && (
                    <div className="mj_Error mj_Login_error" role="alert">
                        {finishing.error}
                    </div>
                )}
            </div>
        );
    }

    return (
        <form className="mj_LoginForm mj_TwoFactorStep" data-two-factor-step="enrol" onSubmit={(e) => void submit(e)}>
            <p className="mj_TwoFactorStep_text">
                This server requires two-factor sign-in. Set it up with an authenticator app such as Google
                Authenticator or 1Password, then enter the code it shows.
            </p>
            {setup ? <SetupCode setup={setup} /> : <p role="status">Getting a setup code…</p>}
            <label className="mj_LoginField" htmlFor="mj_LoginForm_code">
                <span className="mj_LoginField_label">Code from the app</span>
                <CodeInput id="mj_LoginForm_code" value={code} onChange={setCode} allowRecovery={false} />
            </label>
            {error && (
                <div className="mj_Error mj_Login_error" role="alert">
                    {error}
                </div>
            )}
            <button className="mj_LoginSubmit" type="submit" disabled={busy || !setup || !code.trim()}>
                {busy ? "Checking…" : "Turn on and sign in"}
            </button>
            <button className="mj_TwoFactorStep_back" type="button" onClick={() => onBack()}>
                Back
            </button>
        </form>
    );
}

// ── Settings → Security ──────────────────────────────────────────────────────────────────────

type SecurityDialog = "setup" | "move" | "recovery" | "disable";

export function SecuritySettings({
    client,
    onPasswordChanged,
}: {
    client: MatronJournalClient;
    /** After a password change, with how many other devices it signed out. */
    onPasswordChanged?: (signedOut: number) => void;
}): React.ReactElement | null {
    const [status, setStatus] = useState<TwoFactorStatus>();
    const [admin, setAdmin] = useState(false);
    const [missing, setMissing] = useState(false);
    const [error, setError] = useState<string>();
    const [dialog, setDialog] = useState<SecurityDialog>();
    const [policyBusy, setPolicyBusy] = useState(false);
    const mounted = useRef(true);

    const refresh = useCallback(async (): Promise<void> => {
        try {
            const loaded = await client.twoFactorStatus();
            if (!mounted.current) return;
            setStatus(loaded);
            setError(undefined);
        } catch (failure) {
            if (!mounted.current) return;
            // An older journal has no /2fa: say nothing rather than show a broken section.
            if (failure instanceof JournalApiError && failure.status === 404) setMissing(true);
            else setError(`Couldn't load two-factor settings: ${messageOf(failure)}`);
        }
    }, [client]);

    useEffect(() => {
        mounted.current = true;
        void refresh();
        client.isAdmin().then(
            (yes) => {
                if (mounted.current) setAdmin(yes);
            },
            () => undefined,
        );
        return () => {
            mounted.current = false;
        };
    }, [client, refresh]);

    // Nothing until the first answer, so the two-factor rows never flash up and go. A journal
    // without /2fa still has Password.
    if (!missing && !status && !error) return null;

    const setRequired = async (required: boolean): Promise<void> => {
        setPolicyBusy(true);
        try {
            await client.twoFactorPolicy(required);
            await refresh();
        } catch (failure) {
            if (mounted.current) setError(`Couldn't change the requirement: ${messageOf(failure)}`);
        }
        if (mounted.current) setPolicyBusy(false);
    };

    const close = (): void => {
        setDialog(undefined);
        void refresh();
    };

    const since =
        status?.enabled_at != null
            ? new Date(status.enabled_at).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
              })
            : undefined;

    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-security">
            <h3 id="mj-settings-security" className="mj_SettingsSheet_groupTitle">
                Security
            </h3>
            <div className="mj_SettingsSheet_rows">
                <AccountEmailRow client={client} />
                <ChangePassword client={client} onChanged={onPasswordChanged} />
                {status && (
                    <>
                        <div
                            className="mj_SettingsSheet_row mj_SettingsSheet_switchRow"
                            data-two-factor={status.enabled ? "on" : "off"}
                        >
                            <span className="mj_SettingsSheet_switchText">
                                <span>Two-factor sign-in</span>
                                <span className="mj_SettingsSheet_help">
                                    {status.enabled
                                        ? `On since ${since} · ${status.recovery_codes_left} recovery ${status.recovery_codes_left === 1 ? "code" : "codes"} left`
                                        : status.available
                                          ? "Off. Signing in takes only your password."
                                          : "This server isn't set up for two-factor sign-in."}
                                </span>
                            </span>
                            {!status.enabled && status.available && (
                                <button
                                    type="button"
                                    className="mj_SettingsSheet_clear"
                                    data-action="two-factor-setup"
                                    onClick={() => setDialog("setup")}
                                >
                                    Set Up…
                                </button>
                            )}
                        </div>
                        {status.enabled && status.recovery_codes_left < RECOVERY_CODES_LOW && (
                            <p className="mj_SettingsSheet_error" data-two-factor-low>
                                You&apos;re running out of recovery codes. Make a new set.
                            </p>
                        )}
                        {status.enabled && (
                            <div className="mj_DevicesList_footer">
                                <button
                                    type="button"
                                    data-action="two-factor-recovery"
                                    onClick={() => setDialog("recovery")}
                                >
                                    New Recovery Codes…
                                </button>
                                <button type="button" data-action="two-factor-move" onClick={() => setDialog("move")}>
                                    Change App…
                                </button>
                                {!status.required && (
                                    <button
                                        type="button"
                                        data-action="two-factor-disable"
                                        onClick={() => setDialog("disable")}
                                    >
                                        Turn Off…
                                    </button>
                                )}
                            </div>
                        )}
                        {admin && status.available && (
                            <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                                <span className="mj_SettingsSheet_switchText">
                                    <span id="mj-settings-two-factor-required">Require two-factor for everyone</span>
                                    <span id="mj-settings-two-factor-required-help" className="mj_SettingsSheet_help">
                                        Anyone without it sets it up the next time they sign in with a password. Devices
                                        that are already signed in stay signed in.
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    role="switch"
                                    className="mj_SettingsSheet_switch"
                                    data-setting="two-factor-required"
                                    aria-checked={status.required}
                                    aria-labelledby="mj-settings-two-factor-required"
                                    aria-describedby="mj-settings-two-factor-required-help"
                                    disabled={policyBusy}
                                    onClick={() => void setRequired(!status.required)}
                                />
                            </div>
                        )}
                        {!admin && status.required && (
                            <p className="mj_SettingsSheet_help">
                                This server requires two-factor sign-in for everyone.
                            </p>
                        )}
                    </>
                )}
            </div>
            {error && (
                <p className="mj_SettingsSheet_error" role="alert">
                    {error}
                </p>
            )}
            {(dialog === "setup" || dialog === "move") && (
                <SetupSheet client={client} moving={dialog === "move"} onClose={close} />
            )}
            {dialog === "recovery" && <ConfirmSheet client={client} action="recovery" onClose={close} />}
            {dialog === "disable" && <ConfirmSheet client={client} action="disable" onClose={close} />}
        </section>
    );
}

/** Set Up… and Change App…: password (and, moving, a code from the old app), QR, code, recovery codes. */
function SetupSheet({
    client,
    moving,
    onClose,
}: {
    client: MatronJournalClient;
    moving: boolean;
    onClose: () => void;
}): React.ReactElement {
    const [phase, setPhase] = useState<"password" | "scan" | "codes">("password");
    const [password, setPassword] = useState("");
    const [oldCode, setOldCode] = useState("");
    const [code, setCode] = useState("");
    const [signOutOthers, setSignOutOthers] = useState(false);
    const [setup, setSetup] = useState<TwoFactorSetup>();
    const [codes, setCodes] = useState<string[]>([]);
    const [signedOut, setSignedOut] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    const submit = async (): Promise<void> => {
        if (busy) return;
        setBusy(true);
        setError(undefined);
        try {
            if (phase === "password") {
                setSetup(await client.twoFactorSetup(password, moving ? oldCode : undefined));
                setPassword("");
                setOldCode("");
                setPhase("scan");
            } else if (phase === "scan") {
                const result = await client.twoFactorEnable(code, signOutOthers);
                setCodes(result.recovery_codes);
                setSignedOut(result.signed_out);
                setPhase("codes");
            }
        } catch (failure) {
            setError(messageOf(failure));
            if (failure instanceof JournalApiError && failure.code === "no_pending_setup") setPhase("password");
            setCode("");
        }
        setBusy(false);
    };

    const title = moving ? "Change Authenticator App" : "Set Up Two-Factor";
    return (
        <DeviceSheet
            id="mj-two-factor-setup-title"
            title={title}
            className="mj_TwoFactorSheet"
            onClose={onClose}
            onSubmit={() => void submit()}
        >
            {phase === "password" && (
                <>
                    <p>
                        {moving
                            ? "Enter your password and a code from your current app (or a recovery code). Your current app keeps working until the new one is confirmed."
                            : "You'll need an authenticator app such as Google Authenticator or 1Password. Enter your password to start."}
                    </p>
                    <div>
                        <label htmlFor="mj-two-factor-password">Password</label>
                        <input
                            id="mj-two-factor-password"
                            type="password"
                            data-autofocus
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>
                    {moving && (
                        <div>
                            <label htmlFor="mj-two-factor-old-code">Code from your current app</label>
                            <CodeInput
                                id="mj-two-factor-old-code"
                                value={oldCode}
                                onChange={setOldCode}
                                allowRecovery
                                autoFocus={false}
                            />
                        </div>
                    )}
                </>
            )}
            {phase === "scan" && setup && (
                <>
                    <SetupCode setup={setup} />
                    <div>
                        <label htmlFor="mj-two-factor-code">Code from the app</label>
                        <CodeInput id="mj-two-factor-code" value={code} onChange={setCode} allowRecovery={false} />
                    </div>
                    {!moving && (
                        <label className="mj_RecoveryCodes_saved">
                            <input
                                type="checkbox"
                                checked={signOutOthers}
                                data-sign-out-others
                                onChange={(event) => setSignOutOthers(event.target.checked)}
                            />
                            Also sign out my other browsers and apps (agent boxes stay connected)
                        </label>
                    )}
                </>
            )}
            {phase === "codes" && (
                <>
                    <p className="mj_DeviceSheet_success" role="status">
                        {moving ? "Your new app is set up." : "Two-factor sign-in is on."}
                        {signedOut > 0 && ` Signed out ${signedOut} other ${signedOut === 1 ? "device" : "devices"}.`}
                    </p>
                    <RecoveryCodes codes={codes} doneLabel="Done" onDone={onClose} />
                </>
            )}
            {error && (
                <p className="mj_UploadConfirm_error" role="alert">
                    {error}
                </p>
            )}
            {phase !== "codes" && (
                <div className="mj_UploadConfirm_actions">
                    <button type="button" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="mj_UploadConfirm_send"
                        disabled={
                            busy || (phase === "password" ? !password || (moving && !oldCode.trim()) : !code.trim())
                        }
                    >
                        {phase === "password" ? "Continue" : "Turn On"}
                    </button>
                </div>
            )}
        </DeviceSheet>
    );
}

/** New Recovery Codes… and Turn Off…: both need the password and a current code. */
function ConfirmSheet({
    client,
    action,
    onClose,
}: {
    client: MatronJournalClient;
    action: "recovery" | "disable";
    onClose: () => void;
}): React.ReactElement {
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [codes, setCodes] = useState<string[]>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    const submit = async (): Promise<void> => {
        if (busy || !password || !code.trim()) return;
        setBusy(true);
        setError(undefined);
        try {
            if (action === "recovery") {
                setCodes((await client.twoFactorRecoveryCodes(password, code)).recovery_codes);
            } else {
                await client.twoFactorDisable(password, code);
                onClose();
                return;
            }
        } catch (failure) {
            setError(messageOf(failure));
            setCode("");
        }
        setBusy(false);
    };

    const title = action === "recovery" ? "New Recovery Codes" : "Turn Off Two-Factor";
    return (
        <DeviceSheet
            id="mj-two-factor-confirm-title"
            title={title}
            className="mj_TwoFactorSheet"
            role={action === "disable" ? "alertdialog" : "dialog"}
            onClose={onClose}
            onSubmit={() => void submit()}
        >
            {codes ? (
                <RecoveryCodes codes={codes} doneLabel="Done" onDone={onClose} />
            ) : (
                <>
                    <p>
                        {action === "recovery"
                            ? "Your old recovery codes stop working as soon as the new set is made."
                            : "Signing in will take only your password again. Your recovery codes stop working."}
                    </p>
                    <div>
                        <label htmlFor="mj-two-factor-confirm-password">Password</label>
                        <input
                            id="mj-two-factor-confirm-password"
                            type="password"
                            data-autofocus
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>
                    <div>
                        <label htmlFor="mj-two-factor-confirm-code">Code from your app (or a recovery code)</label>
                        <CodeInput
                            id="mj-two-factor-confirm-code"
                            value={code}
                            onChange={setCode}
                            allowRecovery
                            autoFocus={false}
                        />
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
                        <button
                            type="submit"
                            className={action === "disable" ? "mj_DeviceSheet_destructive" : "mj_UploadConfirm_send"}
                            disabled={busy || !password || !code.trim()}
                        >
                            {action === "recovery" ? "Make New Codes" : "Turn Off"}
                        </button>
                    </div>
                </>
            )}
        </DeviceSheet>
    );
}
