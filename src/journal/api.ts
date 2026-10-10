/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    type BoxDefaults,
    type BoxDefaultsPatch,
    type BoxStatus,
    type BriefingLatest,
    type BoxStatusLimitLine,
    type DeviceDTO,
    type DevicesResponse,
    endpointUrl,
    type LoginResponse,
    type MatronConfig,
    type MessagesResponse,
    type Mission,
    type MissionDetail,
    type SearchResponse,
    type SnapshotResponse,
    type TrackerAwaiting,
    type TrackerComment,
    type TrackerCommentWrite,
    type TrackerItem,
    type TrackerItemKind,
    type TrackerItemState,
    type TrackerLink,
    type TrackerResolution,
    type Memory,
    type MemoryWrite,
    type Project,
    type ProjectDetail,
    type UserDefaults,
} from "./types";
import { parseMetrics, type JournalMetrics } from "./ops/model";
import { parseWorkViewEnvelope, type WorkViewEnvelope, type WorkViewGroupBy } from "./work-view";

interface ElectronJournalResponse {
    status: number;
    headers: Record<string, string>;
    body: ArrayBuffer;
}

interface JournalElectron {
    initialise(): Promise<{ config: MatronConfig }>;
    journalRequest(request: {
        serverUrl: string;
        path: string;
        method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        token?: string;
        body?: string;
        // Extra request headers (e.g. Idempotency-Key). Optional + additive: older preloads
        // ignore the field, so tracker mutations degrade to non-idempotent on desktop (the
        // server still applies them, it just can't dedupe a retried desktop request).
        headers?: Record<string, string>;
    }): Promise<ElectronJournalResponse>;
}

interface UploadMediaResponse {
    media_id: string;
    size: number;
    content_type: string;
}

/** `GET /missions?state=` filter. */
type TrackerMissionListState = "open" | "closed";

/** `GET /items` query params (all optional; server clamps `limit` to ≤500). */
interface ItemsFilter {
    state?: TrackerItemState;
    kind?: TrackerItemKind;
    awaiting?: TrackerAwaiting;
    label?: string;
    sort?: "rank" | "updated";
    since?: number;
    limit?: number;
    cursor?: string;
}

/** `PATCH /items/:id` body — any subset; `mission` moves the item (id/num, or null to detach). */
interface ItemPatch {
    title?: string;
    body?: string;
    labels?: string[];
    links?: TrackerLink[];
    awaiting?: TrackerAwaiting | null;
    mission?: string | number | null;
}

export class JournalApiError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
        public readonly code?: string,
        public readonly retryAfter?: number,
        /** The parsed JSON error body, when there was one (e.g. `retry_at`, `blocked_by`). */
        public readonly body?: Record<string, unknown>,
    ) {
        super(message);
    }
}

function electronBridge(): JournalElectron | undefined {
    return (window as Window & { electron?: JournalElectron }).electron;
}

