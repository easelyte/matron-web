/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Settings → Devices, as the Mac app has it: the account's devices (apps and agent boxes) with
 * Rename…, Tag… (agent boxes) and Revoke… on each row, and two pairing flows.
 *
 * - Add Agent… approves a new agent box. The box starts pairing and prints a code; the user types
 *   (or pastes the box's matron://pair link) here, sees which address is asking before anything
 *   can be approved, names the box, approves, and the sheet waits for the box to collect its token.
 * - Link a Device… signs a second device in to this account. It mints a code (POST /link/start)
 *   and shows it with its QR — this sheet is the only place the code is ever shown — then waits
 *   for the other device to claim it and asks for an explicit Approve.
 *
 * The roster is pull-based (journal GET /devices): fetched when the sheet opens and again after
 * every change. Revoking is confirmed first and cannot be undone; revoking the device in use is a
 * sign-out and says so.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { JournalApiError } from "./api";
import type { MatronJournalClient } from "./client";
import {
    DEVICE_NAME_MAX,
    deviceCaption,
    deviceLabel,
    deviceNameProblem,
    displayHost,
    displayPairingCode,
    duplicateTagWarning,
    isPairUri,
    linkUri,
    normalizePairingCode,
    PAIRING_CODE_LENGTH,
    parsePairUri,
    sameOrigin,
    sortDevices,
    tagCharFromDraft,
} from "./devices";
import { SheetHead } from "./PinDialogs";
import type { DeviceDTO, Session } from "./types";

/** How often Add Agent checks the roster for the box that collected its token. */
export const PAIR_CLAIM_POLL_MS = 2500;
/** How long Add Agent waits after the last keystroke before previewing a full code. */
export const PAIR_PREVIEW_DEBOUNCE_MS = 300;
/** How often Link a Device asks whether its code has been claimed, and after a network error. */
export const LINK_POLL_MS = 2000;
export const LINK_ERROR_POLL_MS = 5000;

function describe(error: unknown): string {
    if (error instanceof JournalApiError && error.status === 0) return "check your connection and try again.";
    return error instanceof Error ? error.message : "something went wrong.";
}

const is = (error: unknown, status: number): boolean => error instanceof JournalApiError && error.status === status;

/** Keeps a late answer from touching a sheet that has closed. */
function useMounted(): React.RefObject<boolean> {
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    return mounted;
}

// ── Sheet shell ──────────────────────────────────────────────────────────────────────────────

/**
 * A modal over the Settings sheet, portalled to <body>. Escape and Tab are taken in the capture
 * phase on window so the Settings sheet underneath (which listens on document) neither closes nor
 * pulls focus back into itself; focus returns to the opener on close.
 */
function DeviceSheet({
    id,
    title,
    className,
    role = "dialog",
    describedBy,
    onClose,
    onSubmit,
    children,
}: {
    id: string;
    title: string;
    className?: string;
    /** "alertdialog" for a confirmation that interrupts (revoke / sign out). */
    role?: "dialog" | "alertdialog";
    /** The id of the text a screen reader should read with the title. */
    describedBy?: string;
    onClose: () => void;
    onSubmit?: () => void;
    children: React.ReactNode;
}): React.ReactElement {
    const formRef = useRef<HTMLFormElement>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const form = formRef.current;
        const first = form?.querySelector<HTMLElement>("[data-autofocus]") ?? form;
        first?.focus();
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== "Tab" || !formRef.current) return;
            event.stopPropagation();
            const focusable = [
                ...formRef.current.querySelectorAll<HTMLElement>(
                    "button:not([disabled]), input:not([disabled]), select:not([disabled])",
                ),
            ];
            if (focusable.length === 0) return;
            const head = focusable[0];
            const tail = focusable[focusable.length - 1];
            const inside = focusable.includes(document.activeElement as HTMLElement);
            if (event.shiftKey && (document.activeElement === head || !inside)) {
                event.preventDefault();
                tail.focus();
            } else if (!event.shiftKey && (document.activeElement === tail || !inside)) {
                event.preventDefault();
                head.focus();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            if (opener?.isConnected) opener.focus();
        };
    }, []);

    return createPortal(
        <div
            className="mj_UploadConfirm_scrim mj_DeviceSheet_scrim"
            role={role}
            aria-modal="true"
            aria-labelledby={id}
            aria-describedby={describedBy}
        >
            <form
                ref={formRef}
                tabIndex={-1}
                className={`mj_UploadConfirm mj_NewSessionSheet mj_DeviceSheet ${className ?? ""}`.trim()}
                onSubmit={(event) => {
                    event.preventDefault();
                    onSubmit?.();
                }}
            >
                <SheetHead id={id} title={title} onClose={onClose} />
                {children}
            </form>
        </div>,
        document.body,
    );
}

