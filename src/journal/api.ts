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
    type LinkStart,
    type LinkStatus,
    type PairPreview,
    type LoginResponse,
    type MatronConfig,
    type MessagesResponse,
    type ConversationMissionLink,
    type Mission,
    type MissionDetail,
    type NumberLookup,
    type SearchResponse,
    type SnapshotResponse,
    type TrackerAwaiting,
    type TrackerComment,
    type TrackerCommentWrite,
    type TrackerItem,
    type TrackerItemCreate,
    type TrackerItemKind,
    type TrackerItemState,
    type TrackerRankChange,
    type TrackerLink,
    type TrackerResolution,
    type Memory,
    type MemoryWrite,
    type Project,
    type ProjectDetail,
    type ProjectFeedKind,
    type ProjectFeedPage,
    type UserDefaults,
} from "./types";
import { parseMetrics, type JournalMetrics } from "./ops/model";

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
    /** Only the items filed from this conversation. */
    convo?: string;
    /** `done` is For you's Done view: closed, or answered and no longer waiting on the user. */
    state?: TrackerItemState | "done";
    /** One kind, or several: any of them (a journal that predates the list form answers 400). */
    kind?: TrackerItemKind | readonly TrackerItemKind[];
    awaiting?: TrackerAwaiting;
    label?: string;
    /** `acted`: the user's last action on the item first, falling back to its close time. */
    sort?: "rank" | "updated" | "acted";
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

/**
 * Whether a media fetch failed because the blob is gone for good: the server's media reaper
 * deletes old blobs, and a 404 for a blob id is permanent (ids are never reused).
 */
export function isMediaExpiredError(error: unknown): boolean {
    return error instanceof JournalApiError && error.status === 404;
}

/**
 * One request over XMLHttpRequest, for its upload progress events, answered as a fetch Response so
 * the caller's status and error handling stay the same. Rejects like fetch: an AbortError when
 * `signal` aborts, a TypeError when the network fails.
 */
function xhrRequest(
    url: URL,
    options: {
        method: string;
        headers: Record<string, string>;
        body: ArrayBuffer;
        signal?: AbortSignal;
        onUploadProgress: (fraction: number) => void;
    },
): Promise<Response> {
    return new Promise((resolve, reject) => {
        const { signal } = options;
        if (signal?.aborted) {
            reject(new DOMException("The upload was aborted.", "AbortError"));
            return;
        }
        const xhr = new XMLHttpRequest();
        const onAbort = (): void => xhr.abort();
        xhr.open(options.method, url.toString());
        xhr.responseType = "arraybuffer";
        for (const [name, value] of Object.entries(options.headers)) xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && event.total > 0) options.onUploadProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
            signal?.removeEventListener("abort", onAbort);
            const headers = new Headers();
            for (const line of xhr
                .getAllResponseHeaders()
                .trim()
                .split(/[\r\n]+/)) {
                const colon = line.indexOf(":");
                if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
            }
            const status = xhr.status;
            resolve({
                status,
                headers,
                arrayBuffer: async () => (xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0),
            } as Response);
        };
        xhr.onerror = () => {
            signal?.removeEventListener("abort", onAbort);
            reject(new TypeError("Could not reach the journal server."));
        };
        xhr.onabort = () => {
            signal?.removeEventListener("abort", onAbort);
            reject(new DOMException("The upload was aborted.", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort);
        xhr.send(options.body);
    });
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
    // null: a device that has never connected (an agent box enrolled but not yet online).
    if (device.last_seen_at !== undefined && device.last_seen_at !== null && typeof device.last_seen_at !== "number") {
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
            last_seen_at: device.last_seen_at ?? undefined,
            connected: device.connected,
            is_self: device.is_self,
            ...(typeof device.tag_char === "string" || device.tag_char === null ? { tag_char: device.tag_char } : {}),
            ...(typeof device.created_at === "number" ? { created_at: device.created_at } : {}),
            ...(typeof device.lag === "number" ? { lag: device.lag } : {}),
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
        const response = await fetch(`${process.env.PUBLIC_PATH ?? ""}config.json`, { cache: "no-store" });
        if (!response.ok) return {};
        return (await response.json()) as MatronConfig;
    } catch {
        return {};
    }
}

