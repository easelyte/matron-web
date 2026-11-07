/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Contacts, and contacts on other journals by invite link (journal docs/protocol.md, "Contacts" and
 * "Contacts across journals"). The pure parts live here: the link's shape, the rows' captions and
 * the refusals in plain words. People settings (PeopleSettings.tsx) and the invite ask card
 * (people-card.tsx) draw them.
 */

import { JournalApiError } from "./api";
import { formatShortDate } from "./date-format";
import { asString } from "./types";

export { looksLikeContactLink, parseContactLink, type ContactLink } from "./contact-link";

export type ContactState =
    "awaiting_user" | "pending_out" | "pending_in" | "active" | "blocked" | "declined" | "removed" | "expired";

export interface Contact {
    id: string;
    /** `user` on this journal, `user@journal` on another. */
    address: string;
    peer_user: string;
    peer_journal?: string | null;
    display_name?: string | null;
    state: ContactState;
    key_changed?: boolean;
    /** When the contact's journal stopped answering (epoch ms); absent while it answers. */
    unreachable_since?: number | null;
    created_at?: number;
    accepted_at?: number | null;
}

export type InviteState = "open" | "used" | "expired" | "revoked";

export interface ContactInvite {
    id: string;
    state: InviteState;
    created_at: number;
    expires_at: number;
    used_at?: number | null;
    used_by?: string | null;
    revoked_at?: number | null;
}

/** POST /contacts/invites/open: who sent the link, checked against their journal's key. */
export interface InviteOpened {
    inviter: { address: string; name: string; journal: string; fingerprint: string };
    key_changed: boolean;
    contact: Contact | null;
}

export type InviteAskDecision = "approve" | "decline";

export interface InviteAskAnswer {
    ask: { id: string; state: "awaiting_user" | "approved" | "declined" | "expired" };
    invite?: ContactInvite;
    link?: string;
}

/** The name a contact row leads with. */
export function contactName(contact: Contact): string {
    return asString(contact.display_name).trim() || contact.peer_user || contact.address;
}

/** Whether the contact lives on another journal (its address carries `@journal`). */
export function isRemoteContact(contact: Contact): boolean {
    return !!contact.peer_journal || contact.address.includes("@");
}

/** The second line of a contact row; "" when there is nothing to add to the address. */
export function contactCaption(contact: Contact): string {
    if (contact.key_changed) {
        return "Their journal's key has changed. Nothing is shared until they send you a new invite.";
    }
    if (contact.state === "pending_out") return "Waiting for them to accept";
    if (contact.state === "pending_in") return "Wants to add you — answer in For you";
    if (contact.state === "awaiting_user") return "Your agent asked — answer in For you";
    if (contact.state === "blocked") return "Blocked";
    return "";
}

/** "Their journal hasn't answered since 3 Nov.", when the journal says so; "" otherwise. */
export function unreachableCaption(contact: Contact): string {
    const since = contact.unreachable_since;
    return typeof since === "number" && since > 0
        ? `Their journal hasn't answered since ${formatShortDate(since)}.`
        : "";
}

/** Live rows first (active, then pending), then by name. */
export function sortContacts(contacts: Contact[]): Contact[] {
    const rank = (contact: Contact): number => (contact.state === "active" ? 0 : contact.state === "blocked" ? 2 : 1);
    return [...contacts].sort(
        (a, b) => rank(a) - rank(b) || contactName(a).localeCompare(contactName(b), undefined, { sensitivity: "base" }),
    );
}

/** "Made 7 Nov · expires 14 Nov" for an open invite's row. */
export function inviteCaption(invite: ContactInvite): string {
    return `Made ${formatShortDate(invite.created_at)} · expires ${formatShortDate(invite.expires_at)}`;
}

export const INVITE_SHEET_NOTE =
    "Send this link to them yourself. It is shown only now, works once and lasts 7 days. Nobody becomes a contact until they open it and accept.";

export const ASK_LINK_NOTE = "Shown only on this device, this once. Send it to them yourself.";

export const FINGERPRINT_NOTE =
    "Compare this fingerprint with them another way, in person or on a call, before you accept.";

export const KEY_CHANGED_NOTE =
    "Their journal's key has changed since you were last in touch. Compare the fingerprint before you accept.";

export const ACCEPT_SENT = "Sent. You become contacts when their journal confirms.";

const REFUSALS: Record<string, string> = {
    fingerprint_mismatch:
        "This link's fingerprint does not match their journal. Do not accept it; ask them for a new link.",
    journal_blocked: "Your journal has blocked that journal.",
    own_journal: "This link is from your own journal. Add people here by name instead.",
    unreachable: "Their journal could not be reached. Try again later.",
    bad_journal: "That address is not a Matron journal.",
    federation_off: "Contacts on other Matrons are turned off on your journal.",
    already_contact: "You are already contacts.",
    pending: "You have already accepted; waiting for their journal.",
    blocked: "You have blocked this person. Unblock them first.",
    too_many_contacts: "You have too many contacts on other journals.",
    too_many_invites: "You already have 20 open invites. Withdraw one first.",
    not_pending: "Already answered.",
    expired: "This request expired before it was answered.",
};

export const INVALID_LINK = "This is not a valid invite link.";

/** The reason code a refused contacts call carries: `blocked_by` on a 409, `error` otherwise. */
export function refusalCode(error: unknown): string {
    if (!(error instanceof JournalApiError)) return "";
    const blockedBy = asString(error.body?.blocked_by);
    if (blockedBy) return blockedBy;
    return asString(error.body?.error) || asString(error.code);
}

/** A refused invite call in plain words. `host` is the inviter's journal, when the link is known. */
export function refusalText(error: unknown, host?: string): string {
    if (error instanceof JournalApiError) {
        if (error.status === 0) return "Not sent — check your connection and try again.";
        if (refusalCode(error) === "journal_not_allowed") {
            return `Your journal doesn't allow contacts on ${host || "that journal"}.`;
        }
        const known = REFUSALS[refusalCode(error)];
        if (known) return known;
        if (error.status === 400) return INVALID_LINK;
        if (error.status === 403) return "This account cannot make invites.";
        if (error.status === 404) return "This is no longer open.";
    }
    return "Something went wrong. Try again.";
}
