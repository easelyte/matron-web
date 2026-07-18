/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

export const MESSAGE_EVENT_TYPES = new Set([
    "text",
    "tool_output",
    "diff",
    "prompt",
    "permission_request",
    "file",
    "image",
]);

export interface MatronConfig {
    brand?: string;
    journal_server_url?: string;
    privacy_policy_url?: string;
}

export interface Session {
    serverUrl: string;
    token: string;
    deviceId: number;
    userId: number;
    username: string;
}

export interface LoginResponse {
    token: string;
    device_id: number;
    user_id: number;
}

export interface Conversation {
    id: string;
    title: string;
    session_state: string;
    last_seq: number;
    unread_count: number;
    snippet: string;
    created_at: number;
    last_ts?: number;
    read_up_to_seq: number;
}

export interface SnapshotResponse {
    conversations: Array<Omit<Conversation, "read_up_to_seq"> & { read_up_to_seq?: number }>;
    seq: number;
}

export type EventPayload = Record<string, unknown>;

export interface JournalEvent {
    kind?: "journal";
    seq: number;
    convo_id: string;
    ts: number;
    sender: string;
    type: string;
    payload: EventPayload;
}

export interface MessagesResponse {
    events: JournalEvent[];
}

export interface JournalControlFrame {
    kind: "control";
    op: string;
    seq?: number;
    code?: string;
    detail?: string;
    ref?: string;
}

export interface ToolStreamPayload {
    event: "append" | "sync" | "end";
    offset?: number;
    chunk?: string;
    content?: string;
    head_truncated?: boolean;
    reason?: string;
    meta?: {
        tool?: string;
        command?: string;
    };
}

export interface JournalEphemeralFrame {
    kind: "ephemeral";
    convo_id: string;
    message_ref?: string;
    text?: string;
    replace_text?: string;
    activity?: {
        state: "thinking" | "tool" | "idle";
        detail?: string;
    };
    tool_stream?: ToolStreamPayload;
    status?: SessionStatus;
}

export type ServerFrame = JournalEvent | JournalControlFrame | JournalEphemeralFrame;

export interface SessionStatus {
    model?: string;
    context?: {
        tokens: number;
        window: number;
        pct: number;
    };
    limits?: Array<{
        label: string;
        percent: number;
        resets?: string;
        resets_at?: string;
    }>;
    email?: string;
}

export interface ToolStreamState {
    messageRef: string;
    command?: string;
    tool?: string;
    content: string;
    offset: number;
    headTruncated: boolean;
}

export interface PendingMessage {
    localId: string;
    convoId: string;
    body: string;
    createdAt: number;
    kind?: "text" | "image" | "file";
    filename?: string;
    size?: number;
    contentType?: string;
    caption?: string;
    blobRef?: string | null;
    attachState?: "uploading" | "sending" | "error";
    errorKind?:
        | "upload_failed"
        | "send_failed"
        | "storage_failed"
        | "too_large"
        | "empty"
        | "browser_memory_limit"
        | "electron_binary_unsupported";
    errorMessage?: string;
    canRetry?: boolean;
}

export type ConnectionState = "offline" | "connecting" | "online";

export interface StagedUploadItem {
    id: string;
    file: File;
    /** Built on first confirm attempt; reused by persist retries so a page has ONE row identity. */
    message?: PendingMessage;
}

export interface StagedUploads {
    convoId: string;
    items: StagedUploadItem[];
    /** Cumulative count ever staged into this queue (paste-append increments). Header: "File k of N", k = total - items.length + 1. */
    total: number;
    /** P23 transient-submission lock: set synchronously at confirm entry; all modal actions inert while true. */
    confirming: boolean;
    /** Terminal invalidation notice (items cleared, error page shown). */
    error?: "archived";
    /** Non-terminal persist failure: page kept, inline error shown, Send retries. */
    persistError?: boolean;
}

