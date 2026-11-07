/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The shape of a contact invite link, kept apart from the rest of contacts.ts so the markdown
 * renderer can recognise one without pulling People into the initial bundle.
 */

const CONTACT_LINK_FIELDS = ["v", "j", "u", "t", "fp"] as const;

export interface ContactLink {
    journal: string;
    user: string;
}

/**
 * Reads a `matron://contact?v=1&j=<host>&u=<name>&t=<token>&fp=<fingerprint>` link, as the journal
 * would: exactly those five fields, each once. Null for anything else. The journal checks it again
 * (and checks the fingerprint against the inviter's journal), so this only decides whether the app
 * treats the text as an invite at all.
 */
export function parseContactLink(text: string): ContactLink | null {
    const link = text.trim();
    const match = /^matron:\/\/contact\?([^#\s]*)$/.exec(link);
    if (!match) return null;
    const params = new URLSearchParams(match[1]);
    const keys = [...params.keys()];
    if (keys.length !== CONTACT_LINK_FIELDS.length) return null;
    if (new Set(keys).size !== keys.length) return null;
    if (!CONTACT_LINK_FIELDS.every((field) => params.has(field))) return null;
    if (params.get("v") !== "1") return null;
    const journal = params.get("j") ?? "";
    const user = params.get("u") ?? "";
    if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(journal) || !user) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.get("t") ?? "")) return null;
    if (!/^[a-z2-7]{26}$/.test(params.get("fp") ?? "")) return null;
    return { journal, user };
}

/** Whether a string claims to be a contact invite link, valid or not. */
export function looksLikeContactLink(text: string): boolean {
    return /^\s*matron:\/\/contact\b/i.test(text);
}