// Tracker routes accept either the opaque `it_`/`ms_` id or the bare #num. Strip a leading
// `#` (a `#12`-style ref) and percent-encode so the segment is always a safe path component.
function encodeTrackerId(id: string | number): string {
    return encodeURIComponent(String(id).replace(/^#/, ""));
}

// Optional Idempotency-Key header for a create/comment/close mutation (routes that support it
// dedupe a replayed key; the others ignore the header). Callers mint the UUID at the call site.
function idempotencyHeader(key?: string): { headers?: Record<string, string> } {
    return key ? { headers: { "Idempotency-Key": key } } : {};
}

// Item kinds this client renders beyond the original task/question/decision. The journal only
// returns a `notice` item to a client that names the kind here (others see it as a task), so every
// authenticated request carries it: items arrive through /items and through the mission and
// project details alike.
//
// `X-Matron-Item-Inline: attachments` says this client places an item's or comment's own
// attachments where its body writes `![caption](attachment:<ref>)` (see tracker/inline-attachments).
// Without it the journal rewrites each ref to its caption text, so it rides on the same requests.
const ITEM_KINDS_HEADER = { "X-Matron-Item-Kinds": "notice", "X-Matron-Item-Inline": "attachments" };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseBoxActivity(raw: unknown): BoxStatus["activity"] | undefined {
    if (!isRecord(raw) || !isCount(raw.live_sessions)) return undefined;
    const lastHour = Array.isArray(raw.last_hour) ? raw.last_hour : [];
    const entries = lastHour.flatMap((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.path !== "string" || !entry.path || !isCount(entry.sessions)) return [];
        return [{ path: entry.path, sessions: entry.sessions }];
    });
    return { live_sessions: raw.live_sessions, last_hour: entries };
}

function parseBoxLimits(raw: unknown): BoxStatus["limits"] | undefined {
    if (!isRecord(raw) || !Array.isArray(raw.lines)) return undefined;
    if (typeof raw.as_of !== "number" || !Number.isFinite(raw.as_of)) return undefined;
    const lines = raw.lines.flatMap((line: unknown): BoxStatusLimitLine[] => {
        if (!isRecord(line)) return [];
        if (typeof line.id !== "string" || !line.id || typeof line.label !== "string" || !line.label) return [];
        if (typeof line.percent !== "number" || !Number.isFinite(line.percent)) return [];
        const parsed: BoxStatusLimitLine = { id: line.id, label: line.label, percent: line.percent };
        if (typeof line.resets === "string" && line.resets) parsed.resets = line.resets;
        if (typeof line.resets_at === "string" && line.resets_at) parsed.resets_at = line.resets_at;
        return [parsed];
    });
    if (lines.length === 0) return undefined;
    return { as_of: raw.as_of, lines };
}

function parseBoxDisk(raw: unknown): BoxStatus["disk"] | undefined {
    if (!isRecord(raw) || !isCount(raw.free_bytes) || !isCount(raw.total_bytes)) return undefined;
    if (raw.total_bytes === 0 || raw.free_bytes > raw.total_bytes) return undefined;
    return { free_bytes: raw.free_bytes, total_bytes: raw.total_bytes };
}

function parseBoxVitals(raw: unknown): BoxStatus["vitals"] | undefined {
    if (!isRecord(raw)) return undefined;
    const pct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
    if (!pct(raw.cpu_pct) || !pct(raw.ram_pct) || !Number.isSafeInteger(raw.sampled_at_ms)) return undefined;
    return { cpu_pct: raw.cpu_pct, ram_pct: raw.ram_pct, sampled_at_ms: raw.sampled_at_ms as number };
}

function parseBoxAccount(raw: unknown): BoxStatus["account"] | undefined {
    if (!isRecord(raw) || typeof raw.email !== "string" || !raw.email) return undefined;
    return { email: raw.email };
}

// A box's capacity report — GET /devices `status`, or a live `box_status` frame (whose extra
// `kind`/`device_id` fields are simply ignored here). `reported_at` is required; every block is
// optional and dropped on its own when malformed, so one bad block never hides the others.
export function parseBoxStatus(raw: unknown): BoxStatus | undefined {
    if (!isRecord(raw)) return undefined;
    if (typeof raw.reported_at !== "number" || !Number.isFinite(raw.reported_at)) return undefined;
    const activity = parseBoxActivity(raw.activity);
    const limits = parseBoxLimits(raw.limits);
    const disk = parseBoxDisk(raw.disk);
    const account = parseBoxAccount(raw.account);
    const vitals = parseBoxVitals(raw.vitals);
    return {
        reported_at: raw.reported_at,
        ...(activity ? { activity } : {}),
        ...(limits ? { limits } : {}),
        ...(disk ? { disk } : {}),
        ...(account ? { account } : {}),
        ...(vitals ? { vitals } : {}),
    };
}

function parseDefaultValue(raw: unknown): string | null | undefined {
    if (raw === null || raw === undefined || raw === "") return null;
    return typeof raw === "string" ? raw : undefined;
}

// The user's new-chat defaults — GET /defaults, the PUT /defaults answer, or a live `defaults`
// frame (whose `kind` is ignored here). A missing, null or empty value is "Box default" (null);
// any other non-string rejects the whole body, so a malformed frame never half-applies.
export function parseUserDefaults(raw: unknown): UserDefaults | undefined {
    if (!isRecord(raw)) return undefined;
    const model = parseDefaultValue(raw.default_model);
    const effort = parseDefaultValue(raw.default_effort);
    if (model === undefined || effort === undefined) return undefined;
    return { default_model: model, default_effort: effort };
}

// A box's `defaults` block on GET /devices. A missing key is unset (null); any non-string value
// drops the whole block, so the box shows no editor rather than a half-read one.
export function parseBoxDefaults(raw: unknown): BoxDefaults | undefined {
    if (!isRecord(raw)) return undefined;
    const agent = parseDefaultValue(raw.agent);
    const model = parseDefaultValue(raw.model);
    const effort = parseDefaultValue(raw.effort);
    if (agent === undefined || model === undefined || effort === undefined) return undefined;
    return { agent, model, effort };
}

// The PUT /devices/:id/defaults answer, or a live `box_defaults` frame (whose `kind` is ignored).
export function parseBoxDefaultsState(raw: unknown): (Required<BoxDefaultsPatch> & { device_id: number }) | undefined {
    if (!isRecord(raw) || typeof raw.device_id !== "number" || !Number.isFinite(raw.device_id)) return undefined;
    const agent = parseDefaultValue(raw.default_agent);
    const model = parseDefaultValue(raw.default_model);
    const effort = parseDefaultValue(raw.default_effort);
    if (agent === undefined || model === undefined || effort === undefined) return undefined;
    return { device_id: raw.device_id, default_agent: agent, default_model: model, default_effort: effort };
}

type DeviceParseResult = { device: DeviceDTO; reasons: [] } | { reasons: string[] };

function parseDevice(raw: unknown): DeviceParseResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { reasons: ["not_object"] };

    const device = raw as Record<string, unknown>;
    const reasons: string[] = [];
    if (typeof device.device_id !== "number" || !Number.isFinite(device.device_id)) reasons.push("invalid_device_id");
    if (typeof device.kind !== "string") reasons.push("invalid_kind");
    if (typeof device.connected !== "boolean") reasons.push("invalid_connected");
    if (device.name !== undefined && typeof device.name !== "string") reasons.push("invalid_name");
    if (device.last_seen_at !== undefined && typeof device.last_seen_at !== "number") {
        reasons.push("invalid_last_seen_at");
    }
    if (typeof device.is_self !== "boolean") reasons.push("invalid_is_self");
    if (reasons.length > 0) return { reasons };

    // A malformed or missing `status` never rejects the device — the sheet just shows no usage.
    const status = parseBoxStatus(device.status);
    // Likewise `defaults`: absent on an old journal, dropped when malformed.
    const defaults = parseBoxDefaults(device.defaults);
    return {
        device: {
            device_id: device.device_id,
            kind: device.kind,
            name: device.name,
            last_seen_at: device.last_seen_at,
            connected: device.connected,
            is_self: device.is_self,
            ...(status ? { status } : {}),
            ...(defaults ? { defaults } : {}),
        } as DeviceDTO,
        reasons: [],
    };
}

