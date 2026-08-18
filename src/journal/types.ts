/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

export const MESSAGE_EVENT_TYPES = new Set([
    "text",
    "peer_message",
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
    session_outcome?: string | null;
    last_seq: number;
    unread_count: number;
    snippet: string;
    created_at: number;
    parent_convo_id?: string | null; // null/undefined = top-level; set once at child creation, immutable
    last_ts?: number;
    read_up_to_seq: number;
    agent_kind?: string | null; // which backend runs this conversation ('claude' | 'codex'); null/undefined = unknown, no marker
}

export interface SnapshotResponse {
    conversations: Array<Omit<Conversation, "read_up_to_seq"> & { read_up_to_seq?: number }>;
    seq: number;
    capabilities?: string[];
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

// Host-global vitals reading (#529 3-repo feature). The journal server pushes this on a
// host-scoped ephemeral frame (NO convo_id) roughly every 5s; one value drives the
// host_cpu / host_ram usage bars for EVERY conversation. `sampled_at_ms` is the epoch ms of
// the reading so the staleness dim (status.ts HOST_VITALS_STALE_MS) still ages it if pushes stop.
export interface HostVitals {
    cpu: number;
    ram: number;
    sampled_at_ms: number;
}

export interface JournalEphemeralFrame {
    kind: "ephemeral";
    // Host-scoped frames (host_vitals) carry NO convo_id — the client must not gate them on the
    // selected-conversation guard. Conversation-scoped frames (activity/status/streams) do.
    convo_id?: string;
    message_ref?: string;
    text?: string;
    replace_text?: string;
    activity?: {
        state: "thinking" | "tool" | "idle";
        detail?: string;
    };
    tool_stream?: ToolStreamPayload;
    status?: SessionStatus;
    // Present only on the host-global push (no convo_id). Absent on older servers/bridges →
    // client falls back to the per-status `limits` host entries + existing staleness dim.
    host_vitals?: HostVitals;
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
        // Epoch ms of the last REAL sample for this meter (host vitals only: host_cpu /
        // host_ram). Host readings only refresh on turn-end and get replayed verbatim to new
        // viewers, so on an idle conversation the displayed value can be minutes/hours stale
        // while looking current. When present, the client expires stale readings (renders a
        // muted state past HOST_VITALS_STALE_MS). Absent on older bridges / non-host meters →
        // no staleness logic (current behaviour). See status.ts HOST_VITALS_STALE_MS.
        sampled_at_ms?: number;
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
    /**
     * #541: parent conversation ids whose subagent child rows the user has manually collapsed.
     * Session-local UI state (not server-persisted); default empty = every parent expanded.
     * Threaded into every buildSidebarIndex call so render/selection/unread/mark-all agree.
     */
    collapsedSubagentParentIds: Set<string>;
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
    // Host-global vitals (#529): one host reading (cpu/ram/sample stamp) shared by the whole app,
    // pushed with no convo_id. Threaded into buildUsageMeters to override the per-status host_cpu /
    // host_ram meters. Null/undefined → no push yet (or older server) → fall back to per-status limits.
    hostVitals?: HostVitals | null;
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

/** Shared empty set — default for the optional collapsed-parents argument (no allocation per call). */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

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
    /**
     * #541: parent ids that host at least one subagent child row — a running child whose
     * direct parent is a real, non-archived top-level row (i.e. the child renders nested, or
     * WOULD render nested if the parent were not collapsed). Independent of the collapsed set,
     * so the sidebar row menu can gate its "Collapse/Show subagents" item on the child rows
     * EXISTING, even while they are hidden by an active collapse.
     */
    parentsWithChildRows: Set<string>;
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
 *    resolved placement is "top-level" AND the user has not collapsed that parent; if the
 *    parent is a valid host but collapsed, the child is "hidden" (#541 — suppressed from the
 *    sidebar, but the parent still hosts it, so it is counted in `parentsWithChildRows`);
 *    otherwise (parent not a valid host) "top-level".
 */
export function buildSidebarIndex(
    conversations: Conversation[],
    archivedIds: ReadonlySet<string>,
    collapsedParentIds: ReadonlySet<string> = EMPTY_ID_SET,
): SidebarIndex {
    const allIds = new Set<string>();
    const byId = new Map<string, Conversation>();
    for (const conversation of conversations) {
        allIds.add(conversation.id);
        byId.set(conversation.id, conversation);
    }

    const placement = new Map<string, ChildSidebarPlacement>();
    const parentsWithChildRows = new Set<string>();
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

        if (parentIsTopLevelRow && parent != null) {
            // This is a real subagent child row for `parent` — record the host relationship
            // regardless of collapse (drives the menu gate + the collapsed-count affordance).
            parentsWithChildRows.add(parent.id);
            // Collapse suppresses the row: "hidden" excludes it from EVERY consumer that reads
            // placement (render/nested-splice, auto-select, unread, badge, mark-all) in lock-step.
            const result: ChildSidebarPlacement = collapsedParentIds.has(parent.id) ? "hidden" : "nested";
            placement.set(conversation.id, result);
            return result;
        }
        placement.set(conversation.id, "top-level");
        return "top-level";
    };

    for (const conversation of conversations) resolve(conversation);
    return { allIds, byId, placement, parentsWithChildRows };
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

/**
 * #541: does this conversation currently host any subagent child rows? True when at least one
 * running child nests (or would nest, if the parent is collapsed) directly beneath it. Gates
 * the sidebar-row-menu "Collapse subagents" / "Show subagents" toggle so it appears ONLY for a
 * parent that actually has child rows — collapse state does not change the answer.
 */
export function hasSubagentChildRows(conversation: Pick<Conversation, "id">, index: SidebarIndex): boolean {
    return index.parentsWithChildRows.has(conversation.id);
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

// Image intrinsic pixel dimensions. The bridge attaches these (client-measured on the
// common upload path) to image/file payloads as `dims: { width, height }` so the web
// client can reserve an aspect-ratio box BEFORE the blob decodes — this is what kills the
// thread reflow that otherwise happens as each image finishes loading.
export interface MediaDims {
    width: number;
    height: number;
}

// Parse `payload.dims`. Returns undefined when absent or non-positive (bridge-originated
// images / clients that didn't measure) so the caller falls back to the un-reserved render.
export function parseMediaDims(value: unknown): MediaDims | undefined {
    if (!isObject(value)) return undefined;
    const width = asNumber(value.width, 0);
    const height = asNumber(value.height, 0);
    return width > 0 && height > 0 ? { width, height } : undefined;
}

// Coarse file buckets used to pick a file-tile affordance from a MIME type. A few sensible
// buckets + a generic fallback — deliberately NOT an exhaustive icon library.
export type FileKind = "image" | "pdf" | "text" | "audio" | "video" | "archive" | "generic";

const ARCHIVE_MIME = /(zip|tar|gzip|x-7z-compressed|x-rar|x-bzip|compress)/;

// Map a MIME (`payload.content_type`) to a coarse FileKind. Absent/blank → "generic".
export function fileKindFromMime(contentType: unknown): FileKind {
    const mime = asString(contentType).trim().toLowerCase();
    if (!mime) return "generic";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime === "application/pdf") return "pdf";
    if (mime.startsWith("text/")) return "text";
    if (ARCHIVE_MIME.test(mime)) return "archive";
    return "generic";
}

export function displaySender(sender: string): string {
    const separator = sender.indexOf(":");
    return separator === -1 ? sender : sender.slice(separator + 1);
}

export function conversationTitle(conversation: Conversation): string {
    return conversation.title.trim() || conversation.id;
}

export const PEER_BODY_CAP = 2000;
export const PEER_NAME_CAP = 80;

const PEER_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

export function sanitizePeerText(value: unknown, max = PEER_BODY_CAP): string {
    if (value == null) return "";
    return String(value).replace(PEER_CONTROL_OR_FORMAT, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function eventSnippet(type: string, payload: EventPayload): string {
    if (type === "text") return asString(payload.body).slice(0, 120);
    if (type === "peer_message") return sanitizePeerText(payload.body, 120);
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
