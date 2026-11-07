/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Settings → People: the user's contacts, and contacts on other journals by invite link
 * (journal docs/protocol.md, "Contacts across journals").
 *
 * - The contact list shows each person's full address: `name@journal` for someone on another
 *   journal, and a line when that journal's key has changed (or it has stopped answering, when
 *   the journal says so).
 * - "Invite someone on another Matron" mints an invite (POST /contacts/invites) and shows its link
 *   once, as a QR code with Copy and Share. The journal never shows that link again; the open
 *   invites listed below it can only be withdrawn.
 * - "Open an invite link" takes a pasted `matron://contact?…` link to the accept sheet, which a
 *   tapped link in a message opens too (client.openContactInvite).
 *
 * The accept sheet asks the journal who sent the link (POST /contacts/invites/open, which sends
 * nothing) and shows the inviter's address, journal and key fingerprint, with a note to compare the
 * fingerprint another way. Only Accept sends anything; Cancel just closes.
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { MatronJournalClient } from "./client";
import {
    ACCEPT_SENT,
    contactCaption,
    contactName,
    FINGERPRINT_NOTE,
    INVALID_LINK,
    INVITE_SHEET_NOTE,
    inviteCaption,
    isRemoteContact,
    KEY_CHANGED_NOTE,
    looksLikeContactLink,
    parseContactLink,
    refusalText,
    sortContacts,
    unreachableCaption,
    type Contact,
    type ContactInvite,
    type InviteOpened,
} from "./contacts";
import { copyText } from "./clipboard";
import { DeviceSheet, QrCode } from "./DevicesSettings";
import type { Session } from "./types";

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

const canShare = (): boolean => typeof navigator !== "undefined" && typeof navigator.share === "function";

/** A freshly minted invite link: its QR code, the link itself, and Copy / Share. */
export function InviteLinkView({ link, note }: { link: string; note: string }): React.ReactElement {
    const [copied, setCopied] = useState(false);
    return (
        <div className="mj_InviteLink">
            <QrCode value={link} label="Invite QR code" />
            <p className="mj_InviteLink_url" data-invite-link>
                {link}
            </p>
            <p className="mj_DeviceSheet_muted">{note}</p>
            <div className="mj_UploadConfirm_actions mj_InviteLink_actions">
                <button
                    type="button"
                    data-action="copy-invite"
                    onClick={() => void copyText(link).then((ok) => setCopied(ok))}
                >
                    {copied ? "Copied" : "Copy link"}
                </button>
                {canShare() && (
                    <button
                        type="button"
                        data-action="share-invite"
                        onClick={() => void navigator.share({ text: link }).catch(() => undefined)}
                    >
                        Share…
                    </button>
                )}
            </div>
        </div>
    );
}

type MintPhase = { kind: "minting" } | { kind: "shown"; link: string } | { kind: "error"; message: string };

/** POST /contacts/invites, and the link it returns, shown this once. */
function InviteSheet({
    client,
    onDone,
    onClose,
}: {
    client: MatronJournalClient;
    onDone: () => void;
    onClose: () => void;
}): React.ReactElement {
    const [phase, setPhase] = useState<MintPhase>({ kind: "minting" });
    const mounted = useMounted();
    const started = useRef(false);

    const mint = useCallback(async (): Promise<void> => {
        setPhase({ kind: "minting" });
        try {
            const { link } = await client.createContactInvite();
            onDone();
            // Settings closed meanwhile (signing out, say): the link is shown over the app instead,
            // as the journal never returns it again.
            if (mounted.current) setPhase({ kind: "shown", link });
            else client.showMintedInvite(link);
        } catch (failure) {
            if (mounted.current) setPhase({ kind: "error", message: refusalText(failure) });
        }
    }, [client, mounted, onDone]);

    useEffect(() => {
        // One invite per opening, even under StrictMode's double effect.
        if (started.current) return;
        started.current = true;
        void mint();
    }, [mint]);

    // The link comes back once: the sheet stays open until it has, so it is never minted unseen.
    const minting = phase.kind === "minting";
    const close = (): void => {
        if (!minting) onClose();
    };
    return (
        <DeviceSheet
            id="mj-invite-title"
            title="Invite someone on another Matron"
            className="mj_InviteSheet"
            onClose={close}
        >
            <div className="mj_LinkDeviceSheet_body" aria-live="polite">
                {phase.kind === "minting" && <p role="status">Making an invite…</p>}
                {phase.kind === "shown" && <InviteLinkView link={phase.link} note={INVITE_SHEET_NOTE} />}
                {phase.kind === "error" && (
                    <p className="mj_UploadConfirm_error" role="alert">
                        {phase.message}
                    </p>
                )}
            </div>
            <div className="mj_UploadConfirm_actions">
                <button
                    type="button"
                    className="mj_UploadConfirm_send"
                    data-autofocus
                    disabled={minting}
                    onClick={close}
                >
                    Done
                </button>
            </div>
        </DeviceSheet>
    );
}

