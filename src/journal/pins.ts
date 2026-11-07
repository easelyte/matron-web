/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Journal-backed pinned desk chats (journal protocol "Pins"): up to `limit` conversations the
 * user names and orders, shared by every client. A journal that predates pins omits the `pins`
 * key from GET /snapshot and hello_ok; the client then keeps its browser-local pinned set.
 */

import { JournalApiError } from "./api";
import { conversationBox, splitTitle } from "./boxes";
import {
    isObject,
    type AgentRosterEntry,
    type Conversation,
    type ConvoPin,
    type ConvoPinSuccessor,
    conversationTitle,
    type Session,
} from "./types";

/** The journal's cap when a response does not say (protocol: max 5 pins). */
export const DEFAULT_PIN_LIMIT = 5;
/** A pin label is one line of 1–24 characters. */
export const PIN_LABEL_MAX = 24;
export const PIN_LABEL_FALLBACK = "Pinned chat";

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSuccessor(raw: unknown): ConvoPinSuccessor | undefined {
    if (!isObject(raw) || typeof raw.convo_id !== "string" || !raw.convo_id) return undefined;
    return {
        convo_id: raw.convo_id,
        title: typeof raw.title === "string" ? raw.title : "",
        created_at: finite(raw.created_at) ?? 0,
    };
}

/** One pin, or undefined when the row lacks what the sidebar needs (id + label). */
export function parsePin(raw: unknown): ConvoPin | undefined {
    if (!isObject(raw) || typeof raw.convo_id !== "string" || !raw.convo_id) return undefined;
    if (typeof raw.label !== "string" || !raw.label.trim()) return undefined;
    const successor = parseSuccessor(raw.successor);
    return {
        convo_id: raw.convo_id,
        label: raw.label,
        emoji: typeof raw.emoji === "string" ? raw.emoji : "",
        position: finite(raw.position) ?? 0,
        device_id: finite(raw.device_id) ?? null,
        ...(raw.missing === true ? { missing: true as const } : {}),
        ...(successor ? { successor } : {}),
        created_at: finite(raw.created_at) ?? 0,
        updated_at: finite(raw.updated_at) ?? 0,
    };
}

/** A pin array in `position` order, malformed rows dropped; undefined when `raw` is not an array. */
export function parsePinList(raw: unknown): ConvoPin[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const seen = new Set<string>();
    const pins: ConvoPin[] = [];
    for (const entry of raw) {
        const pin = parsePin(entry);
        if (!pin || seen.has(pin.convo_id)) continue;
        seen.add(pin.convo_id);
        pins.push(pin);
    }
    return pins.sort((a, b) => a.position - b.position);
}

/**
 * The `pins` carried by a snapshot or hello_ok body: the list when the journal supports pins,
 * null when the key is absent (an older journal) or unusable.
 */
export function pinsFromContainer(container: unknown): ConvoPin[] | null {
    if (!isObject(container) || !("pins" in container)) return null;
    return parsePinList(container.pins) ?? null;
}

/** A `{pins, limit}` body from any /pins route; throws on a body with no pin array. */
export function parsePinsResponse(raw: unknown): { pins: ConvoPin[]; limit: number } {
    const pins = isObject(raw) ? parsePinList(raw.pins) : undefined;
    if (!pins) throw new Error("The journal server returned a malformed pins response.");
    const limit = finite((raw as Record<string, unknown>).limit);
    return { pins, limit: limit !== undefined && limit > 0 ? limit : DEFAULT_PIN_LIMIT };
}

/** The inline copy for a failed pin write: the journal's 409s get their own words. */
export function pinErrorMessage(error: unknown): string {
    if (error instanceof JournalApiError && error.status === 409) {
        const detail = error.body?.detail;
        if (detail === "pin_limit") {
            const limit = finite(error.body?.limit);
            return `You can pin up to ${limit !== undefined && limit > 0 ? limit : DEFAULT_PIN_LIMIT} chats.`;
        }
        if (detail === "already_pinned") return "That chat is already pinned.";
    }
    if (error instanceof JournalApiError && error.status === 404) return "That chat isn't pinned any more.";
    return error instanceof Error && error.message ? error.message : "Couldn't update pins.";
}

/** A label fitting the journal's rule: one line, trimmed, at most 24 characters (code points). */
export function clampPinLabel(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return Array.from(line).slice(0, PIN_LABEL_MAX).join("").trim();
}

/** The label a conversation's title suggests: the bridge's marker and "[ab] " short peeled off. */
export function pinLabelFromTitle(title: string): string {
    const { title: rest } = splitTitle(title.trim());
    return clampPinLabel(rest) || PIN_LABEL_FALLBACK;
}

/** The glyph a pin row leads with: its emoji, else the label's first letter upper-cased. */
export function pinGlyph(pin: Pick<ConvoPin, "emoji" | "label">): string {
    const emoji = pin.emoji.trim();
    if (emoji) return emoji;
    return (Array.from(pin.label.trim())[0] ?? "?").toLocaleUpperCase();
}

/** The full order after moving `convoId` one step up or down; undefined when it cannot move. */
export function movedPinOrder(
    pins: ConvoPin[],
    convoId: string,
    direction: "up" | "down",
    // The pins the sidebar shows; the swap is with the nearest shown neighbour, so a hidden
    // (archived) pin between them keeps its place. Defaults to every pin.
    shownIds?: readonly string[],
): string[] | undefined {
    const order = pins.map((pin) => pin.convo_id);
    const shown = (shownIds ?? order).filter((id) => order.includes(id));
    const shownIndex = shown.indexOf(convoId);
    const neighbour = shown[direction === "up" ? shownIndex - 1 : shownIndex + 1];
    if (shownIndex === -1 || neighbour === undefined) return undefined;
    const index = order.indexOf(convoId);
    const target = order.indexOf(neighbour);
    [order[index], order[target]] = [order[target], order[index]];
    return order;
}

