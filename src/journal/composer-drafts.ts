/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { Session } from "./types";
import { utf8Length } from "./types";

export const MAX_DRAFT_BYTES = 64 * 1024;
export const MAX_DRAFT_ENTRIES = 50;

export interface DraftStore {
    read(convoId: string): { text: string; ok: boolean };
    setDraft(convoId: string, text: string): void;
    persist(): void;
    clear(convoId: string): void;
}

const NOOP: DraftStore = {
    read: () => ({ text: "", ok: true }),
    setDraft: () => undefined,
    persist: () => undefined,
    clear: () => undefined,
};

function parseMap(raw: string | null): Record<string, string> {
    if (raw === null) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn("matron: malformed draft store, resetting");
        return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
    }
    return out;
}

export function makeDraftStore(session: Session | undefined): DraftStore {
    if (!session) return NOOP;
    const key = `matron:draft:v1:${encodeURIComponent(session.serverUrl)}:${session.userId}`;
    const mem = new Map<string, string>();
    let hydrated = false;

    const hydrate = (): boolean => {
        try {
            const map = parseMap(localStorage.getItem(key));
            for (const [convoId, text] of Object.entries(map)) {
                if (!mem.has(convoId)) mem.set(convoId, text);
            }
            while (mem.size > MAX_DRAFT_ENTRIES) {
                mem.delete(mem.keys().next().value as string);
            }
            hydrated = true;
            return true;
        } catch {
            console.warn("matron: draft read failed (storage unavailable)");
            return false;
        }
    };

    const persist = (): void => {
        try {
            const out: Record<string, string> = {};
            for (const [convoId, text] of mem) {
                if (utf8Length(text) <= MAX_DRAFT_BYTES) out[convoId] = text;
            }
            localStorage.setItem(key, JSON.stringify(out));
        } catch {
            console.warn("matron: draft persist failed (storage full/unavailable)");
        }
    };

    return {
        read(convoId) {
            if (mem.has(convoId)) return { text: mem.get(convoId)!, ok: true };
            if (!hydrated) {
                const ok = hydrate();
                if (!ok) return { text: "", ok: false };
            }
            return { text: mem.get(convoId) ?? "", ok: true };
        },
        setDraft(convoId, text) {
            if (!hydrated) hydrate();
            mem.delete(convoId);
            if (text.trim() !== "") {
                mem.set(convoId, text);
                while (mem.size > MAX_DRAFT_ENTRIES) {
                    const oldest = mem.keys().next().value as string;
                    mem.delete(oldest);
                }
            }
        },
        persist,
        clear(convoId) {
            if (!hydrated) hydrate();
            mem.delete(convoId);
            persist();
        },
    };
}
