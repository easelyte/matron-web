/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    type DeviceDTO,
    type DevicesResponse,
    endpointUrl,
    type LoginResponse,
    type MatronConfig,
    type MessagesResponse,
    type SnapshotResponse,
} from "./types";

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
        method: "GET" | "POST";
        token?: string;
        body?: string;
    }): Promise<ElectronJournalResponse>;
}

interface UploadMediaResponse {
    media_id: string;
    size: number;
    content_type: string;
}

export class JournalApiError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
        public readonly code?: string,
        public readonly retryAfter?: number,
    ) {
        super(message);
    }
}

function electronBridge(): JournalElectron | undefined {
    return (window as Window & { electron?: JournalElectron }).electron;
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

    return {
        device: {
            device_id: device.device_id,
            kind: device.kind,
            name: device.name,
            last_seen_at: device.last_seen_at,
            connected: device.connected,
            is_self: device.is_self,
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

    public snapshot(): Promise<SnapshotResponse> {
        return this.json<SnapshotResponse>("/snapshot");
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

    public messages(conversationId: string, beforeSeq?: number, limit = 80): Promise<MessagesResponse> {
        const query = new URLSearchParams({ limit: String(limit) });
        if (beforeSeq !== undefined) query.set("before_seq", String(beforeSeq));
        return this.json<MessagesResponse>(`/convo/${encodeURIComponent(conversationId)}/messages?${query.toString()}`);
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
            method?: "GET" | "POST";
            body?: Record<string, unknown>;
            authenticated?: boolean;
            signal?: AbortSignal;
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
            method?: "GET" | "POST";
            body?: Record<string, unknown>;
            authenticated?: boolean;
            rawBody?: ArrayBuffer;
            contentType?: string;
            signal?: AbortSignal;
        } = {},
    ): Promise<{ status: number; headers: Headers; body: ArrayBuffer }> {
        const method = options.method ?? "GET";
        const authenticated = options.authenticated ?? true;
        if (authenticated && !this.token) throw new JournalApiError("Not signed in.", 401, "unauthenticated");

        const jsonBody = options.rawBody === undefined && options.body ? JSON.stringify(options.body) : undefined;
        const body = options.rawBody ?? jsonBody;
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
                parsed = JSON.parse(new TextDecoder().decode(responseBody)) as typeof parsed;
            } catch {
                // Use the status-only fallback below.
            }
            throw new JournalApiError(messageForCode(parsed.error, status), status, parsed.error, parsed.retry_after);
        }
        return { status, headers, body: responseBody };
    }
}
