/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Settings → Devices as the Mac app has it: the rules behind renaming a device, setting an agent
 * box's tag character, pairing a new agent box (Add Agent) and showing a sign-in code to a second
 * device (Link a Device). The journal applies the same rules; mirroring them here lets the sheet
 * refuse or warn before a round trip.
 */

import type { DeviceDTO } from "./types";

/** The journal's cap on a device name (after trimming). */
export const DEVICE_NAME_MAX = 40;

/** Why a drafted device name would be refused, or undefined when it is fine. */
export function deviceNameProblem(draft: string): string | undefined {
    const trimmed = draft.trim();
    if (!trimmed) return "Give the device a name.";
    if ([...trimmed].length > DEVICE_NAME_MAX) return `Names are at most ${DEVICE_NAME_MAX} characters.`;
    return undefined;
}

const segmenter: Intl.Segmenter | undefined =
    typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : undefined;

function firstGrapheme(text: string): string | undefined {
    if (!text) return undefined;
    if (segmenter) {
        for (const { segment } of segmenter.segment(text)) return segment;
        return undefined;
    }
    return [...text][0];
}

// Format, control and space-separator scalars: a tag made only of these renders as nothing.
const INVISIBLE = /^[\p{Cf}\p{Cc}\p{Zs}]$/u;

/**
 * The tag character a draft sends: trimmed, then only its first grapheme. Empty, a cluster of more
 * than 16 scalars, or one that would render as nothing is null — "automatic", derived from the
 * box name. The journal keeps to the same bounds.
 */
export function tagCharFromDraft(draft: string): string | null {
    const tag = firstGrapheme(draft.trim());
    if (!tag) return null;
    const scalars = [...tag];
    if (scalars.length > 16) return null;
    return scalars.some((scalar) => !INVISIBLE.test(scalar)) ? tag : null;
}

/** The warning under the Add Agent tag field when another agent box already shows that tag. */
export function duplicateTagWarning(draft: string, existingTags: readonly string[]): string | undefined {
    const tag = tagCharFromDraft(draft);
    if (!tag) return undefined;
    const clash = existingTags.some(
        (existing) => existing.localeCompare(tag, undefined, { sensitivity: "accent" }) === 0,
    );
    return clash ? `Another agent already uses the tag ${tag}` : undefined;
}

// ── Pairing codes (Add Agent) ────────────────────────────────────────────────────────────────

export const PAIRING_CODE_LENGTH = 8;

/** Every character the journal mints a code from: Crockford base32 without its vowels. */
const PAIRING_ALPHABET = /^[0-9BCDFGHJKMNPQRSTVWXYZ]+$/;

/**
 * The journal's own normalisation: upper-cased, then everything but ASCII letters and digits
 * dropped. Matching it exactly matters: a look-alike letter from another script must count as
 * dropped here too, or the sheet would preview a different code from the one it shows.
 */
export function normalizePairingCode(raw: string): string {
    return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** As typed: `KTNM-3VQ8`, the hyphen appearing once a fifth character exists. */
export function displayPairingCode(raw: string): string {
    const code = normalizePairingCode(raw);
    return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Whether a string claims to be an agent-pairing link (`matron://pair…`), valid or not. */
export function isPairUri(raw: string): boolean {
    return /^matron:\/\/pair(?:[/?#]|$)/i.test(raw.trim());
}

export type PairUriResult =
    | { ok: true; server: URL; code: string }
    | { ok: false; reason: "not_pair_uri" | "unsupported_version" | "malformed" };

/** `https` always; cleartext `http` only for a server on this machine. */
function allowedServer(url: URL): boolean {
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/**
 * Unpacks the pairing link a box prints beside its code:
 * `matron://pair?v=1&server=<server URL>&code=XXXX-XXXX`. The code comes back in display form.
 */
export function parsePairUri(raw: string): PairUriResult {
    if (!isPairUri(raw)) return { ok: false, reason: "not_pair_uri" };
    const trimmed = raw.trim();
    const queryStart = trimmed.indexOf("?");
    const query = queryStart < 0 ? "" : trimmed.slice(queryStart + 1).split("#")[0];
    const params = new URLSearchParams(query);
    const version = params.get("v");
    if (version === null) return { ok: false, reason: "malformed" };
    if (version !== "1") return { ok: false, reason: "unsupported_version" };
    let server: URL;
    try {
        server = new URL(params.get("server") ?? "");
    } catch {
        return { ok: false, reason: "malformed" };
    }
    const code = normalizePairingCode(params.get("code") ?? "");
    if (!server.hostname || !allowedServer(server)) return { ok: false, reason: "malformed" };
    if (code.length !== PAIRING_CODE_LENGTH || !PAIRING_ALPHABET.test(code)) return { ok: false, reason: "malformed" };
    return { ok: true, server, code: displayPairingCode(code) };
}

/** Scheme, host and port (the scheme's default filled in); the path is ignored. */
export function sameOrigin(left: URL, right: URL): boolean {
    return left.origin.toLowerCase() === right.origin.toLowerCase();
}

/** `host`, or `host:port` when the port is explicit — two servers on one host differ only there. */
export function displayHost(url: URL): string {
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

// ── Link a Device ────────────────────────────────────────────────────────────────────────────

/** Query-value escaping as the Mac's URL builder does it: `:` and `/` stay literal. */
function queryValue(value: string): string {
    return encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
}

/** The sign-in QR payload: `matron://link?v=1&server=<server URL>&code=XXXX-XXXX`. */
export function linkUri(serverUrl: string, code: string): string {
    return `matron://link?v=1&server=${queryValue(serverUrl)}&code=${queryValue(code)}`;
}

// ── The roster ───────────────────────────────────────────────────────────────────────────────

/** Apps first, then agent boxes, each newest first. */
export function sortDevices(devices: readonly DeviceDTO[]): DeviceDTO[] {
    return [...devices].sort((left, right) => {
        const leftClient = left.kind === "client";
        const rightClient = right.kind === "client";
        if (leftClient !== rightClient) return leftClient ? -1 : 1;
        return (right.created_at ?? 0) - (left.created_at ?? 0) || right.device_id - left.device_id;
    });
}

/** How far the device's cursor trails the user's head. */
export function lagText(lag: number | undefined): string {
    if (lag === undefined || lag <= 0) return "Up to date";
    return `${lag} event${lag === 1 ? "" : "s"} behind`;
}

const RELATIVE_STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
];

/** "5 min. ago"-style relative last-seen; "Never" for a device that has not connected yet. */
export function lastSeenText(lastSeenAt: number | undefined, now = Date.now()): string {
    if (lastSeenAt === undefined || lastSeenAt === null) return "Never";
    let value = (lastSeenAt - now) / 1000;
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
    for (const [unit, size] of RELATIVE_STEPS) {
        if (Math.abs(value) < size) return format.format(Math.round(value), unit);
        value /= size;
    }
    return format.format(Math.round(value), "year");
}

/** The caption under a device's name: kind, last seen, sync lag, and an agent box's tag. */
export function deviceCaption(device: DeviceDTO, now = Date.now()): string {
    const kind = device.kind ? device.kind[0].toUpperCase() + device.kind.slice(1) : "Device";
    let caption = `${kind} · Last seen ${lastSeenText(device.last_seen_at, now)} · ${lagText(device.lag)}`;
    if (device.kind === "agent" && device.tag_char) caption += ` · Tag ${device.tag_char}`;
    return caption;
}

export function deviceLabel(device: Pick<DeviceDTO, "name">): string {
    return device.name?.trim() ? device.name : "Unnamed device";
}