/** The link the journal minted for an approved agent ask, shown once on this device. */
export function MintedInviteSheet({ link, onClose }: { link: string; onClose: () => void }): React.ReactElement {
    return (
        <DeviceSheet id="mj-minted-invite-title" title="Invite link" className="mj_InviteSheet" onClose={onClose}>
            <div className="mj_LinkDeviceSheet_body">
                <InviteLinkView
                    link={link}
                    note="Shown only on this device, this once. Send it to them yourself. It works once and lasts 7 days."
                />
            </div>
            <div className="mj_UploadConfirm_actions">
                <button type="button" className="mj_UploadConfirm_send" data-autofocus onClick={onClose}>
                    Done
                </button>
            </div>
        </DeviceSheet>
    );
}

/** "Open an invite link": a pasted link, checked for shape, then the accept sheet. */
function PasteInviteSheet({
    onOpen,
    onClose,
}: {
    onOpen: (link: string) => void;
    onClose: () => void;
}): React.ReactElement {
    const [text, setText] = useState("");
    const [problem, setProblem] = useState<string>();
    const submit = (): void => {
        const link = text.trim();
        if (!parseContactLink(link)) {
            setProblem(looksLikeContactLink(link) || link ? INVALID_LINK : undefined);
            return;
        }
        onOpen(link);
    };
    return (
        <DeviceSheet id="mj-paste-invite-title" title="Open an invite link" onClose={onClose} onSubmit={submit}>
            <label className="mj_DeviceSheet_box">
                <span>Paste the link someone sent you.</span>
                <input
                    type="text"
                    data-autofocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the link they sent you"
                    value={text}
                    onChange={(event) => {
                        setText(event.target.value);
                        setProblem(undefined);
                    }}
                />
            </label>
            {problem && (
                <p className="mj_UploadConfirm_error" role="alert">
                    {problem}
                </p>
            )}
            <div className="mj_UploadConfirm_actions">
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
                <button type="submit" className="mj_UploadConfirm_send" disabled={!text.trim()}>
                    Open
                </button>
            </div>
        </DeviceSheet>
    );
}

type AcceptPhase =
    | { kind: "opening" }
    | { kind: "open"; opened: InviteOpened }
    | { kind: "accepting"; opened: InviteOpened }
    | { kind: "sent"; opened: InviteOpened }
    | { kind: "refused"; message: string; opened?: InviteOpened };

/**
 * The accept card for a contact invite link. Opening it asks the journal who sent the link and
 * checks that journal's key against the link's fingerprint; nothing is sent until Accept.
 */
