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
    persist(convoId: string): void;
    clear(convoId: string): void;
    durability(convoId: string): "ok" | "non-durable";
}

const NOOP: DraftStore = {
    read: () => ({ text: "", ok: true }),
    setDraft: () => undefined,
    persist: () => undefined,
    clear: () => undefined,
    durability: () => "ok",
};

function parseMap(raw: string): Record<string, string> | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    // Parse-don't-validate per entry: drop a non-string value but keep valid string siblings, so one
    // corrupt/legacy-drifted entry can't hide every other valid draft. Only unparseable JSON or a
    // non-object top level resets the whole map (returns undefined above).
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
    }
    return out;
}

export function makeDraftStore(session: Session | undefined): DraftStore {
    if (!session) return NOOP;
    const namespace = `${encodeURIComponent(session.serverUrl)}:${session.userId}`;
    const legacyKey = `matron:draft:v1:${namespace}`;
    const prefix = `matron:draft:v2:${namespace}:`;
    const perKey = (convoId: string): string => `${prefix}${encodeURIComponent(convoId)}`;
    const mem = new Map<string, string>();
    const durabilityByConvo = new Map<string, "ok" | "non-durable">();
    let lastTouched: string | undefined;

    const setDurability = (convoId: string, value: "ok" | "non-durable"): void => {
        durabilityByConvo.set(convoId, value);
    };

    const persistedKeyCount = (): number => {
        let count = 0;
        for (let index = 0; index < localStorage.length; index += 1) {
            if (localStorage.key(index)?.startsWith(prefix)) count += 1;
        }
        return count;
    };

    const purgeLegacyEntry = (convoId: string): void => {
        const raw = localStorage.getItem(legacyKey);
        if (raw === null) return;
        const legacy = parseMap(raw);
        if (legacy === undefined || !(convoId in legacy)) return;
        delete legacy[convoId];
        if (Object.keys(legacy).length === 0) {
            localStorage.removeItem(legacyKey);
        } else {
            localStorage.setItem(legacyKey, JSON.stringify(legacy));
        }
    };

    const deleteEverywhere = (convoId: string): void => {
        mem.delete(convoId);
        try {
            // Purge v1 first to minimize stale fallback after a partial failure.
            purgeLegacyEntry(convoId);
            localStorage.removeItem(perKey(convoId));
            setDurability(convoId, "ok");
        } catch {
            console.warn("matron: draft clear failed (storage full/unavailable)");
            setDurability(convoId, "non-durable");
        }
    };

    const migrateLegacy = (): void => {
        let raw: string | null;
        try {
            raw = localStorage.getItem(legacyKey);
        } catch {
            console.warn("matron: draft migration failed (storage unavailable)");
            return;
        }
        if (raw === null) return;

        const legacy = parseMap(raw);
        if (legacy === undefined) {
            console.warn("matron: malformed legacy draft store, skipping migration");
            return;
        }

        const entries = Object.entries(legacy);
        let count: number;
        try {
            count = persistedKeyCount();
        } catch {
            for (const [convoId] of entries) setDurability(convoId, "non-durable");
            console.warn("matron: draft migration failed (storage unavailable)");
            return;
        }

        let allDurable = true;
        for (const [convoId, text] of entries) {
            try {
                const target = perKey(convoId);
                // v2-precedence: never overwrite an existing v2 value with the stale v1 copy.
                // ACCEPTED ultra-rare edge: the getItem check and the setItem below are not atomic, so a
                // concurrent tab that writes a NEWER v2 value for this convo in the gap could be overwritten.
                // This requires two tabs both active during the ONE-TIME v1->v2 migration window — the same
                // cross-tab-non-atomic class documented for clear/eviction; a per-namespace lock is
                // disproportionate for a one-time migration of unsent drafts.
                if (localStorage.getItem(target) !== null) continue;
                if (utf8Length(text) > MAX_DRAFT_BYTES || count >= MAX_DRAFT_ENTRIES) {
                    allDurable = false;
                    setDurability(convoId, "non-durable");
                    continue;
                }
                localStorage.setItem(target, text);
                if (localStorage.getItem(target) === null) {
                    allDurable = false;
                    setDurability(convoId, "non-durable");
                    continue;
                }
                count += 1;
            } catch {
                allDurable = false;
                setDurability(convoId, "non-durable");
            }
        }

        if (!allDurable) return;
        try {
            localStorage.removeItem(legacyKey);
        } catch {
            for (const [convoId] of entries) setDurability(convoId, "non-durable");
            console.warn("matron: draft migration cleanup failed (storage unavailable)");
        }
    };

    migrateLegacy();

    return {
        read(convoId) {
            if (mem.has(convoId)) return { text: mem.get(convoId)!, ok: true };
            try {
                const current = localStorage.getItem(perKey(convoId));
                if (current !== null) return { text: current, ok: true };
                const raw = localStorage.getItem(legacyKey);
                const legacy = raw === null ? undefined : parseMap(raw);
                return { text: legacy?.[convoId] ?? "", ok: true };
            } catch {
                console.warn("matron: draft read failed (storage unavailable)");
                return { text: "", ok: false };
            }
        },
        setDraft(convoId, text) {
            mem.set(convoId, text);
            lastTouched = convoId;
        },
        persist(convoId) {
            // Kept as internal edit-order state; writes are always explicitly keyed.
            void lastTouched;
            // Only persist a conversation that was actually edited this session. A restored-but-
            // untouched draft is NOT in `mem` (read() is lazy and does not hydrate it), so treating
            // an absent entry as "" would silently delete the saved draft on any flush (blur/navigate/
            // pagehide/unmount) without an edit. No mem entry => nothing to write, and nothing to delete.
            if (!mem.has(convoId)) return;
            const text = mem.get(convoId) ?? "";
            if (text.trim() === "") {
                deleteEverywhere(convoId);
                return;
            }
            if (utf8Length(text) > MAX_DRAFT_BYTES) {
                setDurability(convoId, "non-durable");
                return;
            }
            try {
                const target = perKey(convoId);
                const exists = localStorage.getItem(target) !== null;
                if (!exists && persistedKeyCount() >= MAX_DRAFT_ENTRIES) {
                    setDurability(convoId, "non-durable");
                    return;
                }
                localStorage.setItem(target, text);
                setDurability(convoId, "ok");
            } catch {
                console.warn("matron: draft persist failed (storage full/unavailable)");
                setDurability(convoId, "non-durable");
            }
        },
        clear(convoId) {
            deleteEverywhere(convoId);
        },
        durability(convoId) {
            return durabilityByConvo.get(convoId) ?? "ok";
        },
    };
}
