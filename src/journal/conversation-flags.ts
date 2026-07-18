/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { Conversation, Session } from "./types";

export interface IdSetStore {
    storageKey(session: Session): string;
    // read returns { ids, ok } so callers distinguish an empty persisted set (ok:true)
    // from a failed storage read (ok:false) — the latter must NOT overwrite prior state.
    read(session: Session): { ids: Set<string>; ok: boolean };
    write(session: Session, ids: Set<string>): void;
    parse(raw: string | null): Set<string>;
}

export function makeIdSetStore(keyPrefix: string, label: string): IdSetStore {
    const storageKey = (session: Session): string =>
        `${keyPrefix}:${encodeURIComponent(session.serverUrl)}:${session.userId}`;

    const parse = (raw: string | null): Set<string> => {
        if (raw === null) return new Set();
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            console.warn(`matron: malformed ${label} value, ignoring`);
            return new Set();
        }
        if (!Array.isArray(parsed)) {
            console.warn(`matron: ${label} value not an array, ignoring`);
            return new Set();
        }
        return new Set(parsed.filter((value): value is string => typeof value === "string"));
    };

    const read = (session: Session): { ids: Set<string>; ok: boolean } => {
        let raw: string | null;
        try {
            raw = localStorage.getItem(storageKey(session));
        } catch {
            console.warn(`matron: ${label} read failed (storage unavailable)`);
            return { ids: new Set(), ok: false };
        }
        return { ids: parse(raw), ok: true };
    };

    const write = (session: Session, ids: Set<string>): void => {
        localStorage.setItem(storageKey(session), JSON.stringify([...ids]));
    };

    return { storageKey, read, write, parse };
}

export function effectiveUnread(
    conversation: Pick<Conversation, "id" | "unread_count">,
    unreadOverrideIds: Set<string>,
): boolean {
    return conversation.unread_count > 0 || unreadOverrideIds.has(conversation.id);
}