export function AcceptInviteSheet({
    client,
    link,
    onAccepted,
    onClose,
}: {
    client: MatronJournalClient;
    link: string;
    onAccepted?: () => void;
    onClose: () => void;
}): React.ReactElement {
    const host = parseContactLink(link)?.journal;
    const valid = host !== undefined;
    const [phase, setPhase] = useState<AcceptPhase>(() =>
        valid ? { kind: "opening" } : { kind: "refused", message: INVALID_LINK },
    );
    const mounted = useMounted();

    useEffect(() => {
        if (!valid) return;
        let live = true;
        setPhase({ kind: "opening" });
        client.openContactInviteLink(link).then(
            (opened) => {
                if (live) setPhase({ kind: "open", opened });
            },
            (failure: unknown) => {
                if (live) setPhase({ kind: "refused", message: refusalText(failure, host) });
            },
        );
        return () => {
            live = false;
        };
    }, [client, link, valid, host]);

    const accept = async (opened: InviteOpened): Promise<void> => {
        setPhase({ kind: "accepting", opened });
        try {
            await client.acceptContactInvite(link);
            if (!mounted.current) return;
            setPhase({ kind: "sent", opened });
            onAccepted?.();
        } catch (failure) {
            if (mounted.current) setPhase({ kind: "refused", message: refusalText(failure, host), opened });
        }
    };

    const opened = phase.kind === "opening" ? undefined : phase.kind === "refused" ? phase.opened : phase.opened;
    // Already contacts under the same key: nothing to accept. On a changed key a fresh invite is
    // how the contact reconnects, so Accept stays.
    const existing = opened?.contact?.state === "active" && !opened.key_changed && !opened.contact.key_changed;
    const canAccept = (phase.kind === "open" || phase.kind === "accepting") && !existing;

    return (
        <DeviceSheet id="mj-accept-invite-title" title="Contact invite" className="mj_AcceptInvite" onClose={onClose}>
            {phase.kind === "opening" && <p role="status">Checking the link with their journal…</p>}
            {opened && (
                <>
                    <p className="mj_AcceptInvite_headline">
                        <strong>{opened.inviter.address}</strong> invites you to be contacts
                    </p>
                    <dl className="mj_AcceptInvite_details">
                        <dt>From</dt>
                        <dd data-field="address">{opened.inviter.address}</dd>
                        <dt>Journal</dt>
                        <dd data-field="journal">{opened.inviter.journal}</dd>
                        <dt>Fingerprint</dt>
                        <dd data-field="fingerprint" className="mj_AcceptInvite_fingerprint">
                            {opened.inviter.fingerprint}
                        </dd>
                    </dl>
                    {opened.key_changed ? (
                        <p className="mj_DeviceSheet_warning">{KEY_CHANGED_NOTE}</p>
                    ) : (
                        <p className="mj_DeviceSheet_muted">{FINGERPRINT_NOTE}</p>
                    )}
                    {existing && phase.kind !== "refused" && (
                        <p className="mj_DeviceSheet_muted">You are already contacts.</p>
                    )}
                </>
            )}
            {phase.kind === "sent" && (
                <p className="mj_DeviceSheet_success" role="status">
                    {ACCEPT_SENT}
                </p>
            )}
            {phase.kind === "refused" && (
                <p className="mj_UploadConfirm_error" role="alert" data-refusal>
                    {phase.message}
                </p>
            )}
            <div className="mj_UploadConfirm_actions">
                {canAccept ? (
                    <>
                        <button type="button" data-autofocus onClick={onClose}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="mj_UploadConfirm_send"
                            data-action="accept-invite"
                            disabled={phase.kind === "accepting"}
                            onClick={() => void accept(phase.opened)}
                        >
                            Accept
                        </button>
                    </>
                ) : (
                    <button type="button" data-autofocus onClick={onClose}>
                        {phase.kind === "opening" ? "Cancel" : "Close"}
                    </button>
                )}
            </div>
        </DeviceSheet>
    );
}

type PeopleDialog = { kind: "invite" } | { kind: "paste" };