// ── Rename / Tag / Revoke ────────────────────────────────────────────────────────────────────

function RenameSheet({
    client,
    device,
    onDone,
    onClose,
}: {
    client: MatronJournalClient;
    device: DeviceDTO;
    onDone: () => void;
    onClose: () => void;
}): React.ReactElement {
    const [draft, setDraft] = useState(device.name ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const mounted = useMounted();
    const problem = deviceNameProblem(draft);

    const save = async (): Promise<void> => {
        if (saving) return;
        if (problem) {
            setError(problem);
            return;
        }
        setSaving(true);
        setError(undefined);
        try {
            await client.renameDevice(device.device_id, draft.trim());
            if (!mounted.current) return;
            onDone();
            onClose();
        } catch (failure) {
            if (!mounted.current) return;
            setSaving(false);
            setError(`Couldn't rename ${deviceLabel(device)} — ${describe(failure)}`);
        }
    };

    return (
        <DeviceSheet id="mj-device-rename-title" title="Rename device" onClose={onClose} onSubmit={() => void save()}>
            <p>This name labels the box everywhere — in Devices and on the chip beside each conversation.</p>
            <div>
                <label htmlFor="mj-device-rename">Name</label>
                <input
                    id="mj-device-rename"
                    data-autofocus
                    type="text"
                    value={draft}
                    maxLength={DEVICE_NAME_MAX * 2}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setDraft(event.target.value)}
                />
            </div>
            {draft.trim() && problem && <p className="mj_DeviceSheet_caution">{problem}</p>}
            {error && (
                <p className="mj_UploadConfirm_error" role="alert">
                    {error}
                </p>
            )}
            <div className="mj_UploadConfirm_actions">
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
                <button type="submit" className="mj_UploadConfirm_send" disabled={saving || problem !== undefined}>
                    Rename
                </button>
            </div>
        </DeviceSheet>
    );
}

function TagSheet({
    client,
    device,
    onDone,
    onClose,
}: {
    client: MatronJournalClient;
    device: DeviceDTO;
    onDone: () => void;
    onClose: () => void;
}): React.ReactElement {
    const [draft, setDraft] = useState(device.tag_char ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const mounted = useMounted();

    const save = async (): Promise<void> => {
        if (saving) return;
        setSaving(true);
        setError(undefined);
        try {
            // A blank draft (or one that sieves to nothing) clears back to automatic.
            await client.setDeviceTag(device.device_id, tagCharFromDraft(draft));
            if (!mounted.current) return;
            onDone();
            onClose();
        } catch (failure) {
            if (!mounted.current) return;
            setSaving(false);
            setError(`Couldn't set the tag for ${deviceLabel(device)} — ${describe(failure)}`);
        }
    };

    return (
        <DeviceSheet id="mj-device-tag-title" title="Tag character" onClose={onClose} onSubmit={() => void save()}>
            <p>
                One character shown before chat titles to identify this machine, on all your devices. Leave empty to
                derive it from the box name.
            </p>
            <div>
                <label htmlFor="mj-device-tag">Tag for {deviceLabel(device)}</label>
                <input
                    id="mj-device-tag"
                    data-autofocus
                    type="text"
                    value={draft}
                    placeholder="Automatic"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setDraft(event.target.value)}
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
                <button type="submit" className="mj_UploadConfirm_send" disabled={saving}>
                    Save
                </button>
            </div>
        </DeviceSheet>
    );
}