/** "New session on <box> — move pin here?", naming the successor's box (else the pin's, else "this box"). */
export function successorHintText(
    pin: ConvoPin,
    conversations: Pick<Conversation, "id" | "agent_device_id">[],
    agents: AgentRosterEntry[],
): string {
    const successorConvo = pin.successor
        ? conversations.find((conversation) => conversation.id === pin.successor!.convo_id)
        : undefined;
    const deviceId = successorConvo?.agent_device_id ?? pin.device_id;
    const name = deviceId == null ? undefined : agents.find((agent) => agent.device_id === deviceId)?.name.trim();
    return `New session on ${name || "this box"} — move pin here?`;
}

/** One box the Move pin chooser can narrow to: its roster name and how many candidates it has. */
export type PinChooserBox = { name: string; count: number };

/** The box name a conversation row shows (its roster entry's name), or undefined when unnamed or unknown. */
function boxName(conversation: Conversation, roster: AgentRosterEntry[] | undefined): string | undefined {
    return conversationBox(conversation, roster)?.name.trim() || undefined;
}

/** The boxes the chooser's candidates run on, by name, each with its candidate count. */
export function pinChooserBoxes(candidates: Conversation[], roster: AgentRosterEntry[] | undefined): PinChooserBox[] {
    const counts = new Map<string, number>();
    for (const conversation of candidates) {
        const name = boxName(conversation, roster);
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the Move pin chooser shows: the box filter's options (empty unless the candidates span two
 * or more named boxes), the box actually in force (null = All; a chosen box that no candidate runs
 * on any more falls back to All), and the candidates matching both that box and the title query.
 * The options come from every candidate, not the query's matches, so typing never moves the filter.
 */
export function pinChooserView(
    candidates: Conversation[],
    roster: AgentRosterEntry[] | undefined,
    query: string,
    box: string | null,
): { boxes: PinChooserBox[]; box: string | null; conversations: Conversation[] } {
    const all = pinChooserBoxes(candidates, roster);
    const boxes = all.length >= 2 ? all : [];
    const active = box !== null && boxes.some((option) => option.name === box) ? box : null;
    const normalized = query.trim().toLocaleLowerCase();
    const conversations = candidates.filter(
        (conversation) =>
            (active === null || boxName(conversation, roster) === active) &&
            (!normalized || conversationTitle(conversation).toLocaleLowerCase().includes(normalized)),
    );
    return { boxes, box: active, conversations };
}

/**
 * The PUTs that carry the browser-local pinned set over to the journal: locally pinned
 * conversations in sidebar (list) order, skipping ones the journal already pins, up to the
 * room the limit leaves.
 */
export function planPinImport(
    localIds: ReadonlySet<string>,
    conversations: Pick<Conversation, "id" | "title">[],
    journalPins: ConvoPin[],
    limit: number,
): Array<{ convo_id: string; label: string }> {
    const pinned = new Set(journalPins.map((pin) => pin.convo_id));
    const room = Math.max(0, limit - journalPins.length);
    return conversations
        .filter((conversation) => localIds.has(conversation.id) && !pinned.has(conversation.id))
        .slice(0, room)
        .map((conversation) => ({ convo_id: conversation.id, label: pinLabelFromTitle(conversation.title) }));
}

// Once per (server, user): set after the local pinned set has been carried over to the journal.
const PIN_IMPORT_KEY_PREFIX = "matron_journal_pins_imported_v1";

export function pinImportStorageKey(session: Session): string {
    return `${PIN_IMPORT_KEY_PREFIX}:${encodeURIComponent(session.serverUrl)}:${session.userId}`;
}

export function pinImportDone(session: Session): boolean {
    try {
        return localStorage.getItem(pinImportStorageKey(session)) === "1";
    } catch {
        // Unreadable storage: report done so an import never repeats against a journal that has the pins.
        return true;
    }
}

export function markPinImportDone(session: Session): void {
    try {
        localStorage.setItem(pinImportStorageKey(session), "1");
    } catch {
        // The local set is cleared alongside, so a lost flag only means an empty import next time.
    }
}

// The last journal pin list this browser adopted, per (server, user), so a reload or an offline
// start draws the Pinned section before the socket's hello_ok (which then replaces it).
const PIN_CACHE_KEY_PREFIX = "matron_journal_pins_cache_v1";

function pinCacheStorageKey(session: Session): string {
    return `${PIN_CACHE_KEY_PREFIX}:${encodeURIComponent(session.serverUrl)}:${session.userId}`;
}

/** The cached list, or null when there is none (or storage is unreadable or the entry is corrupt). */
export function readCachedPins(session: Session): ConvoPin[] | null {
    try {
        const raw = localStorage.getItem(pinCacheStorageKey(session));
        return raw === null ? null : (parsePinList(JSON.parse(raw)) ?? null);
    } catch {
        return null;
    }
}

/** Cache the adopted list; null (a journal without pins) drops the entry. */
export function writeCachedPins(session: Session, pins: ConvoPin[] | null): void {
    try {
        if (pins) localStorage.setItem(pinCacheStorageKey(session), JSON.stringify(pins));
        else localStorage.removeItem(pinCacheStorageKey(session));
    } catch {
        // Only costs the pre-hello Pinned section on the next start.
    }
}
