/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Journal-synced archive (journal protocol "Archived conversations"). The browser-local archived
 * set stays the sidebar's source; on a journal with archiving it becomes a cache of the journal's
 * set, kept current by `hello_ok.archive` and live `archive` frames, and every Archive/Unarchive is
 * also sent to the journal. A journal without archiving never answers `archive_since`, and the set
 * stays browser-local as before.
 *
 * The cursor (`since`) is stored per (server, user). No stored cursor means this browser has not
 * synced with the journal yet: the hello asks for the whole set, and the browser-local ids the
 * journal does not have are carried over once.
 */

import { type Session } from "./types";

export interface ArchiveChange {
    convo_id: string;
    /** When it was archived; null for an unarchive. */
    archived_at: number | null;
    /** Archived by the journal's idle sweep rather than by hand. */
    auto: boolean;
}

export interface ArchiveDelta {
    changes: ArchiveChange[];
    /** The value to send as `archive_since` next time. */
    at: number;
}

/** The journal accepts at most this many ids per POST /archive. */
export const ARCHIVE_BATCH_MAX = 500;

/** The auto-archive choices offered in Settings, in days (0 = off). */
export const AUTO_ARCHIVE_CHOICES: readonly number[] = [0, 14, 30, 90];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChange(raw: unknown): ArchiveChange | undefined {
    if (!isRecord(raw) || typeof raw.convo_id !== "string" || !raw.convo_id) return undefined;
    const archivedAt = raw.archived_at;
    if (archivedAt !== null && (typeof archivedAt !== "number" || !Number.isFinite(archivedAt))) return undefined;
    return { convo_id: raw.convo_id, archived_at: archivedAt, auto: raw.auto === true };
}

/** `{changes, at}` from hello_ok's `archive`, an `archive` frame or GET /archive; undefined when
 *  `raw` does not have that shape. Malformed changes are dropped. */
export function parseArchiveDelta(raw: unknown): ArchiveDelta | undefined {
    if (!isRecord(raw) || !Array.isArray(raw.changes)) return undefined;
    const at = typeof raw.at === "number" && Number.isFinite(raw.at) && raw.at >= 0 ? raw.at : 0;
    const changes = raw.changes.map(parseChange).filter((c): c is ArchiveChange => c !== undefined);
    return { changes, at };
}

/** `ids` with `changes` applied in order; the same Set when nothing changed. */
export function applyArchiveChanges(ids: Set<string>, changes: readonly ArchiveChange[]): Set<string> {
    let next: Set<string> | undefined;
    for (const change of changes) {
        const archived = change.archived_at !== null;
        if (archived === (next ?? ids).has(change.convo_id)) continue;
        next ??= new Set(ids);
        if (archived) next.add(change.convo_id);
        else next.delete(change.convo_id);
    }
    return next ?? ids;
}

/** `ids` in batches the journal accepts. */
export function archiveBatches(ids: Iterable<string>): string[][] {
    const all = [...ids];
    const out: string[][] = [];
    for (let i = 0; i < all.length; i += ARCHIVE_BATCH_MAX) out.push(all.slice(i, i + ARCHIVE_BATCH_MAX));
    return out;
}

/** "Off", "After 30 days" … for a stored value, including one this build does not offer. */
export function autoArchiveLabel(days: number): string {
    return days === 0 ? "Off" : `After ${days} day${days === 1 ? "" : "s"}`;
}

export function archiveSinceStorageKey(session: Session): string {
    return `matron_journal_archive_since_v1:${encodeURIComponent(session.serverUrl)}:${session.userId}`;
}

/** The stored cursor, or undefined when this browser has not synced the archive yet (or the
 *  storage cannot be read: asking for the whole set again is always safe). */
export function readArchiveSince(session: Session): number | undefined {
    let raw: string | null;
    try {
        raw = localStorage.getItem(archiveSinceStorageKey(session));
    } catch {
        return undefined;
    }
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function writeArchiveSince(session: Session, at: number): void {
    try {
        localStorage.setItem(archiveSinceStorageKey(session), String(at));
    } catch {
        // A lost cursor only means the next hello asks for the whole set again.
    }
}
