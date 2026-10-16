/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { CoordinatorDecision } from "./coordinator-consent";
import type { Routine } from "./routines";

export const MESSAGE_EVENT_TYPES = new Set([
    "text",
    "peer_message",
    "tool_output",
    "diff",
    "prompt",
    "permission_request",
    "file",
    "image",
    "spawn_outcome",
    // v1: tracker markers are not unread messages — `item`/`milestone`/`mission` are
    // deliberately OUT of this set to avoid unread-badge churn (revisit in a later pass).
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

// A box's last capacity report (protocol.md "Box status (`box_status`)"): served as `status`
// on GET /devices for agent devices that have ever reported, and pushed live to client sockets
// as `{kind:'box_status', device_id, reported_at, ...blocks}`. Every block is optional — the
// bridge sends whichever it has — and `reported_at` says how old the numbers are.
export interface BoxStatusLimitLine {
    id: string;
    label: string;
    percent: number;
    // Human reset text ("Sep 28 at 1:10am (Europe/London)") and/or an ISO-8601 instant; each
    // independently optional per line.
    resets?: string;
    resets_at?: string;
}

export interface BoxStatus {
    reported_at: number;
    activity?: {
        live_sessions: number;
        last_hour: Array<{ path: string; sessions: number }>;
    };
    limits?: {
        as_of: number;
        lines: BoxStatusLimitLine[];
    };
    disk?: {
        free_bytes: number;
        total_bytes: number;
    };
    account?: {
        email: string;
    };
    // Host CPU / RAM sample the bridge attaches to its report (read by the Ops page).
    vitals?: {
        cpu_pct: number;
        ram_pct: number;
        sampled_at_ms: number;
    };
}

export interface DeviceDTO {
    device_id: number;
    kind: string;
    name?: string;
    last_seen_at?: number;
    connected: boolean;
    is_self: boolean;
    /** The journal-held tag character shown before an agent box's chat titles; null = automatic. */
    tag_char?: string | null;
    /** Enrolment time (ms); the Devices list sorts newest first within apps and agent boxes. */
    created_at?: number;
    /** How many events the device's cursor trails the user's head. */
    lag?: number;
    // The box's last capacity report (journal `box_status`). Absent for a
    // device that never reported (clients, non-bridge agents) or an older journal.
    status?: BoxStatus;
    /** An agent box's stored defaults for new sessions (see BoxDefaults). Absent on journals
     *  that predate per-box defaults, and on client devices. */
    defaults?: BoxDefaults;
}

/** POST /pair/preview: who is asking to pair, and how long the code has left (seconds). */
export interface PairPreview {
    requester_ip: string;
    expires_in: number;
}

/** POST /link/start: the code this device shows, and its lifetime (seconds). */
export interface LinkStart {
    link_code: string;
    expires_in: number;
}

/** POST /link/status: still waiting for a scan, or claimed by a device asking to sign in. */
export type LinkStatus =
    | { status: "waiting"; expires_in: number }
    | { status: "claimed"; device_name: string; requester_ip: string; expires_in: number };

export interface DevicesResponse {
    devices: DeviceDTO[];
}

export interface RecentFolder {
    path: string;
    last_used: number | null;
}

/** One choice a box offers on its `recent_folders` reply (`agent_options`, `model_options`,
 *  `effort_options`): `value` is what the `start` RPC takes, `label` what the picker shows
 *  (never empty — the parser falls back to `value`). */
export interface StartOption {
    value: string;
    label: string;
}

/** Everything a box's `recent_folders` reply offers the New session sheet. Every block beside
 *  `folders` is optional on the wire: an older bridge omits it, which parses to an empty offer
 *  (the picker hides) rather than failing the folders it rides with. */
export interface NewSessionOffer {
    folders: RecentFolder[];
    /** Coding agents a `start` there may name. Empty = the bridge predates the switch. */
    agentOptions: StartOption[];
    /** What a start with no `agent` runs as. */
    defaultAgent: string | null;
    /** Claude models, without the bridge's own `default` alias (the picker's Default row). */
    modelOptions: StartOption[];
    /** What a start with no `model` runs on, when the box says. Display only. */
    defaultModel: string | null;
    /** Claude effort levels a `start` may name. */
    effortOptions: StartOption[];
    /** What a start with no `effort` runs at, when the box says. Display only. */
    defaultEffort: string | null;
}

/** The New session sheet's picks for `start`. An absent key leaves the choice to the box. */
export interface StartSessionPicks {
    agent?: string;
    model?: string;
    effort?: string;
}

export interface Conversation {
    id: string;
    title: string;
    /** The bridge's own generated title, which `title` replaces with the mission's name while the
     *  conversation is on a mission. Absent from older journals; null on the journal's own rows. */
    auto_title?: string | null;
    session_state: string;
    session_outcome?: string | null;
    last_seq: number;
    unread_count: number;
    snippet: string;
    created_at: number;
    parent_convo_id?: string | null; // null/undefined = top-level; set once at child creation, immutable
    /** The agent box that manages this conversation (`GET /snapshot`); null for legacy rows. */
    agent_device_id?: number | null;
    last_ts?: number;
    read_up_to_seq: number;
    agent_kind?: string | null; // which backend runs this conversation ('claude' | 'codex'); null/undefined = unknown, no marker
    /** Rolling bullet digest maintained by the owning bridge, stored as the raw
        "• a\n• b" text the bridge published. Absent against a server that does not send the
        field; "" when the server knows the field but the bridge never wrote a digest. Parsed
        for display by `conversationSummary()` in ./summary. */
    summary?: string;
    /** Epoch-ms of the last summary CHANGE, as observed by the journal server. 0/undefined =
        never written or an older server — the surface then shows no age label rather than a
        1970 date. Server-observed, so treat it as a lower bound on the digest's real age. */
    summary_updated_at?: number;
    /** Client-only (never sent by the server): the tool call the last message event reported,
        when it was one — the sidebar reads it as plain English with Developer view off. Absent
        after a snapshot replace; the preview then falls back to the server snippet. */
    last_step?: { tool: string; input: Record<string, string | undefined> } | null;
    /** A room's owner plus joined participant device ids (`/snapshot`, membership `convo_meta`);
     *  absent on a conversation that was never an agent-chat room. */
    participants?: number[];
    /** A room's participant conversation ids, owner side first; [] when unknown or nobody is
     *  joined. Present on exactly the rows that carry `participants`. */
    participant_convos?: string[];
}

/** One of the user's agent boxes as the snapshot and `device_meta` frames describe it. */
export interface AgentRosterEntry {
    device_id: number;
    name: string;
    tag_char?: string | null;
}

export interface SnapshotResponse {
    conversations: Array<Omit<Conversation, "read_up_to_seq"> & { read_up_to_seq?: number }>;
    agents?: AgentRosterEntry[];
    seq: number;
    capabilities?: string[];
    /** Journal pins; absent on a journal that predates them (parsed by pins.ts pinsFromContainer). */
    pins?: unknown;
}

/** The newer session on the same box the app offers to move a pin to. */
export interface ConvoPinSuccessor {
    convo_id: string;
    title: string;
    created_at: number;
}

/** A journal-backed pinned desk chat (journal protocol "Pins"). */
export interface ConvoPin {
    convo_id: string;
    /** One line, 1–24 characters; the row's primary text. */
    label: string;
    /** A short token, or "" to draw the label's first letter instead. */
    emoji: string;
    position: number;
    device_id: number | null;
    /** The pinned conversation is gone; the row offers only Move pin… and Unpin. */
    missing?: true;
    successor?: ConvoPinSuccessor;
    created_at: number;
    updated_at: number;
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

/**
 * A single full-text search hit over message content, as returned by the server's
 * `GET /search` endpoint. `snippet` carries `**…**` markers around the matched terms
 * and `…` for elided context; `live` is true while the hit's conversation is running.
 */
export interface SearchHit {
    convo_id: string;
    title: string;
    seq: number;
    ts: number;
    sender: string;
    snippet: string;
    live: boolean;
}

export interface SearchResponse {
    hits: SearchHit[];
}

/**
 * What a tracker number is (`GET /lookup`). Items, missions, milestones and projects share one
 * per-user number space, so a number alone does not say which kind it names. `num` and `title`
 * are absent on an older journal; `mission` is the mission a milestone sits on.
 */
export type NumberLookupKind = "item" | "mission" | "milestone" | "project";
export interface NumberLookup {
    kind: NumberLookupKind;
    id: string;
    num?: number;
    title?: string;
    mission?: { id: string; num: number };
}

/** `none`: no such number (or not visible to this user). `failed`: the journal could not be asked. */
export type NumberLookupOutcome = { status: "found"; hit: NumberLookup } | { status: "none" } | { status: "failed" };

/**
 * Message-content search state (Apple-parity "Messages" section). The conversation list search box
 * filters chat titles in-memory (the "Chats" behaviour); this holds the server-side content
 * hits for the same query. `query` is the query the current `hits` belong to, so the view can
 * ignore results that raced in after the box was cleared or retyped.
 */
export interface MessageSearchState {
    query: string;
    hits: SearchHit[];
    loading: boolean;
    failed: boolean;
}

/**
 * Find in chat: one search within the open conversation. `matchSeqs` holds the matching messages'
 * seqs newest first and `index` the one in view (0 = newest). An empty `query` is a bar opened with
 * nothing searched yet.
 */
export interface ChatSearchState {
    conversationId: string;
    query: string;
    matchSeqs: number[];
    index: number;
    loading: boolean;
    failed: boolean;
    /** Bumped each time the bar should take keyboard focus (Ctrl/⌘F while it is already open). */
    focusTick: number;
}

export interface JournalControlFrame {
    kind: "control";
    op: string;
    seq?: number;
    code?: string;
    detail?: string;
    ref?: string;
    request_id?: string;
    /** hello_ok: the user's journal pins; absent on a journal that predates them. */
    pins?: unknown;
    /** `hello_ok` and the `settings` op carry the user's journal settings (unvalidated JSON). */
    settings?: unknown;
    /** hello_ok: the user's Coordinator conversation (null for none); absent on an older journal. */
    coordinator_convo_id?: unknown;
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

// Host-global vitals reading. The journal server pushes this
// on a host-scoped ephemeral frame (NO convo_id) roughly every 5s; one value refreshes the
// host_cpu / host_ram usage bars for EVERY conversation. It is an OVERRIDE, not the source:
// the bars themselves are synthesized from the status frame's top-level `vitals` (see
// SessionStatus.vitals), which is the contract shared with upstream and matron-apple. Note the
// field names differ from SessionStatus.vitals (`cpu`/`ram` here, `cpu_pct`/`ram_pct` there) —
// that is the bridge's wire shape for this frame, not a typo. `sampled_at_ms` is the epoch ms of
// the reading so the staleness dim (status.ts HOST_VITALS_STALE_MS) still ages it if pushes stop.
export interface HostVitals {
    // OPTIONAL, matching the bridge frame: it omits `cpu` until its CPU sampler has two ticks
    // after boot, and `ram` if the OS reports no total memory. Consumers must narrow before
    // using either as a percent.
    cpu?: number;
    ram?: number;
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
    // the meters still render from `status.vitals`, just at turn-end cadence.
    host_vitals?: HostVitals;
}

// Live box-status fan-out (client sockets only, never replayed): a full replacement of the
// stored report for `device_id`. Blocks are validated client-side by `parseBoxStatus`.
export interface JournalBoxStatusFrame {
    kind: "box_status";
    device_id: number;
    reported_at: number;
    activity?: unknown;
    limits?: unknown;
    disk?: unknown;
    account?: unknown;
    vitals?: unknown;
}

export interface JournalDeviceMetaFrame {
    kind: "device_meta";
    device_id: number;
    name: string;
    tag_char?: string | null;
}

// Coordinator briefing fan-out (client sockets only, never replayed; journal protocol.md
// "Coordinator briefings → Live frame"): pure invalidation — the app refetches GET /briefings/latest.
export interface JournalBriefingFrame {
    kind: "briefing";
    action: "published" | "refreshing" | "refresh_failed";
    briefing_id?: string;
}

// The user's new-chat defaults changed (journal protocol.md "Default model and effort"): sent to
// every live socket of the user, never replayed. Carries the full new state; validated client-side
// by `parseUserDefaults`.
export interface JournalDefaultsFrame {
    kind: "defaults";
    default_model?: unknown;
    default_effort?: unknown;
}

// One agent box's defaults changed (journal protocol.md "Box defaults"): sent to the user's
// client sockets, never replayed. Carries the box's full new state; validated client-side by
// `parseBoxDefaultsState`.
export interface JournalBoxDefaultsFrame {
    kind: "box_defaults";
    device_id?: unknown;
    default_agent?: unknown;
    default_model?: unknown;
    default_effort?: unknown;
}

// Journal pins fan-out (client sockets only): the full pin list after every change.
export interface JournalPinsFrame {
    kind: "pins";
    pins: unknown;
}

export type ServerFrame =
    | JournalEvent
    | JournalControlFrame
    | JournalEphemeralFrame
    | JournalRpcFrame
    | JournalBoxStatusFrame
    | JournalDeviceMetaFrame
    | JournalBriefingFrame
    | JournalDefaultsFrame
    | JournalBoxDefaultsFrame
    | JournalPinsFrame;

export interface SessionStatus {
    model?: string;
    // The MCP extras the session's process was spawned with (e.g. ["browser"]), from matron-bridge
    // buildSessionStatus. Absent on older bridges and on subagent/helper frames: consumers must
    // treat absence as "unknown" (hide), never as "none". [] means no extras.
    extras?: string[];
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
        // Stable machine key from the bridge (v5+): `session`, `week_all`, `week_fable`,
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
    // Host machine vitals (bridge status frame, TOP LEVEL — never a limits[] entry). This is
    // the upstream and the only surface host CPU/RAM is read from: matron-web
    // (here) and matron-apple (WireModels decodes status["vitals"].cpu_pct / .ram_pct) both
    // synthesize their host meters from it. limits[] stays the account's subscription-quota
    // list; a synthetic host entry there renders CPU/RAM twice and displaces a real quota bar
    // on iOS (limits.prefix(3)). Absent on bridges that don't publish vitals → the host meters
    // simply don't render (graceful degradation).
    //
    // Nullable halves (divergence from upstream's `number`, deliberate): the bridge emits
    // cpu_pct: null until its CPU sampler has two ticks after boot, so the render path must
    // narrow before using either value.
    vitals?: {
        cpu_pct: number | null;
        ram_pct: number | null;
        // Epoch ms of the last real sample. Drives the same staleness muting as the per-meter
        // field on limits[]: host readings refresh on turn-end and are replayed verbatim to
        // new viewers, so an idle conversation can show a minutes-old reading as live.
        // See status.ts HOST_VITALS_STALE_MS.
        sampled_at_ms: number;
    };
    email?: string;
    // The session's effort level. Tri-state on the wire: a string while the bridge tracks one,
    // an explicit null once it tracks none, and absent from frames that say nothing about it
    // (see mergeSessionStatus). Held state is a string or absent.
    effort?: string | null;
    // The session's arguments for /model and /effort, as the composer offers them. The bridge owns
    // these lists (they differ per agent): absent says nothing, an empty list offers nothing.
    model_options?: SessionStatusOption[];
    effort_levels?: SessionStatusOption[];
}

export interface SessionStatusOption {
    value: string;
    label?: string;
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
    /** Set on an attachment sent together with others from one composer message. */
    batch?: AttachmentBatchTag;
}

export type ConnectionState = "offline" | "connecting" | "online";

/**
 * One attachment's place in a multi-attachment composer send. Every attachment of a send with more
 * than one carries the same `id`, so the bridge can gather their frames back into the one message
 * the user wrote; `index` is 1-based and `total` is how many frames complete the batch. On the
 * wire it rides in the media payload as `batch_id` / `batch_index` / `batch_total`.
 */
export interface AttachmentBatchTag {
    id: string;
    index: number;
    total: number;
}

/**
 * A file in the composer's attachment tray: picked, pasted or dropped, and not yet sent. It leaves
 * with the composer text when the user sends, so the agent gets the file and the words about it
 * as one turn.
 */
export interface ComposerAttachment {
    id: string;
    file: File;
    /**
     * `staged` waits for a send; `queued` is part of a send in flight and waiting its turn;
     * `uploading` is on its way; `failed` didn't go out and stays for the next send to retry.
     */
    state: "staged" | "queued" | "uploading" | "failed";
    /** Uploaded fraction (0…1) while uploading. */
    progress?: number;
    /** Why it failed, in prose. */
    error?: string;
    /** A file that can never upload (empty, or too big for the browser): it blocks the send until removed. */
    unsendable?: boolean;
    /**
     * The tag this file's frame was about to carry when its send failed. A retry re-emits it under
     * the same batch, so the bridge can still complete the message its siblings already started.
     */
    batch?: AttachmentBatchTag;
}

/** The loaded part of For you's Done list. `error` is the last load's failure; the rows it could
 *  not replace stay. */
export interface InboxDone {
    items: TrackerItem[];
    nextCursor: string | null;
    loading: boolean;
    error?: string;
}

/**
 * The chat's Tasks & decisions pane, beside the conversation. It stays open across conversation
 * switches; `allFor` names the conversation whose pane shows "All" (any other shows "This chat",
 * so moving to another conversation starts on its own items). `items` is the list last loaded for
 * `scope` (the conversation id, or "all"): the open items, then the latest closed ones for Done.
 * `error` is the last load's failure (the rows it could not replace stay); `actionError` the last
 * failed move, until dismissed. `unsupported`: GET /items answered 404, a journal without items.
 */
export interface ChatTasksState {
    open: boolean;
    allFor?: string;
    scope?: string;
    items?: TrackerItem[];
    loading?: boolean;
    error?: string;
    actionError?: string;
    unsupported?: boolean;
}

export interface FocusTarget {
    conversationId: string;
    seq: number;
    token: number;
}

export interface ClientState {
    phase: "loading" | "signed-out" | "signed-in";
    config: MatronConfig;
    session?: Session;
    conversations: Conversation[];
    archivedIds: Set<string>;
    /** Browser-local pins, used only while `journalPins` is null. */
    pinnedIds: Set<string>;
    /** Journal pins in position order; null = this journal does not support pins (or not yet heard). */
    journalPins: ConvoPin[] | null;
    /** The journal's pin cap (from the last /pins response). */
    pinLimit: number;
    favoriteIds: Set<string>;
    unreadOverrideIds: Set<string>;
    /**
     * parent conversation ids whose subagent child rows the user has manually collapsed.
     * Session-local UI state (not server-persisted); default empty = every parent expanded.
     * Threaded into every buildSidebarIndex call so render/selection/unread/mark-all agree.
     */
    collapsedSubagentParentIds: Set<string>;
    /**
     * Sessions that arrived while this tab was live without this device asking for them (an
     * agent, the Coordinator or a routine started them) and that the user has not opened since.
     * Their rows carry a "New" marker. In memory only: a reload starts clean.
     */
    newConversationIds: Set<string>;
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
    /** Sequence to scroll to after loading a message-search deep link. */
    pendingScrollSeq?: number;
    /** True while the selected timeline is a bounded historical window rather than the live tail. */
    viewingHistoryWindow: boolean;
    activity?: JournalEphemeralFrame["activity"];
    sessionStatus?: SessionStatus;
    // Host-global vitals: one host reading (cpu/ram/sample stamp) shared by the whole app,
    // pushed with no convo_id. Threaded into buildUsageMeters to override the per-status host_cpu /
    // host_ram meters. Null/undefined → no push yet (or older server) → fall back to per-status limits.
    hostVitals?: HostVitals | null;
    // Last capacity report per agent device id — seeded from GET /devices, replaced by live
    // `box_status` frames. Read by the new-session sheet.
    boxStatuses: Record<number, BoxStatus>;
    /** The user's agent boxes, from the snapshot and live `device_meta` frames; drives session tags. */
    agents: AgentRosterEntry[];
    textStreams: Record<string, string>;
    toolStreams: Record<string, ToolStreamState>;
    dragActive: boolean;
    /** Each conversation's attachment tray, by conversation id; a conversation with none has no key. */
    composerAttachments: Record<string, ComposerAttachment[]>;
    sendTick: number;
    // A row the open timeline should scroll to and flash once it renders (a search hit, a
    // milestone, "jump to my last message"). Set by client.focusMessage after the history holding
    // `seq` has loaded; the timeline clears it by `token` once it has landed.
    focusTarget?: FocusTarget;
    // Message-content search hits (Apple-parity "Messages" section). Undefined until the first
    // search of a session; cleared back to undefined when the search box empties.
    messageSearch?: MessageSearchState;
    // Files pane (Matron File Explorer, Phase 1b). Undefined = pane closed (main region shows
    // the conversation view / HomePage). Present = pane open; `path` is the last-browsed dir so
    // reopening returns there. This is the SOLE app-global Files state — directory listing,
    // selection, and preview are FilesPane-local (like the conversation timeline is RoomView-local).
    // Mirrors how `selectedConversationId` is the only main-region discriminant today.
    filesView?: FilesViewState;
    // Find in chat: the search bar over the open conversation, while it is up.
    chatSearch?: ChatSearchState;
    // Tracker pane (Missions / Milestones / Decisions-Inbox / Work). `trackerView` is the
    // main-region discriminant (checked alongside filesView — one surface at a time).
    // The rest are store-resident so sidebar badges stay live off WS invalidation:
    //   missions/inboxItems  = the two list views;
    //   trackerItem          = the open item detail (item + its comment thread), null = none;
    //   trackerMission       = the open mission detail, null = none.
    // Undefined = never loaded this session; all reset to undefined via `...blankState()` on logout.
    trackerView?: TrackerViewState;
    // Ops pane: boxes, host, alerts, timers, usage. Another main-region
    // discriminant, one surface at a time with Files and the tracker. The pane owns its fetched
    // data; the store only carries the open flag (live box reports live in `boxStatuses`).
    opsView?: { open: true };
    /** The "Go to number" field is open (the shortcut and both header buttons set it). */
    goToNumberOpen?: boolean;
    /** The subagent open in the pane beside its parent chat (see chatSidePane). It belongs to
     *  `parentId`: it shows only while that chat is on screen. */
    subChatPane?: { parentId: string; childId: string };
    missions?: Mission[];
    inboxItems?: TrackerItem[];
    /** For you's Done tab: closed questions, decisions and notices, newest first. Undefined until
     *  the tab is first opened; `nextCursor` null = everything is loaded. */
    inboxDone?: InboxDone;
    /** Projects (unify step 7): the dashboard rows and the open project's detail. */
    projects?: Project[];
    projectsError?: string;
    /** GET /projects answered 404: an older journal without projects; the tracker shows missions. */
    projectsUnsupported?: boolean;
    /** Last failed project-detail load, keyed by its number (like missionLoadError). */
    projectLoadError?: { id: string; message: string };
    trackerProject?: ProjectDetail | null;
    /** True while the project page's Latest feed fetches its next pages. */
    trackerProjectFeedLoading?: boolean;
    trackerItem?: { item: TrackerItem; comments: TrackerComment[] } | null;
    trackerMission?: MissionDetail | null;
    /** The selected conversation's missions, for the chat header's mission chip. Absent until
     *  fetched; a fetch for another conversation is never shown against this one. */
    conversationMissions?: ConversationMissions;
    /** The chat's Tasks & decisions pane; absent until it is first opened. */
    chatTasks?: ChatTasksState;
    /** True while ANY tracker fetch is in flight (v1: one detail/list open at a time). */
    trackerLoading?: boolean;
    /** Last tracker fetch/mutation error; cleared on the next successful load. */
    trackerError?: string;
    /** Error from the last inbox load only. Unlike trackerError, which any tracker load clears, this
     *  is cleared only by the next inbox load, so a never-loaded inbox can tell "failed" from
     *  "still loading" while other loads come and go. */
    inboxError?: string;
    /** Error from the last item-detail load, keyed by the item it was for (`id` is the item number
     *  as a string, any leading "#" dropped). Unlike trackerError it survives other tracker loads
     *  and an in-flight retry, and is cleared only when an item load succeeds, so the pane can keep
     *  offering a retry for the selected item until it actually loads. */
    itemLoadError?: { id: string; message: string };
    /** Same as inboxError, for the missions list. */
    missionsError?: string;
    /** Same as itemLoadError, for the open mission detail: keyed by the mission number (leading "#"
     *  dropped), survives other tracker loads and an in-flight retry, and is cleared only when a
     *  mission load succeeds, so the pane can keep offering a retry until it actually loads. */
    missionLoadError?: { id: string; message: string };
    /** The Memories view's list, sorted by name. Undefined = never loaded this session. */
    memories?: Memory[];
    /** Same as inboxError, for the memories list. */
    memoriesError?: string;
    /** The Coordinator's latest briefing (top of the Projects tab). Undefined = never loaded. */
    briefing?: BriefingState;
    /** The user's defaults for new chats (Settings → New chats). Undefined = never loaded. */
    defaults?: DefaultsState;
    /** Per-box defaults for new sessions (Settings → Boxes). Undefined = never loaded. */
    boxDefaults?: BoxDefaultsState;
    /** The user's journal settings (GET /settings, `hello_ok`, the `settings` control frame).
     *  Undefined = not known yet. */
    userSettings?: UserSettings;
    /** GET /settings answered 404: an older journal without settings; the switches are hidden. */
    userSettingsUnsupported?: boolean;
    /** The last failed settings save; cleared by the next save. */
    userSettingsError?: string;
    /** Settings → Coordinator: whether the Coordinator may answer chat and spawn asks (`consent`
     *  on GET /coordinator). `enabled` undefined = not known yet, or a journal without the switch. */
    coordinatorConsent?: { enabled?: boolean; error?: string };
    /** The user's Coordinator conversation (GET/PUT /coordinator `convo_id`, `hello_ok`
     *  `coordinator_convo_id`). Undefined = not known yet; null = none set. */
    coordinatorConvoId?: string | null;
    /** Settings → Coordinator → Routines. Undefined = never loaded this session. */
    routines?: RoutinesState;
}

/** The Routines sheet's view of GET /routines and the writes in flight. */
export interface RoutinesState {
    /** Sorted by name. Undefined until the first load lands. */
    list?: Routine[];
    /** GET /routines answered 404: the journal predates routines. */
    unsupported?: boolean;
    loading?: boolean;
    /** The last load's failure. A failed load never clears `list`. */
    error?: string;
    /** Routines with a pause/resume or run request in flight. */
    busyIds?: ReadonlySet<string>;
}

// ── New-chat defaults (journal GET/PUT /defaults) ───────────────────────────────────────────────
// Per-user default model and effort that every bridge applies to a new chat started without a
// choice of its own. null = "Box default": each bridge falls back to its own environment.

/** GET /defaults, and the 200 body of PUT /defaults. */
export interface UserDefaults {
    default_model: string | null;
    default_effort: string | null;
}

export type UserDefaultKey = keyof UserDefaults;

export interface DefaultsState {
    /** The last known defaults; undefined until the first load succeeds. */
    value?: UserDefaults;
    loading: boolean;
    /** The journal predates /defaults (GET answered 404): the settings group says so. */
    unsupported: boolean;
    /** The last load or save failure; a failed save has already reverted its optimistic value. */
    error?: string;
}

// ── Per-box defaults (journal GET /devices `defaults`, PUT /devices/:id/defaults) ─────────────────
// The agent, model and effort a session started on one agent box gets when nobody names them.
// null = the bridge's own fallback (its MATRON_DEFAULT_* environment). The model and effort belong
// to the box's default agent: a Claude alias on a Claude box, a Codex model id on a Codex box.

export type BoxAgent = "claude" | "codex";

/** GET /devices `defaults` on an agent box. */
export interface BoxDefaults {
    agent: string | null;
    model: string | null;
    effort: string | null;
}

/** PUT /devices/:id/defaults body (any subset) and its 200 answer (all keys). */
export interface BoxDefaultsPatch {
    default_agent?: string | null;
    default_model?: string | null;
    default_effort?: string | null;
}

export interface BoxDefaultsState {
    /** The user's agent boxes that carry defaults, in roster order; values include unsaved picks. */
    boxes: Array<{ device_id: number; name?: string; connected: boolean; defaults: BoxDefaults }>;
    loading: boolean;
    /** The journal predates per-box defaults: the settings group is hidden. */
    unsupported: boolean;
    /** The last load or save failure; a failed save has already reverted its optimistic value. */
    error?: string;
}

/** Per-user journal settings. `notices`: agents file things to read as notice items. */
export interface UserSettings {
    notices: boolean;
}

/**
 * The in-app links the markdown renderer activates (markdown.tsx parseMatronHref): the `matron://`
 * deep links, and `link` for an https `/u/<name>/<n>` link to this deployment (link-path.ts).
 */
export type MatronLinkKind = "item" | "mission" | "project" | "convo" | "link";
/** `target` is the #num for item/mission/project, the conversation id for convo, the URL for link. */
export type TrackerLinkHandler = (kind: MatronLinkKind, target: number | string) => void;

// ── Coordinator briefings (journal /briefings, spec 2026-10-04 latest briefing) ─────────────────
// The Coordinator publishes sweeps/status updates as briefings; the Projects tab shows the latest
// and may ask for a fresh one. Every timestamp is epoch ms.

export interface Briefing {
    id: string;
    /** Markdown, ≤32 KB. */
    body: string;
    created_at: number;
    /** The Coordinator conversation the briefing's `text` event was appended to. */
    convo_id: string;
    /** That event's seq (the "Open in chat" anchor). */
    seq: number;
}

export interface BriefingRefresh {
    requested_at: number;
    state: "pending" | "failed" | "timed_out";
    /** Pending only: when the journal stops waiting and the state becomes timed_out. */
    expires_at?: number;
    /** Failed only: the firer's outcome string. */
    outcome?: string;
}

/** GET /briefings/latest, and the 202 body of POST /briefings/refresh. */
export interface BriefingLatest {
    briefing: Briefing | null;
    refresh: BriefingRefresh | null;
    /** When the next refresh may be asked for; null = now. */
    next_refresh_at: number | null;
    has_coordinator: boolean;
}

export interface BriefingState {
    /** The last loaded view; undefined until the first load lands. */
    latest?: BriefingLatest;
    loading: boolean;
    /** The journal predates briefings (GET /briefings/latest 404s): the card stays hidden. */
    unsupported: boolean;
    /** Error from the last load; cleared by the next successful one. */
    error?: string;
    /** A POST /briefings/refresh is in flight. */
    requesting?: boolean;
    /** Why the last refresh ask was refused (429 / 409 / 503 / network). */
    refreshError?: string;
    /** On a 429: when a refresh may be asked for again. */
    retryAt?: number;
}

export interface FilesViewState {
    open: boolean;
    /** Last-browsed absolute directory path; seeds FilesPane on (re)open. */
    path?: string;
    /**
     * Deep-link target: an ABSOLUTE file path the pane should auto-open a preview for once its
     * containing directory listing lands (see FilesPane's auto-select effect). Set only by a
     * `#files=<abs>` deep link (client.applyFilesDeepLink); `path` is then that file's directory.
     */
    targetFile?: string;
    /**
     * Monotonic per-invocation token bumped by openFilesView every time a `targetFile` is supplied.
     * FilesPane keys its fire-once auto-select on THIS, not on `targetFile`, so re-clicking the SAME
     * link after navigating away re-navigates and re-selects (a new token) rather than being
     * permanently deduped by an unchanged path string.
     */
    targetToken?: number;
}

// ── Tracker (Missions / Milestones / Decisions-Inbox / Work) ───────────────────
// Wire shapes bind EXACTLY to the journal tracker API (src/items.js, src/missions.js
// @dd9c04a): `id`/`mission_id`/`supersedes`/`origin_convo_id` are opaque TEXT ids
// (strings); `num` is the human #number (integer); every timestamp is epoch-ms INTEGER
// (number). Titles can be absent across a privacy boundary — bind defensively at render.

/** Which tracker surface the pane shows; `selected*Id` are #num values (integers). */
export interface TrackerViewState {
    open: boolean;
    view?: "missions" | "inbox" | "work" | "memories";
    selectedItemId?: number;
    selectedMissionId?: number;
    /** Work tab: the loop whose detail is open. The Work data itself is WorkView-local. */
    selectedLoopId?: number;
    /** Projects view: the open project's number; undefined = the dashboard. */
    selectedProjectId?: number;
    /** Memories view: the open memory's name, or "" for the new-memory form. Undefined = the list. */
    selectedMemoryName?: string;
    /** Missions (Projects) view: the latest briefing is open in full. */
    briefingOpen?: boolean;
}

// ── Memories (journal /memories, spec 2026-09-27 memories) ─────────────────────
// The user's shared agent memory: standing rules and facts every agent may save and the
// Coordinator reads at spawn. Shaped like a Claude Code memory file. `name` is the key
// (kebab-case, unique per user); PUT /memories/:name overwrites the whole memory.

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
    id: string;
    name: string;
    type: MemoryType;
    /** One line, ≤200 chars — the line the Coordinator sees at spawn. */
    description: string;
    /** Markdown, ≤8192 bytes, may be empty. */
    body: string;
    origin_convo_id: string | null;
    origin_device_id: number | null;
    origin_private?: boolean;
    created_by: "user" | "agent";
    updated_by: "user" | "agent";
    created_at: number;
    updated_at: number;
}

/** PUT /memories/:name body. Omitted `body` clears the stored body; omitted `type` keeps it. */
export interface MemoryWrite {
    description: string;
    body?: string;
    type?: MemoryType;
}

/** `notice` is an FYI the user reads but does not decide: filed awaiting the user with a "Seen"
 *  button, and closed as done by the tap. The journal only sends it to clients that ask for it
 *  (the X-Matron-Item-Kinds header); others see a task. */
export type TrackerItemKind = "task" | "question" | "decision" | "notice";
export type TrackerItemState = "open" | "closed";
export type TrackerResolution = "done" | "answered" | "decided" | "reversed" | "cancelled";
export type TrackerAwaiting = "user" | "agent";
export type TrackerMilestoneKind = "user_input" | "progress";
export type TrackerMissionState = "open" | "closed";
export type TrackerActor = "user" | "agent";
export type TrackerCommentKind = "comment" | "status";

export interface TrackerLink {
    url: string;
    title?: string;
}

export interface TrackerAttachment {
    blob_ref: string;
    mime: string;
    name: string;
    size: number;
    transcript?: string;
    /** Pixel dimensions the journal measured for an image attachment; absent on other mimes and on
     *  images it could not measure. */
    width?: number;
    height?: number;
}

/** A resolution/state/awaiting triple; a status comment's text derives from `meta.to`. */
export interface StatusSnapshot {
    state: TrackerItemState;
    resolution: TrackerResolution | null;
    awaiting: TrackerAwaiting | null;
}

/** Whether the session that owns an item is busy (the journal's `working` block). `running`: that
 *  conversation is mid-turn. `queued`: the user wrote on the item and the agent's turn has not
 *  started yet; it lapses at `until` (ms) if nothing else happens. */
export interface TrackerWorking {
    state: "running" | "queued";
    since: number | null;
    until: number | null;
}

/** A pending offer to move an item to another conversation. The owner changes only on acceptance. */
export interface TrackerHandover {
    state: "awaiting_user" | "offered";
    to_convo_id: string;
    to_convo_title: string | null;
    expires_at: number;
}

export interface TrackerItem {
    id: string;
    num: number;
    kind: TrackerItemKind;
    state: TrackerItemState;
    resolution: TrackerResolution | null;
    awaiting: TrackerAwaiting | null;
    rank: number;
    title: string;
    body: string;
    labels: string[];
    links: TrackerLink[];
    supersedes: string | null;
    origin_convo_id: string;
    /** Title of the origin conversation as the journal resolved it, for provenance labels. Absent
     *  on a journal that predates the field; null or "" when the origin conversation is gone or
     *  untitled. */
    origin_convo_title?: string | null;
    origin_device_id?: number;
    created_by: TrackerActor;
    created_at: number;
    updated_at: number;
    closed_at: number | null;
    /** When the user last acted on the item (a reply, a tap, a close or reopen; else when they
     *  filed it). Null when only agents have touched it; absent on a journal that predates it. */
    last_user_input_at?: number | null;
    mission_id: string | null;
    mission_num: number | null;
    comment_count: number;
    last_comment_at: number | null;
    attachments: TrackerAttachment[];
    has_image: boolean;
    /** The item's own one-tap answers (a notice offers "Seen"). Absent on a journal that predates
     *  item actions. */
    actions?: string[];
    /** The action the user last tapped on the item itself ("Seen" on a notice they have read). */
    chosen_action?: string | null;
    /** Null when the owning session is idle; absent on a journal that predates the field and on
     *  another person's item. */
    working?: TrackerWorking | null;
    /** Null when no handover waits; absent on older journals and cached items. */
    handover?: TrackerHandover | null;
}

export interface TrackerComment {
    id: string;
    item_id: string;
    author: TrackerActor;
    device_id: number;
    kind: TrackerCommentKind;
    body: string;
    attachments: TrackerAttachment[];
    meta?: { from?: StatusSnapshot; to?: StatusSnapshot } | null;
    created_at: number;
    /** One-tap answers this comment offers (an agent's follow-up question). Absent on a journal
     *  that predates comment actions; `[]` on every comment that offers none. */
    actions?: string[];
    /** The label of the user's latest tap on this comment's `actions`, null until one. */
    chosen_action?: string | null;
    /** Set on the user's tap comment: the tapped label, and the id of the comment it answers
     *  (null when it answered the item's own buttons). */
    action?: string | null;
    reply_to?: string | null;
    /** Who wrote an agent's comment: the box's name, and the conversation its session writes from
     *  when the bridge named one. Absent on a journal that predates the fields; null on the user's
     *  own comments and wherever the journal cannot say. */
    device_name?: string | null;
    convo_id?: string | null;
    convo_title?: string | null;
}

/** `POST /items/:id/comments` body. `action` + `reply_to` is a tap on a comment's button. */
export interface TrackerCommentWrite {
    body?: string;
    attachments?: TrackerAttachment[];
    action?: string;
    reply_to?: string;
}

/** `POST /items` body: a new item filed into the conversation `convo_id`. */
export interface TrackerItemCreate {
    kind: "task" | "question" | "decision";
    title: string;
    body: string;
    convo_id: string;
}

/** `POST /items/:id/rank` body: to the top or bottom of the open tasks, or between two of them
 *  (their item ids). */
export type TrackerRankChange = { position: "top" | "bottom" } | { after: string; before: string };

/** The `{num,title,kind,created_at}` digest a mission list-row carries for its newest milestone. */
export interface MissionLastMilestone {
    num: number;
    title: string;
    kind: TrackerMilestoneKind;
    created_at: number;
}

export interface Mission {
    id: string;
    num: number;
    state: TrackerMissionState;
    title: string;
    /** Optional short label the journal names the mission's conversations by (null when unset;
     *  absent from older journals). */
    name?: string | null;
    body: string;
    close_summary: string | null;
    closed_by: TrackerActor | null;
    closed_over_open_items: number;
    origin_convo_id: string;
    origin_device_id?: number;
    created_by: TrackerActor;
    created_at: number;
    updated_at: number;
    last_milestone_at: number | null;
    closed_at: number | null;
    // List-row counts (present on every list/detail mission row).
    open_items: number;
    needs_you: number;
    conversations: number;
    milestones: number;
    last_milestone: MissionLastMilestone | null;
    /** The mission's project (journal Projects); null when it is in none. */
    project_id?: string | null;
    project_num?: number | null;
    /** The mission's activity rollup, where the journal sends it. */
    activity?: string;
    /** When anything last happened on the mission (milestone, status, its conversations), where
     *  the journal sends it. */
    last_activity_at?: number | null;
    /** The mission's status line (one short paragraph, inline markdown), who set it and when.
     *  Null when unset; absent from journals that predate mission status. */
    status?: string | null;
    status_by?: TrackerActor | null;
    status_updated_at?: number | null;
}

export interface Milestone {
    id: string;
    mission_id: string;
    num: number;
    kind: TrackerMilestoneKind;
    title: string;
    body: string;
    convo_id: string;
    seq: number;
    device_id: number;
    created_by: TrackerActor;
    created_at: number;
}

/** The reduced open-item shape a mission detail lists (awaiting-user first). */
export interface MissionItemRef {
    id: string;
    num: number;
    kind: TrackerItemKind;
    state: TrackerItemState;
    awaiting: TrackerAwaiting | null;
    title: string;
    origin_convo_id: string;
    updated_at: number;
}

export interface MissionConversation {
    id: string;
    title: string;
    /** The bridge's generated topic (see Conversation.auto_title); absent from older journals. */
    auto_title?: string | null;
    state: string;
    box: string | null;
}

/** A project (journal `GET /projects`): groups missions; carries rollups of its missions. */
export interface Project {
    id: string;
    num: number;
    state: "open" | "closed";
    title: string;
    body: string;
    status: string | null;
    status_by: TrackerActor | null;
    status_updated_at: number | null;
    created_at: number;
    updated_at: number;
    close_summary?: string | null;
    merged_into_num?: number | null;
    missions: { running: number; waiting: number; idle: number; quiet: number; closed: number };
    needs_you: number;
    open_items: number;
    last_activity_at: number;
}

/** The project roll-up's kinds (`GET /projects/:id/feed?kind=`). */
export type ProjectFeedKind = "decisions" | "files" | "milestones";

/** One page of a roll-up kind: `total` across every page, `next_before` the cursor for the next
 *  (older) page, null on the last. */
export interface ProjectFeedPage<Row> {
    total: number;
    rows: Row[];
    next_before: string | null;
}

/** A decision item (open = in force; closed = decided, done or reversed), or a question closed as
 *  answered, on one of the project's missions. */
export interface ProjectDecisionRow {
    id: string;
    num: number;
    kind: "decision" | "question";
    state: TrackerItemState;
    resolution: TrackerResolution | null;
    title: string;
    supersedes?: string | null;
    created_at: number;
    closed_at: number | null;
    mission_id?: string | null;
    mission_num?: number | null;
    /** A question's answer: the user's newest comment, else a voice note's transcript. */
    answer?: string | null;
}

/** A file or image on the project's items or in its missions' chats. */
export interface ProjectFileRow {
    blob_id: string;
    name?: string | null;
    content_type?: string | null;
    size?: number | null;
    caption?: string | null;
    mission_num?: number | null;
    source: { item_num: number } | { convo_id: string; seq: number };
    posted_at?: number | null;
}

/** `GET /projects/:id`. The three roll-up pages come from a journal with Projects view v2; an
 *  older one sends none of them. */
export interface ProjectDetail {
    project: Project;
    missions: Mission[];
    needs_you: Array<MissionItemRef & { mission_id: string; mission_num: number }>;
    recent_milestones: Array<Milestone & { mission_num: number }>;
    sessions_by_box: Record<string, number>;
    decisions?: ProjectFeedPage<ProjectDecisionRow>;
    files?: ProjectFeedPage<ProjectFileRow>;
    milestones?: ProjectFeedPage<Milestone & { mission_num: number | null }>;
    /** Set when the asked-for project was merged: this detail is the project it went into. */
    merged_from?: { id: string; num: number };
}

/** One mission a conversation has touched (`GET /conversations/:id/missions`): the mission row
 *  with the link's own fields beside it. */
export interface ConversationMissionLink extends Mission {
    /** Where the conversation's milestones go by default. At most one link is current. */
    current: boolean;
    /** False once the conversation left the mission. */
    active: boolean;
    how?: string | null;
    joined_at?: number | null;
    ended_at?: number | null;
}

/** The selected conversation's missions, as last fetched for it. */
export interface ConversationMissions {
    convoId: string;
    links: ConversationMissionLink[];
}

export interface MissionDetail {
    mission: Mission;
    milestones: Milestone[];
    items: MissionItemRef[];
    conversations: MissionConversation[];
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

/**
 * childrenOf for every parent at once: parent id → its children, in childrenOf's order. One pass
 * over the list, for renders that ask for many parents' children (the sidebar asks per row).
 */
export function groupChildrenByParent(conversations: Conversation[]): Map<string, Conversation[]> {
    const byParent = new Map<string, Conversation[]>();
    for (const conversation of conversations) {
        const parentId = conversation.parent_convo_id;
        if (!parentId) continue;
        const siblings = byParent.get(parentId);
        if (siblings) siblings.push(conversation);
        else byParent.set(parentId, [conversation]);
    }
    for (const siblings of byParent.values()) {
        siblings.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return byParent;
}

/**
 * Every parent's children in one pass, each list ordered as `childrenOf` orders it. The sidebar
 * looks up a row's children once per row; scanning the whole list each time made a render
 * quadratic in the number of conversations.
 */
export function childrenByParent(conversations: Conversation[]): Map<string, Conversation[]> {
    const index = new Map<string, Conversation[]>();
    for (const conversation of conversations) {
        const parentId = conversation.parent_convo_id;
        if (!parentId) continue;
        const list = index.get(parentId);
        if (list) list.push(conversation);
        else index.set(parentId, [conversation]);
    }
    for (const list of index.values()) {
        list.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return index;
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
 * precomputed lookups shared by every sidebar-visibility consumer so the SAME
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
     * parent ids that host at least one subagent child row — a running child whose
     * direct parent is a real, non-archived top-level row (i.e. the child renders nested, or
     * WOULD render nested if the parent were not collapsed). Independent of the collapsed set,
     * so the sidebar row menu can gate its "Collapse/Show subagents" item on the child rows
     * EXISTING, even while they are hidden by an active collapse.
     */
    parentsWithChildRows: Set<string>;
}

/**
 * resolve EVERY conversation's Active/Favorites placement once, through
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
 *    parent is a valid host but collapsed, the child is "hidden" (suppressed from the
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

        // An ARCHIVED child is rendered in the Archived tab, never as a nested Active row, so it
        // must NOT register its parent as a host — otherwise the parent offers a dead "Collapse
        // subagents" control that hides nothing (the render splice + the collapsed count already
        // skip archived children with `!archivedIds.has(child.id)`). Fall through to top-level;
        // archivedIds filters it out of Active regardless of placement.
        if (parentIsTopLevelRow && parent != null && !archivedIds.has(conversation.id)) {
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
 * the SINGLE source of truth for where a subagent conversation lands in the Active/
 * Favorites sidebar — a pure lookup of the placement resolved once in buildSidebarIndex, so
 * all call sites (rendering, selection, unread, badge, mark-all) stay in lock-step. Defaults
 * to "top-level" for an id absent from the index (orphan-style recovery).
 */
export function childSidebarPlacement(conversation: Conversation, index: SidebarIndex): ChildSidebarPlacement {
    return index.placement.get(conversation.id) ?? "top-level";
}

/**
 * the ONE canonical "does this conversation render as a TOP-LEVEL sidebar row?"
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
 * does this conversation currently host any subagent child rows? True when at least one
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

/**
 * The display name of a `file` / `image` event. `name` is the key the media-send contract defines
 * and what the bridge and the native apps emit; `filename` is the older spelling, still read so
 * events written before the switch keep their names.
 */
export function mediaFileName(payload: EventPayload): string {
    return asString(payload.name) || asString(payload.filename);
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

// Single authoritative source for the image-frame height cap. Emitted at runtime as the
// `--mj-image-frame-max-height` CSS custom property on the `.mj_Image` figure (see AuthenticatedMedia),
// which BOTH `.mj_ImageFrame_sized` and `.mj_Image img` consume via `var(...)` in journal.pcss — so
// the JS cap and the CSS caps cannot drift. A non-replaced <div> sized by CSS `aspect-ratio` does not
// back-shrink its width when the computed height hits `max-height` (that ratio-preserving
// back-propagation only happens for replaced elements like a bare <img>), so the cap is also baked
// into the seeded width in JS — see imageFrameStyle.
export const IMAGE_FRAME_MAX_HEIGHT_PX = 520;

// Inline style that reserves an image's box before the blob decodes, so the thread doesn't reflow
// on load. `aspectRatio` holds the shape; `width` seeds the intrinsic size (further capped by the
// CSS max-width for the column). The width is pre-shrunk so that when the ratio-derived height
// would exceed IMAGE_FRAME_MAX_HEIGHT_PX the box shrinks in BOTH dimensions — replicating replaced-
// element sizing. Without this, portrait/square images get an over-wide frame and the inner
// object-fit:contain <img> letterboxes with dead margins.
export function imageFrameStyle(dims: MediaDims): { aspectRatio: string; width: number } {
    return {
        aspectRatio: `${dims.width} / ${dims.height}`,
        width: Math.min(dims.width, dims.width * (IMAGE_FRAME_MAX_HEIGHT_PX / dims.height)),
    };
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

export type SpawnOutcomeKind = "started" | "declined" | "expired" | "failed" | "unknown";

/** Classifies a journaled `spawn_outcome` payload; unrecognised values collapse to "unknown"
    so a future outcome (or bridge bug) never crashes the timeline (see spawnOutcomeSnippet). */
export function spawnOutcomeKind(payload: EventPayload): SpawnOutcomeKind {
    const outcome = asString(payload.outcome);
    if (outcome === "started" || outcome === "declined" || outcome === "expired" || outcome === "failed") {
        return outcome;
    }
    return "unknown";
}

/** One agent-spawn ask as a conversation's events tell it: its card and its outcome, if any. */
export interface SpawnConsentRows {
    /** The `permission_request` (kind `agent_spawn`) that asked; null when it is not here. */
    request: JournalEvent | null;
    /** The ask's `spawn_outcome` payload; null while it has none. */
    outcome: EventPayload | null;
    /** The Coordinator's answer to the card, when it gave one (spawnConsentRowsIn). */
    coordinatorDecision?: CoordinatorDecision;
}

/**
 * Finds one agent-spawn ask in a conversation's events by its request id: the first card that
 * names it, and the last outcome for it should there ever be two (the timeline's own rule).
 */
export function findSpawnConsentRows(events: readonly JournalEvent[], requestId: string): SpawnConsentRows {
    let request: JournalEvent | null = null;
    let outcome: EventPayload | null = null;
    for (const event of events) {
        if (event.payload.request_id !== requestId) continue;
        if (event.type === "permission_request" && event.payload.kind === "agent_spawn") request ??= event;
        else if (event.type === "spawn_outcome") outcome = event.payload;
    }
    return { request, outcome };
}

export function spawnOutcomeSnippet(payload: EventPayload): string {
    switch (spawnOutcomeKind(payload)) {
        case "started":
            return "🚀 Spawned session started";
        case "declined":
            return "🚫 Spawn declined";
        case "expired":
            return "⌛ Spawn request expired";
        case "failed": {
            const errorCode = asString(payload.error_code);
            return errorCode ? `❌ Spawn failed — ${errorCode}` : "❌ Spawn failed";
        }
        default:
            return "Spawn request resolved";
    }
}

export function eventSnippet(type: string, payload: EventPayload): string {
    if (type === "text") return asString(payload.body).slice(0, 120);
    if (type === "peer_message") return sanitizePeerText(payload.body, 120);
    if (type === "file") return `📎 ${asString(payload.caption) || mediaFileName(payload) || "File"}`.slice(0, 120);
    if (type === "image") return `🖼 ${asString(payload.caption) || mediaFileName(payload) || "Image"}`.slice(0, 120);
    if (type === "prompt") return `? ${asString(payload.question).slice(0, 110)}`;
    if (type === "permission_request") {
        // agent_spawn payloads carry no `description` (that's a generic-permission field) — the
        // sidebar row would otherwise read the empty "Permission: " (Task 1 review finding).
        // Fixed copy, not derived from topic/task: the server mints this same literal string
        // into the snapshot snippet, and the two must be byte-exact or the sidebar row
        // flip-flops across a resume (same ruling just applied to the Android client).
        if (asString(payload.kind) === "agent_spawn") return "🤝 Agent spawn request";
        if (asString(payload.kind) === "agent_chat") return "🤝 Agent chat request";
        return `Permission: ${asString(payload.description).slice(0, 100)}`;
    }
    if (type === "spawn_outcome") {
        // Byte-exact with the server's own snapshot snippet strings — bare, no error-code
        // suffix, and a terse bracketed fallback for an unrecognised outcome. Deliberately NOT
        // spawnOutcomeSnippet: that richer copy (error code suffix, "Spawn request resolved")
        // is for the timeline row only, where local judgement calls don't need to match the
        // server's minted string.
        switch (spawnOutcomeKind(payload)) {
            case "started":
                return "🚀 Spawned session started";
            case "declined":
                return "🚫 Spawn declined";
            case "expired":
                return "⌛ Spawn request expired";
            case "failed":
                return "❌ Spawn failed";
            default:
                return "[spawn_outcome]";
        }
    }
    if (type === "item") {
        // Tracker item marker (payload: {num,kind,title,action,awaiting?,...}). Titles can be
        // absent across a privacy boundary — fall back to `#num`. `📌` mirrors the server's own
        // minted marker text so the sidebar preview reads consistently with the timeline card.
        const num = asNumber(payload.num);
        const kind = asString(payload.kind, "item");
        const title = asString(payload.title).trim();
        const needsUser = asString(payload.awaiting) === "user";
        const head = num ? `${kind} #${num}` : kind;
        const label = needsUser ? `📌 Needs you — ${head}` : `📌 ${head}`;
        return (title ? `${label}: ${title}` : label).slice(0, 120);
    }
    if (type === "milestone") {
        // Milestone marker (payload: {num,kind,title,...}). user_input milestones are the urgent
        // "needs you" kind; still preview title-first, falling back to `#num`.
        const num = asNumber(payload.num);
        const title = asString(payload.title).trim();
        const label = num ? `🏁 Milestone #${num}` : "🏁 Milestone";
        return (title ? `${label}: ${title}` : label).slice(0, 120);
    }
    if (type === "mission") {
        // Mission marker (payload: {num,title,action}). Mirrors MissionNotice's timeline copy at a
        // sidebar-preview length; title falls back to `#num`.
        const num = asNumber(payload.num);
        const title = asString(payload.title).trim();
        const label = num ? `🏁 Mission #${num}` : "🏁 Mission";
        return (title ? `${label}: ${title}` : label).slice(0, 120);
    }
    if (type === "memory") {
        // Memory marker (payload: {memory_id, action, created, by, name?, description?}); the name
        // is absent across a privacy boundary. Mirrors MemoryNotice's timeline copy.
        const name = asString(payload.name).trim();
        const action = asString(payload.action);
        const verb = action === "deleted" ? "deleted" : payload.created === true ? "saved" : "updated";
        return (name ? `🧠 Memory ${verb}: ${name}` : `🧠 Memory ${verb}`).slice(0, 120);
    }
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