function RevokeSheet({
    client,
    device,
    onDone,
    onClose,
}: {
    client: MatronJournalClient;
    device: DeviceDTO;
    onDone: () => void;
    onClose: () => void;
}): React.ReactElement {
    const [revoking, setRevoking] = useState(false);
    const [error, setError] = useState<string>();
    const mounted = useMounted();
    const self = device.is_self;

    const revoke = async (): Promise<void> => {
        if (revoking) return;
        setRevoking(true);
        setError(undefined);
        try {
            await client.revokeDevice(device);
            if (!mounted.current) return;
            onDone();
            onClose();
        } catch (failure) {
            if (!mounted.current) return;
            setRevoking(false);
            setError(`Couldn't revoke ${deviceLabel(device)} — ${describe(failure)}`);
        }
    };

    return (
        <DeviceSheet
            id="mj-device-revoke-title"
            title={self ? "Sign out this device?" : `Revoke “${deviceLabel(device)}”?`}
            className="mj_DeviceSheet_revoke"
            role="alertdialog"
            describedBy="mj-device-revoke-body"
            onClose={onClose}
        >
            {self ? (
                <p id="mj-device-revoke-body" className="mj_DeviceSheet_warning" data-self-warning>
                    This is the device you are using now. It loses access immediately and you&apos;ll be returned to
                    sign-in.
                </p>
            ) : (
                <p id="mj-device-revoke-body">
                    The device loses access immediately. There&apos;s no undo — re-enroll it to restore access.
                </p>
            )}
            {error && (
                <p className="mj_UploadConfirm_error" role="alert">
                    {error}
                </p>
            )}
            <div className="mj_UploadConfirm_actions">
                <button type="button" data-autofocus onClick={onClose}>
                    Cancel
                </button>
                {/* A click only, never a form submit: Enter must not revoke or sign out. */}
                <button
                    type="button"
                    className="mj_DeviceSheet_destructive"
                    disabled={revoking}
                    onClick={() => void revoke()}
                >
                    {self ? "Sign Out" : "Revoke"}
                </button>
            </div>
        </DeviceSheet>
    );
}

// ── Add Agent ────────────────────────────────────────────────────────────────────────────────

type PairPhase =
    | { kind: "enter" }
    | { kind: "preview"; requesterIp: string; expiresAt: number }
    | { kind: "waiting" }
    | { kind: "success"; name: string };

function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