export interface ClientState {
    phase: "loading" | "signed-out" | "signed-in";
    config: MatronConfig;
    session?: Session;
    conversations: Conversation[];
    archivedIds: Set<string>;
    pinnedIds: Set<string>;
    favoriteIds: Set<string>;
    unreadOverrideIds: Set<string>;
    controlError?: string;
    selectedConversationId?: string;
    events: JournalEvent[];
    pendingMessages: PendingMessage[];
    connection: ConnectionState;
    connectionError?: string;
    loadingHistory: boolean;
    hasOlderHistory: boolean;
    activity?: JournalEphemeralFrame["activity"];
    sessionStatus?: SessionStatus;
    textStreams: Record<string, string>;
    toolStreams: Record<string, ToolStreamState>;
    dragActive: boolean;
    stagedUploads?: StagedUploads;
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function displaySender(sender: string): string {
    const separator = sender.indexOf(":");
    return separator === -1 ? sender : sender.slice(separator + 1);
}

export function conversationTitle(conversation: Conversation): string {
    return conversation.title.trim() || conversation.id;
}

export function eventSnippet(type: string, payload: EventPayload): string {
    if (type === "text") return asString(payload.body).slice(0, 120);
    if (type === "file") return `📎 ${asString(payload.caption) || asString(payload.filename, "File")}`.slice(0, 120);
    if (type === "image") return `🖼 ${asString(payload.caption) || asString(payload.filename, "Image")}`.slice(0, 120);
    if (type === "prompt") return `? ${asString(payload.question).slice(0, 110)}`;
    if (type === "permission_request") return `Permission: ${asString(payload.description).slice(0, 100)}`;
    if (typeof payload.snippet === "string") return payload.snippet.slice(0, 120);
    if (type === "tool_output" && typeof payload.command === "string") return `$ ${payload.command}`.slice(0, 120);
    return `[${type}]`;
}

export function normalizeServerUrl(raw: string): string {
    const value = raw.trim();
    const withScheme = value.startsWith("/")
        ? new URL(value, window.location.origin).href
        : /^[a-z][a-z\d+.-]*:\/\//i.test(value)
          ? value
          : `https://${value}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        throw new Error("Enter a valid journal server URL.");
    }

    if (url.username || url.password || url.search || url.hash) {
        throw new Error("The server URL cannot contain credentials, a query, or a fragment.");
    }
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
        throw new Error("Use HTTPS (HTTP is only allowed for a local development server).");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href.replace(/\/$/, "");
}

export function endpointUrl(serverUrl: string, path: string): URL {
    const base = new URL(`${serverUrl.replace(/\/+$/, "")}/`);
    const prefix = base.pathname.replace(/\/+$/, "");
    const relative = new URL(path, "https://matron.invalid");
    base.pathname = `${prefix}/${relative.pathname.replace(/^\/+/, "")}`;
    base.search = relative.search;
    return base;
}

export function websocketUrl(serverUrl: string): string {
    const url = endpointUrl(serverUrl, "/ws");
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    return url.href;
}

export function utf8Length(value: string): number {
    return new TextEncoder().encode(value).length;
}

export function trimUtf8Prefix(value: string, bytes: number): string {
    if (bytes <= 0) return value;
    const encoded = new TextEncoder().encode(value);
    if (bytes >= encoded.length) return "";
    return new TextDecoder().decode(encoded.slice(bytes));
}

export const TOOL_LOG_TTL_MS = 24 * 60 * 60 * 1000;

export function enforceToolLogTtl(event: JournalEvent, now = Date.now()): JournalEvent {
    if (
        event.type !== "tool_output" ||
        event.payload.live_log !== true ||
        event.payload.expired === true ||
        event.ts + TOOL_LOG_TTL_MS > now
    ) {
        return event;
    }

    const payload: EventPayload = { ...event.payload, expired: true, blob_ref: null };
    delete payload.snippet;
    return { ...event, payload };
}