/** Settings → People. Hidden while signed out. */
export function PeopleSettings({
    client,
    session,
}: {
    client: MatronJournalClient;
    session?: Session;
}): React.ReactElement | null {
    const [contacts, setContacts] = useState<Contact[]>();
    const [invites, setInvites] = useState<ContactInvite[]>([]);
    const [error, setError] = useState<string>();
    const [inviteError, setInviteError] = useState<string>();
    const [dialog, setDialog] = useState<PeopleDialog>();
    const mounted = useMounted();
    const loadSeq = useRef(0);

    const refresh = useCallback(async (): Promise<void> => {
        const seq = ++loadSeq.current;
        const [contactRows, inviteRows] = await Promise.allSettled([
            client.listContacts(),
            client.listContactInvites(),
        ]);
        if (!mounted.current || seq !== loadSeq.current) return;
        if (contactRows.status === "fulfilled") {
            setContacts(sortContacts(contactRows.value));
            setError(undefined);
        } else {
            setError(`Couldn't load contacts — ${refusalText(contactRows.reason)}`);
        }
        // With federation off the journal refuses the invite list; there is simply nothing open.
        setInvites(inviteRows.status === "fulfilled" ? inviteRows.value.filter((row) => row.state === "open") : []);
    }, [client, mounted]);

    // The accept sheet opens over everything; once it closes, a contact it made shows here.
    const accepting = useSyncExternalStore(
        client.subscribe,
        () => client.getSnapshot().contactInviteLink !== undefined,
    );
    const signedIn = session !== undefined;
    useEffect(() => {
        if (signedIn && !accepting) void refresh();
    }, [refresh, signedIn, accepting]);

    const withdraw = async (invite: ContactInvite): Promise<void> => {
        setInviteError(undefined);
        try {
            await client.withdrawContactInvite(invite.id);
        } catch (failure) {
            if (mounted.current) setInviteError(`Couldn't withdraw — ${refusalText(failure)}`);
        }
        void refresh();
    };

    if (!session) return null;

    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-people">
            <h3 id="mj-settings-people" className="mj_SettingsSheet_groupTitle">
                People
            </h3>
            {contacts && contacts.length > 0 && (
                <ul className="mj_SettingsSheet_rows mj_DevicesList mj_PeopleList">
                    {contacts.map((contact) => {
                        const caption = contactCaption(contact);
                        const unreachable = unreachableCaption(contact);
                        return (
                            <li
                                key={contact.id}
                                className="mj_SettingsSheet_row mj_DevicesList_row"
                                data-contact={contact.address}
                                data-state={contact.state}
                            >
                                <span className="mj_DevicesList_text">
                                    <span className="mj_DevicesList_name">{contactName(contact)}</span>
                                    {isRemoteContact(contact) && (
                                        <span className="mj_DevicesList_caption mj_PeopleList_address">
                                            {contact.address}
                                        </span>
                                    )}
                                    {caption && (
                                        <span
                                            className={`mj_DevicesList_caption${contact.key_changed ? " mj_PeopleList_warning" : ""}`}
                                        >
                                            {caption}
                                        </span>
                                    )}
                                    {unreachable && (
                                        <span className="mj_DevicesList_caption mj_PeopleList_warning">
                                            {unreachable}
                                        </span>
                                    )}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
            {contacts && contacts.length === 0 && !error && <p className="mj_SettingsSheet_help">No contacts yet.</p>}
            {error && <p className="mj_SettingsSheet_help mj_PeopleList_error">{error}</p>}
            <div className="mj_DevicesList_footer mj_PeopleList_footer">
                <button type="button" data-action="paste-invite" onClick={() => setDialog({ kind: "paste" })}>
                    Open an invite link
                </button>
                <button type="button" data-action="invite-remote" onClick={() => setDialog({ kind: "invite" })}>
                    Invite someone on another Matron
                </button>
            </div>
            {invites.length > 0 && (
                <>
                    <h4 className="mj_PeopleList_subhead">Open invites</h4>
                    <ul className="mj_SettingsSheet_rows mj_DevicesList mj_InviteList">
                        {invites.map((invite) => (
                            <li
                                key={invite.id}
                                className="mj_SettingsSheet_row mj_DevicesList_row"
                                data-invite={invite.id}
                            >
                                <span className="mj_DevicesList_text">
                                    <span className="mj_DevicesList_caption">{inviteCaption(invite)}</span>
                                </span>
                                <span className="mj_DevicesList_actions">
                                    <button
                                        type="button"
                                        className="mj_DevicesList_revoke"
                                        data-action="withdraw-invite"
                                        onClick={() => void withdraw(invite)}
                                    >
                                        Withdraw
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            {inviteError && (
                <p className="mj_SettingsSheet_error" role="alert">
                    {inviteError}
                </p>
            )}
            {dialog?.kind === "invite" && (
                <InviteSheet client={client} onDone={() => void refresh()} onClose={() => setDialog(undefined)} />
            )}
            {dialog?.kind === "paste" && (
                <PasteInviteSheet
                    onOpen={(link) => {
                        setDialog(undefined);
                        client.openContactInvite(link);
                    }}
                    onClose={() => setDialog(undefined)}
                />
            )}
        </section>
    );
}
