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

export interface DeviceDTO {
    device_id: number;
    kind: string;
    name?: string;
    last_seen_at?: number;
    connected: boolean;
    is_self: boolean;
}

export interface DevicesResponse {
    devices: DeviceDTO[];
}

export interface RecentFolder {
    path: string;
    last_used: number | null;
}

export interface Conversation {
    id: string;
    title: string;
    session_state: string;
    last_seq: number;
    unread_count: number;
    snippet: string;
    created_at: number;
    parent_convo_id?: string | null; // null/undefined = top-level; set once at child creation, immutable
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
    request_id?: string;
}

export interface JournalRpcFrame {
    kind: "rpc";
    response?: {
        request_id: string;
        agent_device_id: number;
        ok: boolean;
        result?: unknown;
        error?: {
            code: string;
            detail?: string;
        };
    };
}

export type RpcReply =
    | { ok: true; origin: "agent"; result: unknown }
    | {
          ok: false;
          origin: "agent" | "relay" | "timeout" | "teardown";
          code: string;
          detail?: string;
      };

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

export type ServerFrame = JournalEvent | JournalControlFrame | JournalEphemeralFrame | JournalRpcFrame;

export interface SessionStatus {
    model?: string;
    // v5 header subtitle: `model · workdir · run-state`. The bridge does not yet
    // include the session cwd in the status frame — the segment renders only when
    // present, so it lights up the moment the bridge adds it (tracked follow-up).
    workdir?: string;
    context?: {
        tokens: number;
        window: number;
        pct: number;
    };
    limits?: Array<{
        // Stable machine key from the bridge (v5+): `session_5h`, `week_all`, `week_fable`,
        // `week_<slug>` (e.g. `week_sonnet_5`), and host meters `host_cpu` / `host_ram`.
        // Absent on older/cached frames — the client falls back to parsing `label`.
        id?: string;
        label: string;
        percent: number;
        // Raw used/limit pair (context bar rides these to show e.g. 144k/200k). Optional —
        // only the synthesized ctx meter carries them today.
        used?: number;
        limit?: number;
        unit?: string;
        model?: string;
        resets?: string;
        // ISO string (KEPT — the bridge did not change this). resetDisplay still accepts a
        // number here too as a belt-and-suspenders fallback for any pre-contract frame.
        resets_at?: string | number;
        // Epoch ms (number, NEW — the bridge adds this alongside the ISO `resets_at`).
        // resetDisplay PREFERS this when present.
        resets_at_ms?: number;
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
    preferencesUnavailable?: boolean;
    selectedConversationId?: string;
    events: JournalEvent[];
    pendingMessages: PendingMessage[];
    connection: ConnectionState;
    connectionError?: string;
    connectionErrorSeq: number;
    loadingHistory: boolean;
    hasOlderHistory: boolean;
    activity?: JournalEphemeralFrame["activity"];
    sessionStatus?: SessionStatus;
    textStreams: Record<string, string>;
    toolStreams: Record<string, ToolStreamState>;
    dragActive: boolean;
    stagedUploads?: StagedUploads;
    sendTick: number;
}

export function coerceParentId(x: unknown): string | null {
    const s = typeof x === "string" ? x.trim() : "";
    return s || null;
}

export function isSubChat(c: Pick<Conversation, "parent_convo_id">): boolean {
    return c.parent_convo_id != null && c.parent_convo_id !== "";
}

export function childrenOf(conversations: Conversation[], parentId: string | null | undefined): Conversation[] {
    if (!parentId) return [];
    return conversations
        .filter((c) => c.parent_convo_id === parentId)
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function runningChildrenOf(conversations: Conversation[], parentId: string | null | undefined): Conversation[] {
    return childrenOf(conversations, parentId).filter((c) => c.session_state === "running");
}

export function parentPresent(c: Conversation, ids: ReadonlySet<string>): boolean {
    return isSubChat(c) && c.parent_convo_id !== c.id && c.parent_convo_id != null && ids.has(c.parent_convo_id);
}

export type ChildSidebarPlacement = "nested" | "top-level" | "hidden";

/**
 * #536: precomputed lookups shared by every sidebar-visibility consumer so the SAME
 * classification drives rendering, selection, unread aggregation, the desktop badge, and
 * mark-all. Build it once per derivation from the conversation list + the archived set.
 * `placement` holds each conversation's fully-resolved Active/Favorites placement (see
 * buildSidebarIndex) — consumers READ it rather than re-deriving, so no two consumers can
 * disagree and no approximation of "is the parent a real top-level row" survives.
 */
export interface SidebarIndex {
    /** Every conversation id, archived or not — distinguishes archived-parent from orphan. */
    allIds: Set<string>;
    /** id → conversation. */
    byId: Map<string, Conversation>;
    /** id → fully-resolved Active/Favorites placement (memoized, cycle-safe). */
    placement: Map<string, ChildSidebarPlacement>;
}

/**
 * #536 (terminal): resolve EVERY conversation's Active/Favorites placement once, through
 * the SAME recursive classifier, memoized and cycle-safe. This removes the last
 * approximation — a running child nests ONLY when its direct parent's ACTUAL resolved
 * placement is "top-level" (a real, rendered top-level row); if the parent is archived,
 * hidden, or itself nested, the child cannot nest and follows the transient rule directly
 * (running → "top-level", done/idle → "hidden"). So a running descendant is always
 * reachable — nested under a real top-level parent, or top-level itself — never lost, at
 * any tree depth.
 *
 * Placement rules per conversation:
 *  - not a subchat → "top-level" (its Active presence is gated by archived at call sites).
 *  - subchat, parent missing / self-referential / cyclic → "top-level" (orphan recovery).
 *  - subchat, parent present, NOT running → "hidden" (one-shot: a finished child lingers
 *    nowhere in Active).
 *  - subchat, parent present, running → "nested" iff the parent is a non-archived row whose
 *    resolved placement is "top-level"; otherwise "top-level".
 */
export function buildSidebarIndex(conversations: Conversation[], archivedIds: ReadonlySet<string>): SidebarIndex {
    const allIds = new Set<string>();
    const byId = new Map<string, Conversation>();
    for (const conversation of conversations) {
        allIds.add(conversation.id);
        byId.set(conversation.id, conversation);
    }

    const placement = new Map<string, ChildSidebarPlacement>();
    const resolving = new Set<string>(); // in-progress ids → parent-chain cycle guard

    const resolve = (conversation: Conversation): ChildSidebarPlacement => {
        const cached = placement.get(conversation.id);
        if (cached) return cached;
        // Re-entered while its own resolution is in progress → a parent_convo_id cycle. Break
        // it by treating this node as top-level (recovery) so a running descendant is reachable
        // and resolution terminates. Not cached here; the outermost call caches the real value.
        if (resolving.has(conversation.id)) return "top-level";

        if (!isSubChat(conversation)) {
            placement.set(conversation.id, "top-level");
            return "top-level";
        }
        const parentId = conversation.parent_convo_id;
        if (parentId == null || parentId === "" || parentId === conversation.id || !allIds.has(parentId)) {
            placement.set(conversation.id, "top-level"); // orphan / missing parent → recovery
            return "top-level";
        }
        if (conversation.session_state !== "running") {
            placement.set(conversation.id, "hidden"); // parent present, not running → transient hide
            return "hidden";
        }
        // Running child: nest ONLY under a real top-level row — the parent's ACTUAL resolved
        // placement, not an approximation. Archived parents are never hosts.
        resolving.add(conversation.id);
        const parent = byId.get(parentId);
        const parentIsTopLevelRow = parent != null && !archivedIds.has(parent.id) && resolve(parent) === "top-level";
        resolving.delete(conversation.id);

        const result: ChildSidebarPlacement = parentIsTopLevelRow ? "nested" : "top-level";
        placement.set(conversation.id, result);
        return result;
    };

    for (const conversation of conversations) resolve(conversation);
    return { allIds, byId, placement };
}

/**
 * #536: the SINGLE source of truth for where a subagent conversation lands in the Active/
 * Favorites sidebar — a pure lookup of the placement resolved once in buildSidebarIndex, so
 * all call sites (rendering, selection, unread, badge, mark-all) stay in lock-step. Defaults
 * to "top-level" for an id absent from the index (orphan-style recovery).
 */
export function childSidebarPlacement(conversation: Conversation, index: SidebarIndex): ChildSidebarPlacement {
    return index.placement.get(conversation.id) ?? "top-level";
}

/**
 * #536: the ONE canonical "does this conversation render as a TOP-LEVEL sidebar row?"
 * predicate. A non-child always does; a child does only when its resolved placement is
 * "top-level" (orphan, archived-parent-running, or a running descendant that cannot nest).
 * Used by rendering, auto-selection, unread aggregation, the desktop badge, and mark-all so
 * a row that is not rendered can never be silently auto-selected or counted. Callers still
 * exclude archived ids separately where a tab or aggregate requires it.
 */
export function rendersAsTopLevelRow(conversation: Conversation, index: SidebarIndex): boolean {
    return !isSubChat(conversation) || childSidebarPlacement(conversation, index) === "top-level";
}

export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number, thresholdPx = 80): boolean {
    return scrollHeight - scrollTop - clientHeight <= thresholdPx;
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