export function AddAgentSheet({
    client,
    serverUrl,
    existing,
    onClose,
}: {
    client: MatronJournalClient;
    /** The signed-in server: a pasted pairing link must name the same one. */
    serverUrl: string;
    existing: readonly DeviceDTO[];
    onClose: () => void;
}): React.ReactElement {
    const [code, setCode] = useState("");
    const [phase, setPhase] = useState<PairPhase>({ kind: "enter" });
    const [error, setError] = useState<string>();
    const [name, setName] = useState("");
    const [tag, setTag] = useState("");
    const [approving, setApproving] = useState(false);
    // Bumped when the same code is pasted again, so a preview that failed before is retried.
    const [previewAttempt, setPreviewAttempt] = useState(0);
    const mounted = useMounted();
    const previewSeq = useRef(0);
    const claimTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const now = useNow(phase.kind === "preview");

    useEffect(() => () => clearTimeout(claimTimer.current), []);

    // The code and name fields unmount once approved: keep keyboard focus on the button that
    // remains (Close while waiting, Done once connected) rather than letting it fall to <body>.
    const finalButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (phase.kind === "waiting" || phase.kind === "success") finalButton.current?.focus();
    }, [phase.kind]);

    // Preview once the field holds a full code, after a short pause; any edit starts over.
    useEffect(() => {
        const normalized = normalizePairingCode(code);
        const seq = ++previewSeq.current;
        if (normalized.length !== PAIRING_CODE_LENGTH) return;
        const timer = setTimeout(() => {
            void client.pairPreview(normalized).then(
                (preview) => {
                    if (!mounted.current || previewSeq.current !== seq) return;
                    setPhase((current) =>
                        current.kind === "enter" || current.kind === "preview"
                            ? {
                                  kind: "preview",
                                  requesterIp: preview.requester_ip,
                                  expiresAt: Date.now() + preview.expires_in * 1000,
                              }
                            : current,
                    );
                },
                (failure) => {
                    if (!mounted.current || previewSeq.current !== seq) return;
                    setError(
                        is(failure, 404)
                            ? "Code not recognized or expired. Get a fresh code from the box and try again."
                            : "Couldn't check that code — try again.",
                    );
                },
            );
        }, PAIR_PREVIEW_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [client, code, mounted, previewAttempt]);

    const reject = (message: string): void => {
        setCode("");
        setPhase({ kind: "enter" });
        setError(message);
    };

    const onCodeInput = (raw: string): void => {
        if (phase.kind === "waiting" || phase.kind === "success") return;
        if (isPairUri(raw)) {
            const parsed = parsePairUri(raw);
            if (!parsed.ok) {
                reject(
                    parsed.reason === "unsupported_version"
                        ? "This pairing code needs a newer version of Matron — update the app."
                        : "That pairing link is incomplete. Type the code shown on the box instead.",
                );
                return;
            }
            // A code minted by another journal means nothing to this one: never send it here.
            // Fail closed: if the signed-in address can't be read, no link is trusted.
            let own: URL | undefined;
            try {
                own = new URL(serverUrl);
            } catch {
                own = undefined;
            }
            if (!own || !sameOrigin(parsed.server, own)) {
                reject(
                    own
                        ? `This link is for ${displayHost(parsed.server)}, you're signed in to ${displayHost(own)}.`
                        : "That pairing link can't be checked against this server. Type the code shown on the box instead.",
                );
                return;
            }
            raw = parsed.code;
            if (displayPairingCode(raw) === code) setPreviewAttempt((attempt) => attempt + 1);
        }
        setError(undefined);
        setPhase({ kind: "enter" });
        setCode(displayPairingCode(raw));
    };

    const expired = phase.kind === "preview" && phase.expiresAt <= now;
    const nameProblem = name.trim() ? deviceNameProblem(name) : undefined;
    // Longer than a code: the field still shows it, and says why nothing is checked.
    const codeTooLong = normalizePairingCode(code).length > PAIRING_CODE_LENGTH;
    const nameWarning = existing.some((device) => device.name === name)
        ? `You already have an agent called ${name}`
        : undefined;
    const tagWarning = duplicateTagWarning(
        tag,
        existing.flatMap((device) => (device.kind === "agent" && device.tag_char ? [device.tag_char] : [])),
    );
    const warnings = [nameProblem, nameWarning, tagWarning].filter(
        (warning): warning is string => warning !== undefined,
    );

    const approve = async (): Promise<void> => {
        if (phase.kind !== "preview" || approving || expired) return;
        const agentName = name.trim();
        if (!agentName) {
            setError("Name the agent first — the name can't be changed later.");
            return;
        }
        if (nameProblem) {
            setError(nameProblem);
            return;
        }
        setApproving(true);
        setError(undefined);
        const deadline = phase.expiresAt;
        // The box shows up as a NEW agent id, never matched by name (names are not unique).
        let before: Set<number>;
        try {
            before = new Set((await client.listDevices()).map((device) => device.device_id));
        } catch {
            if (!mounted.current) return;
            setApproving(false);
            setError("Couldn't reach the server — try again.");
            return;
        }
        try {
            await client.pairApprove(normalizePairingCode(code), agentName, tagCharFromDraft(tag));
        } catch (failure) {
            if (!mounted.current) return;
            setApproving(false);
            setError(
                is(failure, 409)
                    ? "This code was already approved."
                    : is(failure, 404)
                      ? "Code not recognized or expired. Get a fresh code from the box and try again."
                      : "Couldn't approve — try again.",
            );
            return;
        }
        if (!mounted.current) return;
        previewSeq.current += 1;
        setApproving(false);
        setPhase({ kind: "waiting" });
        const poll = async (): Promise<void> => {
            if (!mounted.current) return;
            if (Date.now() > deadline) {
                setError("The box never collected its token. Start again with a fresh code.");
                setCode("");
                setPhase({ kind: "enter" });
                return;
            }
            const claimed = await client.listDevices().then(
                (devices) => devices.find((device) => device.kind === "agent" && !before.has(device.device_id)),
                () => undefined,
            );
            if (!mounted.current) return;
            if (claimed) {
                setPhase({ kind: "success", name: deviceLabel(claimed) });
                return;
            }
            claimTimer.current = setTimeout(() => void poll(), PAIR_CLAIM_POLL_MS);
        };
        void poll();
    };

    const remaining = phase.kind === "preview" ? Math.floor((phase.expiresAt - now) / 1000) : 0;

    return (
        <DeviceSheet
            id="mj-add-agent-title"
            title="Add Agent"
            className="mj_AddAgentSheet"
            onClose={onClose}
            onSubmit={() => void approve()}
        >
            {(phase.kind === "enter" || phase.kind === "preview") && (
                <>
                    <p>
                        On the box, start pairing — it prints a code like KTNM-3VQ8. Type it here, or paste the pairing
                        link (matron://pair…).
                    </p>
                    <div>
                        <label htmlFor="mj-add-agent-code">Pairing code</label>
                        <input
                            id="mj-add-agent-code"
                            className="mj_AddAgentSheet_code"
                            data-autofocus
                            type="text"
                            value={code}
                            placeholder="XXXX-XXXX"
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            onChange={(event) => onCodeInput(event.target.value)}
                        />
                    </div>
                    {codeTooLong && (
                        <p className="mj_DeviceSheet_caution">
                            Pairing codes are {PAIRING_CODE_LENGTH} characters — check the code on the box.
                        </p>
                    )}
                </>
            )}
            {error && (
                <p className="mj_UploadConfirm_error" role="alert">
                    {error}
                </p>
            )}
            {phase.kind === "preview" && (
                <>
                    <div className="mj_DeviceSheet_box" data-pair-preview>
                        <p>
                            A device at <strong>{phase.requesterIp}</strong> is asking to connect as an agent on your
                            account. Only approve if this is your machine — check the code on its terminal.
                        </p>
                        <p className={remaining > 60 ? "mj_DeviceSheet_muted" : "mj_UploadConfirm_error"}>
                            {remaining > 0
                                ? `Code expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
                                : "Code expired — get a fresh one from the box."}
                        </p>
                    </div>
                    <div>
                        <label htmlFor="mj-add-agent-name">Agent name</label>
                        <input
                            id="mj-add-agent-name"
                            type="text"
                            value={name}
                            placeholder="e.g. box-7"
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </div>
                    <div>
                        <label htmlFor="mj-add-agent-tag">Tag character (optional)</label>
                        <input
                            id="mj-add-agent-tag"
                            type="text"
                            value={tag}
                            placeholder="e.g. 7"
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => setTag(event.target.value)}
                        />
                    </div>
                    <p className={warnings.length > 0 ? "mj_DeviceSheet_caution" : "mj_DeviceSheet_muted"}>
                        {warnings.length > 0
                            ? warnings.join("\n")
                            : "Convention: the box's short hostname. The name can't be changed later. The tag is the one character shown before this box's chat titles on all your devices — leave it empty to derive one from the name; you can change it later in Devices."}
                    </p>
                </>
            )}
            {phase.kind === "waiting" && (
                <div className="mj_DeviceSheet_box" role="status">
                    <p>Waiting for the agent to connect…</p>
                    <p className="mj_DeviceSheet_muted">
                        This finishes automatically once the box collects its token — usually a few seconds. You can
                        close this; the device list will show it when it lands.
                    </p>
                </div>
            )}
            {phase.kind === "success" && (
                <p className="mj_DeviceSheet_success" role="status">
                    <strong>{phase.name}</strong> is connected.
                </p>
            )}
            <div className="mj_UploadConfirm_actions">
                {phase.kind === "success" ? (
                    <button type="button" className="mj_UploadConfirm_send" ref={finalButton} onClick={onClose}>
                        Done
                    </button>
                ) : (
                    <button type="button" ref={phase.kind === "waiting" ? finalButton : undefined} onClick={onClose}>
                        {phase.kind === "waiting" ? "Close" : "Cancel"}
                    </button>
                )}
                {phase.kind === "preview" && (
                    <button
                        type="submit"
                        className="mj_UploadConfirm_send"
                        disabled={approving || !name.trim() || nameProblem !== undefined || expired}
                    >
                        Approve
                    </button>
                )}
            </div>
        </DeviceSheet>
    );
}

// ── Link a Device ────────────────────────────────────────────────────────────────────────────

type QrFactory = typeof import("qrcode-generator");
let qrFactory: Promise<QrFactory> | undefined;
/** The QR encoder is only needed by this sheet, so it stays out of the app's first download. */
function loadQrFactory(): Promise<QrFactory> {
    qrFactory ??= import("qrcode-generator").then((module) => module.default);
    return qrFactory;
}

/** A QR code as an SVG of dark modules on a light quiet zone (readable in either theme). */
export function QrCode({ value, size = 200 }: { value: string; size?: number }): React.ReactElement {
    const [factory, setFactory] = useState<QrFactory>();
    useEffect(() => {
        let live = true;
        loadQrFactory().then(
            (loaded) => {
                if (live) setFactory(() => loaded);
            },
            () => {
                // Offline mid-load: the code is shown as text under the QR, which is enough.
                qrFactory = undefined;
            },
        );
        return () => {
            live = false;
        };
    }, []);
    if (!factory) return <span className="mj_QrCode mj_QrCode_pending" style={{ width: size, height: size }} />;
    const qr = factory(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 2;
    const full = count + margin * 2;
    let path = "";
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
        }
    }
    return (
        <svg
            className="mj_QrCode"
            viewBox={`0 0 ${full} ${full}`}
            width={size}
            height={size}
            shapeRendering="crispEdges"
            role="img"
            aria-label="Sign-in QR code"
        >
            <rect width={full} height={full} fill="#fff" />
            <path d={path} fill="#000" />
        </svg>
    );
}

type LinkPhase =
    | { kind: "loading" }
    | { kind: "showing"; code: string }
    | { kind: "claimed"; code: string; deviceName: string; requesterIp: string }
    | { kind: "approved" }
    | { kind: "denied" }
    | { kind: "unsupported" }
    | { kind: "error"; message: string };

export function LinkDeviceSheet({
    client,
    serverUrl,
    onClose,
}: {
    client: MatronJournalClient;
    serverUrl: string;
    onClose: () => void;
}): React.ReactElement {
    const [phase, setPhase] = useState<LinkPhase>({ kind: "loading" });
    const [notice, setNotice] = useState<string>();
    const [submitting, setSubmitting] = useState(false);
    // Bumped by every stop: a session start or poll from before it abandons on its next step.
    const generation = useRef(0);
    const pollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const submittingRef = useRef(false);

    const stop = useCallback((): void => {
        generation.current += 1;
        clearTimeout(pollTimer.current);
    }, []);

    const startSession = useCallback(async (): Promise<void> => {
        const gen = generation.current;
        let code: string;
        try {
            code = (await client.linkStart()).link_code;
        } catch (failure) {
            if (gen !== generation.current) return;
            setPhase(
                is(failure, 404)
                    ? { kind: "unsupported" }
                    : { kind: "error", message: "Couldn't reach the server — try again." },
            );
            return;
        }
        if (gen !== generation.current) return;
        setPhase({ kind: "showing", code });
        const poll = (delay: number): void => {
            pollTimer.current = setTimeout(async () => {
                if (gen !== generation.current) return;
                if (submittingRef.current) return poll(LINK_POLL_MS); // don't race an approve or deny
                try {
                    const status = await client.linkStatus();
                    if (gen !== generation.current) return;
                    if (status.status === "claimed") {
                        setPhase((current) =>
                            current.kind === "claimed"
                                ? current
                                : {
                                      kind: "claimed",
                                      code,
                                      deviceName: status.device_name,
                                      requesterIp: status.requester_ip,
                                  },
                        );
                    }
                    poll(LINK_POLL_MS);
                } catch (failure) {
                    if (gen !== generation.current) return;
                    // Expired (routine): show a fresh code. Signed out or revoked: stop quietly.
                    if (is(failure, 404)) return void startSession();
                    if (is(failure, 401)) return;
                    poll(LINK_ERROR_POLL_MS);
                }
            }, delay);
        };
        poll(LINK_POLL_MS);
    }, [client]);

    const restart = useCallback(async (): Promise<void> => {
        stop();
        setNotice(undefined);
        setPhase({ kind: "loading" });
        await startSession();
    }, [startSession, stop]);

    useEffect(() => {
        void restart();
        return stop;
    }, [restart, stop]);

    const decide = async (decision: "approve" | "deny"): Promise<void> => {
        if (phase.kind !== "claimed" || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        // A stop() while the request is out (the sheet closing) bumps this: then nothing below
        // may mint a fresh code or start polling again behind a closed sheet.
        const gen = generation.current;
        try {
            await (decision === "approve" ? client.linkApprove(phase.code) : client.linkDeny(phase.code));
            if (gen !== generation.current) return;
            stop();
            setPhase({ kind: decision === "approve" ? "approved" : "denied" });
        } catch (failure) {
            if (gen !== generation.current) return;
            if (is(failure, 404) || (decision === "approve" && is(failure, 409))) {
                // Nothing left to decide (expired, or replaced): show a fresh code.
                if (decision === "approve") setNotice("Code expired — showing a fresh one");
                stop();
                await startSession();
            } else {
                setNotice(decision === "approve" ? "Couldn't approve — try again." : "Couldn't deny — try again.");
            }
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    return (
        <DeviceSheet id="mj-link-device-title" title="Link a Device" className="mj_LinkDeviceSheet" onClose={onClose}>
            {notice && <p className="mj_DeviceSheet_caution">{notice}</p>}
            <div className="mj_LinkDeviceSheet_body" aria-live="polite">
                {phase.kind === "loading" && <p role="status">Getting a code…</p>}
                {phase.kind === "showing" && (
                    <>
                        <QrCode value={linkUri(serverUrl, phase.code)} />
                        <p className="mj_LinkDeviceSheet_code" data-link-code>
                            {phase.code}
                        </p>
                        <p>
                            On your phone, tablet or other computer, open the Matron app and choose “Scan QR code” — or
                            type the code under “Have a link code?” on its sign-in screen. Codes refresh automatically.
                        </p>
                        <p className="mj_DeviceSheet_muted">
                            Signing in to Matron in a web browser? Use your username and password there; the web app
                            doesn&apos;t take link codes.
                        </p>
                    </>
                )}
                {phase.kind === "claimed" && (
                    <>
                        <p>
                            <strong>{phase.deviceName}</strong> at <strong>{phase.requesterIp}</strong> wants to sign in
                            to your account. Only approve if this is your device.
                        </p>
                        <div className="mj_UploadConfirm_actions mj_LinkDeviceSheet_decide">
                            <button
                                type="button"
                                className="mj_DeviceSheet_destructive"
                                disabled={submitting}
                                onClick={() => void decide("deny")}
                            >
                                Deny
                            </button>
                            <button
                                type="button"
                                className="mj_UploadConfirm_send"
                                disabled={submitting}
                                onClick={() => void decide("approve")}
                            >
                                Approve
                            </button>
                        </div>
                        <p className="mj_DeviceSheet_muted">
                            This signs a computer into <strong>your</strong> account — only approve if it&apos;s yours,
                            in front of you.
                        </p>
                    </>
                )}
                {phase.kind === "approved" && (
                    <p className="mj_DeviceSheet_success" role="status">
                        Approved — finishing sign-in on the other device.
                    </p>
                )}
                {phase.kind === "denied" && <p role="status">Denied. No device was signed in.</p>}
                {phase.kind === "unsupported" && <p>Server doesn&apos;t support device linking yet.</p>}
                {phase.kind === "error" && (
                    <>
                        <p className="mj_UploadConfirm_error" role="alert">
                            {phase.message}
                        </p>
                        <div className="mj_UploadConfirm_actions">
                            <button type="button" onClick={() => void restart()}>
                                Try again
                            </button>
                        </div>
                    </>
                )}
            </div>
        </DeviceSheet>
    );
}

// ── The Devices group ────────────────────────────────────────────────────────────────────────

type DeviceDialog =
    | { kind: "rename"; device: DeviceDTO }
    | { kind: "tag"; device: DeviceDTO }
    | { kind: "revoke"; device: DeviceDTO }
    | { kind: "add-agent" }
    | { kind: "link" };

/** Settings → Devices. Hidden while signed out (no journal to ask). */
export function DevicesSettings({
    client,
    session,
}: {
    client: MatronJournalClient;
    session?: Session;
}): React.ReactElement | null {
    const [devices, setDevices] = useState<DeviceDTO[]>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [dialog, setDialog] = useState<DeviceDialog>();
    const mounted = useMounted();
    const loadSeq = useRef(0);

    const refresh = useCallback(async (): Promise<void> => {
        const seq = ++loadSeq.current;
        setLoading(true);
        try {
            const list = await client.listDevices();
            if (!mounted.current || seq !== loadSeq.current) return;
            setDevices(sortDevices(list));
            setError(undefined);
        } catch (failure) {
            if (!mounted.current || seq !== loadSeq.current) return;
            setError(`Couldn't load devices — ${describe(failure)}`);
        } finally {
            if (mounted.current && seq === loadSeq.current) setLoading(false);
        }
    }, [client, mounted]);

    const signedIn = session !== undefined;
    useEffect(() => {
        if (signedIn) void refresh();
    }, [refresh, signedIn]);

    if (!session) return null;
    const close = (): void => setDialog(undefined);
    const now = Date.now();

    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-devices">
            <h3 id="mj-settings-devices" className="mj_SettingsSheet_groupTitle">
                Devices
            </h3>
            {devices && devices.length > 0 && (
                <ul className="mj_SettingsSheet_rows mj_DevicesList">
                    {devices.map((device) => (
                        <li
                            key={device.device_id}
                            className="mj_SettingsSheet_row mj_DevicesList_row"
                            data-device={device.device_id}
                            data-kind={device.kind}
                        >
                            <span className="mj_DevicesList_text">
                                <span className="mj_DevicesList_name">
                                    {deviceLabel(device)}
                                    {device.is_self && <span className="mj_DevicesList_self">This device</span>}
                                </span>
                                <span className="mj_DevicesList_caption">{deviceCaption(device, now)}</span>
                            </span>
                            <span className="mj_DevicesList_actions">
                                {device.kind === "agent" && (
                                    <button
                                        type="button"
                                        data-device-action="tag"
                                        title="Choose the character shown before this machine's chat titles"
                                        onClick={() => setDialog({ kind: "tag", device })}
                                    >
                                        Tag…
                                    </button>
                                )}
                                <button
                                    type="button"
                                    data-device-action="rename"
                                    onClick={() => setDialog({ kind: "rename", device })}
                                >
                                    Rename…
                                </button>
                                <button
                                    type="button"
                                    data-device-action="revoke"
                                    className="mj_DevicesList_revoke"
                                    onClick={() => setDialog({ kind: "revoke", device })}
                                >
                                    {device.is_self ? "Sign Out…" : "Revoke…"}
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {devices && devices.length === 0 && !loading && !error && (
                <p className="mj_SettingsSheet_help">
                    No devices — that&apos;s odd, this browser should be here. Try Refresh.
                </p>
            )}
            {error && (
                <p className="mj_SettingsSheet_error" role="alert">
                    {error}
                </p>
            )}
            <div className="mj_DevicesList_footer">
                <button type="button" data-action="devices-refresh" onClick={() => void refresh()}>
                    Refresh
                </button>
                <button type="button" data-action="link-device" onClick={() => setDialog({ kind: "link" })}>
                    Link a Device…
                </button>
                <button type="button" data-action="add-agent" onClick={() => setDialog({ kind: "add-agent" })}>
                    Add Agent…
                </button>
            </div>
            {dialog?.kind === "rename" && (
                <RenameSheet client={client} device={dialog.device} onDone={() => void refresh()} onClose={close} />
            )}
            {dialog?.kind === "tag" && (
                <TagSheet client={client} device={dialog.device} onDone={() => void refresh()} onClose={close} />
            )}
            {dialog?.kind === "revoke" && (
                <RevokeSheet client={client} device={dialog.device} onDone={() => void refresh()} onClose={close} />
            )}
            {dialog?.kind === "add-agent" && (
                <AddAgentSheet
                    client={client}
                    serverUrl={session.serverUrl}
                    existing={devices ?? []}
                    onClose={() => {
                        close();
                        void refresh();
                    }}
                />
            )}
            {dialog?.kind === "link" && (
                <LinkDeviceSheet
                    client={client}
                    serverUrl={session.serverUrl}
                    onClose={() => {
                        close();
                        void refresh();
                    }}
                />
            )}
        </section>
    );
}
