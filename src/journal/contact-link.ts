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
 * Reads a contact invite link, as the journal would, in either of its two forms:
 *
 *     https://<host>/contact#v=1&j=<host>&u=<name>&t=<token>&fp=<fingerprint>
 *     matron://contact?v=1&j=<host>&u=<name>&t=<token>&fp=<fingerprint>
 *
 * Exactly those five fields, each once. The https form (the one chat apps make tappable) carries
 * them in the fragment, must be on the journal it names, at exactly `/contact`, with no query or
 * user info. Null for anything else. The journal checks it again (and checks the fingerprint
 * against the inviter's journal), so this only decides whether the app treats the text as an
 * invite at all.
 */
export function parseContactLink(text: string): ContactLink | null {
    const link = text.trim();
    if (link.length > 1024) return null;
    const app = /^matron:\/\/contact\?([^#\s]*)$/.exec(link);
    if (app) return parseFields(app[1]);
    if (!/^https:\/\//i.test(link) || /\s/.test(link)) return null;
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.pathname !== "/contact" || url.search || url.username || url.password) {
        return null;
    }
    if (url.hash.length < 2) return null;
    const fields = parseFields(url.hash.slice(1));
    if (!fields) return null;
    // `j` as a URL writes it, as the journal reads it: an explicit default port (`:443`) is
    // dropped, and a port the URL parser refuses is no link.
    let named: string;
    try {
        named = new URL(`https://${fields.journal}`).host;
    } catch {
        return null;
    }
    return named === url.host ? fields : null;
}

function parseFields(query: string): ContactLink | null {
    const params = new URLSearchParams(query);
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
    return /^\s*(?:matron:\/\/contact\b|https:\/\/[^/\s]+\/contact#)/i.test(text);
}

/** The link to hand on from a mint: the https form when the journal sent one, else `matron://`. */
export function shareableInviteLink(minted: { link?: string; web_link?: string }): string | undefined {
    return minted.web_link || minted.link || undefined;
}