/**
 * The most attachments the journal takes on one item or comment; a write with more is refused
 * (HTTP 400). Mirrors the journal's own limit, so a client that has more to send splits them.
 */
export const JOURNAL_ATTACHMENTS_MAX = 20;

function messageForCode(code: string | undefined, status: number): string {
    return knownErrorMessage(code) ?? `The journal server returned HTTP ${status}.`;
}

/** The sentence for a journal error code this client knows, or undefined for any other code. */
export function knownErrorMessage(code: string | undefined): string | undefined {
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
            return undefined;
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

    // Answers one parked agent-chat ask — the ONLY path that resolves an agent-chat consent card
    // (a prompt_reply never reaches the parked row). Keyed on the room and the device the row is
    // filed under. Resolves to the server's `delivered` flag; 409 (no longer awaiting an answer)
    // and 404 (not this user's room) surface as a typed JournalApiError.
    public async answerAgentChat(
        roomId: string,
        targetDeviceId: number,
        decision: "approve" | "deny",
        signal?: AbortSignal,
    ): Promise<boolean> {
        const response = await this.json<{ delivered?: boolean }>("/agent-chat/answer", {
            method: "POST",
            body: { room_id: roomId, target_device_id: targetDeviceId, decision },
            signal,
        });
        return response?.delivered === true;
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

    /** POST /projects — a new project (the Projects home's "New project"). A blank body is left out. */
    public createProject(fields: { title: string; body?: string }, idemKey?: string): Promise<{ project: Project }> {
        const body: { title: string; body?: string } = { title: fields.title };
        if (fields.body?.trim()) body.body = fields.body;
        return this.json<{ project: Project }>("/projects", { method: "POST", body, ...idempotencyHeader(idemKey) });
    }

    /** POST /projects/:id/merge — every mission of `id` moves to `into`, and `id` closes as merged. */
    public mergeProject(id: string | number, into: string | number): Promise<{ project: Project; merged: Project }> {
        return this.json<{ project: Project; merged: Project }>(`/projects/${encodeTrackerId(id)}/merge`, {
            method: "POST",
            body: { into },
        });
    }

    /** GET /projects/:id/feed — the next (older) page of one roll-up kind, from a `next_before` cursor. */
    public projectFeed<Row = unknown>(
        id: string | number,
        kind: ProjectFeedKind,
        before: string,
    ): Promise<ProjectFeedPage<Row>> {
        const query = new URLSearchParams({ kind, before });
        return this.json<ProjectFeedPage<Row>>(`/projects/${encodeTrackerId(id)}/feed?${query.toString()}`);
    }

    /** GET /missions/:id — full detail (mission + milestones newest-first + open items + convos). */
    public mission(id: string | number): Promise<MissionDetail> {
        return this.json<MissionDetail>(`/missions/${encodeTrackerId(id)}`);
    }

    /** GET /conversations/:id/missions — every mission the conversation is or was on, current
     *  first. A row spreads the mission flat beside the link fields; a nested `mission` object is
     *  accepted too, so either journal shape reads the same. */
    public async conversationMissions(convoId: string): Promise<ConversationMissionLink[]> {
        const body = await this.json<{ missions?: unknown }>(`/conversations/${encodeURIComponent(convoId)}/missions`);
        const rows = Array.isArray(body.missions) ? body.missions : [];
        return rows.flatMap((row): ConversationMissionLink[] => {
            if (!row || typeof row !== "object") return [];
            const record = row as Record<string, unknown>;
            const nested = record.mission && typeof record.mission === "object" ? record.mission : {};
            const mission = { ...record, ...nested } as Record<string, unknown>;
            if (typeof mission.id !== "string" || typeof mission.num !== "number") return [];
            const endedAt = typeof record.ended_at === "number" ? record.ended_at : null;
            return [
                {
                    ...(mission as unknown as Mission),
                    current: record.current === true,
                    active: typeof record.active === "boolean" ? record.active : endedAt == null,
                    how: typeof record.how === "string" ? record.how : null,
                    joined_at: typeof record.joined_at === "number" ? record.joined_at : null,
                    ended_at: endedAt,
                },
            ];
        });
    }

    /** GET /items — the filtered/sorted item list (`next_cursor` paginates; server clamps limit ≤500). */
    public items(filter: ItemsFilter = {}): Promise<{ items: TrackerItem[]; next_cursor: string | null }> {
        const query = new URLSearchParams();
        if (filter.convo) query.set("convo", filter.convo);
        if (filter.state) query.set("state", filter.state);
        if (filter.kind) query.set("kind", typeof filter.kind === "string" ? filter.kind : filter.kind.join(","));
        if (filter.awaiting) query.set("awaiting", filter.awaiting);
        if (filter.label) query.set("label", filter.label);
        if (filter.sort) query.set("sort", filter.sort);
        if (filter.since !== undefined) query.set("since", String(filter.since));
        if (filter.limit !== undefined) query.set("limit", String(filter.limit));
        if (filter.cursor) query.set("cursor", filter.cursor);
        const suffix = query.toString();
        return this.json<{ items: TrackerItem[]; next_cursor: string | null }>(`/items${suffix ? `?${suffix}` : ""}`);
    }

    /** GET /items/:id — the item plus its comment thread (status rows carry `meta.from`/`meta.to`). */
    public item(id: string | number): Promise<{ item: TrackerItem; comments: TrackerComment[] }> {
        return this.json<{ item: TrackerItem; comments: TrackerComment[] }>(`/items/${encodeTrackerId(id)}`);
    }

    /** POST /items — file a new item from the user into a conversation. */
    public createItem(body: TrackerItemCreate, idemKey?: string): Promise<{ item: TrackerItem }> {
        return this.json<{ item: TrackerItem }>("/items", { method: "POST", body, ...idempotencyHeader(idemKey) });
    }

    /** POST /items/:id/rank — move an open task in the ordered list. */
    public rankItem(id: string | number, change: TrackerRankChange): Promise<{ item: TrackerItem }> {
        return this.json<{ item: TrackerItem }>(`/items/${encodeTrackerId(id)}/rank`, { method: "POST", body: change });
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

    // ── Notification settings (journal /notify, /coordinator; Bearer-auth, per user) ──

    /**
     * GET /notify — what may notify the user: the synced mode, event switches and per-conversation
     * overrides, plus this device's own level. Unvalidated (notifications.ts parses it); a journal
     * that predates the route answers 404, which throws a JournalApiError.
     */
    public async notifySettings(): Promise<unknown> {
        return this.json<unknown>("/notify");
    }

    /**
     * PUT /notify — changes any part of the settings: `mode`, `events`, this device's
     * `device_level`, or one conversation's `convo` level or mute (an explicit null clears it).
     * Answers the whole view, as GET does; client tokens only.
     */
    public async updateNotify(body: Record<string, unknown>): Promise<unknown> {
        return this.json<unknown>("/notify", { method: "PUT", body });
    }

    /**
     * GET /coordinator — `{convo_id, consent}`: the user's Coordinator conversation (null for none)
     * and whether the Coordinator may answer chat and spawn asks. Unvalidated.
     */
    public async coordinator(): Promise<unknown> {
        return this.json<unknown>("/coordinator");
    }

    /** PUT /coordinator {consent} — the Coordinator consent-approval switch. Unvalidated `{convo_id, consent}`. */
    public async putCoordinatorConsent(consent: boolean): Promise<unknown> {
        return this.json<unknown>("/coordinator", { method: "PUT", body: { consent } });
    }

    /**
     * PUT /coordinator {convo_id} — make a conversation the Coordinator, or clear it with null.
     * 404 for a conversation the user does not own. Unvalidated `{convo_id, consent}`.
     */
    public async putCoordinator(convoId: string | null): Promise<unknown> {
        return this.json<unknown>("/coordinator", { method: "PUT", body: { convo_id: convoId } });
    }

    // ── Coordinator routines (journal /routines; 404 on the collection = a journal without them) ──

    /** GET /routines — `{routines}` by name. Unvalidated (routines.ts parses it). */
    public routines(): Promise<unknown> {
        return this.json<unknown>("/routines");
    }

    /** POST /routines — 201 `{routine}`; 409 `{blocked_by: 'name' | 'cap'}`, 400 for a bad field. */
    public createRoutine(body: Record<string, unknown>): Promise<unknown> {
        return this.json<unknown>("/routines", { method: "POST", body });
    }

    /** PATCH /routines/:key — any subset of the fields (never `name`); 200 `{routine}`. */
    public patchRoutine(key: string, body: Record<string, unknown>): Promise<unknown> {
        return this.json<unknown>(`/routines/${encodeURIComponent(key)}`, { method: "PATCH", body });
    }

    /** DELETE /routines/:key — 200 `{ok: true}`; 404 when it is already gone. */
    public deleteRoutine(key: string): Promise<unknown> {
        return this.json<unknown>(`/routines/${encodeURIComponent(key)}`, { method: "DELETE", body: {} });
    }

    /** POST /routines/:key/run — 202 `{accepted: true}` or `{delivered: false, reason}`. */
    public runRoutine(key: string): Promise<unknown> {
        return this.json<unknown>(`/routines/${encodeURIComponent(key)}/run`, { method: "POST", body: {} });
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

    // ── Device admin (Settings → Devices; client tokens only, 404 = not yours or gone) ──

    /** POST /devices/:id/rename — the journal trims and sanitises the name and caps it at 40. */
    public async renameDevice(deviceId: number, name: string): Promise<void> {
        await this.json<unknown>(`/devices/${encodeURIComponent(String(deviceId))}/rename`, {
            method: "POST",
            body: { name },
        });
    }

    /** POST /devices/:id/tag — set the tag character, or clear it back to automatic with null. */
    public async setDeviceTag(deviceId: number, tagChar: string | null): Promise<void> {
        await this.json<unknown>(`/devices/${encodeURIComponent(String(deviceId))}/tag`, {
            method: "POST",
            body: { tag_char: tagChar },
        });
    }

    /** POST /devices/:id/revoke — immediate and permanent; revoking this device signs it out. */
    public async revokeDevice(deviceId: number): Promise<void> {
        await this.json<unknown>(`/devices/${encodeURIComponent(String(deviceId))}/revoke`, {
            method: "POST",
            body: {},
        });
    }

    /** POST /pair/preview — who is asking to pair with a box's code. 404: unknown, expired or used. */
    public async pairPreview(pairCode: string): Promise<PairPreview> {
        const raw = await this.json<Record<string, unknown>>("/pair/preview", {
            method: "POST",
            body: { pair_code: pairCode },
        });
        if (typeof raw?.requester_ip !== "string" || typeof raw.expires_in !== "number") {
            throw new JournalApiError("The journal server returned a malformed pair preview.", 200);
        }
        return { requester_ip: raw.requester_ip, expires_in: raw.expires_in };
    }

    /** POST /pair/approve — bind the box's code to this user; 409 when already approved. */
    public async pairApprove(pairCode: string, agentName: string, tagChar: string | null): Promise<void> {
        await this.json<unknown>("/pair/approve", {
            method: "POST",
            body: { pair_code: pairCode, agent_name: agentName, ...(tagChar ? { tag_char: tagChar } : {}) },
        });
    }

    /** POST /link/start — mint (or replace) this device's sign-in code for a second device. */
    public async linkStart(): Promise<LinkStart> {
        const raw = await this.json<Record<string, unknown>>("/link/start", { method: "POST", body: {} });
        if (typeof raw?.link_code !== "string" || typeof raw.expires_in !== "number") {
            throw new JournalApiError("The journal server returned a malformed link code.", 200);
        }
        return { link_code: raw.link_code, expires_in: raw.expires_in };
    }

    /** POST /link/status — 404 when this device has no live code (expired or resolved). */
    public async linkStatus(): Promise<LinkStatus> {
        const raw = await this.json<Record<string, unknown>>("/link/status", { method: "POST", body: {} });
        const expiresIn = typeof raw?.expires_in === "number" ? raw.expires_in : 0;
        if (raw?.status === "waiting") return { status: "waiting", expires_in: expiresIn };
        if (raw?.status === "claimed" && typeof raw.device_name === "string" && typeof raw.requester_ip === "string") {
            return {
                status: "claimed",
                device_name: raw.device_name,
                requester_ip: raw.requester_ip,
                expires_in: expiresIn,
            };
        }
        throw new JournalApiError("The journal server returned a malformed link status.", 200);
    }

    /** POST /link/approve — 409: nothing claimed yet or already resolved; 404: expired. */
    public async linkApprove(linkCode: string): Promise<void> {
        await this.json<unknown>("/link/approve", { method: "POST", body: { link_code: linkCode } });
    }

    /** POST /link/deny — 404: expired. */
    public async linkDeny(linkCode: string): Promise<void> {
        await this.json<unknown>("/link/deny", { method: "POST", body: { link_code: linkCode } });
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
    public settings(): Promise<{ notices?: unknown; auto_approve_coordinator_spawns?: unknown }> {
        return this.json<{ notices?: unknown; auto_approve_coordinator_spawns?: unknown }>("/settings");
    }

    /** PATCH /settings — change any subset; the whole settings object comes back. */
    public patchSettings(body: {
        notices?: boolean;
        auto_approve_coordinator_spawns?: boolean;
    }): Promise<{ notices?: unknown; auto_approve_coordinator_spawns?: unknown }> {
        return this.json<{ notices?: unknown; auto_approve_coordinator_spawns?: unknown }>("/settings", {
            method: "PATCH",
            body,
        });
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

    /** PATCH /missions/:id — edit the mission title/body, or move it to another project. */
    public patchMission(
        id: string | number,
        body: { title?: string; body?: string; project?: string | number },
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

    /**
     * Find in chat: every message in one conversation matching `query`, newest first
     * (`GET /search?mode=recent&convo_id=…`). Hits carry only convo_id/seq/ts/sender. A journal
     * scoped to one conversation returns up to 500; one that predates the mode ignores it and
     * answers its ranked list (up to 50, best match first), so callers order by seq themselves.
     */
    public searchConversation(
        conversationId: string,
        query: string,
        limit = 500,
        signal?: AbortSignal,
    ): Promise<{ hits?: unknown }> {
        const params = new URLSearchParams({
            q: query,
            limit: String(limit),
            mode: "recent",
            convo_id: conversationId,
        });
        return this.json<{ hits?: unknown }>(`/search?${params.toString()}`, { signal });
    }

    /**
     * GET /lookup — which of `user`'s tracker rows carries number `num` (item, mission, milestone
     * or project). 404 when there is none, or the caller may not see it.
     */
    public lookup(user: string, num: number, signal?: AbortSignal): Promise<NumberLookup> {
        const params = new URLSearchParams({ user, num: String(num) });
        return this.json<NumberLookup>(`/lookup?${params.toString()}`, { signal });
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
        /** Uploaded fraction (0…1) as the bytes leave. Only reported where the browser can see
         *  upload progress; without it the upload still completes, just silently. */
        onProgress?: (fraction: number) => void,
    ): Promise<UploadMediaResponse> {
        const response = await this.request("/media", {
            method: "POST",
            rawBody: bytes,
            contentType,
            signal,
            onUploadProgress: onProgress,
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
            onUploadProgress?: (fraction: number) => void;
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
            const requestHeaders: Record<string, string> = {
                ...(options.rawBody !== undefined
                    ? options.contentType
                        ? { "Content-Type": options.contentType }
                        : {}
                    : jsonBody
                      ? { "Content-Type": "application/json" }
                      : {}),
                ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}),
                ...(extraHeaders ?? {}),
            };
            let response: Response;
            try {
                // fetch() cannot report upload progress, so a binary body whose caller wants it goes
                // over XMLHttpRequest instead; everything after the response is shared.
                response =
                    options.rawBody !== undefined && options.onUploadProgress && typeof XMLHttpRequest === "function"
                        ? await xhrRequest(endpointUrl(this.serverUrl, path), {
                              method,
                              headers: requestHeaders,
                              body: options.rawBody,
                              signal: options.signal,
                              onUploadProgress: options.onUploadProgress,
                          })
                        : await fetch(endpointUrl(this.serverUrl, path), {
                              method,
                              headers: requestHeaders,
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
