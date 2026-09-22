/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    type JournalControlFrame,
    type JournalEphemeralFrame,
    type JournalEvent,
    type JournalRpcFrame,
    type ServerFrame,
    isObject,
} from "./types";

// Runtime decoding at the WebSocket frame boundary (#753). connection.ts used to
// cast `JSON.parse(data) as ServerFrame` with no validation, so every downstream
// consumer — the IndexedDB journal store, the sticky session-status merge, the
// host-vitals gauge — trusted field names, nullability and units on faith. This
// module narrows each frame shape BEFORE it reaches those caches:
//
//   • A structurally-broken frame (bad discriminant, a journal event whose
//     store-bound fields are the wrong type) is REJECTED — connection.ts drops
//     it, so the cache keeps its last good value rather than ingesting garbage.
//   • A conversation-scoped ephemeral frame whose OPTIONAL sub-shape is malformed
//     (an out-of-range vitals reading, an unknown activity state) has just that
//     sub-shape stripped. Every store branch is guarded (`if (frame.host_vitals)`)
//     or a sticky merge (mergeSessionStatus), so an absent sub-shape means "no
//     update" — the last good value survives.
//   • Every rejection or narrowing emits a diagnostic via connection.ts, so a
//     producer schema drift surfaces in the console instead of silently painting
//     stale or blank UI.
//
// Wire shapes are anchored to the producers: journal events/control/rpc from
// matron-journal `src/ws.js`, ephemeral status/host_vitals from matron-bridge
// (`buildSessionStatus`, index.js host-vitals publisher). The conformance
// fixtures in test/fixtures/frames/ are captured from those producers so a shape
// change there fails this decoder's test loud rather than at runtime.

export type FrameDecodeResult = { ok: true; frame: ServerFrame; narrowed?: string[] } | { ok: false; reason: string };