export async function loadMatronConfig(): Promise<MatronConfig> {
    const electron = electronBridge();
    if (electron) {
        const result = await electron.initialise();
        return result.config ?? {};
    }

    try {
        const response = await fetch("config.json", { cache: "no-store" });
        if (!response.ok) return {};
        return (await response.json()) as MatronConfig;
    } catch {
        return {};
    }
}

function messageForCode(code: string | undefined, status: number): string {
    switch (code) {
        case "bad_credentials":
            return "The username or password is incorrect.";
        case "locked_out":
            return "Too many failed attempts. Try again later.";
        case "rate_limited":
            return "Too many sign-in attempts. Try again in a minute.";
        case "unauthenticated":
            return "This device session is no longer valid.";
        case "forbidden":
            return "This device is not allowed to perform that action.";
        case "not_found":
            return "The requested item was not found.";
        case "too_large":
            return "File too large.";
        case "empty":
            return "That file is empty.";
        case "bad_model":
            return "The journal did not accept that model.";
        case "bad_effort":
            return "The journal did not accept that effort level.";
        case "bad_agent":
            return "The journal did not accept that agent.";
        case "not_agent_device":
            return "That device is not an agent box.";
        default:
            return `The journal server returned HTTP ${status}.`;
    }
}

export class JournalApi {
    private devicesRequest?: { promise: Promise<unknown>; controller: AbortController };