// Percentage plausibility bound (#79 added this for the two vitals shapes): host
// CPU/RAM and status vitals are whole-system percentages, so a value outside
// 0..100 is a wire bug, not a reading — reject it and keep the last good one.
const PCT_MIN = 0;
const PCT_MAX = 100;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isPercent(value: unknown): value is number {
    return isFiniteNumber(value) && value >= PCT_MIN && value <= PCT_MAX;
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

// host_vitals frame (matron-bridge index.js host-vitals publisher): { cpu?, ram?,
// sampled_at_ms }. cpu/ram are integer percentages, OMITTED (not null) until the
// sampler warms; sampled_at_ms is always present. Any deviation drops the whole
// sub-shape — a half-valid host reading is not worth painting over the last good.
function isValidHostVitals(value: unknown): boolean {
    if (!isObject(value)) return false;
    if (!isFiniteNumber(value.sampled_at_ms)) return false;
    if (value.cpu !== undefined && !isPercent(value.cpu)) return false;
    if (value.ram !== undefined && !isPercent(value.ram)) return false;
    return true;
}

// status.vitals (matron-bridge buildSessionStatus): { cpu_pct: number|null,
// ram_pct: number|null, sampled_at_ms }. The nullable halves are the divergence
// from upstream — the bridge emits null until its CPU sampler has two ticks — so
// null is valid; a string or an out-of-range number is not.
function isValidStatusVitals(value: unknown): boolean {
    if (!isObject(value)) return false;
    if (!isFiniteNumber(value.sampled_at_ms)) return false;
    if (!(value.cpu_pct === null || isPercent(value.cpu_pct))) return false;
    if (!(value.ram_pct === null || isPercent(value.ram_pct))) return false;
    return true;
}

// status.context: { tokens, window, pct } — the context bar reads all three as
// finite numbers.
function isValidStatusContext(value: unknown): boolean {
    return isObject(value) && isFiniteNumber(value.tokens) && isFiniteNumber(value.window) && isFiniteNumber(value.pct);
}

const ACTIVITY_STATES = new Set(["thinking", "tool", "idle"]);

// activity: { state: "thinking"|"tool"|"idle", detail? }. state is read directly
// (`frame.activity.state === "idle"`), so an unknown value would silently wedge
// the activity indicator — narrow it out.
function isValidActivity(value: unknown): boolean {
    if (!isObject(value)) return false;
    if (!isString(value.state) || !ACTIVITY_STATES.has(value.state)) return false;
    if (value.detail !== undefined && !isString(value.detail)) return false;
    return true;
}

const TOOL_STREAM_EVENTS = new Set(["append", "sync", "end"]);

// tool_stream: { event: "append"|"sync"|"end", ... }. Only `event` gates the
// dispatch (applyToolStream); the string/number payload fields are read
// defensively downstream, so the event enum is the load-bearing check here.
function isValidToolStream(value: unknown): boolean {
    return isObject(value) && isString(value.event) && TOOL_STREAM_EVENTS.has(value.event);
}

// A journal event flows straight into IndexedDB via database.applyJournal with no
// further validation, so its store-bound fields must be the right type or the
// durable mirror is corrupted. This is the highest-value structural check.
function decodeJournalEvent(raw: Record<string, unknown>): FrameDecodeResult {
    if (!isFiniteNumber(raw.seq)) return { ok: false, reason: "journal:seq" };
    if (!isString(raw.convo_id)) return { ok: false, reason: "journal:convo_id" };
    if (!isFiniteNumber(raw.ts)) return { ok: false, reason: "journal:ts" };
    if (!isString(raw.sender)) return { ok: false, reason: "journal:sender" };
    if (!isString(raw.type)) return { ok: false, reason: "journal:type" };
    if (!isObject(raw.payload)) return { ok: false, reason: "journal:payload" };
    return { ok: true, frame: raw as unknown as JournalEvent };
}

// Control frames dispatch on `op` (hello_ok / snapshot_required / error / …), so
// a missing op is unusable. Everything else on the frame is optional and read
// defensively in connection.ts / client.ts, so op is the only required field.
function decodeControl(raw: Record<string, unknown>): FrameDecodeResult {
    if (!isString(raw.op)) return { ok: false, reason: "control:op" };
    return { ok: true, frame: raw as unknown as JournalControlFrame };
}

// RPC frames already get thorough runtime validation in JournalConnection.handleFrame
// (request_id/ok/agent_device_id/error narrowing, with a malformed_rpc diagnostic
// and graceful resolution of the pending request). Rejecting a malformed rpc HERE
// would instead strand the pending request until timeout, a regression — so this
// stage is structural pass-through and leaves the existing handling in place.
function decodeRpc(raw: Record<string, unknown>): FrameDecodeResult {
    return { ok: true, frame: raw as unknown as JournalRpcFrame };
}

// Ephemeral frames are the narrowing case: they carry independent optional
// sub-shapes (host_vitals, status, activity, tool_stream), each feeding a
// last-good-preserving store branch. A malformed sub-shape is stripped rather
// than dropping the whole frame, so a valid activity still lands even if the
// vitals half of the same frame is garbage.
function decodeEphemeral(raw: Record<string, unknown>): FrameDecodeResult {
    const out: Record<string, unknown> = { ...raw };
    const narrowed: string[] = [];

    if (out.convo_id !== undefined && !isString(out.convo_id)) {
        delete out.convo_id;
        narrowed.push("convo_id");
    }
    if (out.host_vitals !== undefined && !isValidHostVitals(out.host_vitals)) {
        delete out.host_vitals;
        narrowed.push("host_vitals");
    }
    if (out.status !== undefined) {
        if (!isObject(out.status)) {
            delete out.status;
            narrowed.push("status");
        } else {
            const status: Record<string, unknown> = { ...out.status };
            if (status.vitals !== undefined && !isValidStatusVitals(status.vitals)) {
                delete status.vitals;
                narrowed.push("status.vitals");
            }
            if (status.context !== undefined && !isValidStatusContext(status.context)) {
                delete status.context;
                narrowed.push("status.context");
            }
            if (status.limits !== undefined && !Array.isArray(status.limits)) {
                delete status.limits;
                narrowed.push("status.limits");
            }
            out.status = status;
        }
    }
    if (out.activity !== undefined && !isValidActivity(out.activity)) {
        delete out.activity;
        narrowed.push("activity");
    }
    if (out.tool_stream !== undefined && !isValidToolStream(out.tool_stream)) {
        delete out.tool_stream;
        narrowed.push("tool_stream");
    }

    return {
        ok: true,
        frame: out as unknown as JournalEphemeralFrame,
        narrowed: narrowed.length > 0 ? narrowed : undefined,
    };
}

/**
 * Decode and narrow a raw parsed WebSocket message into a ServerFrame. Returns
 * `{ ok: false, reason }` for a frame that must be dropped (non-object, unknown
 * discriminant, or a journal event with the wrong-typed store-bound fields), or
 * `{ ok: true, frame, narrowed? }` for a frame safe to forward — `narrowed`
 * lists any ephemeral sub-shapes that were stripped as invalid.
 */
export function decodeServerFrame(raw: unknown): FrameDecodeResult {
    if (!isObject(raw)) return { ok: false, reason: "not_object" };
    switch (raw.kind) {
        case "journal":
            return decodeJournalEvent(raw);
        case "control":
            return decodeControl(raw);
        case "rpc":
            return decodeRpc(raw);
        case "ephemeral":
            return decodeEphemeral(raw);
        default:
            return { ok: false, reason: "unknown_kind" };
    }
}