    public constructor(
        public readonly serverUrl: string,
        private token?: string,
    ) {}

    public setToken(token?: string): void {
        this.token = token;
    }

    public login(username: string, password: string, deviceName: string): Promise<LoginResponse> {
        return this.json<LoginResponse>("/login", {
            method: "POST",
            authenticated: false,
            body: { username, password, device_name: deviceName },
        });
    }

    /** GET /metrics: journal health for the Ops page (head seq, per-device lag, DB size). */
    public async metrics(): Promise<JournalMetrics | null> {
        return parseMetrics(await this.json<unknown>("/metrics"));
    }

    public snapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
        return this.json<SnapshotResponse>("/snapshot", { signal });
    }

    public async devices(): Promise<DevicesResponse> {
        const request = this.devicesRequest ?? this.startDevicesRequest();
        const devicesCall = request.promise;
        // The request may outlive the transport-agnostic timeout (notably in Electron).
        void devicesCall.catch(() => undefined);

        let timeoutTimer: ReturnType<typeof setTimeout>;
        const timeoutReject = new Promise<never>((_resolve, reject) => {
            timeoutTimer = setTimeout(() => {
                if (this.devicesRequest === request) this.devicesRequest = undefined;
                void request.promise.catch(() => undefined);
                reject(new JournalApiError("timeout", 0));
                request.controller.abort();
            }, 10_000);
        });

        let raw: unknown;
        try {
            raw = await Promise.race([devicesCall, timeoutReject]);
        } finally {
            clearTimeout(timeoutTimer!);
        }

        if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("devices" in raw)) {
            throw new JournalApiError("The journal server returned a malformed devices response.", 200);
        }

        const rawDevices = (raw as { devices?: unknown }).devices;
        if (!Array.isArray(rawDevices)) {
            throw new JournalApiError("The journal server returned a malformed devices response.", 200);
        }

        const parsedDevices = rawDevices.map(parseDevice);
        const devices = parsedDevices.flatMap((parsed) => ("device" in parsed ? [parsed.device] : []));
        if (rawDevices.length > 0 && devices.length === 0) {
            throw new JournalApiError("The journal server returned a malformed devices response.", 200);
        }
        const rejected = parsedDevices.filter((parsed): parsed is { reasons: string[] } => !("device" in parsed));
        if (rejected.length > 0) {
            console.warn("matron:devices", {
                event: "partial_roster",
                rejected_count: rejected.length,
                reasons: rejected.map((item) => item.reasons),
            });
        }

        return { devices };
    }

    private startDevicesRequest(): { promise: Promise<unknown>; controller: AbortController } {
        const controller = new AbortController();
        const request = { promise: this.json<unknown>("/devices", { signal: controller.signal }), controller };
        this.devicesRequest = request;
        const clear = (): void => {
            if (this.devicesRequest === request) this.devicesRequest = undefined;
        };
        void request.promise.then(clear, clear);
        return request;
    }

    // First client-initiated REST POST (§ design "The answer call"). 200 -> {ok:true}, discarded;
    // 409 (already resolved elsewhere/expired) and 404 (row gone) surface as a typed
    // JournalApiError so the card can distinguish them by `.status`. Never sends `always_allow`.
    public async answerAgentSpawn(
        requestId: string,
        decision: "approve" | "deny",
        signal?: AbortSignal,
    ): Promise<void> {
        await this.json<{ ok: boolean }>("/agent-spawn/answer", {
            method: "POST",
            body: { request_id: requestId, decision },
            signal,
        });
    }

    // ── Tracker: missions / milestones / items (all at journal root, Bearer-auth, user-global) ──

    /** GET /missions?state= — the mission list rows (counts + last-milestone digest baked in). */
    public missions(state?: TrackerMissionListState): Promise<{ missions: Mission[] }> {
        const query = state ? `?state=${encodeURIComponent(state)}` : "";
        return this.json<{ missions: Mission[] }>(`/missions${query}`);
    }

    /** GET /projects — every project, newest activity first, with mission rollups. */
    public projects(): Promise<{ projects: Project[] }> {
        return this.json<{ projects: Project[] }>("/projects");
    }

    /** GET /projects/:id — the project with its missions, needs-you items, recent milestones and sessions by box. */
    public project(id: string | number): Promise<ProjectDetail> {
        return this.json<ProjectDetail>(`/projects/${encodeTrackerId(id)}`);
    }

    /** GET /missions/:id — full detail (mission + milestones newest-first + open items + convos). */
    public mission(id: string | number): Promise<MissionDetail> {
        return this.json<MissionDetail>(`/missions/${encodeTrackerId(id)}`);
    }

    /** GET /items — the filtered/sorted item list (`next_cursor` paginates; server clamps limit ≤500). */
    public items(filter: ItemsFilter = {}): Promise<{ items: TrackerItem[]; next_cursor: string | null }> {
        const query = new URLSearchParams();
        if (filter.state) query.set("state", filter.state);
        if (filter.kind) query.set("kind", filter.kind);
        if (filter.awaiting) query.set("awaiting", filter.awaiting);
        if (filter.label) query.set("label", filter.label);
        if (filter.sort) query.set("sort", filter.sort);
        if (filter.since !== undefined) query.set("since", String(filter.since));
        if (filter.limit !== undefined) query.set("limit", String(filter.limit));
        if (filter.cursor) query.set("cursor", filter.cursor);
        const suffix = query.toString();
        return this.json<{ items: TrackerItem[]; next_cursor: string | null }>(`/items${suffix ? `?${suffix}` : ""}`);
    }

    /** GET /work?group_by= — the live, read-only loop-store projection. */
    public async work(groupBy: WorkViewGroupBy = "repo", signal?: AbortSignal): Promise<WorkViewEnvelope> {
        const raw = await this.json<unknown>(`/work?group_by=${encodeURIComponent(groupBy)}`, { signal });
        try {
            const envelope = parseWorkViewEnvelope(raw);
            // The parser only checks that `group_by` is a member of the enum, which is not the
            // same as it being the grouping we ASKED for. A producer bug, a stale cache or
            // version skew can return a structurally valid repo-grouped envelope for a domain
            // request; the pane's tab is driven by local state, so it would render repo groups
            // under the Domain tab with no warning. Silently showing one grouping as another is
            // a wrong operational view, which is worse than an error.
            if (envelope.status !== "error" && envelope.group_by !== groupBy) {
                throw new Error(`Work response grouped by "${envelope.group_by}" but "${groupBy}" was requested.`);
            }
            return envelope;
        } catch (error) {
            throw new JournalApiError(error instanceof Error ? error.message : "Malformed Work response.", 200);
        }
    }

    /** GET /items/:id — the item plus its comment thread (status rows carry `meta.from`/`meta.to`). */
    public item(id: string | number): Promise<{ item: TrackerItem; comments: TrackerComment[] }> {
        return this.json<{ item: TrackerItem; comments: TrackerComment[] }>(`/items/${encodeTrackerId(id)}`);
    }

    /** PATCH /items/:id — edit title/body/labels/links/awaiting or move the item to a mission. */
    public patchItem(id: string | number, body: ItemPatch): Promise<{ item: TrackerItem }> {
        return this.json<{ item: TrackerItem }>(`/items/${encodeTrackerId(id)}`, { method: "PATCH", body });
    }

    /** POST /items/:id/comments — a user comment flips awaiting→agent and reopens a closed item.
     *  With `action` + `reply_to` it is a tap on one of that comment's buttons. */
    public postItemComment(
        id: string | number,
        body: TrackerCommentWrite,
        idemKey?: string,
    ): Promise<{ item: TrackerItem; comment: TrackerComment }> {
        return this.json<{ item: TrackerItem; comment: TrackerComment }>(`/items/${encodeTrackerId(id)}/comments`, {
            method: "POST",
            body,
            ...idempotencyHeader(idemKey),
        });
    }

    /** POST /items/:id/close — resolve the item (optional closing note). */
    public closeItem(
        id: string | number,
        body: { resolution: TrackerResolution; comment?: string },
        idemKey?: string,
    ): Promise<{ item: TrackerItem; comment: TrackerComment }> {
        return this.json<{ item: TrackerItem; comment: TrackerComment }>(`/items/${encodeTrackerId(id)}/close`, {
            method: "POST",
            body,
            ...idempotencyHeader(idemKey),
        });
    }

    /** POST /items/:id/reopen — reopen a closed item (optional note). */
    public reopenItem(
        id: string | number,
        body: { comment?: string } = {},
        idemKey?: string,
    ): Promise<{ item: TrackerItem; comment: TrackerComment }> {
        return this.json<{ item: TrackerItem; comment: TrackerComment }>(`/items/${encodeTrackerId(id)}/reopen`, {
            method: "POST",
            body,
            ...idempotencyHeader(idemKey),
        });
    }

    // ── Memories (journal /memories, spec 2026-09-27 memories; Bearer-auth, user-global) ──

    /** GET /memories — every memory, ordered by name (≤200 rows, no paging). */
    public memories(): Promise<{ memories: Memory[] }> {
        return this.json<{ memories: Memory[] }>("/memories");
    }

    /** PUT /memories/:name — upsert by name (201 created / 200 updated; the whole memory). */
    public putMemory(name: string, body: MemoryWrite): Promise<{ memory: Memory }> {
        return this.json<{ memory: Memory }>(`/memories/${encodeURIComponent(name)}`, { method: "PUT", body });
    }

    /** DELETE /memories/:name — the deleted row comes back. */
    public deleteMemory(name: string): Promise<{ memory: Memory }> {
        return this.json<{ memory: Memory }>(`/memories/${encodeURIComponent(name)}`, { method: "DELETE" });
    }

    // ── New-chat defaults (journal /defaults; Bearer-auth, per user) ──

    /** GET /defaults — the user's default model and effort for new chats (null = box default). */
    public async defaults(): Promise<UserDefaults> {
        return this.userDefaults(await this.json<unknown>("/defaults"));
    }

    /**
     * PUT /defaults — change any subset of the defaults; a key left out is untouched and null
     * clears it. 400 `bad_model` / `bad_effort` throw a JournalApiError. Resolves to the full new state.
     */
    public async putDefaults(body: Partial<UserDefaults>): Promise<UserDefaults> {
        return this.userDefaults(await this.json<unknown>("/defaults", { method: "PUT", body }));
    }

    private userDefaults(raw: unknown): UserDefaults {
        const defaults = parseUserDefaults(raw);
        if (!defaults) throw new JournalApiError("The journal server returned malformed defaults.", 200);
        return defaults;
    }

    /**
     * PUT /devices/:id/defaults — change any subset of one agent box's defaults; a key left out is
     * untouched and null clears it (changing the agent without a model clears the model). 400
     * `bad_agent` / `bad_model` / `bad_effort` / `not_agent_device` and 404 (also a journal without
     * per-box defaults) throw a JournalApiError. Resolves to the box's full new state.
     */
    public async putBoxDefaults(
        deviceId: number,
        body: BoxDefaultsPatch,
    ): Promise<Required<BoxDefaultsPatch> & { device_id: number }> {
        const raw = await this.json<unknown>(`/devices/${encodeURIComponent(String(deviceId))}/defaults`, {
            method: "PUT",
            body,
        });
        const state = parseBoxDefaultsState(raw);
        if (!state) throw new JournalApiError("The journal server returned malformed box defaults.", 200);
        return state;
    }

    // ── Pinned desk chats (journal /pins; every route answers with the whole list) ──

    /** GET /pins — `{pins, limit}`; 404 on a journal without pins. */
    public pins(): Promise<unknown> {
        return this.json<unknown>("/pins");
    }

    /** PUT /pins — reorder; `order` names every pin exactly once. */
    public reorderPins(order: string[]): Promise<unknown> {
        return this.json<unknown>("/pins", { method: "PUT", body: { order } });
    }

    /** PUT /pins/:convo_id — create (label required) or edit. 409 `{detail:'pin_limit', limit}` when full. */
    public putPin(convoId: string, body: { label?: string; emoji?: string }): Promise<unknown> {
        return this.json<unknown>(`/pins/${encodeURIComponent(convoId)}`, { method: "PUT", body });
    }

    /** DELETE /pins/:convo_id — unpin; 404 when not pinned. */
    public deletePin(convoId: string): Promise<unknown> {
        return this.json<unknown>(`/pins/${encodeURIComponent(convoId)}`, { method: "DELETE" });
    }

    /** POST /pins/:convo_id/move — repoint the pin at another conversation; 409 'already_pinned'. */
    public movePin(convoId: string, toConvoId: string): Promise<unknown> {
        return this.json<unknown>(`/pins/${encodeURIComponent(convoId)}/move`, {
            method: "POST",
            body: { to_convo_id: toConvoId },
        });
    }

    /** POST /pins/:convo_id/dismiss — stop offering this successor. */
    public dismissPinSuccessor(convoId: string, successorId: string): Promise<unknown> {
        return this.json<unknown>(`/pins/${encodeURIComponent(convoId)}/dismiss`, {
            method: "POST",
            body: { successor_id: successorId },
        });
    }

    // ── User settings (journal /settings; 404 on a journal without them) ──

    /** GET /settings — the user's journal settings. */
    public settings(): Promise<{ notices?: unknown }> {
        return this.json<{ notices?: unknown }>("/settings");
    }

    /** PATCH /settings — change any subset; the whole settings object comes back. */
    public patchSettings(body: { notices?: boolean }): Promise<{ notices?: unknown }> {
        return this.json<{ notices?: unknown }>("/settings", { method: "PATCH", body });
    }

    // ── Coordinator briefings (journal /briefings, spec 2026-10-04 latest briefing) ──

    /** GET /briefings/latest — the latest briefing and refresh state; 404 on a journal without them. */
    public latestBriefing(): Promise<BriefingLatest> {
        return this.json<BriefingLatest>("/briefings/latest");
    }

    /**
     * POST /briefings/refresh — ask the Coordinator for a new briefing. 202 with the
     * GET /briefings/latest shape; 429 `{error:'rate_limited', retry_at}`, 409
     * `{blocked_by:'no_coordinator'}`, 503 `{error:'busy'}` throw a JournalApiError carrying the body.
     */
    public refreshBriefing(): Promise<BriefingLatest> {
        return this.json<BriefingLatest>("/briefings/refresh", { method: "POST" });
    }

    /** PATCH /missions/:id — edit the mission title/body. */
    public patchMission(
        id: string | number,
        body: { title?: string; body?: string },
        idemKey?: string,
    ): Promise<{ mission: Mission }> {
        return this.json<{ mission: Mission }>(`/missions/${encodeTrackerId(id)}`, {
            method: "PATCH",
            body,
            ...idempotencyHeader(idemKey),
        });
    }

    /** POST /missions/:id/close — close the mission with a summary (client CAN force over open items). */
    public closeMission(
        id: string | number,
        body: { summary: string },
        idemKey?: string,
    ): Promise<{ mission: Mission }> {
        return this.json<{ mission: Mission }>(`/missions/${encodeTrackerId(id)}/close`, {
            method: "POST",
            body,
            ...idempotencyHeader(idemKey),
        });
    }

    public messages(
        conversationId: string,
        beforeSeq?: number,
        limit = 80,
        aroundSeq?: number,
    ): Promise<MessagesResponse> {
        const query = new URLSearchParams({ limit: String(limit) });
        // The server (GET /convo/:id/messages) treats before_seq and around_seq as mutually
        // exclusive (400 if both). around_seq returns a window centered on an arbitrary seq —
        // the deep-link path (jump to a search hit) uses it; normal tail-paging uses before_seq.
        if (aroundSeq !== undefined) {
            query.set("around_seq", String(aroundSeq));
        } else if (beforeSeq !== undefined) {
            query.set("before_seq", String(beforeSeq));
        }
        return this.json<MessagesResponse>(`/convo/${encodeURIComponent(conversationId)}/messages?${query.toString()}`);
    }

    /**
     * Full-text search over the signed-in user's message content (`GET /search`). The server
     * caps `limit` at 50 and rejects an empty or over-256-char query with 400; the caller
     * (client.searchMessages) gates on a trimmed non-empty query and treats a throw as no hits.
     */
    public search(query: string, limit = 20, signal?: AbortSignal): Promise<SearchResponse> {
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        return this.json<SearchResponse>(`/search?${params.toString()}`, { signal });
    }

    public async media(mediaId: string): Promise<Blob> {
        const response = await this.request(`/media/${encodeURIComponent(mediaId)}`);
        const contentType = response.headers.get("content-type") ?? "application/octet-stream";
        return new Blob([response.body], { type: contentType });
    }

    public async uploadMedia(
        bytes: ArrayBuffer,
        contentType: string,
        signal?: AbortSignal,
    ): Promise<UploadMediaResponse> {
        const response = await this.request("/media", {
            method: "POST",
            rawBody: bytes,
            contentType,
            signal,
        });
        const text = new TextDecoder().decode(response.body);
        let parsed: unknown;
        try {
            parsed = JSON.parse(text) as unknown;
        } catch {
            throw new JournalApiError("The journal server returned malformed JSON.", response.status);
        }
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed) ||
            !("media_id" in parsed) ||
            typeof parsed.media_id !== "string" ||
            parsed.media_id.trim() === "" ||
            !("size" in parsed) ||
            typeof parsed.size !== "number" ||
            !Number.isFinite(parsed.size) ||
            !("content_type" in parsed) ||
            typeof parsed.content_type !== "string"
        ) {
            throw new JournalApiError("The journal server returned a malformed media response.", response.status);
        }
        return {
            media_id: parsed.media_id,
            size: parsed.size,
            content_type: parsed.content_type,
        };
    }

    private async json<T>(
        path: string,
        options: {
            method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
            body?: object;
            authenticated?: boolean;
            signal?: AbortSignal;
            headers?: Record<string, string>;
        } = {},
    ): Promise<T> {
        const response = await this.request(path, options);
        const text = new TextDecoder().decode(response.body);
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new JournalApiError("The journal server returned malformed JSON.", response.status);
        }
    }

    private async request(
        path: string,
        options: {
            method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
            body?: object;
            authenticated?: boolean;
            rawBody?: ArrayBuffer;
            contentType?: string;
            signal?: AbortSignal;
            headers?: Record<string, string>;
        } = {},
    ): Promise<{ status: number; headers: Headers; body: ArrayBuffer }> {
        const method = options.method ?? "GET";
        const authenticated = options.authenticated ?? true;
        if (authenticated && !this.token) throw new JournalApiError("Not signed in.", 401, "unauthenticated");

        const jsonBody = options.rawBody === undefined && options.body ? JSON.stringify(options.body) : undefined;
        const body = options.rawBody ?? jsonBody;
        const extraHeaders = authenticated ? { ...ITEM_KINDS_HEADER, ...options.headers } : options.headers;
        const electron = electronBridge();
        if (electron && options.rawBody !== undefined) {
            throw new JournalApiError(
                "Attachments aren't supported in the desktop build yet.",
                0,
                "electron_binary_unsupported",
            );
        }
        let status: number;
        let headers: Headers;
        let responseBody: ArrayBuffer;

        if (electron) {
            const response = await electron.journalRequest({
                serverUrl: this.serverUrl,
                path,
                method,
                token: authenticated ? this.token : undefined,
                body: jsonBody,
                headers: extraHeaders,
            });
            status = response.status;
            headers = new Headers(response.headers);
            responseBody = response.body;
        } else {
            let response: Response;
            try {
                response = await fetch(endpointUrl(this.serverUrl, path), {
                    method,
                    headers: {
                        ...(options.rawBody !== undefined
                            ? options.contentType
                                ? { "Content-Type": options.contentType }
                                : {}
                            : jsonBody
                              ? { "Content-Type": "application/json" }
                              : {}),
                        ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}),
                        ...(extraHeaders ?? {}),
                    },
                    body,
                    signal: options.signal,
                });
            } catch (error) {
                throw new JournalApiError(
                    error instanceof Error ? error.message : "Could not reach the journal server.",
                    0,
                );
            }
            status = response.status;
            headers = response.headers;
            responseBody = await response.arrayBuffer();
        }

        if (status < 200 || status >= 300) {
            let parsed: { error?: string; retry_after?: number } = {};
            try {
                const decoded: unknown = JSON.parse(new TextDecoder().decode(responseBody));
                if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
                    parsed = decoded as typeof parsed;
                }
            } catch {
                // Use the status-only fallback below.
            }
            throw new JournalApiError(
                messageForCode(parsed.error, status),
                status,
                parsed.error,
                parsed.retry_after,
                parsed as Record<string, unknown>,
            );
        }
        return { status, headers, body: responseBody };
    }
}
