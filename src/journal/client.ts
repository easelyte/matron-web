/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { parseSessionOptions, type SessionOptions } from "./new-session";
import {
    JOURNAL_ATTACHMENTS_MAX,
    JournalApi,
    JournalApiError,
    isMediaExpiredError,
    knownErrorMessage,
    loadMatronConfig,
    parseBoxDefaultsState,
    parseBoxStatus,
    parseUserDefaults,
} from "./api";
import { JournalConnection } from "./connection";
import { FilesApi } from "./files/filesApi";
import { effectiveUnread, makeIdSetStore, type IdSetStore } from "./conversation-flags";
import { parseCoordinatorConsent, resetSessionStops, spawnConsentRowsIn } from "./coordinator-consent";
import { JournalDatabase } from "./database";
import { buildEditFileParams, classifyEditFileReply, type EditFileInput, type EditFileOutcome } from "./edit-file";
import { buildReadFileParams, classifyReadFileReply, type ReadFileInput, type ReadFileOutcome } from "./read-file";
import { helperContextStatus, mergeSessionStatus } from "./status";
import { sectionStateFromReply, type JournalMetrics, type OpsSection, type OpsSectionState } from "./ops/model";
import {
    parseRoutine,
    parseRoutineList,
    type Routine,
    type RoutineDraft,
    routineErrorMessage,
    routineFormError,
    routineRequestBody,
    routineRunMessage,
    RoutineRules,
    ROUTINES_UNSUPPORTED,
    sortRoutines,
} from "./routines";
import { newestOwnMessageSeq } from "./jump-to-message";
import { parseOwnTrackerUrl, parseTrackerLinkPath, type TrackerLinkPath } from "./link-path";
import {
    DEFAULT_PIN_LIMIT,
    markPinImportDone,
    movedPinOrder,
    parsePinList,
    parsePinsResponse,
    pinErrorMessage,
    pinImportDone,
    pinsFromContainer,
    planPinImport,
    readCachedPins,
    writeCachedPins,
} from "./pins";
import { isAgentRoomTitle, isStartCommand, NEW_CONVERSATION_STALE_MS, startedSessionIntents } from "./needs-you";
import { SeenTracker } from "./seen-tracker";
import { appendFeedPage, kindsWithMore } from "./tracker/projectActivity";
import { CHAT_TASKS_DONE_FETCH, chatTaskSections, planTaskMove } from "./tracker/chat-tasks";
import { doneSortKey, inDone } from "./tracker/format";
import {
    asNumber,
    buildSidebarIndex,
    type BoxStatus,
    type JournalBoxStatusFrame,
    type BriefingLatest,
    type BriefingRefresh,
    type BriefingState,
    type AttachmentBatchTag,
    type ClientState,
    type ComposerAttachment,
    type Conversation,
    type ConversationMissionLink,
    type BoxDefaults,
    type BoxDefaultsPatch,
    type BoxDefaultsState,
    type DefaultsState,
    type ConvoPin,
    type DeviceDTO,
    type HostVitals,
    type LinkStart,
    type LinkStatus,
    type PairPreview,
    isSubChat,
    type MatronLinkKind,
    type Mission,
    type NumberLookup,
    type NumberLookupKind,
    type NumberLookupOutcome,
    type JournalEphemeralFrame,
    type JournalEvent,
    MESSAGE_EVENT_TYPES,
    normalizeServerUrl,
    type NewSessionOffer,
    type PendingMessage,
    type Project,
    type RecentFolder,
    rendersAsTopLevelRow,
    type RpcReply,
    type SearchHit,
    type ServerFrame,
    type Session,
    type SessionStatus,
    type SnapshotResponse,
    type SpawnConsentRows,
    type StartOption,
    type StartSessionPicks,
    type TrackerAttachment,
    type JournalControlFrame,
    type RoutinesState,
    type TrackerCommentWrite,
    type TrackerItem,
    type TrackerItemCreate,
    type UserSettings,
    type MemoryWrite,
    type TrackerResolution,
    type TrackerViewState,
    trimUtf8Prefix,
    type UserDefaultKey,
    type UserDefaults,
    type ToolStreamState,
    utf8Length,
} from "./types";
import type { WorkViewEnvelope, WorkViewGroupBy } from "./work-view";

const SESSION_KEY = "matron_journal_session_v1";
const LAST_SERVER_KEY = "matron_journal_last_server";
const SELECTED_CONVERSATION_KEY_PREFIX = "matron_journal_selected_conversation_v1";
const HISTORY_PAGE_SIZE = 80;
// A subagent card's one-off tail fetch: the server's page cap, and how long a card waits for it.
const CONVERSATION_TAIL_SIZE = 200;
const CONVERSATION_TAIL_TIMEOUT_MS = 15_000;
// A jump to a message pages history back at most this many pages (80 rows each) before landing on
// the oldest row loaded: a hit thousands of messages deep must not fetch the whole conversation
// while the transcript sits still.
const FOCUS_MAX_PAGES = 20;
// While another history page is in flight a jump waits for it, polling this often, this many times.
const FOCUS_WAIT_MS = 50;
const FOCUS_MAX_WAITS = 300;
// Find in chat steps through a conversation's whole match list, so it asks for more than the
// sidebar's search; the journal caps a single-conversation search at this.
const CHAT_SEARCH_LIMIT = 500;
// Message-content search hits per query (server caps at 50; 20 keeps the Messages section tight).
const MESSAGE_SEARCH_LIMIT = 20;
// Max query length the server accepts (over this it returns 400); guard client-side so an
// over-long query reads as "no results", not a misleading "search unavailable" outage.
const MESSAGE_SEARCH_MAX_QUERY_LEN = 256;
// Transport-agnostic deadline: abort a /search that never settles so "Searching…" can't hang.
const MESSAGE_SEARCH_TIMEOUT_MS = 15_000;
/** How long "go to number" waits for the journal before reporting a failed lookup. */
export const NUMBER_LOOKUP_TIMEOUT_MS = 15_000;
/** A mission page's closed items come in pages of this many (the Mac's closed-items page). */
export const MISSION_CLOSED_PAGE = 50;
/** How many `GET /items` pages of closed items one `fetchMissionClosedItems` call walks at most. */
const MISSION_CLOSED_SCAN_PAGES = 4;

const NUMBER_LOOKUP_KINDS: readonly NumberLookupKind[] = ["item", "mission", "milestone", "project"];
const isTrackerNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A `/lookup` answer reduced to the fields this app understands; null when it names no known kind. */
function sanitizeNumberLookup(raw: unknown): NumberLookup | null {
    if (!raw || typeof raw !== "object") return null;
    const { kind, id, num, title, mission } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !NUMBER_LOOKUP_KINDS.includes(kind as NumberLookupKind)) return null;
    const hit: NumberLookup = { kind: kind as NumberLookupKind, id };
    if (isTrackerNumber(num)) hit.num = num;
    if (typeof title === "string" && title) hit.title = title;
    if (mission && typeof mission === "object") {
        const parent = mission as Record<string, unknown>;
        if (typeof parent.id === "string" && isTrackerNumber(parent.num)) {
            hit.mission = { id: parent.id, num: parent.num };
        }
    }
    return hit;
}

/**
 * Runtime guard for the GET /search response. The producer is a separate service, so we parse at
 * the boundary (P33) rather than trusting the compile-time cast: a non-array `hits` or a hit missing
 * a required field is dropped instead of crashing the render (e.g. `snippet.split` on undefined).
 */
function sanitizeSearchHits(response: { hits?: unknown } | null | undefined): SearchHit[] {
    const raw = response?.hits;
    if (!Array.isArray(raw)) return [];
    const hits: SearchHit[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const h = item as Record<string, unknown>;
        if (
            typeof h.convo_id !== "string" ||
            typeof h.title !== "string" ||
            typeof h.seq !== "number" ||
            typeof h.ts !== "number" ||
            typeof h.sender !== "string" ||
            typeof h.snippet !== "string"
        ) {
            continue;
        }
        hits.push({
            convo_id: h.convo_id,
            title: h.title,
            seq: h.seq,
            ts: h.ts,
            sender: h.sender,
            snippet: h.snippet,
            live: h.live === true,
        });
    }
    return hits;
}
// The bridge publishes the new convo's first frame (convo_upsert -> convo_meta) at create time,
// before the CLI emits anything, so a healthy create clears this within milliseconds. It only
// fires when that frame sits in the bridge publisher's queue across a reconnect, whose backoff
// caps at 30s (journal-publisher DEFAULT_BACKOFF_CAP_MS). 10s flagged ordinary blips under load.
export const RPC_CREATE_WATCHDOG_MS = 30_000;
// Shown (as a dismissible status) when the watchdog fires; cleared again by the first frame for
// the created convo, so it never outlives the delay it describes.
export const RPC_CREATE_STALLED_NOTICE =
    "New session is still starting — it will appear once it syncs. Refresh if it doesn't.";
// reconnect-loop guard. A malformed-seq LIVE frame triggers a full resync; a single one
// recovers cleanly (a fresh snapshot never contains it), so the healthy case never approaches
// this bound. But a server that repeatedly pushes malformed frames would re-poison each clean
// cursor immediately, so more than LIMIT resyncs inside WINDOW halts auto-resync and surfaces an
// error instead of looping. The counter resets on the next well-formed frame (server recovered).
const MALFORMED_SEQ_RESYNC_LIMIT = 3;
const MALFORMED_SEQ_RESYNC_WINDOW_MS = 30_000;
export const MALFORMED_SEQ_HALTED_ERROR = "Sync paused — the server is sending malformed updates. Reload to try again.";
/**
 * The matching seqs of a find-in-chat response, newest first and without repeats. Only `seq` (and
 * `convo_id`, to drop anything outside the conversation) is read, so both the journal's
 * newest-first hits and an older journal's ranked ones parse.
 */
export function conversationMatchSeqs(
    response: { hits?: unknown } | null | undefined,
    conversationId: string,
): number[] {
    const raw = response?.hits;
    if (!Array.isArray(raw)) return [];
    const seqs = new Set<number>();
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const hit = item as Record<string, unknown>;
        if (hit.convo_id !== undefined && hit.convo_id !== conversationId) continue;
        if (typeof hit.seq === "number" && Number.isSafeInteger(hit.seq) && hit.seq >= 0) seqs.add(hit.seq);
    }
    return [...seqs].sort((a, b) => b - a);
}

// How long a marker-driven refetch waits, so a burst of markers costs one GET.
const MARKER_REFETCH_DELAY_MS = 250;
const BACKFILL_SNAPSHOT_TIMEOUT_MS = 10_000;
// How long after start-up the one-off room-membership backfill reads its snapshot, so it never
// competes with the first paint and the first history read.
const MEMBERSHIP_BACKFILL_DELAY_MS = 5_000;
const TOOL_STREAM_DISPLAY_BYTES = 65_536;
const MARK_ALL_READ_ERROR = "Some conversations couldn't be updated — device storage is full or unavailable.";
export const PREFERENCES_UNAVAILABLE_ERROR = "Couldn't load saved preferences — device storage unavailable.";
// This is only a browser memory-safety ceiling. The server's 413 response is
// authoritative for deployment-specific upload policy.
export const BROWSER_MEMORY_SAFETY_MAX_BYTES = 512 * 1024 * 1024;
// Upload deadline is size-aware, not a fixed wall-clock. A fixed 60s covered
// file read + the whole POST, so a server-accepted file whose transfer alone
// exceeds 60s (e.g. 50MB on a ~5 Mbit/s uplink ≈ 84s) would deterministically
// abort as upload_failed and retry could never succeed. Scale the deadline by
// size against a conservative uplink floor, keeping a base for small files and
// a hard cap so a truly-stuck upload is still bounded.
const UPLOAD_TIMEOUT_BASE_MS = 60_000;
const UPLOAD_MIN_BYTES_PER_MS = 64; // ≈ 0.5 Mbit/s uplink floor
const UPLOAD_TIMEOUT_MAX_MS = 15 * 60_000; // 15 min cap
export function uploadTimeoutMsFor(sizeBytes: number): number {
    const sized = Math.ceil((Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0) / UPLOAD_MIN_BYTES_PER_MS);
    return Math.min(UPLOAD_TIMEOUT_MAX_MS, Math.max(UPLOAD_TIMEOUT_BASE_MS, sized));
}

// Client-local per-session flag stores. Archive key string is UNCHANGED (zero migration).
export const archiveStore: IdSetStore = makeIdSetStore(
    "matron_journal_archived_conversations_v1",
    "archived-conversations",
);
export const pinnedStore: IdSetStore = makeIdSetStore("matron_journal_pinned_conversations_v1", "pinned-conversations");
export const favoriteStore: IdSetStore = makeIdSetStore(
    "matron_journal_favorite_conversations_v1",
    "favorite-conversations",
);
export const unreadStore: IdSetStore = makeIdSetStore("matron_journal_unread_conversations_v1", "unread-conversations");

interface ConversationHistoryState {
    initialized: boolean;
    oldestSeq?: number;
    newestSeq?: number;
    hasMore: boolean;
    hasMoreNewer: boolean;
}

interface ElectronBadgeBridge {
    send(channel: "setBadgeCount", count: number): void;
}

interface AttachmentOwner {
    gen: number;
    api: JournalApi;
    db: JournalDatabase;
}

type PersistPendingAttachmentOutcome =
    { kind: "persisted-uploadable" } | { kind: "persisted-terminal" } | { kind: "persist-failed" };

/** What one ask of a possibly sleeping box found: it answered, it is still booting, or the ask
 *  never reached the journal. */
/** Which feature started a jump to a message (see focusMessage). */
export type FocusOwner = "link" | "search" | "lastOwnMessage";
export type AgentProbe = "up" | "booting" | "failed";

export type StartOutcome =
    | { kind: "created"; convoId: string }
    /** `code` is the agent's error code when it gave one (e.g. `bad_workdir`); `reach` = the box
        couldn't be reached at all. */
    | { kind: "error"; message: string; code?: string; reach?: boolean }
    | { kind: "uncertain" };

export type WorkerKind = "claude" | "codex";

/** How one item comment went: written, or not — with why, unless the session ended meanwhile
 *  (signed out, or another account signed in), when there is nothing left to report it to. */
export type TrackerCommentOutcome = { ok: true } | { ok: false; reason?: string };

function parseRecentFolders(raw: unknown): RecentFolder[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): RecentFolder[] => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const folder = entry as Record<string, unknown>;
        if (
            typeof folder.path !== "string" ||
            folder.path.length === 0 ||
            (folder.last_used !== null && (typeof folder.last_used !== "number" || !Number.isFinite(folder.last_used)))
        ) {
            return [];
        }
        return [{ path: folder.path, last_used: folder.last_used }];
    });
}

// Bridge order is kept. A repeated value is dropped: the value is the option's identity.
function parseStartOptions(raw: unknown): StartOption[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.flatMap((entry): StartOption[] => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const { value, label } = entry as Record<string, unknown>;
        if (typeof value !== "string" || value.length === 0 || seen.has(value)) return [];
        seen.add(value);
        return [{ value, label: typeof label === "string" && label.length > 0 ? label : value }];
    });
}

function parseOfferDefault(raw: unknown): string | null {
    return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function workerKind(conversation: Conversation): WorkerKind | null {
    // Sub-chats resolve their kind from the convo-id infix: children go through
    // a separate mint path and carry no agent_kind field.
    if (isSubChat(conversation)) {
        if (/:codex:[^:]+$/.test(conversation.id)) return "codex";
        if (/:sub:[^:]+$/.test(conversation.id)) return "claude";
        return null;
    }
    // Top-level rows use the server-recorded agent_kind — their ids
    // are bare UUIDs with no infix. An absent/unknown value renders no marker.
    if (conversation.agent_kind === "codex") return "codex";
    if (conversation.agent_kind === "claude") return "claude";
    return null;
}

function deviceName(): string {
    if ((window as Window & { electron?: unknown }).electron) {
        const platform = navigator.platform || "computer";
        return `Matron Desktop (${platform})`;
    }
    return `Matron Web (${navigator.platform || "browser"})`;
}

function blankState(): ClientState {
    return {
        phase: "loading",
        config: {},
        conversations: [],
        archivedIds: new Set(),
        pinnedIds: new Set(),
        journalPins: null,
        pinLimit: DEFAULT_PIN_LIMIT,
        favoriteIds: new Set(),
        unreadOverrideIds: new Set(),
        collapsedSubagentParentIds: new Set(),
        newConversationIds: new Set(),
        controlError: undefined,
        events: [],
        pendingMessages: [],
        connection: "offline",
        connectionErrorSeq: 0,
        loadingHistory: false,
        hasOlderHistory: false,
        pendingScrollSeq: undefined,
        viewingHistoryWindow: false,
        textStreams: {},
        toolStreams: {},
        boxStatuses: {},
        agents: [],
        dragActive: false,
        composerAttachments: {},
        sendTick: 0,
    };
}

function storedSession(): Session | undefined {
    try {
        const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Partial<Session> | null;
        if (
            !parsed ||
            typeof parsed.serverUrl !== "string" ||
            typeof parsed.token !== "string" ||
            typeof parsed.deviceId !== "number" ||
            typeof parsed.userId !== "number" ||
            typeof parsed.username !== "string"
        ) {
            return undefined;
        }
        return parsed as Session;
    } catch {
        return undefined;
    }
}

function selectedConversationStorageKey(session: Session): string {
    return `${SELECTED_CONVERSATION_KEY_PREFIX}:${encodeURIComponent(session.serverUrl)}:${session.userId}`;
}

function storedSelectedConversation(session: Session): string | undefined {
    try {
        return localStorage.getItem(selectedConversationStorageKey(session)) ?? undefined;
    } catch {
        return undefined;
    }
}

export function archivedStorageKey(session: Session): string {
    return archiveStore.storageKey(session);
}

export function storedArchivedIds(session: Session): Set<string> {
    return archiveStore.read(session).ids;
}

export function storeArchivedIds(session: Session, ids: Set<string>): void {
    archiveStore.write(session, ids);
}

function firstSelectableConversation(
    conversations: Conversation[],
    preferredId: string | undefined,
    archivedIds: Set<string>,
    collapsedParentIds: ReadonlySet<string>,
): Conversation | undefined {
    // auto-selection uses the SAME canonical predicate as rendering — a child that
    // is not a top-level sidebar row (hidden done child, or a nested child) must never be
    // silently auto-selected on reload; skip to the next selectable top-level row.
    // same collapsed set as render/mark-all/badge, so a collapsed (hidden) child is
    // never auto-selected either.
    const index = buildSidebarIndex(conversations, archivedIds, collapsedParentIds);
    const selectable = (conversation: Conversation): boolean =>
        !archivedIds.has(conversation.id) && rendersAsTopLevelRow(conversation, index);
    const preferred = conversations.find((conversation) => conversation.id === preferredId && selectable(conversation));
    return preferred ?? conversations.find(selectable);
}

function storeSelectedConversation(session: Session, conversationId: string | undefined): void {
    try {
        const key = selectedConversationStorageKey(session);
        if (conversationId) localStorage.setItem(key, conversationId);
        else localStorage.removeItem(key);
    } catch {
        // Selection persistence is optional when storage is unavailable.
    }
}

function capToolStream(value: string): { content: string; truncated: boolean } {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length <= TOOL_STREAM_DISPLAY_BYTES) return { content: value, truncated: false };
    let slice = bytes.slice(bytes.length - TOOL_STREAM_DISPLAY_BYTES);
    while (slice.length > 0 && (slice[0] & 0xc0) === 0x80) slice = slice.slice(1);
    return { content: new TextDecoder().decode(slice), truncated: true };
}

/** A tray file's failed upload, in the words its chip shows. */
function stagedUploadError(error: unknown): string {
    const aborted =
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof JournalApiError && error.status === 0 && /abort/i.test(error.message));
    if (aborted) return "The upload was interrupted.";
    if (error instanceof Error && error.message) return error.message;
    return "Upload failed.";
}

function abortPromise(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        const rejectAbort = (): void => reject(new DOMException("The upload timed out.", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
    });
}

/** A recorded voice note as a file: `voice-note.<ext>`, the extension following the recorder's mime. */
export function voiceNoteFile(blob: Blob): File {
    const type = blob.type || "audio/webm";
    const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    return new File([blob], `voice-note.${ext}`, { type });
}

/** See MatronJournalClient.addLiveListener. */
export interface LiveListener {
    frame?(frame: ServerFrame): void;
    journalEvent?(event: JournalEvent, previous: Conversation | undefined): void;
}

/**
 * The freshly read conversation list, keeping the previous object for every conversation whose
 * fields are all unchanged (and the previous array when nothing changed at all), so the sidebar's
 * memoised rows only re-render for the conversations that did change.
 */
export function keepUnchangedConversations(previous: Conversation[], next: Conversation[]): Conversation[] {
    const byId = new Map(previous.map((conversation) => [conversation.id, conversation]));
    let same = previous.length === next.length;
    const kept = next.map((conversation, index) => {
        const old = byId.get(conversation.id);
        const keep = old !== undefined && sameFields(old, conversation) ? old : conversation;
        if (keep !== previous[index]) same = false;
        return keep;
    });
    return same ? previous : kept;
}

function sameFields(left: Conversation, right: Conversation): boolean {
    const keys = Object.keys(left) as (keyof Conversation)[];
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.is(left[key], right[key]));
}

export class MatronJournalClient {
    private state = blankState();
    // The `/u/<name>/<n>` link the page was opened at, until the first sign-in opens it.
    private pathLink: TrackerLinkPath | null = parseTrackerLinkPath(window.location.pathname);
    private readonly listeners = new Set<() => void>();
    private readonly liveListeners = new Set<LiveListener>();
    private api?: JournalApi;
    // Monotonic guard so only the latest message-search request writes its results — an earlier
    // slow response (or a cleared box) can never clobber a newer query's hits. See searchMessages.
    private searchSeq = 0;
    // The in-flight message-search request, so a superseding query / clear / logout can abort it
    // (bounded exit — a stalled /search never leaves the section stuck "Searching…").
    private searchAbort?: AbortController;
    private database?: JournalDatabase;
    private connection?: JournalConnection;
    // Read state: which timeline rows and tracker items were actually on screen, reported as
    // `seen` / `item_seen` over the socket. Separate from read_marker and the unread badge.
    public readonly seen = new SeenTracker({ send: (op) => this.connection?.send(op) ?? false });
    private readonly history = new Map<string, ConversationHistoryState>();
    // refreshConversationTail(): one request per conversation per session (settled or in flight).
    private readonly conversationTailFetches = new Map<string, Promise<boolean>>();
    // The latest-history-page fetch a spawn consent item made per conversation, keyed
    // `${sessionGen}:${convoId}`: in flight (later reads wait on it) or done (a card that is not in
    // that page is not asked for again). A failed fetch is forgotten so the next read retries.
    private readonly consentHistoryFetches = new Map<string, Promise<void>>();
    private readonly activities = new Map<string, JournalEphemeralFrame["activity"]>();
    private readonly statuses = new Map<string, NonNullable<JournalEphemeralFrame["status"]>>();
    // Host-global vitals: ONE value for the whole app, keyed to no conversation. Set from
    // the host-scoped ephemeral push (~5s) and threaded into every UsageCluster via
    // ClientState.hostVitals to OVERRIDE the host_cpu / host_ram meters buildUsageMeters
    // synthesizes from the turn-end `status.vitals`. Null until the first push (or on a server
    // that never sends it) → the status.vitals figures stand.
    private hostVitals: HostVitals | null = null;
    private readonly textStreams = new Map<string, Record<string, string>>();
    private readonly toolStreams = new Map<string, Record<string, ToolStreamState>>();
    private readonly retiredStreamRefs = new Set<string>();
    private readonly mediaUrls = new Map<string, string>();
    private readonly mediaUrlRequests = new Map<string, Promise<string>>();
    // Files pane (Phase 1b): one FilesApi bound to the current session, built lazily on first use
    // and torn down (blob URLs revoked) on sign-out. Mirrors the mediaUrls ownership model.
    private filesApiInstance?: FilesApi;
    // Blob ids the server answered 404 for: reaped, permanently. Never re-requested.
    private readonly expiredMedia = new Set<string>();
    private readonly readHighWater = new Map<string, number>();
    private readonly readTimers = new Map<string, number>();
    private pendingFiles = new Map<string, File>();
    private transientAttachmentErrors = new Map<string, PendingMessage>();
    private readonly dismissedAttachments = new Set<string>();
    private readonly attachmentOperations = new Map<string, Promise<void>>();
    private readonly retryingAttachments = new Set<string>();
    private inFlightUploads = new Map<string, AbortController>();
    private readonly uploadConvos = new Map<string, string>();
    private readonly issuedRefreshEpochs = new Map<string, number>();
    private readonly appliedRefreshEpochs = new Map<string, number>();
    // Every explicit conversation selection supersedes all earlier selection work, including a
    // deep link to another sequence in the same conversation (where an id-only guard is insufficient).
    private selectionEpoch = 0;
    // Monotonic guards so only the latest tracker detail request writes its result — an earlier slow
    // response (out-of-order load, or a superseded selection) can never clobber a newer one. Mirrors
    // searchSeq. Bumped on every loadItem/loadMission call; the resolved response checks it before
    // patching (F1 stale-response guard).
    private trackerItemGen = 0;
    private trackerMissionGen = 0;
    private trackerInboxGen = 0;
    private trackerInboxDoneGen = 0;
    // True while a loadInbox walk is in flight. The first connect-time walk publishes only at the
    // end, so until then inboxItems is undefined; writes and item markers that land meanwhile must
    // still count (see inboxTracked / applyWrittenItem) or the walk's older pages overwrite them.
    private inboxWalking = false;
    // Items written (e.g. a Seen tap) while a walk is in flight, by id, newest updated_at kept.
    // Merged over the walk's result when it publishes, so a page fetched before the write cannot
    // put a closed notice back in For you.
    private inboxPendingWrites = new Map<string, TrackerItem>();
    private trackerMissionsGen = 0;
    private trackerProjectsGen = 0;
    private conversationMissionsGen = 0;
    // The last missions fetched per conversation, so returning to one shows its chip at once
    // (and the header does not jump) while the fresh fetch runs. Cleared with the session.
    private readonly conversationMissionsCache = new Map<string, ConversationMissionLink[]>();
    // The generation of the newest load per conversation: only that load may write its cache entry,
    // so a slower, older request cannot put back what a newer one replaced.
    private readonly conversationMissionsCacheGen = new Map<string, number>();
    // Pending marker-driven refetch of the chip's missions: a burst of `mission` markers (a
    // reconnect replay; `left` then `current_changed`) costs one GET.
    private conversationMissionsRefetchTimer?: number;
    private trackerProjectGen = 0;
    // Pending marker-driven inbox refetch. A burst of `item` markers (a reconnect replay, a batch of
    // agent writes) coalesces into ONE inbox walk instead of one per marker.
    private trackerInboxRefetchTimer?: number;
    // The chat's Tasks & decisions pane: a request generation for its list (a newer load, or a
    // drag, supersedes an older load still in flight) and its coalesced marker refetch.
    private chatTasksGen = 0;
    private chatTasksRefetchTimer?: number;
    // Ranks staged by a move the journal has not confirmed yet: a load that lands meanwhile (a
    // second move's refetch, a marker) still reads the old rank, so these win until it answers.
    private chatTasksStaged = new Map<string, number>();
    // Same for `mission` / `milestone` markers and the missions list.
    private trackerMissionsRefetchTimer?: number;
    private trackerMemoriesGen = 0;
    private trackerMemoriesRefetchTimer?: number;
    private trackerItemWorkingRefetchTimer?: number;
    private trackerItemWorkingRefetchNum?: number;
    // Coordinator briefing: a request-generation guard like the tracker loaders', and the timer
    // that refetches once a pending refresh's expires_at passes (the journal then reports it
    // timed_out, which no frame announces).
    private briefingGen = 0;
    private settingsGen = 0;
    // Coordinator consent switch: bumped by every write, so a GET sent before one is dropped and
    // only the latest write's answer moves the switch; the journal's last known value (where a
    // failed write puts the switch back); and the write chain that keeps PUTs in tap order.
    private coordinatorConsentEpoch = 0;
    private coordinatorConsentConfirmed?: boolean;
    private coordinatorConsentWrite: Promise<void> = Promise.resolve();
    // The Coordinator conversation: bumped by every write, hello and marker, so only the newest
    // answer lands; and the pending marker-driven refetch (a burst of `coordinator` events costs
    // one GET).
    private coordinatorEpoch = 0;
    // A `coordinator` marker arrived and no hello, write or read has answered since: the value in
    // state may be the old one.
    private coordinatorStale = false;
    private coordinatorRefetchTimer?: number;
    // Routines: a request-generation guard like the tracker loaders', the views showing them (only
    // then do `routine` markers and reconnects refetch), and the pending marker-driven refetch.
    private routinesGen = 0;
    private routinesViewers = 0;
    private routinesRefetchTimer?: number;
    private briefingExpiryTimer?: number;
    // New-chat defaults. What the sheet shows is always `defaultsServer` (the latest answer from
    // the journal: a GET result, a PUT response's key, or a live frame, applied in arrival order)
    // with the user's unsaved picks (`defaultsPending`, the desired value per key) laid on top.
    // Saves are single-flight per key (`defaultsSaving`): a pick made while that key's PUT is in
    // flight only updates the desired value, and the PUT loop sends it once the current one
    // settles, so the journal and the sheet both end on the latest pick. `defaultsSeq` moves on
    // every GET start, frame and PUT response, so a GET answers only if nothing newer has landed
    // since it was sent. `defaultsViewers` counts the views showing the defaults, which is what
    // makes a reconnect refetch (the `defaults` frame is never replayed).
    private defaultsServer?: UserDefaults;
    private defaultsPending = new Map<UserDefaultKey, string | null>();
    private defaultsSaving = new Map<UserDefaultKey, Promise<boolean>>();
    // The key whose failed save the current `error` reports: a later successful save of that key
    // clears it.
    private defaultsErrorKey?: UserDefaultKey;
    private defaultsSeq = 0;
    private defaultsViewers = 0;
    // Per-box defaults (Settings → Boxes). What the group shows for a box is its journal value
    // (`boxDefaultsServer`, from GET /devices, a PUT answer or a `box_defaults` frame) with the
    // PUT on the wire (`boxDefaultsInFlight`) and any newer unsent picks (`boxDefaultsPending`)
    // laid on top. One PUT per box at a time; picks made meanwhile go in the next one. Each change
    // to a box's journal value is stamped from `boxDefaultsClock`, so a GET sent before it never
    // overwrites it. `boxDefaultsViewers` makes a reconnect refetch (the frame is never replayed).
    private boxDefaultsServer = new Map<number, BoxDefaults>();
    private boxDefaultsInFlight = new Map<number, BoxDefaultsPatch>();
    private boxDefaultsPending = new Map<number, BoxDefaultsPatch>();
    private boxDefaultsSaving = new Map<number, Promise<boolean>>();
    private boxDefaultsStamps = new Map<number, number>();
    private boxDefaultsList: Array<{ device_id: number; name?: string; connected: boolean }> = [];
    private boxDefaultsClock = 0;
    private boxDefaultsLoadGen = 0;
    private boxDefaultsViewers = 0;
    // The box whose failed save the error is about (undefined: a load error, or none).
    private boxDefaultsErrorBox?: number;
    // The clock reading when the current save error was raised (0: none since sign-in).
    private boxDefaultsErrorAt = 0;
    // Whether the pending missions refetch should also reload the open mission detail: set by item
    // markers, which don't say which mission the item belongs to.
    private trackerMissionRefetchPending = false;
    private sessionGen = 0;
    private ackTimer?: number;
    private pendingAck = 0;
    // timestamps (ms) of recent malformed-seq-triggered resyncs, for the reconnect-loop
    // guard in handleMalformedJournalFrame. Pruned to MALFORMED_SEQ_RESYNC_WINDOW_MS on each hit —
    // the sliding window IS the "clean period" reset, so a burst inside the window trips the guard
    // while a genuinely transient blip ages out on its own. Deliberately NOT reset on a single good
    // frame: that would let a server alternating good/malformed frames resync unbounded.
    private malformedSeqResyncs: number[] = [];
    // once the reconnect-loop guard trips, journal processing is HALTED — the connection is
    // stopped and every subsequent frame is ignored so no later frame can advance/ack the cursor
    // past the unrecovered malformed row (applyJournal has no gap detection). Cleared only by a
    // fresh session (resetTransientSyncState on logout / snapshot transition, or a reload).
    private journalHalted = false;
    private historyError?: string;
    // Bumped by every jump to a message; a paging jump whose token is stale has been superseded.
    private focusToken = 0;
    // Which feature started the jump now running: closing find-in-chat cancels only its own jump,
    // never a "jump to my last message" that happens to be in flight while the bar is up.
    private focusOwner?: FocusOwner;
    // Find in chat: only the newest request applies, and closing the bar supersedes one in flight.
    private chatSearchSeq = 0;
    private chatSearchAbort?: AbortController;
    private startSessionRequest?: Promise<StartOutcome>;
    // The session starts this device asked for and has not seen born yet: a conversation that
    // answers one is the user's own, and never gets the "New" marker.
    private startIntents = startedSessionIntents();
    // Live-born conversations whose first frames (a session_status, a title-less meta) could not
    // yet say whether they are a room, a child or the answer to a start, by id with the first
    // frame's time. The verdict waits for a titled convo_meta or a message; an entry that never
    // gets one ages out after NEW_CONVERSATION_STALE_MS.
    private newVerdictPending = new Map<string, number>();
    private rpcCreateWatchdog?: number;
    private rpcCreateWatchdogConvo?: string;
    private rpcCreateWatchdogGen?: number;
    // Convo whose watchdog fired and put RPC_CREATE_STALLED_NOTICE up; a later frame for it lifts it.
    private rpcCreateStalledConvo?: string;
    private storageListener?: (event: StorageEvent) => void;
    /** Guards the one-time `hashchange` binding for the Files deep link (see initialise). */
    private deepLinkListenerBound = false;
    private storeHydrated = { archive: true, pinned: true, favorite: true, unread: true };
    private storeWritable = { archive: true, pinned: true, favorite: true, unread: true };
    // The one-time carry-over of browser-local pins to the journal: one run at a time, retried
    // after a failure (the localStorage flag makes a finished import once per server+user).
    private pinImportStarted = false;
    // The journal's list while a carry-over is pending or failed: the sidebar keeps the
    // browser-local set until the import lands, so local pins never vanish mid-import.
    private stagedPins: ConvoPin[] | null = null;

    public get sessionGeneration(): number {
        return this.sessionGen;
    }

    private allStorageHealthy(): boolean {
        return Object.values(this.storeHydrated).every(Boolean) && Object.values(this.storeWritable).every(Boolean);
    }

    private logStorageDiag(
        event: "read_fail" | "write_fail" | "degrade" | "recover",
        store: string,
        ok: boolean,
    ): void {
        // Console diagnostics are the deliberate ceiling here; this is not a telemetry pipeline.
        console.warn("matron:store", { event, store, ok });
    }

    private storageUnavailable(store: string): boolean {
        const unavailable = !this.allStorageHealthy();
        if (unavailable !== Boolean(this.state.preferencesUnavailable)) {
            this.logStorageDiag(unavailable ? "degrade" : "recover", store, !unavailable);
        }
        return unavailable;
    }

    public readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    public readonly getSnapshot = (): ClientState => this.state;

    /**
     * Observes what the socket delivers, for side effects that live outside the client (desktop
     * notifications): every server frame as it arrives, and each journal event once it is newly
     * applied, with the conversation as it stood before it. Listeners only watch; a throwing one
     * is logged and never disturbs sync.
     */
    public readonly addLiveListener = (listener: LiveListener): (() => void) => {
        this.liveListeners.add(listener);
        return () => this.liveListeners.delete(listener);
    };

    private emitLive(call: (listener: LiveListener) => void): void {
        for (const listener of this.liveListeners) {
            try {
                call(listener);
            } catch (error) {
                console.warn("matron:live-listener", error);
            }
        }
    }

    public async initialise(): Promise<void> {
        let config = {};
        try {
            config = await loadMatronConfig();
        } catch (error) {
            this.patch({
                phase: "signed-out",
                connectionError: error instanceof Error ? error.message : "Could not load Matron configuration",
            });
            return;
        }
        this.patch({ config });

        // Re-apply the Files deep link on every hash change so a bridge link clicked into an
        // already-open app deep-links with no reload. Bound once, before sign-in, so a link that
        // arrives while the session is still restoring is honoured on the next hashchange.
        if (!this.deepLinkListenerBound && typeof window !== "undefined") {
            this.deepLinkListenerBound = true;
            window.addEventListener("hashchange", () => this.applyDeepLinks());
        }

        const session = storedSession();
        if (!session) {
            this.patch({ phase: "signed-out" });
            return;
        }

        try {
            await this.startSession(session);
            // Signed in: honour a `#files=<abs>` fragment present at load (the common flow — the
            // operator followed a bridge link into a fresh tab with a stored session).
            this.applyDeepLinks();
        } catch (error) {
            localStorage.removeItem(SESSION_KEY);
            this.patch({
                phase: "signed-out",
                session: undefined,
                connectionError: error instanceof Error ? error.message : "Could not restore the device session",
            });
        }
    }

    public suggestedServer(): string {
        return this.state.config.journal_server_url || localStorage.getItem(LAST_SERVER_KEY) || "";
    }

    public async login(serverInput: string, username: string, password: string): Promise<void> {
        const serverUrl = normalizeServerUrl(serverInput);
        const api = new JournalApi(serverUrl);
        const response = await api.login(username.trim(), password, deviceName());
        const session: Session = {
            serverUrl,
            token: response.token,
            deviceId: response.device_id,
            userId: response.user_id,
            username: username.trim(),
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        localStorage.setItem(LAST_SERVER_KEY, serverUrl);
        await this.startSession(session);
        // A deep link followed WITHOUT a stored session lands here (interactive login), not in
        // initialise's stored-session branch, and no hashchange fires — apply it now so the linked
        // file opens instead of being stranded behind the conversation view.
        this.applyDeepLinks();
    }

    public async logout(message?: string): Promise<void> {
        this.sessionGen += 1;
        for (const controller of this.inFlightUploads.values()) controller.abort();
        this.inFlightUploads.clear();
        this.uploadConvos.clear();
        this.dismissedAttachments.clear();
        this.pendingFiles.clear();
        this.transientAttachmentErrors.clear();
        this.seen.reset();
        this.connection?.stop();
        this.connection = undefined;
        if (this.storageListener) {
            window.removeEventListener("storage", this.storageListener);
            this.storageListener = undefined;
        }
        this.resetTransientSyncState();
        try {
            await this.database?.reset();
        } catch {
            // Signing out must not be blocked by a failed local cleanup.
        }
        this.database?.close();
        this.database = undefined;
        this.api = undefined;
        this.coordinatorConsentConfirmed = undefined;
        resetSessionStops();
        this.defaultsServer = undefined;
        this.defaultsPending.clear();
        this.defaultsSaving.clear();
        this.boxDefaultsServer.clear();
        this.boxDefaultsInFlight.clear();
        this.boxDefaultsPending.clear();
        this.boxDefaultsSaving.clear();
        this.boxDefaultsStamps.clear();
        this.boxDefaultsList = [];
        this.boxDefaultsErrorBox = undefined;
        this.boxDefaultsErrorAt = 0;
        for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
        this.mediaUrls.clear();
        this.filesApiInstance?.dispose();
        this.filesApiInstance = undefined;
        this.expiredMedia.clear();
        this.startIntents = startedSessionIntents();
        this.newVerdictPending.clear();
        // The archived-conversations key is deliberately left in place: it is a per-device
        // preference that re-login should restore. Clearing it here would also go unnoticed
        // by this tab, since storage events only fire in other tabs.
        localStorage.removeItem(SESSION_KEY);
        this.state = {
            ...blankState(),
            phase: "signed-out",
            config: this.state.config,
            connectionError: message,
        };
        this.emit();
    }

    public async listAgents(): Promise<DeviceDTO[]> {
        const response = await this.api?.devices();
        if (!response) throw new Error("Not signed in.");
        this.rememberBoxStatuses(response.devices);
        return response.devices
            .filter((device) => device.kind === "agent")
            .sort(
                (left, right) =>
                    Number(right.connected) - Number(left.connected) ||
                    (left.name ?? "").localeCompare(right.name ?? "") ||
                    left.device_id - right.device_id,
            );
    }

    public async recentFolders(agentDeviceId: number): Promise<RecentFolder[]> {
        return (await this.newSessionOffer(agentDeviceId)).folders;
    }

    /**
     * Apply a guarded, atomic edit to an existing file on the agent's box via
     * the bridge `edit_file` RPC. Thin wrapper: build the exact wire
     * params -> agentRpc -> classify the reply into a UI-ready outcome. All the
     * param-shape + error-code mapping (the CAS + path-safety surface) lives in
     * the pure, unit-tested ./edit-file module.
     */
    public async editFile(agentDeviceId: number, input: EditFileInput): Promise<EditFileOutcome> {
        const reply = await this.agentRpc(agentDeviceId, "edit_file", buildEditFileParams(input));
        return classifyEditFileReply(reply);
    }

    /**
     * Read an existing file on the agent's box via the bridge `read_file` RPC
     * Thin wrapper mirroring editFile: build the wire
     * params -> agentRpc -> classify into a UI-ready outcome. Its whole point is
     * to make edit_file's expected_sha256 CAS usable — the editor reads to get
     * the current content + sha, then edits WITH that sha as the precondition.
     * All the shape + error-code mapping lives in the pure ./read-file module.
     */
    public async readFile(agentDeviceId: number, input: ReadFileInput): Promise<ReadFileOutcome> {
        const reply = await this.agentRpc(agentDeviceId, "read_file", buildReadFileParams(input));
        return classifyReadFileReply(reply);
    }

    /**
     * What a box offers for a new session (v6 options sheet): recent folders plus the model and
     * agent options and defaults the bridge's `recent_folders` reply carries. Throws when the box
     * can't answer, so the caller can show its own error.
     */
    public async sessionOptions(agentDeviceId: number): Promise<SessionOptions> {
        const reply = await this.agentRpc(agentDeviceId, "recent_folders", {});
        if (!reply.ok) throw new Error(reply.code ?? "unavailable");
        return parseSessionOptions(reply.result);
    }

    // A box's `recent_folders` reply: its folders, plus the agent, model and effort choices a
    // `start` there may name. A failed or malformed reply is an empty offer, never a throw.
    public async newSessionOffer(agentDeviceId: number): Promise<NewSessionOffer> {
        const reply = await this.agentRpc(agentDeviceId, "recent_folders", {});
        const result =
            reply.ok && typeof reply.result === "object" && reply.result !== null && !Array.isArray(reply.result)
                ? (reply.result as Record<string, unknown>)
                : {};
        return {
            folders: parseRecentFolders(result.folders),
            agentOptions: parseStartOptions(result.agent_options),
            defaultAgent: parseOfferDefault(result.default_agent),
            // The bridge's model list mirrors its /model buttons, which lead with the `default`
            // alias; the sheet's own Default row already stands for that, so drop the duplicate.
            modelOptions: parseStartOptions(result.model_options).filter((option) => option.value !== "default"),
            defaultModel: parseOfferDefault(result.default_model),
            effortOptions: parseStartOptions(result.effort_options).filter((option) => option.value !== "default"),
            defaultEffort: parseOfferDefault(result.default_effort),
        };
    }

    // One ask of a box that may be asleep. The journal boots an idle-stopped box whenever a
    // request targets it and refuses that request with `agent_unreachable`, so the first refused
    // ask is the wake and re-asking until the box answers is how a caller learns it is up. A
    // timeout also reads as booting: mid-boot the socket can be up before the bridge is.
    public async probeAgent(agentDeviceId: number): Promise<AgentProbe> {
        const reply = await this.agentRpc(agentDeviceId, "recent_folders", {});
        if (reply.ok || reply.origin === "agent") return "up";
        if (reply.code === "agent_unreachable" || reply.origin === "timeout") return "booting";
        return "failed";
    }

    public startSessionRpc(
        agentDeviceId: number,
        workdir: string,
        browser: boolean,
        choice: StartSessionPicks & { idempotencyKey?: string } = {},
    ): Promise<StartOutcome> {
        if (this.startSessionRequest) {
            return Promise.resolve({ kind: "error", message: "A session is already starting — please wait." });
        }

        const request = this.performStartSessionRpc(agentDeviceId, workdir, browser, choice);
        this.startSessionRequest = request;
        const clear = (): void => {
            if (this.startSessionRequest === request) this.startSessionRequest = undefined;
        };
        void request.then(clear, clear);
        return request;
    }

    private async performStartSessionRpc(
        agentDeviceId: number,
        workdir: string,
        browser: boolean,
        choice: StartSessionPicks & { idempotencyKey?: string } = {},
    ): Promise<StartOutcome> {
        const params: { workdir?: string; browser?: true; idempotency_key?: string } & StartSessionPicks = {};
        const normalizedWorkdir = workdir.trim();
        if (normalizedWorkdir) params.workdir = normalizedWorkdir;
        if (browser) params.browser = true;
        if (choice.agent) params.agent = choice.agent;
        if (choice.model) params.model = choice.model;
        if (choice.effort) params.effort = choice.effort;
        // One key per operator intent: a retry after an uncertain start re-answers the same
        // conversation instead of spawning a second one (bridge start dedup).
        if (choice.idempotencyKey) params.idempotency_key = choice.idempotencyKey;

        // The session this start brings is the user's own: it must not arrive marked "New".
        this.startIntents.noteBox(agentDeviceId, Date.now());
        const reply = await this.agentRpc(agentDeviceId, "start", params);
        if (reply.ok) {
            if (typeof reply.result !== "object" || reply.result === null || Array.isArray(reply.result)) {
                return { kind: "uncertain" };
            }
            const convoId = (reply.result as Record<string, unknown>).convo_id;
            if (typeof convoId === "string" && convoId.length > 0) {
                // Its first frames may have beaten this reply. If they already settled its verdict,
                // only the box's ask is left, and any mark it got is undone: it is the user's own
                // even when the sheet was dismissed and it is not opened. Otherwise (not seen yet,
                // or its verdict still waits for the titled meta) it is claimed by id.
                const seen = this.state.conversations.some((candidate) => candidate.id === convoId);
                if (seen && !this.newVerdictPending.has(convoId)) {
                    this.startIntents.forgetBox(agentDeviceId);
                    this.clearNewMark(convoId);
                } else {
                    this.startIntents.noteConversation(convoId, agentDeviceId);
                }
                return { kind: "created", convoId };
            }
            return { kind: "uncertain" };
        }
        // A refusal brings no session; a session that does arrive on this box later is not this ask's.
        if (reply.origin !== "timeout") this.startIntents.forgetBox(agentDeviceId);
        if (reply.origin === "relay") {
            return {
                kind: "error",
                reach: true,
                message:
                    reply.code === "not_connected" || reply.code === "not_ready"
                        ? "Still connecting — try again in a moment."
                        : "Couldn't reach that box — try again.",
            };
        }
        if (reply.origin === "agent" && reply.code === "bad_workdir") {
            return { kind: "error", code: "bad_workdir", message: "That folder doesn’t exist on the box." };
        }
        // The pickers only ever show what this box's own reply offered, so these mean the box
        // has changed since; the Default rows always work.
        if (reply.origin === "agent" && reply.code === "bad_model") {
            return { kind: "error", message: "That box doesn't offer that model — pick another." };
        }
        if (reply.origin === "agent" && reply.code === "bad_effort") {
            return { kind: "error", message: "That box doesn't offer that effort — pick another." };
        }
        if (reply.origin === "agent" && reply.code === "bad_agent") {
            return { kind: "error", message: "That box can't start that agent — pick another." };
        }
        // A bridge without Codex's app-server transport refuses browser tools on an explicit Codex
        // start: a definite refusal, so no session is coming — not "may have started".
        if (reply.origin === "agent" && reply.code === "bad_request" && choice.agent === "codex" && browser) {
            return { kind: "error", message: "That box can't give Codex browser tools — untick Browser tools." };
        }
        return { kind: "uncertain" };
    }

    /**
     * Full-text search over message content for the Apple-parity "Messages" section. The caller
     * (the search box) debounces; this method owns correctness:
     *  - An empty/blank OR over-length (server rejects >256) query clears the section without a
     *    request, so a giant paste reads as "no results", not a spurious "unavailable" outage.
     *  - searchSeq ensures only the newest request applies; searchAbort cancels the prior in-flight
     *    request AND a per-request timeout aborts one that never settles — bounded exit, so the
     *    section can't hang on "Searching…" and obsolete searches don't pile up.
     *  - Hits stay bound to the query that produced them: a new query starts empty (loading), so an
     *    earlier query's hits are never shown under a later query's label.
     *  - A server/transport/timeout error degrades to a failed empty state, never a throw — the
     *    chat-title filter keeps working regardless.
     */
    public async searchMessages(rawQuery: string): Promise<void> {
        const query = rawQuery.trim();
        this.searchAbort?.abort(); // cancel any in-flight request; its stale result is guarded off below
        this.searchAbort = undefined;
        if (!query || query.length > MESSAGE_SEARCH_MAX_QUERY_LEN) {
            this.searchSeq += 1; // supersede any in-flight request so its result is ignored
            if (this.state.messageSearch) this.patch({ messageSearch: undefined });
            return;
        }
        if (!this.api) return;
        const seq = ++this.searchSeq;
        const controller = new AbortController();
        this.searchAbort = controller;
        this.patch({ messageSearch: { query, hits: [], loading: true, failed: false } });
        // A request can outlive the deadline on a transport that ignores the abort signal (Electron
        // journalRequest observes no signal), so the bounded exit comes from a transport-independent
        // Promise.race — mirroring devices(). The abort still fires to free the browser fetch.
        const searchCall = this.api.search(query, MESSAGE_SEARCH_LIMIT, controller.signal);
        void searchCall.catch(() => undefined);
        let timeoutTimer: ReturnType<typeof setTimeout>;
        const timeoutReject = new Promise<never>((_resolve, reject) => {
            timeoutTimer = setTimeout(() => {
                reject(new Error("timeout"));
                controller.abort();
            }, MESSAGE_SEARCH_TIMEOUT_MS);
        });
        try {
            const response = await Promise.race([searchCall, timeoutReject]);
            if (seq !== this.searchSeq) return;
            // Defensive parse: the /search producer is a separate service, so guard against a
            // version-skewed or malformed success (hits not an array, a hit missing fields) rather
            // than letting it crash the render. A non-conforming payload degrades to "no results".
            this.patch({ messageSearch: { query, hits: sanitizeSearchHits(response), loading: false, failed: false } });
        } catch {
            if (seq !== this.searchSeq) return;
            this.patch({ messageSearch: { query, hits: [], loading: false, failed: true } });
        } finally {
            clearTimeout(timeoutTimer!);
            if (this.searchAbort === controller) this.searchAbort = undefined;
        }
    }

    /**
     * Pull a conversation's newest page from the server into the local store, once per session,
     * for a child whose history predates this tab. Concurrent callers share one request; it is
     * bounded by CONVERSATION_TAIL_TIMEOUT_MS so a stalled request never holds a card. Resolves
     * true when new history was stored (callers then re-read conversationEvents), false when
     * nothing changed or the request failed (a later call retries a failure).
     */
    public refreshConversationTail(conversationId: string): Promise<boolean> {
        const inflight = this.conversationTailFetches.get(conversationId);
        if (inflight) return inflight;
        const database = this.database;
        const api = this.api;
        if (!database || !api) return Promise.resolve(false);
        // The catch below compares against this to forget only its own request.
        const slot: { request?: Promise<boolean> } = {};
        const request = (async (): Promise<boolean> => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const response = await Promise.race([
                    api.messages(conversationId, undefined, CONVERSATION_TAIL_SIZE),
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(
                            () => reject(new Error("conversation tail timed out")),
                            CONVERSATION_TAIL_TIMEOUT_MS,
                        );
                    }),
                ]);
                if (this.database !== database) return false;
                await database.putHistory(response.events);
                return response.events.length > 0;
            } catch {
                // Let a later mount retry; the stored events still render meanwhile. Only forget
                // THIS request: a reset may have cleared the map and a newer one taken the slot.
                if (this.conversationTailFetches.get(conversationId) === slot.request) {
                    this.conversationTailFetches.delete(conversationId);
                }
                return false;
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
        })();
        slot.request = request;
        this.conversationTailFetches.set(conversationId, request);
        return request;
    }

    public async selectConversation(
        conversationId: string,
        opts?: { clearUnread?: boolean; fromRpcCreate?: boolean; suppressNotFound?: boolean },
    ): Promise<void> {
        const selectionEpoch = ++this.selectionEpoch;
        const existingHistory = this.history.get(conversationId);
        const returningFromHistoryWindow = existingHistory?.hasMoreNewer === true;
        if (returningFromHistoryWindow) {
            this.history.set(conversationId, {
                initialized: false,
                oldestSeq: undefined,
                newestSeq: undefined,
                hasMore: true,
                hasMoreNewer: false,
            });
        }
        if (!this.beginConversationSelection(conversationId, opts, false)) return;
        // A conversation opened for the first time needs its history from the journal. Ask for it
        // now, alongside the local read below, instead of after it: the request then overlaps the
        // IndexedDB read and the first render. Whichever refresh lands last wins (refresh epochs).
        const history = this.history.get(conversationId)?.initialized
            ? undefined
            : this.loadOlderHistory({ suppressNotFound: opts?.fromRpcCreate || opts?.suppressNotFound });
        if (!returningFromHistoryWindow) {
            await this.refreshSelectedConversation(conversationId, this.database, this.sessionGen, selectionEpoch);
        }
        if (!this.isCurrentSelection(conversationId, selectionEpoch)) {
            await history;
            return;
        }
        this.announceConversationViewing(conversationId);
        await history;
    }

    public async selectConversationAtSeq(conversationId: string, seq: number): Promise<void> {
        const selectionEpoch = ++this.selectionEpoch;
        const database = this.database;
        const api = this.api;
        const gen = this.sessionGen;
        if (!database || !api || !this.state.session) return;
        const ownsSelection = (): boolean =>
            this.isCurrentSelection(conversationId, selectionEpoch) &&
            this.sessionGen === gen &&
            this.database === database &&
            this.api === api;

        this.history.set(conversationId, {
            initialized: true,
            oldestSeq: undefined,
            newestSeq: undefined,
            hasMore: true,
            hasMoreNewer: true,
        });
        // A historical window does not prove that the unread tail was seen. Preserve both the
        // local unread override and the durable read position until Jump to latest.
        if (!this.beginConversationSelection(conversationId, { clearUnread: false }, true)) return;

        try {
            const response = await api.messages(conversationId, undefined, HISTORY_PAGE_SIZE, seq);
            if (!ownsSelection()) return;
            await database.putHistory(response.events);
            if (!ownsSelection()) return;
            await this.reconcilePersistedOwnMessages(database);
            if (!ownsSelection()) return;
            const oldestSeq = response.events.reduce<number | undefined>(
                (current, event) => (current === undefined ? event.seq : Math.min(current, event.seq)),
                undefined,
            );
            const newestSeq = response.events.reduce<number | undefined>(
                (current, event) => (current === undefined ? event.seq : Math.max(current, event.seq)),
                undefined,
            );
            this.history.set(conversationId, {
                initialized: true,
                oldestSeq,
                newestSeq,
                hasMore: response.events.length === HISTORY_PAGE_SIZE && oldestSeq !== undefined && oldestSeq > 1,
                hasMoreNewer: true,
            });
            if (!ownsSelection()) return;
            this.patch({
                viewingHistoryWindow: true,
                hasOlderHistory: this.history.get(conversationId)?.hasMore ?? false,
            });
            await this.refreshSelectedConversation(conversationId, database, gen, selectionEpoch);
            if (!ownsSelection()) return;
            // Publish the target only after the matching rows are in state, so the view cannot
            // consume it during the intermediate empty-timeline render.
            this.patch({ pendingScrollSeq: seq });
            this.clearHistoryError();
        } catch {
            if (!ownsSelection()) return;
            await this.selectConversation(conversationId);
            if (this.state.selectedConversationId !== conversationId || this.state.viewingHistoryWindow) return;
            this.historyError = "Couldn't jump to that message";
            this.patch({ connectionError: this.historyError });
        }
    }

    public async jumpToLatest(): Promise<void> {
        const conversationId = this.state.selectedConversationId;
        if (!conversationId) return;
        await this.selectConversation(conversationId);
    }

    public clearPendingScrollSeq(seq: number): void {
        if (this.state.pendingScrollSeq === seq) this.patch({ pendingScrollSeq: undefined });
    }

    private beginConversationSelection(
        conversationId: string,
        opts: { clearUnread?: boolean; fromRpcCreate?: boolean } | undefined,
        viewingHistoryWindow: boolean,
    ): boolean {
        if (!this.database || !this.state.session) return false;
        // fromRpcCreate is for a room created milliseconds ago by this client's own RPC: it arms
        // the sync watchdog (frames must follow shortly) AND tolerates a young room's 404 on
        // history. suppressNotFound wants only the latter — opening a spawn-created room long
        // after the fact must not arm a watchdog that only an incoming frame can clear, or an
        // idle session reports "not syncing" as an error.
        if (opts?.fromRpcCreate) this.armRpcCreateWatchdog(conversationId);
        if (opts?.clearUnread ?? true) this.clearUnreadOverride(conversationId);
        // Opening a conversation, by any route, ends its "New" marker.
        this.clearNewMark(conversationId);
        storeSelectedConversation(this.state.session, conversationId);
        // Selecting a conversation closes the Tracker pane, so it drops the cached item detail the
        // same way closeTrackerView does.
        if (this.state.trackerView) {
            this.trackerItemGen += 1;
            this.trackerMissionGen += 1;
            this.trackerProjectGen += 1;
        }
        if (this.state.chatSearch && this.state.chatSearch.conversationId !== conversationId) {
            // The bar closes below; a search still in flight there must not answer a bar opened on
            // that conversation again later.
            this.chatSearchSeq += 1;
            this.chatSearchAbort?.abort();
            this.chatSearchAbort = undefined;
        }
        this.patch({
            selectedConversationId: conversationId,
            // Selecting a conversation closes the Files pane and the Tracker pane so the chosen
            // room becomes visible (both are main-region discriminants checked ahead of
            // selectedConversationId; the tracker also takes precedence over Files).
            filesView: undefined,
            trackerView: undefined,
            opsView: undefined,
            ...(this.state.trackerView ? { trackerItem: null, trackerMission: null, trackerProject: null } : {}),
            events: [],
            pendingMessages: [],
            focusTarget: undefined,
            // Find in chat searches one conversation; opening another closes its bar.
            ...(this.state.chatSearch && this.state.chatSearch.conversationId !== conversationId
                ? { chatSearch: undefined }
                : {}),
            loadingHistory: false,
            hasOlderHistory: this.history.get(conversationId)?.hasMore ?? true,
            pendingScrollSeq: undefined,
            viewingHistoryWindow,
            activity: viewingHistoryWindow ? undefined : this.activities.get(conversationId),
            sessionStatus: this.statusFor(conversationId),
            textStreams: viewingHistoryWindow ? {} : { ...(this.textStreams.get(conversationId) ?? {}) },
            toolStreams: viewingHistoryWindow ? {} : { ...(this.toolStreams.get(conversationId) ?? {}) },
        });
        return true;
    }

    private isCurrentSelection(conversationId: string, selectionEpoch: number): boolean {
        return this.selectionEpoch === selectionEpoch && this.state.selectedConversationId === conversationId;
    }

    private isViewingHistoricalWindow(conversationId: string): boolean {
        return this.history.get(conversationId)?.hasMoreNewer === true;
    }

    private announceConversationViewing(conversationId: string): void {
        this.connection?.send({ op: "viewing", convo_id: conversationId });

        const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
        if (conversation?.unread_count) this.scheduleRead(conversationId, conversation.last_seq, 0);
    }

    /**
     * complete the historical→live transition when forward-paging (loadNewerHistory) reaches
     * the true tail. beginConversationSelection suppresses these for a historical window; now that
     * the reader has caught up they must run — but without re-selecting (which would reset the
     * window and lose the forward-paged rows). Mirrors the live-entry effects of selectConversation:
     * resubscribe via `viewing` (the deep-link path never sent it, and it drives the server's
     * ephemeral replay per the subchats design), clear the unread override now that the tail is
     * seen, schedule the read marker, and repopulate the activity/stream caches that were blanked
     * while viewing history.
     */
    private resumeLiveFromHistoryWindow(conversationId: string): void {
        this.clearUnreadOverride(conversationId);
        this.patch({
            activity: this.activities.get(conversationId),
            sessionStatus: this.statusFor(conversationId),
            textStreams: { ...(this.textStreams.get(conversationId) ?? {}) },
            toolStreams: { ...(this.toolStreams.get(conversationId) ?? {}) },
        });
        this.announceConversationViewing(conversationId);
    }

    public clearSelection(): void {
        // Find in chat belongs to the conversation being left: a search still in flight must not
        // reopen it, nor answer a bar opened there later.
        this.endChatSearch();
        this.connection?.send({ op: "viewing", convo_id: null });
        if (this.state.session) storeSelectedConversation(this.state.session, undefined);
        this.patch({
            selectedConversationId: undefined,
            events: [],
            pendingMessages: [],
            pendingScrollSeq: undefined,
            viewingHistoryWindow: false,
        });
    }

    public archiveConversation(conversationId: string): void {
        this.setArchived(conversationId, true);
    }

    public unarchiveConversation(conversationId: string): void {
        this.setArchived(conversationId, false);
    }

    public pinConversation(id: string): void {
        this.setFlag(pinnedStore, "pinnedIds", id, true);
    }

    public unpinConversation(id: string): void {
        this.setFlag(pinnedStore, "pinnedIds", id, false);
    }

    // ── Journal pins (only while state.journalPins is non-null) ─────────────

    /**
     * PUT /pins/:convo_id — pin (label required) or edit a pin. Resolves to an inline error
     * message, or undefined on success (the list then comes from the response).
     */
    public savePin(convoId: string, pin: { label: string; emoji: string }): Promise<string | undefined> {
        return this.pinRequest((api) => api.putPin(convoId, pin));
    }

    /** POST /pins/:convo_id/move — repoint a pin at another conversation; resolves to an error message. */
    public movePin(convoId: string, toConvoId: string): Promise<string | undefined> {
        return this.pinRequest((api) => api.movePin(convoId, toConvoId));
    }

    /** DELETE /pins/:convo_id; a failure lands in the sidebar's control error. */
    public async removePin(convoId: string): Promise<void> {
        this.reportPinError(await this.pinRequest((api) => api.deletePin(convoId)));
    }

    /** One step up or down the Pinned section (PUT /pins with the whole order). */
    public async shiftPin(convoId: string, direction: "up" | "down", shownIds?: readonly string[]): Promise<void> {
        const order = movedPinOrder(this.state.journalPins ?? [], convoId, direction, shownIds);
        if (!order) return;
        this.reportPinError(await this.pinRequest((api) => api.reorderPins(order)));
    }

    /** Move the pin to its offered successor. */
    public async acceptPinSuccessor(pin: ConvoPin): Promise<void> {
        if (!pin.successor) return;
        this.reportPinError(await this.movePin(pin.convo_id, pin.successor.convo_id));
    }

    /** Stop offering the successor. */
    public async dismissPinSuccessor(pin: ConvoPin): Promise<void> {
        const successorId = pin.successor?.convo_id;
        if (!successorId) return;
        this.reportPinError(await this.pinRequest((api) => api.dismissPinSuccessor(pin.convo_id, successorId)));
    }

    private reportPinError(error: string | undefined): void {
        if (error) this.patch({ controlError: `Couldn't update pins: ${error}` });
    }

    private async pinRequest(run: (api: JournalApi) => Promise<unknown>): Promise<string | undefined> {
        const api = this.api;
        if (!api) return "Not signed in.";
        try {
            const { pins, limit } = parsePinsResponse(await run(api));
            if (this.api === api) this.applyJournalPins(pins, limit);
            return undefined;
        } catch (error) {
            return pinErrorMessage(error);
        }
    }

    /**
     * Adopt the journal's pin list (null = this journal has no pins: keep the browser-local set).
     * The first time pins are supported this session, carry any browser-local pins over.
     */
    private applyJournalPins(pins: ConvoPin[] | null, limit?: number): void {
        const importPending = pins !== null && this.localPinImportPending();
        // Before the sidebar first shows journal pins, stage them while local pins await their
        // carry-over. Once it shows them, keep the list current and import alongside.
        if (importPending && (this.stagedPins !== null || this.state.journalPins === null)) {
            this.stagedPins = pins;
            if (limit !== undefined) this.patch({ pinLimit: limit });
        } else {
            this.stagedPins = null;
            this.patch({ journalPins: pins, ...(limit !== undefined ? { pinLimit: limit } : {}) });
            if (this.state.session) writeCachedPins(this.state.session, pins);
        }
        if (importPending) void this.importLocalPins();
    }

    /** Browser-local pins exist that have not been carried over to the journal yet. */
    private localPinImportPending(): boolean {
        const session = this.state.session;
        if (!session || pinImportDone(session)) return false;
        const local = pinnedStore.read(session);
        return local.ok && local.ids.size > 0;
    }

    /**
     * One-time import, per (server, user): PUT each browser-local pin the journal lacks, in list
     * order and within the limit, then clear the local set and switch the sidebar to the journal's
     * list. Any failure stops the import and leaves the local set (and the flag) untouched — the
     * sidebar stays on what it showed (the local pins, until the journal's were adopted), and the
     * next pin list from the journal (a live frame, a pin action, a reconnect) retries.
     */
    private async importLocalPins(): Promise<void> {
        const session = this.state.session;
        const api = this.api;
        if (!session || !api || this.pinImportStarted || pinImportDone(session)) return;
        const local = pinnedStore.read(session);
        if (!local.ok || local.ids.size === 0) return;
        this.pinImportStarted = true;
        const plan = planPinImport(
            local.ids,
            this.state.conversations,
            this.stagedPins ?? this.state.journalPins ?? [],
            this.state.pinLimit,
        );
        for (const { convo_id, label } of plan) {
            let result: { pins: ConvoPin[]; limit: number };
            try {
                result = parsePinsResponse(await api.putPin(convo_id, { label, emoji: "" }));
            } catch (error) {
                console.warn("matron: pin import stopped", pinErrorMessage(error));
                if (this.api === api) this.pinImportStarted = false;
                return;
            }
            if (this.api !== api) return;
            if (this.stagedPins !== null) this.stagedPins = result.pins;
            else this.patch({ journalPins: result.pins });
            this.patch({ pinLimit: result.limit });
        }
        if (this.api !== api || this.state.session !== session) return;
        markPinImportDone(session);
        let cleared = true;
        try {
            pinnedStore.write(session, new Set());
        } catch {
            this.logStorageDiag("write_fail", "pinned", false);
            cleared = false;
        }
        const pins = this.stagedPins ?? this.state.journalPins ?? [];
        this.stagedPins = null;
        this.patch({ journalPins: pins, ...(cleared ? { pinnedIds: new Set<string>() } : {}) });
        writeCachedPins(session, pins);
    }

    public favoriteConversation(id: string): void {
        this.setFlag(favoriteStore, "favoriteIds", id, true);
    }

    public unfavoriteConversation(id: string): void {
        this.setFlag(favoriteStore, "favoriteIds", id, false);
    }

    public markConversationUnread(id: string): void {
        this.setFlag(unreadStore, "unreadOverrideIds", id, true);
    }

    /**
     * toggle whether a parent conversation's subagent child rows are collapsed in the
     * sidebar. Session-local (no store persistence) — the collapsed set is threaded into every
     * buildSidebarIndex call, so collapsing suppresses the child rows across render, selection,
     * unread aggregation, the desktop badge, and mark-all in lock-step.
     */
    public toggleSubagentCollapse(parentId: string): void {
        const next = new Set(this.state.collapsedSubagentParentIds);
        if (next.has(parentId)) next.delete(parentId);
        else next.add(parentId);
        this.patch({ collapsedSubagentParentIds: next });
    }

    public markConversationRead(conversationId: string): boolean {
        const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
        if (!conversation) return true;
        const cleared = this.clearUnreadOverride(conversationId);
        if (conversation.unread_count > 0) this.scheduleRead(conversationId, conversation.last_seq, 0);
        return cleared;
    }

    public markAllRead(): void {
        const previousControlError = this.state.controlError;
        // mark-all targets exactly the rows Active renders as top-level (canonical
        // predicate) — never a hidden done child (no row, no Mark-all button) nor a nested
        // child, both of which would otherwise leave a stuck, untargetable unread badge.
        const index = buildSidebarIndex(
            this.state.conversations,
            this.state.archivedIds,
            this.state.collapsedSubagentParentIds,
        );
        let anyFailed = false;
        for (const conversation of this.state.conversations) {
            if (this.state.archivedIds.has(conversation.id)) continue;
            if (!rendersAsTopLevelRow(conversation, index)) continue;
            if (!effectiveUnread(conversation, this.state.unreadOverrideIds)) continue;
            // Single canonical mark-read path; it clears the override and flushes the server read.
            if (!this.markConversationRead(conversation.id)) anyFailed = true;
        }
        this.patch({
            controlError: anyFailed
                ? MARK_ALL_READ_ERROR
                : previousControlError === MARK_ALL_READ_ERROR
                  ? undefined
                  : previousControlError,
        });
    }

    public async loadOlderHistory(opts?: { suppressNotFound?: boolean }): Promise<void> {
        const conversationId = this.state.selectedConversationId;
        if (!conversationId || !this.database || !this.api || this.state.loadingHistory) return;
        const database = this.database;
        const api = this.api;
        const gen = this.sessionGen;
        const selectionEpoch = this.selectionEpoch;
        const ownsLoad = (): boolean =>
            this.sessionGen === gen &&
            this.database === database &&
            this.api === api &&
            this.isCurrentSelection(conversationId, selectionEpoch);
        const history = this.history.get(conversationId) ?? {
            initialized: false,
            hasMore: true,
            hasMoreNewer: false,
        };
        if (history.initialized && !history.hasMore) return;

        this.patch({ loadingHistory: true });
        try {
            const response = await api.messages(
                conversationId,
                history.initialized ? history.oldestSeq : undefined,
                HISTORY_PAGE_SIZE,
            );
            if (!ownsLoad()) return;
            await database.putHistory(response.events);
            if (!ownsLoad()) return;
            await this.reconcilePersistedOwnMessages(database);
            if (!ownsLoad()) return;
            const minimum = response.events.reduce<number | undefined>(
                (current, event) => (current === undefined ? event.seq : Math.min(current, event.seq)),
                history.oldestSeq,
            );
            const maximum = response.events.reduce<number | undefined>(
                (current, event) => (current === undefined ? event.seq : Math.max(current, event.seq)),
                history.newestSeq,
            );
            const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
            const emptyInitialPageWithKnownHistory =
                !history.initialized && response.events.length === 0 && (conversation?.last_seq ?? 0) > 0;
            this.history.set(conversationId, {
                initialized: !emptyInitialPageWithKnownHistory,
                oldestSeq: minimum,
                newestSeq: maximum,
                hasMore: emptyInitialPageWithKnownHistory || response.events.length === HISTORY_PAGE_SIZE,
                hasMoreNewer: history.hasMoreNewer,
            });
            if (this.state.selectedConversationId === conversationId) {
                await this.refreshSelectedConversation(conversationId, database, gen, selectionEpoch);
                if (!ownsLoad()) return;
            }
            this.clearHistoryError();
        } catch (error) {
            if (!ownsLoad()) return;
            if (
                opts?.suppressNotFound &&
                error instanceof JournalApiError &&
                error.status === 404 &&
                error.code === "not_found"
            ) {
                this.history.set(conversationId, {
                    initialized: true,
                    hasMore: false,
                    hasMoreNewer: false,
                });
                this.clearHistoryError();
                return;
            }
            this.historyError = error instanceof Error ? error.message : "Could not load message history";
            this.patch({ connectionError: this.historyError });
        } finally {
            if (ownsLoad()) {
                this.patch({
                    loadingHistory: false,
                    hasOlderHistory: this.history.get(conversationId)?.hasMore ?? false,
                    viewingHistoryWindow: this.history.get(conversationId)?.hasMoreNewer ?? false,
                });
            }
        }
    }

    /**
     * forward-page a deep-link historical window toward the live tail. The mirror of
     * loadOlderHistory — where that extends the window's oldest edge downward, this extends the
     * newest edge upward so scrolling DOWN loads NEWER messages instead of forcing "Jump to
     * latest" (which discards reading position). The server has no after_seq, so the forward
     * half is obtained via around_seq = newestSeq + 1: messagesAround returns floor(limit/2)
     * rows before the anchor (already held — deduped by putHistory) and the remainder from the
     * anchor up, i.e. the events with seq >= newestSeq + 1. Only meaningful while a historical
     * window is open (hasMoreNewer); once a forward page brings nothing past the newest edge the
     * window collapses (hasMoreNewer = false) and the normal live-append path (handleEvent)
     * resumes. Tail detection is response-derived (no-forward-progress), never from cached
     * summary state, so it can neither strand unfetched rows nor wedge. Reuses loadOlderHistory's
     * selection-epoch / session / database ownership guard so a response that lost the selection
     * never mutates it.
     */
    public async loadNewerHistory(): Promise<void> {
        const conversationId = this.state.selectedConversationId;
        if (!conversationId || !this.database || !this.api || this.state.loadingHistory) return;
        const history = this.history.get(conversationId);
        // Forward-paging only applies inside an open historical window with a known newest edge.
        if (!history || !history.hasMoreNewer || history.newestSeq === undefined) return;
        const anchorNewestSeq = history.newestSeq;
        const database = this.database;
        const api = this.api;
        const gen = this.sessionGen;
        const selectionEpoch = this.selectionEpoch;
        const ownsLoad = (): boolean =>
            this.sessionGen === gen &&
            this.database === database &&
            this.api === api &&
            this.isCurrentSelection(conversationId, selectionEpoch);

        this.patch({ loadingHistory: true });
        try {
            const response = await api.messages(conversationId, undefined, HISTORY_PAGE_SIZE, anchorNewestSeq + 1);
            if (!ownsLoad()) return;
            await database.putHistory(response.events);
            if (!ownsLoad()) return;
            await this.reconcilePersistedOwnMessages(database);
            if (!ownsLoad()) return;
            const minimum = response.events.reduce<number | undefined>(
                (current, event) => (current === undefined ? event.seq : Math.min(current, event.seq)),
                history.oldestSeq,
            );
            const maximum = response.events.reduce<number | undefined>(
                (current, event) => (current === undefined ? event.seq : Math.max(current, event.seq)),
                history.newestSeq,
            );
            // Tail detection is derived purely from the response, never from independently-cached
            // metadata: the window collapses only once a forward page brings nothing past the
            // newest edge (no event with seq > anchor). Using the sidebar's last_seq as terminal
            // proof would be a canonical-source violation — a stale-low summary could prematurely
            // flip to "live" and strand server rows the window never fetched, while a stale-high
            // one could wedge it. No-forward-progress costs at most one extra overlap-only request
            // at the true tail and can neither hide nor skip rows.
            const reachedTail = maximum === undefined || maximum <= anchorNewestSeq;
            // On collapse the upper bound must cover any live frame that raced in and was persisted
            // (with a higher seq) while the window was open — handleJournal suppresses the newestSeq
            // bump during a historical window, so a stale response maximum would filter that frame
            // out of the "live" timeline. Take the max with the canonical last_seq (the DB's newest
            // applied seq); max() also means a stale-LOW last_seq can never pull the bound below the
            // fetched edge. While still paging the bound stays at the fetched maximum.
            const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
            const liveNewestSeq =
                reachedTail && maximum !== undefined ? Math.max(maximum, conversation?.last_seq ?? maximum) : maximum;
            this.history.set(conversationId, {
                initialized: true,
                oldestSeq: minimum,
                newestSeq: liveNewestSeq,
                hasMore: history.hasMore,
                hasMoreNewer: !reachedTail,
            });
            if (this.state.selectedConversationId === conversationId) {
                // Check-act ordering: the abort-capable refresh must land BEFORE any irreversible
                // live-entry side effect. If db.events()/outbox() rejects, roll the window back so
                // the reader is not stranded on stale rows with pagination gone — and, crucially,
                // without having cleared unread or flushed a durable read marker for messages the
                // refreshed timeline never actually showed.
                try {
                    await this.refreshSelectedConversation(conversationId, database, gen, selectionEpoch);
                } catch (refreshError) {
                    this.history.set(conversationId, history);
                    throw refreshError;
                }
                if (!ownsLoad()) return;
                // Only now that the timeline is refreshed: reaching the tail is a full historical→
                // live transition, not just a flag flip — run the same live-entry side effects
                // selectConversation performs (subscribe via `viewing`, clear unread, schedule the
                // read marker, repopulate ephemerals) WITHOUT resetting the window (which would
                // discard the forward-paged rows and the reading position).
                if (reachedTail) this.resumeLiveFromHistoryWindow(conversationId);
            }
            this.clearHistoryError();
        } catch (error) {
            if (!ownsLoad()) return;
            this.historyError = error instanceof Error ? error.message : "Could not load newer messages";
            this.patch({ connectionError: this.historyError });
        } finally {
            if (ownsLoad()) {
                this.patch({
                    loadingHistory: false,
                    hasOlderHistory: this.history.get(conversationId)?.hasMore ?? false,
                    viewingHistoryWindow: this.history.get(conversationId)?.hasMoreNewer ?? false,
                });
            }
        }
    }

    // ── Jump to a message ───────────────────────────────────────────────────

    /**
     * Opens `conversationId` on the row with `seq` (a search hit, a milestone's anchor) instead of
     * at its tail: pages history back until that seq is loaded, then hands the timeline a
     * `focusTarget` to scroll to and flash. A seq that is not rendered (a milestone's own marker, a
     * deleted row) lands on the nearest row before it; one older than the history reached in
     * FOCUS_MAX_PAGES pages lands on the oldest row loaded. A newer jump, or opening another
     * conversation, supersedes one still paging. Resolves true when a target was handed over.
     */
    public async focusMessage(conversationId: string, seq: number, owner: FocusOwner = "link"): Promise<boolean> {
        if (!conversationId || !Number.isSafeInteger(seq) || seq < 0) return false;
        const token = ++this.focusToken;
        this.focusOwner = owner;
        if (this.state.selectedConversationId !== conversationId) {
            await this.selectConversation(conversationId, { suppressNotFound: true });
        } else {
            this.closeTrackerView();
        }
        const loaded = (): boolean => {
            if (this.state.events.some((event) => event.seq === seq)) return true;
            const history = this.history.get(conversationId);
            return Boolean(history?.initialized && history.oldestSeq !== undefined && history.oldestSeq <= seq);
        };
        if (!(await this.pageHistoryUntil(conversationId, token, loaded))) return false;
        this.patch({ focusTarget: { conversationId, seq, token } });
        return true;
    }

    /**
     * Scrolls the open conversation to the newest message the user sent themself — what scrolling
     * can't find once an agent has run for hours. Pages back until one is loaded (bounded like
     * focusMessage). Resolves false when there is none to land on; the transcript stays put.
     */
    public async jumpToLastOwnMessage(): Promise<boolean> {
        const conversationId = this.state.selectedConversationId;
        if (!conversationId || this.state.trackerView) return false;
        const token = ++this.focusToken;
        this.focusOwner = "lastOwnMessage";
        const found = (): boolean => newestOwnMessageSeq(this.state.events) !== undefined;
        if (!(await this.pageHistoryUntil(conversationId, token, found))) return false;
        const seq = newestOwnMessageSeq(this.state.events);
        if (seq === undefined) return false;
        this.patch({ focusTarget: { conversationId, seq, token } });
        return true;
    }

    /** The timeline landed on (or gave up on) the target handed over with `token`. */
    public clearFocusTarget(token: number): void {
        if (this.state.focusTarget?.token === token) this.patch({ focusTarget: undefined });
    }

    // ── Find in chat ────────────────────────────────────────────────────────

    /**
     * Ctrl/⌘F: opens the search bar over the open conversation with nothing searched yet, or —
     * with the bar already up — keeps its search and asks for the field to take focus again.
     */
    public openChatSearch(): void {
        const conversationId = this.state.selectedConversationId;
        if (!conversationId || this.state.trackerView) return;
        const current = this.state.chatSearch;
        this.patch({
            chatSearch:
                current?.conversationId === conversationId
                    ? { ...current, focusTick: current.focusTick + 1 }
                    : {
                          conversationId,
                          query: "",
                          matchSeqs: [],
                          index: 0,
                          loading: false,
                          failed: false,
                          focusTick: 1,
                      },
        });
    }

    /**
     * Searches one conversation (the open one unless `conversationId` says otherwise, which it then
     * opens) and jumps to the newest match, paging history back as far as it lies. The journal
     * searches the whole conversation, not just the loaded rows. `startingAt` is the message a
     * sidebar search result showed: the jump lands there instead, and it counts among the matches
     * even when the narrower in-chat matching would not have found it. Only leading whitespace is
     * trimmed: a trailing space tells the journal the last word is finished.
     */
    public async beginChatSearch(
        rawQuery: string,
        opts: { conversationId?: string; startingAt?: number } = {},
    ): Promise<void> {
        const query = rawQuery.replace(/^\s+/, "");
        const conversationId = opts.conversationId ?? this.state.selectedConversationId;
        if (!query.trim() || query.length > MESSAGE_SEARCH_MAX_QUERY_LEN || !conversationId || !this.api) return;
        if (this.state.selectedConversationId !== conversationId) {
            await this.selectConversation(conversationId, { suppressNotFound: true });
            if (this.state.selectedConversationId !== conversationId) return;
        } else {
            this.closeTrackerView();
        }
        this.chatSearchAbort?.abort();
        // The previous query's jump, if still paging, must not land while this one searches.
        this.cancelChatSearchFocus();
        const seq = ++this.chatSearchSeq;
        const controller = new AbortController();
        this.chatSearchAbort = controller;
        const focusTick =
            this.state.chatSearch?.conversationId === conversationId ? this.state.chatSearch.focusTick : 0;
        const startingAt = opts.startingAt;
        this.patch({
            chatSearch: { conversationId, query, matchSeqs: [], index: 0, loading: true, failed: false, focusTick },
        });
        const call = this.api.searchConversation(conversationId, query, CHAT_SEARCH_LIMIT, controller.signal);
        void call.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error("timeout"));
                controller.abort();
            }, MESSAGE_SEARCH_TIMEOUT_MS);
        });
        const stale = (): boolean =>
            seq !== this.chatSearchSeq ||
            this.state.chatSearch?.conversationId !== conversationId ||
            this.state.selectedConversationId !== conversationId;
        let matchSeqs: number[];
        let failed = false;
        try {
            matchSeqs = conversationMatchSeqs(await Promise.race([call, timeout]), conversationId);
        } catch {
            matchSeqs = [];
            failed = true;
        } finally {
            clearTimeout(timer!);
            if (this.chatSearchAbort === controller) this.chatSearchAbort = undefined;
        }
        if (stale()) return;
        if (startingAt !== undefined && Number.isSafeInteger(startingAt) && !matchSeqs.includes(startingAt)) {
            matchSeqs = [...matchSeqs, startingAt].sort((a, b) => b - a);
        }
        const index = startingAt === undefined ? 0 : Math.max(0, matchSeqs.indexOf(startingAt));
        this.patch({ chatSearch: { conversationId, query, matchSeqs, index, loading: false, failed, focusTick } });
        if (matchSeqs.length === 0) {
            // "No matches": an earlier query's deep jump still paging must not land afterwards.
            this.cancelChatSearchFocus();
            return;
        }
        // The tracker opened over the conversation meanwhile: landing would close it again.
        if (this.state.trackerView) return;
        await this.focusMessage(conversationId, matchSeqs[index], "search");
    }

    /** Steps to the adjacent match: `older` walks up into history. Stops at either end. */
    public async stepChatSearch(older: boolean): Promise<void> {
        const search = this.state.chatSearch;
        if (!search || search.loading) return;
        const next = search.index + (older ? 1 : -1);
        if (next < 0 || next >= search.matchSeqs.length) return;
        this.patch({ chatSearch: { ...search, index: next } });
        await this.focusMessage(search.conversationId, search.matchSeqs[next], "search");
    }

    /**
     * Closes the bar. The transcript stays where it is, so a search jump still paging is cancelled
     * too — left running, it would scroll the transcript after the user closed search.
     */
    public endChatSearch(): void {
        this.chatSearchSeq += 1;
        this.chatSearchAbort?.abort();
        this.chatSearchAbort = undefined;
        if (this.state.chatSearch) this.patch({ chatSearch: undefined });
        this.cancelChatSearchFocus();
    }

    /** A sidebar search result: open its conversation on the message, with the find bar up. */
    public openSearchHit(hit: SearchHit): void {
        const query = this.state.messageSearch?.query;
        if (query) void this.beginChatSearch(query, { conversationId: hit.convo_id, startingAt: hit.seq });
        else void this.focusMessage(hit.convo_id, hit.seq);
    }

    private cancelChatSearchFocus(): void {
        if (this.focusOwner !== "search") return;
        const token = this.focusToken;
        this.focusToken += 1;
        this.focusOwner = undefined;
        // A target already handed over but not yet landed goes too.
        if (this.state.focusTarget?.token === token) this.patch({ focusTarget: undefined });
    }

    /**
     * Loads older pages of the open conversation until `done()` holds or history runs out, at most
     * FOCUS_MAX_PAGES pages. A page already in flight (the "Load earlier" button) is waited out
     * rather than raced; a failed page stops the walk. Resolves false when the jump was superseded
     * (a newer jump, or another conversation opened) — the caller then lands nothing.
     */
    private async pageHistoryUntil(conversationId: string, token: number, done: () => boolean): Promise<boolean> {
        const current = (): boolean =>
            this.focusToken === token && this.state.selectedConversationId === conversationId;
        let pages = 0;
        let waits = 0;
        while (current() && !done()) {
            if (this.history.get(conversationId)?.hasMore === false) break;
            if (this.state.loadingHistory) {
                if (++waits > FOCUS_MAX_WAITS) break;
                await new Promise((resolve) => setTimeout(resolve, FOCUS_WAIT_MS));
                continue;
            }
            if (pages >= FOCUS_MAX_PAGES) break;
            pages += 1;
            await this.loadOlderHistory({ suppressNotFound: true });
            if (this.historyError) break;
        }
        return current();
    }

    public async sendMessage(bodyInput: string, targetConvoId?: string): Promise<boolean> {
        const body = bodyInput.trim();
        const conversationId = targetConvoId ?? this.state.selectedConversationId;
        if (!body || !conversationId || !this.database) return false;
        if (this.state.selectedConversationId === conversationId && this.isViewingHistoricalWindow(conversationId))
            return false;
        if (this.isChildConvo(conversationId)) return false;
        const db = this.database;
        const gen = this.sessionGen;
        const connection = this.connection;
        const owns = (): boolean => this.sessionGen === gen && this.database === db && this.connection === connection;
        const message: PendingMessage = {
            localId: crypto.randomUUID(),
            convoId: conversationId,
            body,
            createdAt: Date.now(),
        };
        await db.addToOutbox(message); // the only awaited durable step
        if (!owns()) return false;
        if (isStartCommand(body)) {
            const box = this.state.conversations.find((candidate) => candidate.id === conversationId)?.agent_device_id;
            this.startIntents.noteBox(box ?? null, Date.now());
        }
        // sendTick is a synchronous "a send happened → scroll to bottom" signal; bump it now (the
        // message is durably queued) rather than gating it behind the async refresh below.
        if (this.state.selectedConversationId === conversationId) {
            try {
                this.patch({ sendTick: this.state.sendTick + 1 });
            } catch (error) {
                console.warn("matron: post-send state update failed (message still queued)", error);
            }
        }
        // Everything after the durable write is best-effort and must never reject sendMessage or
        // delay its resolution. Otherwise the composer remains retryable despite a queued message.
        void (async () => {
            try {
                await this.refreshSelectedConversation(conversationId);
            } catch (error) {
                console.warn("matron: post-send refresh failed (message still queued)", error);
            }
        })();
        try {
            this.sendPendingMessage(message, connection);
        } catch (error) {
            console.warn("matron: post-send dispatch threw (message still queued)", error);
        }
        return true;
    }

    private buildPendingAttachment(file: File, convoId: string, caption?: string): PendingMessage {
        return {
            localId: crypto.randomUUID(),
            convoId,
            body: "",
            createdAt: Date.now(),
            kind: file.type.startsWith("image/") ? "image" : "file",
            filename: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
            blobRef: null,
            attachState: "uploading",
            ...(caption ? { caption } : {}),
        };
    }

    private async persistPendingAttachment(
        message: PendingMessage,
        file: File,
        db: JournalDatabase,
        gen: number,
    ): Promise<PersistPendingAttachmentOutcome> {
        if (file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES || file.size === 0) {
            message.attachState = "error";
            message.errorKind = file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES ? "browser_memory_limit" : "empty";
            if (!(await this.persistAttachment(message, db, gen))) return { kind: "persist-failed" };
            if (this.sessionGen !== gen) return { kind: "persist-failed" };
            await this.refreshSelectedConversation(message.convoId, db, gen).catch(() => undefined);
            return { kind: "persisted-terminal" };
        }
        this.pendingFiles.set(message.localId, file);
        if (!(await this.persistAttachment(message, db, gen))) return { kind: "persist-failed" };
        if (this.sessionGen !== gen || this.database !== db) return { kind: "persist-failed" };
        return message.attachState === "uploading" ? { kind: "persisted-uploadable" } : { kind: "persisted-terminal" };
    }

    private async runPendingUpload(message: PendingMessage, file: File, owner: AttachmentOwner): Promise<void> {
        if (!this.ownsAttachment(owner, message.localId)) return;
        try {
            await this.uploadPendingAttachment(message, file, owner);
        } catch {
            if (
                !this.ownsAttachment(owner, message.localId) ||
                message.attachState !== "uploading" ||
                this.inFlightUploads.has(message.localId)
            ) {
                return;
            }
            message.attachState = "error";
            message.errorKind = "upload_failed";
            if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
            try {
                await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
            } catch {
                if (
                    this.ownsAttachment(owner, message.localId) &&
                    this.state.selectedConversationId === message.convoId &&
                    !this.isViewingHistoricalWindow(message.convoId)
                ) {
                    const pendingMessages = this.state.pendingMessages.filter(
                        (pending) => pending.localId !== message.localId,
                    );
                    this.patch({ pendingMessages: [...pendingMessages, { ...message, canRetry: true }] });
                }
            }
        }
    }

    /**
     * `"sent"` means the attachment was durably persisted to the outbox and its upload was dispatched,
     * not that delivery was confirmed. Later upload failures resolve here and surface through the
     * standard retryable outbox error tile.
     */
    public async sendAttachment(
        file: File,
        convoId: string,
        caption?: string,
        sessionGen = this.sessionGen,
    ): Promise<"sent" | "persisted-terminal" | "persist-failed" | "skipped"> {
        if (sessionGen !== this.sessionGen) return "skipped";
        const gen = sessionGen;
        const api = this.api;
        const db = this.database;
        if (!api || !db) return "skipped";
        if (this.state.selectedConversationId === convoId && this.isViewingHistoricalWindow(convoId)) return "skipped";
        if (this.isChildConvo(convoId)) return "skipped";
        const owner = { gen, api, db };
        const message = this.buildPendingAttachment(file, convoId, caption);
        const persistOutcome = await this.persistPendingAttachment(message, file, db, gen);
        if (persistOutcome.kind === "persisted-terminal") return "persisted-terminal";
        if (persistOutcome.kind === "persist-failed") return "persist-failed";
        const optimisticRefresh = this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
        await Promise.all([optimisticRefresh, this.runPendingUpload(message, file, owner)]);
        return "sent";
    }

    /**
     * `caption` is the composer's typed draft sent with the voice note: the agent gets the typed text,
     * then the transcript, in one turn.
     */
    public async sendVoiceNote(
        blob: Blob,
        convoId?: string,
        sessionGen = this.sessionGen,
        caption?: string,
    ): Promise<"sent" | "persisted-terminal" | "persist-failed" | "skipped"> {
        if (sessionGen !== this.sessionGen) return "skipped";
        const cid = convoId ?? this.state.selectedConversationId;
        if (!cid || this.isChildConvo(cid) || this.state.archivedIds.has(cid)) return "skipped";
        if (blob.size === 0) return "skipped";

        return await this.sendAttachment(voiceNoteFile(blob), cid, caption?.trim() || undefined, sessionGen);
    }

    public async retryAttachment(localId: string): Promise<void> {
        if (this.dismissedAttachments.has(localId) || this.retryingAttachments.has(localId)) return;
        this.retryingAttachments.add(localId);
        try {
            await this.runAttachmentOperation(localId, async () => {
                if (this.dismissedAttachments.has(localId)) return;
                const gen = this.sessionGen;
                const api = this.api;
                const db = this.database;
                if (!api || !db) return;
                const owner = { gen, api, db };

                const outbox = await db.outbox();
                if (!this.ownsAttachment(owner, localId)) return;
                const message =
                    outbox.find((candidate) => candidate.localId === localId) ??
                    this.transientAttachmentErrors.get(localId);
                if (!message || message.attachState !== "error") return;
                delete message.canRetry;
                if (this.isChildConvo(message.convoId)) {
                    this.markChildBlocked(message);
                    if (!(await this.persistAttachment(message, db, gen))) return;
                    if (!this.ownsAttachment(owner, localId)) return;
                    await this.refreshSelectedConversation(message.convoId, db, gen);
                    return;
                }
                if (this.state.selectedConversationId === message.convoId) {
                    this.patch({ sendTick: this.state.sendTick + 1 });
                }

                if (
                    message.errorKind === "upload_failed" ||
                    (message.errorKind === "storage_failed" && !message.blobRef)
                ) {
                    const file = this.pendingFiles.get(localId);
                    if (!file) return;
                    message.attachState = "uploading";
                    message.blobRef = null;
                    delete message.errorKind;
                    if (!(await this.persistAttachment(message, db, gen))) return;
                    if (!this.ownsAttachment(owner, localId)) return;
                    await this.refreshSelectedConversation(message.convoId, db, gen);
                    if (!this.ownsAttachment(owner, localId)) return;
                    await this.uploadPendingAttachment(message, file, owner);
                    return;
                }

                if (
                    (message.errorKind === "send_failed" || message.errorKind === "storage_failed") &&
                    message.blobRef
                ) {
                    await this.emitPendingAttachment(message, owner);
                }
            });
        } finally {
            this.retryingAttachments.delete(localId);
        }
    }

    private async uploadPendingAttachment(message: PendingMessage, file: File, owner: AttachmentOwner): Promise<void> {
        if (!this.ownsAttachment(owner, message.localId)) return;

        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), uploadTimeoutMsFor(file.size));
        this.inFlightUploads.set(message.localId, controller);
        this.uploadConvos.set(message.localId, message.convoId);
        let mediaId: string;
        try {
            const bytes = await Promise.race([file.arrayBuffer(), abortPromise(controller.signal)]);
            if (!this.ownsAttachment(owner, message.localId)) return;
            if (this.isChildConvo(message.convoId)) {
                this.markChildBlocked(message);
                if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
                if (!this.ownsAttachment(owner, message.localId)) return;
                await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
                return;
            }
            const response = await owner.api.uploadMedia(bytes, message.contentType ?? file.type, controller.signal);
            if (!this.ownsAttachment(owner, message.localId)) return;
            if (typeof response.media_id !== "string" || response.media_id.trim() === "") {
                throw new Error("The journal server returned a malformed media response.");
            }
            mediaId = response.media_id;
        } catch (error) {
            if (!this.ownsAttachment(owner, message.localId)) return;
            if (this.isChildConvo(message.convoId)) {
                this.markChildBlocked(message);
                if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
                if (!this.ownsAttachment(owner, message.localId)) return;
                await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
                return;
            }
            message.blobRef = null;
            message.attachState = "error";
            message.errorKind =
                error instanceof JournalApiError &&
                (error.code === "too_large" || error.code === "empty" || error.code === "electron_binary_unsupported")
                    ? error.code
                    : "upload_failed";
            message.errorMessage =
                error instanceof JournalApiError && error.code === "electron_binary_unsupported"
                    ? error.message
                    : undefined;
            if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
            if (message.errorKind !== "upload_failed") this.pendingFiles.delete(message.localId);
            if (!this.ownsAttachment(owner, message.localId)) return;
            await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
            if (!this.ownsAttachment(owner, message.localId)) return;
            return;
        } finally {
            window.clearTimeout(timer);
            if (this.inFlightUploads.get(message.localId) === controller) {
                this.inFlightUploads.delete(message.localId);
                this.uploadConvos.delete(message.localId);
            }
        }

        message.blobRef = mediaId;
        await this.emitPendingAttachment(message, owner);
    }

    private attachmentPayload(message: PendingMessage): Record<string, unknown> {
        return {
            blob_ref: message.blobRef,
            name: message.filename,
            filename: message.filename,
            content_type: message.contentType,
            size: message.size,
            local_id: message.localId,
            ...(message.caption ? { caption: message.caption } : {}),
            // Absent for a lone attachment, so its frame is exactly what an older bridge expects.
            ...(message.batch
                ? {
                      batch_id: message.batch.id,
                      batch_index: message.batch.index,
                      batch_total: message.batch.total,
                  }
                : {}),
        };
    }

    private async emitPendingAttachment(message: PendingMessage, owner: AttachmentOwner): Promise<void> {
        if (this.isChildConvo(message.convoId)) {
            this.markChildBlocked(message);
            if (!this.ownsAttachment(owner, message.localId)) return;
            if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
            if (!this.ownsAttachment(owner, message.localId)) return;
            await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
            return;
        }
        if (!message.blobRef || (message.kind !== "image" && message.kind !== "file")) return;
        if (!this.ownsAttachment(owner, message.localId)) return;

        message.attachState = "sending";
        delete message.errorKind;
        if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
        if (!this.ownsAttachment(owner, message.localId)) return;
        this.pendingFiles.delete(message.localId);
        await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
        if (!this.ownsAttachment(owner, message.localId)) return;

        if (this.dismissedAttachments.has(message.localId)) return;
        // Re-check child state immediately before egress — no await follows, so this synchronous check
        // and the send are atomic w.r.t. in-memory state. The convo may have transitioned to a read-only
        // child during the awaits above (concurrent convo_meta / snapshot refresh) after the entry check
        // at line 701. Defense-in-depth last line; authoritative read-only enforcement is server-side
        // — a documented server follow-up). (ship-review B1)
        if (this.isChildConvo(message.convoId)) {
            this.markChildBlocked(message);
            if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
            if (!this.ownsAttachment(owner, message.localId)) return;
            await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
            return;
        }
        const ok = this.connection?.send({
            op: "send",
            convo_id: message.convoId,
            type: message.kind,
            blob_ref: message.blobRef,
            payload: this.attachmentPayload(message),
            local_id: message.localId,
        });
        if (ok === true) return;

        message.attachState = "error";
        message.errorKind = "send_failed";
        if (!this.ownsAttachment(owner, message.localId)) return;
        if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
        if (!this.ownsAttachment(owner, message.localId)) return;
        await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
        if (!this.ownsAttachment(owner, message.localId)) return;
    }

    public async attachFiles(files: File[]): Promise<void> {
        const gen = this.sessionGen;
        const convoId = this.state.selectedConversationId;
        if (!convoId) return;

        for (const file of files) {
            if (this.sessionGen !== gen) break;
            try {
                await this.sendAttachment(file, convoId);
            } catch {
                // Continue so one failed attachment does not block the rest of the batch.
            }
        }
    }

    /**
     * Adds files to a conversation's attachment tray (the selected one by default). Picking, pasting
     * and dropping all land here; nothing uploads until the user sends.
     */
    public stageFiles(files: File[], convoId = this.state.selectedConversationId): void {
        if (files.length === 0 || !convoId || this.isChildConvo(convoId)) return;
        if (this.isViewingHistoricalWindow(convoId)) return;
        const added = files.map((file): ComposerAttachment => {
            const unsendable =
                file.size === 0
                    ? "That file is empty."
                    : file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES
                      ? "Too large for this browser to upload."
                      : undefined;
            return unsendable
                ? { id: crypto.randomUUID(), file, state: "failed", error: unsendable, unsendable: true }
                : { id: crypto.randomUUID(), file, state: "staged" };
        });
        this.setTray(convoId, [...this.trayOf(convoId), ...added]);
    }

    /** Takes one file out of the tray. A file already part of a send in flight stays. */
    public removeStagedFile(convoId: string, id: string): void {
        const tray = this.trayOf(convoId);
        const item = tray.find((candidate) => candidate.id === id);
        if (!item || item.state === "queued" || item.state === "uploading") return;
        this.setTray(
            convoId,
            tray.filter((candidate) => candidate.id !== id),
        );
    }

    /**
     * Sends a conversation's tray with the composer text, as one turn: the files upload one at a
     * time, each followed by its media frame. The text rides on the first as its caption (once, so
     * the agent doesn't read it per file), and with more than one file every frame carries the same
     * batch tag, so the bridge hands them to the agent together.
     *
     * Stops at the first failed upload: a later file sent without the earlier one it goes with would
     * reach the agent out of context. The failed file and the ones after it stay in the tray, keeping
     * their batch tags, and the next send retries them. `captionDelivered` says whether the text went
     * out with a file that made it, so the composer knows whether to put it back.
     */
    public async sendStagedFiles(
        convoId: string,
        caption: string,
    ): Promise<{ outcome: "sent" | "failed" | "skipped"; captionDelivered: boolean }> {
        const skipped = { outcome: "skipped" as const, captionDelivered: false };
        const gen = this.sessionGen;
        const api = this.api;
        const db = this.database;
        if (!api || !db || this.isChildConvo(convoId) || !this.stagedConvoValid(convoId)) return skipped;
        const tray = this.trayOf(convoId);
        if (
            tray.length === 0 ||
            tray.some((item) => item.unsendable || item.state === "queued" || item.state === "uploading")
        ) {
            return skipped;
        }
        // Fresh tags only across files that haven't failed out of an earlier send, and only when
        // there is more than one: a lone file goes untagged, and a retried one keeps its own tag.
        const untagged = tray.filter((item) => !item.batch);
        const batchId = untagged.length > 1 ? crypto.randomUUID() : undefined;
        let freshIndex = 0;
        const plan = tray.map((item) => ({
            id: item.id,
            file: item.file,
            batch: item.batch ?? (batchId ? { id: batchId, index: ++freshIndex, total: untagged.length } : undefined),
        }));
        const planned = new Set(plan.map((step) => step.id));
        this.setTray(
            convoId,
            tray.map((item) =>
                planned.has(item.id) ? { ...item, state: "queued", progress: undefined, error: undefined } : item,
            ),
        );
        if (this.state.selectedConversationId === convoId) this.patch({ sendTick: this.state.sendTick + 1 });

        const owner: AttachmentOwner = { gen, api, db };
        try {
            return await this.runStagedSend(convoId, plan, caption.trim(), owner);
        } finally {
            // Whatever way the send ended, no file of it may stay stuck as queued or uploading:
            // anything still in the tray goes back to staged with its batch tag, ready to retry.
            if (this.sessionGen === gen) {
                const batches = new Map(plan.map((step) => [step.id, step.batch]));
                const tray = this.trayOf(convoId);
                if (
                    tray.some((item) => batches.has(item.id) && (item.state === "queued" || item.state === "uploading"))
                ) {
                    this.setTray(
                        convoId,
                        tray.map((item): ComposerAttachment => {
                            if (!batches.has(item.id) || (item.state !== "queued" && item.state !== "uploading")) {
                                return item;
                            }
                            const batch = batches.get(item.id);
                            return { id: item.id, file: item.file, state: "staged", ...(batch ? { batch } : {}) };
                        }),
                    );
                }
            }
        }
    }

    private async runStagedSend(
        convoId: string,
        plan: { id: string; file: File; batch?: AttachmentBatchTag }[],
        text: string,
        owner: AttachmentOwner,
    ): Promise<{ outcome: "sent" | "failed" | "skipped"; captionDelivered: boolean }> {
        const { gen, api, db } = owner;
        let captionDelivered = false;
        for (const [index, step] of plan.entries()) {
            if (this.sessionGen !== gen || this.api !== api || this.database !== db) {
                return { outcome: "skipped", captionDelivered };
            }
            let mediaId: string;
            try {
                if (this.isChildConvo(convoId)) throw new Error("Can't send to a read-only subagent transcript.");
                if (!this.stagedConvoValid(convoId)) throw new Error("This conversation was archived.");
                this.updateStaged(convoId, step.id, { state: "uploading", progress: 0 });
                mediaId = await this.uploadStagedFile(convoId, step.id, step.file, api);
            } catch (error) {
                if (this.sessionGen !== gen) return { outcome: "skipped", captionDelivered };
                const unsent = new Map(plan.slice(index).map((later) => [later.id, later.batch]));
                this.setTray(
                    convoId,
                    this.trayOf(convoId).map((item): ComposerAttachment => {
                        if (!unsent.has(item.id)) return item;
                        const batch = unsent.get(item.id);
                        const kept: ComposerAttachment = { id: item.id, file: item.file, state: "staged" };
                        if (batch) kept.batch = batch;
                        if (item.id === step.id) {
                            kept.state = "failed";
                            kept.error = stagedUploadError(error);
                        }
                        return kept;
                    }),
                );
                return { outcome: "failed", captionDelivered };
            }
            const message = this.buildPendingAttachment(step.file, convoId, index === 0 ? text : undefined);
            message.blobRef = mediaId;
            if (step.batch) message.batch = step.batch;
            // Out of the tray as it joins the timeline, so the two never show the same file.
            this.setTray(
                convoId,
                this.trayOf(convoId).filter((item) => item.id !== step.id),
            );
            // From here the outbox owns it: a failed frame becomes a retryable tile in the timeline,
            // and the text is with it either way.
            if (message.caption) captionDelivered = true;
            try {
                await this.emitPendingAttachment(message, owner);
            } catch (error) {
                console.warn("matron: attachment frame not dispatched", error);
                return { outcome: "failed", captionDelivered };
            }
        }
        return { outcome: "sent", captionDelivered };
    }

    private trayOf(convoId: string): ComposerAttachment[] {
        return this.state.composerAttachments[convoId] ?? [];
    }

    private setTray(convoId: string, items: ComposerAttachment[]): void {
        const next = { ...this.state.composerAttachments };
        if (items.length > 0) next[convoId] = items;
        else delete next[convoId];
        this.patch({ composerAttachments: next });
    }

    private updateStaged(convoId: string, id: string, change: Partial<ComposerAttachment>): void {
        const tray = this.trayOf(convoId);
        if (!tray.some((item) => item.id === id)) return;
        this.setTray(
            convoId,
            tray.map((item) => (item.id === id ? { ...item, ...change } : item)),
        );
    }

    private async uploadStagedFile(convoId: string, id: string, file: File, api: JournalApi): Promise<string> {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), uploadTimeoutMsFor(file.size));
        // Tracked with the outbox uploads, so signing out or the conversation turning into a
        // read-only subagent transcript aborts it too.
        this.inFlightUploads.set(id, controller);
        this.uploadConvos.set(id, convoId);
        try {
            const bytes = await Promise.race([file.arrayBuffer(), abortPromise(controller.signal)]);
            const response = await api.uploadMedia(
                bytes,
                file.type || "application/octet-stream",
                controller.signal,
                (fraction) => this.updateStaged(convoId, id, { progress: fraction }),
            );
            if (typeof response.media_id !== "string" || response.media_id.trim() === "") {
                throw new Error("The journal server returned a malformed media response.");
            }
            return response.media_id;
        } finally {
            window.clearTimeout(timer);
            if (this.inFlightUploads.get(id) === controller) {
                this.inFlightUploads.delete(id);
                this.uploadConvos.delete(id);
            }
        }
    }

    private stagedConvoValid(convoId: string): boolean {
        return (
            this.state.conversations.some((conversation) => conversation.id === convoId) &&
            !this.state.archivedIds.has(convoId)
        );
    }

    public async dismissAttachment(localId: string): Promise<void> {
        this.dismissedAttachments.add(localId);
        this.inFlightUploads.get(localId)?.abort();
        const gen = this.sessionGen;
        const db = this.database;
        if (!db) return;

        await this.runAttachmentOperation(localId, async () => {
            await db.deleteOutboxRow(localId);
            if (this.sessionGen !== gen || this.database !== db) return;
            this.pendingFiles.delete(localId);
            this.transientAttachmentErrors.delete(localId);
            const conversationId = this.state.selectedConversationId;
            if (conversationId) await this.refreshSelectedConversation(conversationId, db, gen);
        });
    }

    public sendPromptReply(targetSeq: number, choice?: string, text?: string): boolean {
        const conversationId = this.state.selectedConversationId;
        if (!conversationId) return false;
        if (this.state.viewingHistoryWindow || this.isViewingHistoricalWindow(conversationId)) return false;
        if (this.isChildConvo(conversationId)) return false;
        const sent =
            this.connection?.send({
                op: "prompt_reply",
                convo_id: conversationId,
                target_seq: targetSeq,
                choice: choice ?? null,
                text: text ?? null,
            }) ?? false;
        if (!sent) this.patch({ connectionError: "Reconnect before answering this prompt." });
        return sent;
    }

    // House pattern: components talk to the client, not JournalApi directly. Errors (notably
    // JournalApiError with `.status` 409/404) are rethrown unchanged for the card's state machine.
    public async answerAgentSpawn(
        requestId: string,
        decision: "approve" | "deny",
        signal?: AbortSignal,
    ): Promise<void> {
        const conversationId = this.state.selectedConversationId;
        if (conversationId && (this.state.viewingHistoryWindow || this.isViewingHistoricalWindow(conversationId))) {
            throw new Error("Jump to latest to answer this request.");
        }
        if (!this.api) throw new Error("Not signed in.");
        await this.api.answerAgentSpawn(requestId, decision, signal);
    }

    /**
     * Answers the agent-spawn ask a consent item stands for, through the same call as the card in
     * the conversation, then refetches the item if it is still the one open: the journal closes it
     * once the ask is decided, and after a 409 (answered elsewhere, or expired) the copy that still
     * offered the buttons was stale. Errors are rethrown unchanged for the card's state machine.
     */
    public async answerSpawnConsent(
        itemNum: number,
        requestId: string,
        decision: "approve" | "deny",
        signal?: AbortSignal,
    ): Promise<void> {
        try {
            await this.answerAgentSpawn(requestId, decision, signal);
        } catch (error) {
            if (error instanceof JournalApiError && error.status === 409) this.refreshSelectedItem(itemNum);
            throw error;
        }
        this.refreshSelectedItem(itemNum);
    }

    private refreshSelectedItem(itemNum: number): void {
        if (this.isSelectedTrackerItem(itemNum)) void this.loadItem(itemNum);
    }

    /**
     * The agent-spawn ask a consent item stands for, as the conversation that asked tells it: the
     * card's own event and its outcome. Read from the local store. A conversation this device has
     * not opened may not hold the card yet, so the first miss fetches that conversation's latest
     * history page once (per conversation and session) and looks again. Never throws: a store or
     * network failure reads as "not here", which the item shows as a card that has not arrived.
     */
    public async spawnConsentRows(convoId: string, requestId: string): Promise<SpawnConsentRows> {
        const database = this.database;
        const none: SpawnConsentRows = { request: null, outcome: null };
        if (!database || !convoId || !requestId) return none;
        let rows: SpawnConsentRows;
        try {
            rows = spawnConsentRowsIn(await database.events(convoId), requestId);
        } catch {
            return none;
        }
        const api = this.api;
        if (rows.request || !api) return rows;
        const fetchKey = `${this.sessionGen}:${convoId}`;
        let fetch = this.consentHistoryFetches.get(fetchKey);
        if (!fetch) {
            fetch = (async (): Promise<void> => {
                const response = await api.messages(convoId);
                if (this.database === database && this.api === api) await database.putHistory(response.events);
            })();
            this.consentHistoryFetches.set(fetchKey, fetch);
            fetch.catch(() => {
                if (this.consentHistoryFetches.get(fetchKey) === fetch) this.consentHistoryFetches.delete(fetchKey);
            });
        }
        try {
            await fetch;
            if (this.database !== database) return rows;
            return spawnConsentRowsIn(await database.events(convoId), requestId);
        } catch {
            return rows;
        }
    }

    public async answerAgentChat(
        roomId: string,
        targetDeviceId: number,
        decision: "approve" | "deny",
        signal?: AbortSignal,
    ): Promise<boolean> {
        if (!this.api) throw new Error("Not signed in.");
        return this.api.answerAgentChat(roomId, targetDeviceId, decision, signal);
    }

    // Concurrent callers for the same id (the viewer body and its DownloadLink mount in the
    // same commit) share one in-flight request: without the dedupe map each miss fetched the
    // blob again and the loser's object URL was overwritten in the cache — never revoked, a
    // permanent leak of the whole blob.
    public mediaUrl(mediaId: string): Promise<string> {
        const cached = this.mediaUrls.get(mediaId);
        if (cached) return Promise.resolve(cached);
        if (this.expiredMedia.has(mediaId)) return Promise.reject(new JournalApiError("Media expired", 404));
        const inflight = this.mediaUrlRequests.get(mediaId);
        if (inflight) return inflight;
        const api = this.api;
        if (!api) return Promise.reject(new Error("Not signed in"));
        const gen = this.sessionGen;
        const request = (async (): Promise<string> => {
            try {
                const blob = await api.media(mediaId);
                const url = URL.createObjectURL(blob);
                if (this.sessionGen !== gen) {
                    // Signed out mid-fetch: the teardown that revokes cached URLs already ran,
                    // so caching now would leak this one into the next session.
                    URL.revokeObjectURL(url);
                    throw new Error("Not signed in");
                }
                this.mediaUrls.set(mediaId, url);
                return url;
            } catch (error) {
                if (isMediaExpiredError(error) && this.sessionGen === gen) this.expiredMedia.add(mediaId);
                throw error;
            } finally {
                this.mediaUrlRequests.delete(mediaId);
            }
        })();
        this.mediaUrlRequests.set(mediaId, request);
        return request;
    }

    /** Whether a fetch for this blob already came back 404 (reaped server-side). */
    public isMediaExpired(mediaId: string): boolean {
        return this.expiredMedia.has(mediaId);
    }

    public selectedConversation(): Conversation | undefined {
        return this.state.conversations.find((conversation) => conversation.id === this.state.selectedConversationId);
    }

    // ── Files pane (Phase 1b) ───────────────────────────────────────────────────────────────
    // The session-scoped file API, built lazily. Returns undefined when signed out. The fixture
    // harness overrides this method with a mock (mirrors how it stubs mediaUrl).
    public filesApi(): FilesApi | undefined {
        const session = this.state.session;
        if (!session) return undefined;
        this.filesApiInstance ??= new FilesApi(session.serverUrl, session.token);
        return this.filesApiInstance;
    }

    // Open the Files pane (main-region discriminant). Preserves the selected conversation so
    // closing returns to it. `path` seeds the browsed directory; defaults to the remembered one.
    // `targetFile` (absolute) asks FilesPane to auto-open a preview for that file once its
    // directory listing lands — used by the `#files=<abs>` deep link; omit for a plain open (it
    // then clears any stale target so a later plain open doesn't re-trigger a previous deep link).
    public openFilesView(path?: string, targetFile?: string): void {
        // Symmetric to openTrackerView closing Files: one main-region surface at a time, so
        // opening Files closes the tracker (the tracker takes render precedence otherwise).
        this.closeTrackerView();
        this.closeOpsView();
        // Bump the invocation token whenever a target is supplied, so re-opening the SAME file (e.g.
        // the operator clicks the same deep link again after browsing elsewhere) is a distinct
        // invocation FilesPane will act on, not a no-op deduped by the unchanged path string.
        const targetToken = targetFile ? (this.state.filesView?.targetToken ?? 0) + 1 : undefined;
        this.patch({ filesView: { open: true, path: path ?? this.state.filesView?.path, targetFile, targetToken } });
    }

    public closeFilesView(): void {
        if (!this.state.filesView) return;
        this.patch({ filesView: undefined });
    }

    // Persist the last-browsed directory so a reopen returns there. No-op when the pane is closed.
    // Preserves the deep-link `targetFile` so persisting the server-normalized directory does not
    // wipe a target that FilesPane has not yet had a chance to select.
    public setFilesPath(path: string): void {
        if (!this.state.filesView?.open) return;
        if (this.state.filesView.path === path) return;
        this.patch({
            filesView: {
                open: true,
                path,
                targetFile: this.state.filesView.targetFile,
                targetToken: this.state.filesView.targetToken,
            },
        });
    }

    // Hash-based deep link into the Files pane: `#files=<url-encoded-absolute-path>`. Opens the
    // pane at the file's directory and asks FilesPane to auto-preview it, then CLEARS the hash so a
    // refresh or back-button does not re-trigger. No token — auth is the operator's existing web
    // session, exactly like every other Files read. Called at bootstrap (after sign-in) and on
    // every `hashchange`, so clicking a bridge-minted link into an already-open app just works with
    // no reload. A malformed or non-absolute payload is ignored (hash left as-is for inspection).
    public applyFilesDeepLink(): void {
        if (typeof window === "undefined") return;
        const hash = window.location.hash || "";
        const match = /^#files=(.*)$/.exec(hash);
        if (!match) return;
        let abs: string;
        try {
            abs = decodeURIComponent(match[1]);
        } catch {
            return; // malformed percent-encoding — leave the hash for the operator to see
        }
        if (!abs || !abs.startsWith("/")) return;
        // Only meaningful once signed in (the pane renders only then); leave the hash otherwise so
        // it can be re-applied on the next hashchange once the session is up.
        if (this.state.phase !== "signed-in") return;
        const slash = abs.lastIndexOf("/");
        const dir = abs.slice(0, Math.max(1, slash));
        this.openFilesView(dir, abs);
        // Clear the fragment without a history entry so refresh/back does not re-fire the deep link.
        try {
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
        } catch {
            window.location.hash = "";
        }
    }

    /** Every hash deep link the app understands. Each applier ignores a hash that is not its own. */
    public applyDeepLinks(): void {
        this.applyFilesDeepLink();
        this.applyWorkDeepLink();
    }

    // Hash-based deep link into the tracker's Work tab: `#work` opens the list, `#work=<loop id>`
    // opens that loop's detail. Same lifecycle as `#files=`: applied after sign-in and on every
    // hashchange, left in place while signed out so it is honoured once the session is up, and
    // cleared once applied so a refresh or back-button does not re-fire it.
    public applyWorkDeepLink(): void {
        if (typeof window === "undefined") return;
        const match = /^#work(?:=(\d+))?$/.exec(window.location.hash || "");
        if (!match) return;
        const loopId = match[1] === undefined ? null : Number(match[1]);
        // A malformed id is left in place for inspection, exactly like a malformed #files= link.
        if (loopId !== null && (!Number.isSafeInteger(loopId) || loopId < 1)) return;
        if (this.state.phase !== "signed-in") return;
        this.openTrackerLoop(loopId);
        try {
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
        } catch {
            window.location.hash = "";
        }
    }

    // ── Tracker pane (Missions / Milestones / Decisions-Inbox / Work) ───────────────
    // The tracker shares the main region with the Files pane and the conversation view —
    // one surface at a time — so opening it closes Files (mirrors how Files closes over the
    // conversation view). `trackerView` is the discriminant; the list/detail data is
    // store-resident (loaded lazily by the load* helpers below, invalidated over WS).

    // `itemId`/`missionId`: a number selects that row; `null` explicitly CLEARS that selection
    // (mutual exclusion — see openTrackerItem/openTrackerMission); `undefined` preserves the prev
    // selection. `null ?? prev` would resolve to prev, so the clear needs the explicit === null arm.
    public openTrackerView(
        opts: {
            view?: "missions" | "inbox" | "work" | "memories";
            itemId?: number | null;
            missionId?: number | null;
            loopId?: number | null;
            memoryName?: string | null;
            projectId?: number | null;
            /** true opens the latest briefing in full (Projects view); false closes it. */
            briefing?: boolean;
        } = {},
    ): void {
        this.closeFilesView();
        this.closeOpsView();
        const prev = this.state.trackerView;
        const view = opts.view ?? prev?.view ?? "inbox";
        // An open briefing survives only an update in the same view that touches no other
        // selection: a tab switch or a detail's back button (which clear selections with null)
        // closes it too.
        const selecting =
            opts.itemId !== undefined ||
            opts.missionId !== undefined ||
            opts.memoryName !== undefined ||
            opts.projectId !== undefined;
        const briefingOpen =
            opts.briefing !== undefined
                ? opts.briefing || undefined
                : !selecting && view === prev?.view
                  ? prev?.briefingOpen
                  : undefined;
        const next: TrackerViewState = {
            open: true,
            view,
            selectedItemId: opts.itemId === null ? undefined : (opts.itemId ?? prev?.selectedItemId),
            selectedMissionId: opts.missionId === null ? undefined : (opts.missionId ?? prev?.selectedMissionId),
            selectedLoopId: opts.loopId === null ? undefined : (opts.loopId ?? prev?.selectedLoopId),
            selectedMemoryName: opts.memoryName === null ? undefined : (opts.memoryName ?? prev?.selectedMemoryName),
            selectedProjectId: opts.projectId === null ? undefined : (opts.projectId ?? prev?.selectedProjectId),
            ...(briefingOpen ? { briefingOpen } : {}),
        };
        // Omit an absent selection rather than carrying `key: undefined`, so a plain view switch
        // leaves the state shape exactly as it was before loop selection existed.
        if (next.selectedLoopId === undefined) delete next.selectedLoopId;
        if (next.selectedMemoryName === undefined) delete next.selectedMemoryName;
        // The tracker covers the transcript: a jump still paging history is dropped, and a target
        // not yet landed is withdrawn, or returning to the conversation would flash a jump the
        // user has since left.
        this.focusToken += 1;
        this.patch({ trackerView: next, ...(this.state.focusTarget ? { focusTarget: undefined } : {}) });
    }

    /** Open the Work tab, on a loop's detail when `loopId` is a number, else on the list. */
    public openTrackerLoop(loopId: number | null): void {
        this.openTrackerView({ view: "work", loopId, itemId: null, missionId: null, memoryName: null });
    }

    // Memories view entry points: a name opens that memory's editor, "" opens the new-memory form,
    // and closeTrackerMemory returns to the list. Item and mission selections are cleared so the
    // pane's item-first precedence cannot shadow the memory (same rule as openTrackerItem).
    public openTrackerMemory(name: string): void {
        if (this.state.trackerItem) this.patch({ trackerItem: null });
        if (this.state.trackerMission) this.patch({ trackerMission: null });
        this.openTrackerView({
            view: "memories",
            memoryName: name,
            itemId: null,
            missionId: null,
            loopId: null,
            projectId: null,
        });
    }

    public closeTrackerMemory(): void {
        this.openTrackerView({ view: "memories", memoryName: null });
    }

    // Closing drops the cached item and mission details (and orphans any in-flight load of them):
    // markers are not followed while the pane is closed, so a record kept across a close could reopen
    // showing a status, and live actions, that another client has since changed.
    public closeTrackerView(): void {
        if (!this.state.trackerView) return;
        this.trackerItemGen += 1;
        this.trackerMissionGen += 1;
        this.trackerProjectGen += 1;
        this.patch({ trackerView: undefined, trackerItem: null, trackerMission: null, trackerProject: null });
    }

    // ── Ops pane ───────────────────────────────────────────────
    // Boxes, quotas, host, alerts, timers, usage. Same one-surface-at-a-time rule as Files and the
    // tracker. Its data is fetched by the pane on open (GET /devices, GET /metrics, and one
    // `ops_snapshot` agent RPC per section); only live `box_status` reports land in the store.

    public openOpsView(): void {
        this.closeFilesView();
        this.closeTrackerView();
        if (this.state.opsView?.open) return;
        this.patch({ opsView: { open: true } });
    }

    public closeOpsView(): void {
        if (!this.state.opsView) return;
        this.patch({ opsView: undefined });
    }

    /** Journal health for the Ops page; null when the server has no /metrics or it failed. */
    public async journalMetrics(): Promise<JournalMetrics | null> {
        if (!this.api) return null;
        try {
            return await this.api.metrics();
        } catch {
            return null;
        }
    }

    /** One `ops_snapshot` section from a box, mapped onto the page's section state. Read-only. */
    public async opsSnapshot<S extends OpsSection>(agentDeviceId: number, section: S): Promise<OpsSectionState<S>> {
        const reply = await this.agentRpc(agentDeviceId, "ops_snapshot", { section });
        return sectionStateFromReply(section, reply);
    }

    // Deep-link / row-tap entry points: select the row (last-tap-wins) and switch to its view.
    // The pane's own effect issues the matching load* call when the selection changes.
    // Selecting a DIFFERENT row invalidates the cached detail up front (→ null) so the previously
    // loaded record can never be rendered — nor have its action handlers (reply/close/reopen) fire —
    // against the new selection before the loader replaces it (F1). Re-selecting the same row keeps
    // the cache so it doesn't flash.
    // `keepProject`: an item opened from a project page keeps that project selected, so the item's
    // back button can return to it (the view switch still clears it).
    public openTrackerItem(num: number, opts: { keepProject?: boolean } = {}): void {
        if (this.state.trackerItem && this.state.trackerItem.item.num !== num) {
            this.patch({ trackerItem: null });
        }
        // Item and mission selection are MUTUALLY EXCLUSIVE — the pane shows one detail at a time and
        // gives the item precedence. Opening an item must clear any prior mission selection AND its
        // cached detail, or a cross-kind deep link (mission→item) would leave the stale mission
        // selected/rendered and shadow the item just opened (F3).
        if (this.state.trackerMission) this.patch({ trackerMission: null });
        this.openTrackerView({
            view: "inbox",
            itemId: num,
            missionId: null,
            projectId: opts.keepProject ? undefined : null,
        });
    }

    /** Opens a project page on the Projects view (the tracker's "missions" view key). */
    public openTrackerProject(num: number): void {
        if (this.state.trackerProject && this.state.trackerProject.project.num !== num) {
            this.patch({ trackerProject: null });
        }
        if (this.state.trackerItem) this.patch({ trackerItem: null });
        if (this.state.trackerMission) this.patch({ trackerMission: null });
        this.openTrackerView({ view: "missions", projectId: num, missionId: null, itemId: null });
    }

    public openTrackerMission(num: number): void {
        if (this.state.trackerMission && this.state.trackerMission.mission?.num !== num) {
            this.patch({ trackerMission: null });
        }
        // Symmetric to openTrackerItem — clear any item selection + cache so an item→mission deep
        // link can't leave the item selected and win the pane's item-first precedence (F3).
        if (this.state.trackerItem) this.patch({ trackerItem: null });
        this.openTrackerView({ view: "missions", missionId: num, itemId: null, projectId: null });
    }

    // One in-app handler for `matron://item|mission|project/<N>` and `matron://convo/<id>` markdown
    // deep links (markdown.tsx parseMatronHref), shared by the timeline and every tracker Markdown
    // call site so a valid link is always activatable (F6) — never rendered inert or stripped.
    // A project link opens that project's page (openTrackerProject).
    public openTrackerLink(kind: MatronLinkKind, target: number | string): void {
        if (kind === "link") {
            if (typeof target !== "string") return;
            const link = parseOwnTrackerUrl(target);
            const user = this.state.session?.username;
            // Another user's number would open the wrong row here, so it opens as a web page.
            if (link && user && link.user.toLowerCase() === user.toLowerCase()) void this.openLinkedNumber(link.num);
            else window.open(target, "_blank", "noopener,noreferrer");
            return;
        }
        if (kind === "convo") {
            if (typeof target === "string" && target) void this.selectConversation(target, { suppressNotFound: true });
            return;
        }
        const num = typeof target === "number" ? target : Number(target);
        if (!Number.isSafeInteger(num) || num <= 0) return;
        if (kind === "item") this.openTrackerItem(num);
        else if (kind === "mission") this.openTrackerMission(num);
        else this.openTrackerProject(num);
    }

    // ── Go to number ────────────────────────────────────────────────────────
    // Items, missions, milestones and projects share one per-user number space, and each kind
    // opens differently, so "go to 412" first asks the journal which kind 412 is.

    public openGoToNumber(): void {
        if (!this.state.goToNumberOpen) this.patch({ goToNumberOpen: true });
    }

    public closeGoToNumber(): void {
        if (this.state.goToNumberOpen) this.patch({ goToNumberOpen: false });
    }

    // ── Subagent side pane and media browser ────────────────────────────────

    /**
     * Opens a subagent from a Subtask line or a subagent pill. With its parent on screen it opens
     * in the pane beside the parent (switching the pane if another subagent is there); from
     * anywhere else, such as a sibling subagent opened on its own, it opens as the conversation.
     */
    public openSubChat(childId: string): void {
        const child = this.state.conversations.find((conversation) => conversation.id === childId);
        const parentId = child?.parent_convo_id;
        if (parentId && parentId === this.state.selectedConversationId && !this.state.trackerView?.open) {
            const open = this.state.subChatPane;
            // One pane beside the chat: the subagent takes the slot from the Tasks pane.
            const tasks = this.state.chatTasks;
            if (open?.parentId !== parentId || open.childId !== childId || tasks?.open) {
                this.patch({
                    subChatPane: { parentId, childId },
                    ...(tasks?.open ? { chatTasks: { ...tasks, open: false } } : {}),
                });
            }
            return;
        }
        void this.selectConversation(childId, { suppressNotFound: true });
    }

    /** Resolves once the open conversation's history page in flight has landed, or once another
     *  conversation is on screen. */
    private historyLoadSettled(conversationId: string): Promise<void> {
        return new Promise((resolve) => {
            const check = (): void => {
                if (this.state.loadingHistory && this.state.selectedConversationId === conversationId) return;
                unsubscribe();
                resolve();
            };
            const unsubscribe = this.subscribe(check);
            check();
        });
    }

    public closeSubChat(): void {
        if (this.state.subChatPane) this.patch({ subChatPane: undefined });
    }

    /**
     * Every stored event of a conversation, oldest first: what the side pane and the media browser
     * show for a conversation other than (or as well as) the one on screen. When its history was
     * never loaded, the newest page is fetched first, as opening the conversation would. Never
     * throws: a failed fetch still returns what is stored.
     */
    public async conversationEvents(conversationId: string): Promise<JournalEvent[]> {
        const db = this.database;
        if (!db) return [];
        const api = this.api;
        if (conversationId === this.state.selectedConversationId) {
            // The conversation on screen pages its own history: wait for (or start) its first
            // page there, so the transcript, its "Load earlier" state and its scroll anchor stay
            // in step, rather than fetching the same page beside it.
            if (this.state.loadingHistory) await this.historyLoadSettled(conversationId);
            else if (api && !this.history.get(conversationId)?.initialized) await this.loadOlderHistory();
            return this.database === db ? db.events(conversationId) : [];
        }
        if (api && !this.history.get(conversationId)?.initialized) {
            try {
                const response = await api.messages(conversationId, undefined, HISTORY_PAGE_SIZE);
                if (this.database !== db) return [];
                await db.putHistory(response.events);
                if (!this.history.get(conversationId)?.initialized) {
                    const known = this.state.conversations.find((candidate) => candidate.id === conversationId);
                    const emptyWithKnownHistory = response.events.length === 0 && (known?.last_seq ?? 0) > 0;
                    this.history.set(conversationId, {
                        initialized: !emptyWithKnownHistory,
                        oldestSeq: response.events.reduce<number | undefined>(
                            (current, event) => (current === undefined ? event.seq : Math.min(current, event.seq)),
                            undefined,
                        ),
                        hasMore: emptyWithKnownHistory || response.events.length === HISTORY_PAGE_SIZE,
                        hasMoreNewer: false,
                    });
                }
            } catch {
                // Offline or refused: show what is stored.
            }
        }
        return db.events(conversationId);
    }

    /**
     * Asks the journal what the signed-in user's number `num` is. Never throws: a 404 is `none`
     * (no such number), anything else that goes wrong is `failed`. The payload is checked field
     * by field, since the journal is a separate service that may be older or newer than this app.
     */
    public async lookupNumber(num: number, signal?: AbortSignal): Promise<NumberLookupOutcome> {
        const api = this.api;
        const user = this.state.session?.username;
        if (!api || !user || !Number.isSafeInteger(num) || num <= 0) return { status: "failed" };
        // Bounded like searchMessages: a transport that ignores the abort signal must not leave
        // the field waiting for ever.
        const call = api.lookup(user, num, signal);
        void call.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), NUMBER_LOOKUP_TIMEOUT_MS);
        });
        try {
            const hit = sanitizeNumberLookup(await Promise.race([call, timeout]));
            return hit ? { status: "found", hit } : { status: "failed" };
        } catch (error) {
            if (error instanceof JournalApiError && error.status === 404) return { status: "none" };
            return { status: "failed" };
        } finally {
            clearTimeout(timer!);
        }
    }

    /**
     * Opens what a lookup found; `asked` is the number that was looked up, used when an older
     * journal's answer does not carry the row's own number. A milestone has no page of its own,
     * so it opens the mission it sits on. Returns false when there is nothing to open.
     */
    public openNumberHit(hit: NumberLookup, asked: number): boolean {
        const num = hit.num ?? asked;
        if (hit.kind === "item") this.openTrackerItem(num);
        else if (hit.kind === "mission") this.openTrackerMission(num);
        else if (hit.kind === "project") this.openTrackerProject(num);
        else if (hit.mission) this.openTrackerMission(hit.mission.num);
        else return false;
        return true;
    }

    // ── Coordinator briefing (top of the Projects tab) ──────────────────────

    /** Open the latest briefing in full, in the Projects view (the tracker's "missions" key). */
    public openBriefing(): void {
        if (this.state.trackerItem) this.patch({ trackerItem: null });
        if (this.state.trackerMission) this.patch({ trackerMission: null });
        this.openTrackerView({
            view: "missions",
            itemId: null,
            missionId: null,
            memoryName: null,
            projectId: null,
            briefing: true,
        });
    }

    public closeBriefing(): void {
        this.openTrackerView({ view: "missions", briefing: false });
    }

    /**
     * "Open in chat": the Coordinator conversation the briefing was posted to, landed on the
     * briefing's own message. Without a seq (an older journal) it opens at the tail, where the
     * briefing is unless the Coordinator has said more since.
     */
    public openBriefingInChat(convoId: string, seq?: number): void {
        if (seq !== undefined && Number.isSafeInteger(seq)) void this.focusMessage(convoId, seq);
        else void this.selectConversation(convoId, { suppressNotFound: true });
    }

    // GET /briefings/latest. A 404 means the journal predates briefings: the card stays hidden
    // (unsupported), and no error is shown. Loaders never clear a loaded view on failure.
    // A successful load clears a refused ask's message (busy, couldn't ask): the card now shows the
    // journal's current view, so a later frame, reconnect or return to the dashboard never pairs a
    // new briefing with an old "The Coordinator is busy". `keepRefreshError` is for the 409 path's
    // own refetch, whose message explains why the card is about to go. A 429's `retryAt` stays: it
    // is the journal's own retry time and lapses by itself.
    // ── User settings (GET/PATCH /settings, kept live by `hello_ok` and the `settings` frame) ──

    public async loadSettings(): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.settingsGen;
        try {
            const settings = parseUserSettings(await api.settings());
            if (this.api !== api || this.settingsGen !== gen) return;
            this.patch({
                userSettingsUnsupported: false,
                ...(settings ? { userSettings: settings, userSettingsError: undefined } : {}),
            });
        } catch (error) {
            if (this.api !== api || this.settingsGen !== gen) return;
            // An older journal has no /settings: hide the switches. Any other failure keeps what the
            // hello frame said, so a blip does not take the switch away.
            if (error instanceof JournalApiError && error.status === 404) {
                this.patch({ userSettingsUnsupported: true });
            }
        }
    }

    public setNoticesSetting(notices: boolean): Promise<boolean> {
        return this.saveUserSettings({ notices });
    }

    public setAutoApproveCoordinatorSpawnsSetting(enabled: boolean): Promise<boolean> {
        return this.saveUserSettings({ auto_approve_coordinator_spawns: enabled });
    }

    /** Save a subset, preserving the other switches until the full journal view arrives. */
    private async saveUserSettings(patch: Partial<UserSettings>): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        const previous = this.state.userSettings;
        const gen = ++this.settingsGen;
        this.patch({ userSettings: { ...previous, ...patch }, userSettingsError: undefined });
        try {
            const settings = parseUserSettings(await api.patchSettings(patch));
            if (this.api === api && this.settingsGen === gen && settings) this.patch({ userSettings: settings });
            return true;
        } catch (error) {
            if (this.api === api && this.settingsGen === gen) {
                this.patch({ userSettings: previous, userSettingsError: errorMessage(error) });
            }
            return false;
        }
    }

    // ── Coordinator consent approval (Settings → Coordinator; GET/PUT /coordinator `consent`) ──

    /**
     * GET /coordinator: the switch's value, and the Coordinator conversation. A journal without
     * `consent` leaves the switch hidden.
     */
    public async loadCoordinatorConsent(): Promise<void> {
        const api = this.api;
        if (!api) return;
        const epoch = this.coordinatorConsentEpoch;
        const coordinatorEpoch = this.coordinatorEpoch;
        try {
            const raw = await api.coordinator();
            const enabled = parseCoordinatorConsent(raw);
            // The same answer names the Coordinator conversation (Settings shows it above the switch).
            const id = coordinatorIdIn(raw);
            if (this.api === api && id !== undefined && this.coordinatorEpoch === coordinatorEpoch) {
                this.coordinatorStale = false;
                this.patch({ coordinatorConvoId: id });
            }
            // A write since the GET was sent is newer than its answer.
            if (this.api !== api || this.coordinatorConsentEpoch !== epoch) return;
            this.coordinatorConsentConfirmed = enabled;
            this.patch({ coordinatorConsent: { ...this.state.coordinatorConsent, enabled } });
        } catch {
            // Keep what is shown: a blip must not take the switch away.
        }
    }

    /**
     * PUT /coordinator {consent}. The switch moves at once; a failed write puts it back to the
     * journal's last known value and says why. Writes go one at a time, in tap order, so the
     * journal ends on the last tap, and only the latest write's answer moves the switch.
     */
    public setCoordinatorConsent(enabled: boolean): Promise<void> {
        const api = this.api;
        const current = this.state.coordinatorConsent?.enabled;
        if (!api || current === undefined || current === enabled) return Promise.resolve();
        const epoch = ++this.coordinatorConsentEpoch;
        this.patch({ coordinatorConsent: { enabled, error: undefined } });
        const write = this.coordinatorConsentWrite.then(async () => {
            if (this.api !== api) return;
            try {
                const stored = parseCoordinatorConsent(await api.putCoordinatorConsent(enabled)) ?? enabled;
                if (this.api !== api) return;
                this.coordinatorConsentConfirmed = stored;
                if (this.coordinatorConsentEpoch === epoch) this.patch({ coordinatorConsent: { enabled: stored } });
            } catch (error) {
                if (this.api !== api || this.coordinatorConsentEpoch !== epoch) return;
                this.patch({
                    coordinatorConsent: { enabled: this.coordinatorConsentConfirmed, error: errorMessage(error) },
                });
            }
        });
        this.coordinatorConsentWrite = write;
        return write;
    }

    // ── The Coordinator conversation (rail entry, Settings → Coordinator; /coordinator `convo_id`) ──

    /**
     * GET /coordinator: the user's Coordinator conversation, asked fresh each time. The one lookup
     * for anything that opens the Coordinator (the rail entry, a keyboard shortcut): call it and
     * pass a non-null answer to `selectConversation(id, { suppressNotFound: true })`, or use
     * `openCoordinator()`, rather than reading `/coordinator` again.
     *
     * Resolves to the journal's answer (null = no Coordinator), which also updates
     * `coordinatorConvoId`; when a hello, write or marker landed while the read was in flight, that
     * newer value instead. A failed read falls back to the last known value, so an offline click
     * still opens it. Null for a signed-out client, or a failed read with nothing known.
     */
    public async coordinatorConversationId(): Promise<string | null> {
        const api = this.api;
        if (!api) return null;
        // A `coordinator` marker only says the value changed: an answer it overtook is asked again
        // (a few times at most), while a hello or write already put the newer value in state.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const epoch = this.coordinatorEpoch;
            let raw: unknown;
            try {
                raw = await api.coordinator();
            } catch {
                return this.api === api ? (this.state.coordinatorConvoId ?? null) : null;
            }
            if (this.api !== api) return null;
            if (this.coordinatorEpoch === epoch) {
                const id = coordinatorIdIn(raw);
                if (id !== undefined) {
                    this.coordinatorStale = false;
                    this.patch({ coordinatorConvoId: id });
                }
                return id ?? null;
            }
            if (!this.coordinatorStale) return this.state.coordinatorConvoId ?? null;
        }
        return this.state.coordinatorConvoId ?? null;
    }

    /**
     * The rail's Coordinator entry: opens the Coordinator conversation (`coordinatorConversationId`
     * semantics: the journal first, the last known value when the read fails). Resolves false
     * when there is none, so the caller can offer the chooser.
     */
    public async openCoordinator(): Promise<boolean> {
        const id = await this.coordinatorConversationId();
        if (!id) return false;
        this.closeTrackerView();
        void this.selectConversation(id, { suppressNotFound: true });
        return true;
    }

    /**
     * PUT /coordinator {convo_id}: the user's pick, or null to clear. The journal first; the value
     * shown follows its answer, so a failed write changes nothing. Resolves to the message to
     * show, or undefined on success.
     */
    public async setCoordinator(convoId: string | null): Promise<string | undefined> {
        const api = this.api;
        if (!api) return "Not signed in.";
        try {
            const raw = await api.putCoordinator(convoId);
            if (this.api !== api) return undefined;
            this.coordinatorEpoch += 1;
            this.coordinatorStale = false;
            this.patch({ coordinatorConvoId: coordinatorIdIn(raw) ?? convoId });
            return undefined;
        } catch (error) {
            if (error instanceof JournalApiError && error.status === 404) {
                return "That conversation can't be the Coordinator: it no longer exists, or it isn't yours.";
            }
            return `Couldn't change the Coordinator: ${errorMessage(error)}`;
        }
    }

    // hello_ok's `coordinator_convo_id` is the journal's word on connect; it supersedes any GET in
    // flight. An older journal leaves the key out, and a GET asks instead.
    private applyHelloCoordinator(hello: JournalControlFrame): void {
        const id =
            "coordinator_convo_id" in hello ? coordinatorIdIn({ convo_id: hello.coordinator_convo_id }) : undefined;
        if (id === undefined) {
            void this.coordinatorConversationId();
            return;
        }
        this.coordinatorEpoch += 1;
        this.coordinatorStale = false;
        this.patch({ coordinatorConvoId: id });
    }

    // `coordinator` events (assigned / released) and `routine` markers are pure invalidation: the
    // journal's answer is refetched, so a reconnect's replayed backlog can never leave an old value.
    private handleCoordinatorMarker(event: JournalEvent): void {
        if (event.type === "coordinator") {
            this.coordinatorEpoch += 1;
            this.coordinatorStale = true;
            if (this.coordinatorRefetchTimer !== undefined) return;
            this.coordinatorRefetchTimer = window.setTimeout(() => {
                this.coordinatorRefetchTimer = undefined;
                void this.coordinatorConversationId();
            }, MARKER_REFETCH_DELAY_MS);
            return;
        }
        if (event.type === "routine" && this.routinesViewers > 0) this.scheduleRoutinesRefetch();
    }

    // ── Coordinator routines (Settings → Coordinator → Routines; journal /routines) ──

    /**
     * The Routines sheet is showing: load now, and follow `routine` markers and reconnects until
     * the returned function is called. Nothing loads before, so an older journal's 404 stays on
     * that sheet.
     */
    public watchRoutines(): () => void {
        this.routinesViewers += 1;
        void this.loadRoutines();
        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            this.routinesViewers = Math.max(0, this.routinesViewers - 1);
            if (this.routinesViewers === 0 && this.routinesRefetchTimer !== undefined) {
                window.clearTimeout(this.routinesRefetchTimer);
                this.routinesRefetchTimer = undefined;
            }
        };
    }

    /** GET /routines. A 404 marks the journal as without routines; a failure keeps the list. */
    public async loadRoutines(): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.routinesGen;
        this.patchRoutines({ loading: true });
        try {
            const list = parseRoutineList(await api.routines());
            if (this.api !== api || this.routinesGen !== gen) return;
            if (!list) {
                this.patchRoutines({ loading: false, error: "The journal sent a malformed routines list." });
                return;
            }
            this.patchRoutines({ list, loading: false, unsupported: false, error: undefined });
        } catch (error) {
            if (this.api !== api || this.routinesGen !== gen) return;
            if (error instanceof JournalApiError && error.status === 404) {
                this.patchRoutines({ loading: false, unsupported: true, error: undefined });
                return;
            }
            this.patchRoutines({ loading: false, error: errorMessage(error) });
        }
    }

    /** Pause (false) or resume (true). Resolves to the message to show, or undefined. */
    public async setRoutineEnabled(id: string, enabled: boolean): Promise<string | undefined> {
        const api = this.api;
        if (!api || this.state.routines?.busyIds?.has(id)) return undefined;
        this.markRoutineBusy(id, true);
        try {
            const raw = await api.patchRoutine(id, { enabled });
            if (this.api !== api) return undefined;
            this.replaceRoutine(routineIn(raw));
            return undefined;
        } catch (error) {
            if (this.api !== api) return undefined;
            if (error instanceof JournalApiError && error.status === 404) void this.loadRoutines();
            return routineFailure(error, false);
        } finally {
            if (this.api === api) this.markRoutineBusy(id, false);
        }
    }

    /**
     * POST /routines/:key/run: fires the routine now. Its outcome lands later as a `fired` marker,
     * which refetches the list. Resolves to null once the journal took it, otherwise the reason.
     */
    public async runRoutine(id: string): Promise<string | null> {
        const api = this.api;
        if (!api || this.state.routines?.busyIds?.has(id)) return null;
        this.markRoutineBusy(id, true);
        try {
            const message = routineRunMessage(await api.runRoutine(id));
            return this.api === api ? message : null;
        } catch (error) {
            return this.api === api ? routineFailure(error, false) : null;
        } finally {
            if (this.api === api) this.markRoutineBusy(id, false);
        }
    }

    /**
     * Creates (`existingId` undefined) or edits a routine. The journal's rules are checked first,
     * and a new routine's name must not already be in the list. Resolves to the message to show,
     * or undefined on success.
     */
    public async saveRoutine(
        existingId: string | undefined,
        name: string,
        draft: RoutineDraft,
    ): Promise<string | undefined> {
        const api = this.api;
        if (!api) return "Not signed in.";
        const isNew = existingId === undefined;
        if (isNew && !this.state.routines?.list) await this.loadRoutines();
        const problem = routineFormError(name, draft);
        if (problem) return problem;
        const routines = this.state.routines;
        if (isNew) {
            if (!routines?.list) {
                return routines?.unsupported
                    ? ROUTINES_UNSUPPORTED
                    : "Routines haven't loaded yet, so this name can't be checked. Try again in a moment.";
            }
            if (routines.list.some((routine) => routine.name === name)) {
                return `A routine named "${name}" already exists. Open it from the list to change it.`;
            }
            if (routines.list.length >= RoutineRules.maxRoutines)
                return routineErrorMessage(409, { blocked_by: "cap" }, true)!;
        }
        const body = routineRequestBody(draft);
        try {
            const raw = isNew
                ? await api.createRoutine({ ...body, name, tz: draft.tz })
                : await api.patchRoutine(existingId, body);
            if (this.api !== api) return undefined;
            this.replaceRoutine(routineIn(raw));
            return undefined;
        } catch (error) {
            if (this.api !== api) return undefined;
            // An edit of a routine deleted elsewhere: drop it from the list, as a pause does.
            if (!isNew && error instanceof JournalApiError && error.status === 404) void this.loadRoutines();
            return routineFailure(error, isNew);
        }
    }

    /** DELETE /routines/:key. A routine already gone counts as deleted. */
    public async deleteRoutine(id: string): Promise<string | undefined> {
        const api = this.api;
        if (!api) return "Not signed in.";
        try {
            await api.deleteRoutine(id);
        } catch (error) {
            if (!(error instanceof JournalApiError && error.status === 404)) return routineFailure(error, false);
        }
        if (this.api !== api) return undefined;
        // Any load in flight was asked before the delete: its answer may still have the routine.
        this.routinesGen += 1;
        const list = this.state.routines?.list?.filter((routine) => routine.id !== id);
        this.patchRoutines({ loading: false, ...(list ? { list } : {}) });
        return undefined;
    }

    private patchRoutines(update: Partial<RoutinesState>): void {
        this.patch({ routines: { ...this.state.routines, ...update } });
    }

    private markRoutineBusy(id: string, busy: boolean): void {
        const busyIds = new Set(this.state.routines?.busyIds ?? []);
        if (busy) busyIds.add(id);
        else busyIds.delete(id);
        this.patchRoutines({ busyIds });
    }

    // One routine's fresh copy goes into the list at once, before the marker's refetch lands. Any
    // load already in flight was asked before this write, so its answer is dropped.
    private replaceRoutine(routine: Routine | null): void {
        if (!routine) {
            void this.loadRoutines();
            return;
        }
        this.routinesGen += 1;
        const others = (this.state.routines?.list ?? []).filter((row) => row.id !== routine.id);
        this.patchRoutines({ list: sortRoutines([...others, routine]), loading: false });
    }

    private scheduleRoutinesRefetch(): void {
        if (this.routinesRefetchTimer !== undefined) return;
        this.routinesRefetchTimer = window.setTimeout(() => {
            this.routinesRefetchTimer = undefined;
            if (this.routinesViewers > 0) void this.loadRoutines();
        }, MARKER_REFETCH_DELAY_MS);
    }

    // A settings frame (or hello_ok) is the journal's word on the current value; it supersedes any
    // GET still in flight.
    private applySettingsFrame(raw: unknown): void {
        const settings = parseUserSettings(raw);
        if (!settings) return;
        ++this.settingsGen;
        this.patch({ userSettings: settings, userSettingsError: undefined });
    }

    public async loadBriefing(opts: { keepRefreshError?: boolean } = {}): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.briefingGen;
        this.patchBriefing({ loading: true });
        try {
            const latest = sanitizeBriefingLatest(await api.latestBriefing());
            if (this.api !== api || this.briefingGen !== gen) return;
            this.setBriefingLatest(latest, {
                loading: false,
                unsupported: false,
                error: undefined,
                ...(opts.keepRefreshError ? {} : { refreshError: undefined }),
            });
        } catch (error) {
            if (this.api !== api || this.briefingGen !== gen) return;
            if (error instanceof JournalApiError && error.status === 404) {
                this.patchBriefing({ loading: false, unsupported: true, error: undefined });
                return;
            }
            this.patchBriefing({ loading: false, error: errorMessage(error) });
        }
    }

    /**
     * POST /briefings/refresh — ask the Coordinator for a new briefing. Resolves true when the
     * journal took the ask (202). A 429 records `retryAt` (the card says "Try again in N min"); a
     * 409 (no Coordinator) and a 503 (busy) record a message; a 409 also refetches, so a
     * Coordinator that went away hides the card.
     */
    public async requestBriefingRefresh(): Promise<boolean> {
        const api = this.api;
        if (!api || this.state.briefing?.requesting) return false;
        this.patchBriefing({ requesting: true, refreshError: undefined, retryAt: undefined });
        try {
            const latest = sanitizeBriefingLatest(await api.refreshBriefing());
            if (this.api !== api) return false;
            // The 202 body is the freshest view: supersede any load still in flight.
            this.briefingGen += 1;
            this.setBriefingLatest(latest, { requesting: false, loading: false, error: undefined });
            return true;
        } catch (error) {
            if (this.api !== api) return false;
            if (error instanceof JournalApiError && error.status === 429) {
                const retryAt = asNumber(error.body?.retry_at, 0);
                this.patchBriefing({
                    requesting: false,
                    retryAt: retryAt > 0 ? retryAt : Date.now() + 60_000,
                });
                return false;
            }
            if (error instanceof JournalApiError && error.status === 409) {
                this.patchBriefing({ requesting: false, refreshError: "There's no Coordinator to ask." });
                void this.loadBriefing({ keepRefreshError: true });
                return false;
            }
            if (error instanceof JournalApiError && error.status === 503) {
                this.patchBriefing({
                    requesting: false,
                    refreshError: "The Coordinator is busy. Try again in a moment.",
                });
                return false;
            }
            this.patchBriefing({
                requesting: false,
                refreshError: `Couldn't ask for a briefing: ${errorMessage(error)}`,
            });
            return false;
        }
    }

    private patchBriefing(update: Partial<BriefingState>): void {
        this.patch({ briefing: { loading: false, unsupported: false, ...this.state.briefing, ...update } });
    }

    private setBriefingLatest(latest: BriefingLatest, update: Partial<BriefingState>): void {
        this.patchBriefing({ ...update, latest });
        this.scheduleBriefingExpiry(latest);
    }

    // A pending refresh turns timed_out at expires_at without any frame: refetch just after it so
    // the card stops saying "Refreshing…" and offers to try again.
    private scheduleBriefingExpiry(latest: BriefingLatest): void {
        if (this.briefingExpiryTimer !== undefined) window.clearTimeout(this.briefingExpiryTimer);
        this.briefingExpiryTimer = undefined;
        const expiresAt = latest.refresh?.state === "pending" ? latest.refresh.expires_at : undefined;
        if (expiresAt === undefined) return;
        const delay = Math.min(Math.max(0, expiresAt - Date.now()) + 1_000, 2_147_000_000);
        this.briefingExpiryTimer = window.setTimeout(() => {
            this.briefingExpiryTimer = undefined;
            if (this.state.trackerView?.open && this.state.briefing && !this.state.briefing.unsupported) {
                void this.loadBriefing();
            }
        }, delay);
    }

    // The live `briefing` frame (published / refreshing / refresh_failed) is pure invalidation, as
    // is a reconnect (nothing replays the frame). Only a loaded card on an open pane refetches; a
    // closed pane reloads when the Projects tab opens again.
    private refetchBriefingIfShown(): void {
        const briefing = this.state.briefing;
        if (!this.state.trackerView?.open || !briefing || briefing.unsupported) return;
        void this.loadBriefing();
    }

    // ── New-chat defaults (Settings → New chats; journal GET/PUT /defaults) ──────────────────

    /**
     * A view starts showing the defaults: load them now, and refetch on every reconnect until the
     * returned release is called (a `defaults` frame missed while offline is never replayed).
     */
    public showDefaults(): () => void {
        this.defaultsViewers += 1;
        void this.loadDefaults();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.defaultsViewers -= 1;
        };
    }

    // GET /defaults. A 404 means the journal predates per-user defaults: the group says so and
    // shows no controls. A failed load keeps whatever value was already loaded. The answer is
    // dropped when a newer GET, frame or PUT response landed after it was sent.
    public async loadDefaults(): Promise<void> {
        const api = this.api;
        if (!api) return;
        const seq = ++this.defaultsSeq;
        this.patchDefaults({ loading: true });
        try {
            const value = await api.defaults();
            if (this.api !== api || this.defaultsSeq !== seq) return;
            this.defaultsServer = value;
            this.defaultsErrorKey = undefined;
            this.showDefaultsValue({ loading: false, unsupported: false, error: undefined });
        } catch (error) {
            if (this.api !== api || this.defaultsSeq !== seq) return;
            if (error instanceof JournalApiError && error.status === 404) {
                this.patchDefaults({ loading: false, unsupported: true, error: undefined });
                return;
            }
            this.defaultsErrorKey = undefined;
            this.patchDefaults({ loading: false, error: `Couldn't load the defaults: ${errorMessage(error)}` });
        }
    }

    /**
     * PUT /defaults for one key, optimistically: the new value shows at once and, if the journal
     * refuses or can't be reached, goes back to the journal's latest value with an error.
     * null = "Box default". Resolves true when the key's last PUT stored it.
     */
    public setDefault(key: UserDefaultKey, value: string | null): Promise<boolean> {
        const api = this.api;
        if (!api || !this.defaultsServer) return Promise.resolve(false);
        if (this.state.defaults?.value?.[key] === value) return Promise.resolve(true);
        this.defaultsPending.set(key, value);
        this.defaultsErrorKey = undefined;
        this.showDefaultsValue({ error: undefined });
        const saving = this.defaultsSaving.get(key);
        if (saving) return saving;
        // Only this loop's own entry is removed: after a sign-out a new session may own the key.
        const run: Promise<boolean> = this.saveDefaultPicks(api, key).finally(() => {
            if (this.defaultsSaving.get(key) === run) this.defaultsSaving.delete(key);
        });
        this.defaultsSaving.set(key, run);
        return run;
    }

    // One key's PUT loop: send the desired value, apply the answer, and go round again while a
    // newer pick is waiting. Resolves with the outcome of the last PUT.
    private async saveDefaultPicks(api: JournalApi, key: UserDefaultKey): Promise<boolean> {
        let saved = false;
        while (this.api === api && this.defaultsPending.has(key)) {
            const value = this.defaultsPending.get(key)!;
            try {
                const stored = await api.putDefaults({ [key]: value });
                if (this.api !== api) return false;
                // The response's own key (in the journal's spelling: trimmed, lowercased) always
                // applies; its other key is never newer than a frame already applied, so it is left.
                this.defaultsSeq += 1;
                this.defaultsServer = { ...this.defaultsServer!, [key]: stored[key] };
                if (this.defaultsPending.get(key) === value) this.defaultsPending.delete(key);
                const clearError = this.defaultsErrorKey === key;
                if (clearError) this.defaultsErrorKey = undefined;
                this.showDefaultsValue(clearError ? { error: undefined } : {});
                saved = true;
            } catch (error) {
                if (this.api !== api) return false;
                // Drop the failed pick; a newer one waiting for this key is sent next.
                if (this.defaultsPending.get(key) === value) this.defaultsPending.delete(key);
                const label = key === "default_model" ? "default model" : "default effort";
                this.defaultsErrorKey = key;
                this.showDefaultsValue({ error: `Couldn't save the ${label}: ${errorMessage(error)}` });
                saved = false;
            }
        }
        return saved;
    }

    // The live `defaults` frame carries the full new state (a change from any device or agent,
    // including the echo of this client's own save). It replaces the journal's value; picks still
    // in flight stay on top until their own PUT answers.
    private handleDefaultsFrame(frame: unknown): void {
        const value = parseUserDefaults(frame);
        if (!value) return;
        this.defaultsSeq += 1;
        this.defaultsServer = value;
        this.defaultsErrorKey = undefined;
        this.showDefaultsValue({ loading: false, unsupported: false, error: undefined });
    }

    private showDefaultsValue(update: Partial<DefaultsState>): void {
        const value = { ...this.defaultsServer! };
        for (const [key, pick] of this.defaultsPending) value[key] = pick;
        this.patchDefaults({ ...update, value });
    }

    private patchDefaults(update: Partial<DefaultsState>): void {
        this.patch({ defaults: { loading: false, unsupported: false, ...this.state.defaults, ...update } });
    }

    // ── Device admin (Settings → Devices). Pull-based, as on the Mac: the screen re-fetches the
    // roster after every change; only the agent roster (session tags) is pushed, by `device_meta`.

    private deviceAdminApi(): JournalApi {
        if (!this.api) throw new JournalApiError("Not signed in.", 401, "unauthenticated");
        return this.api;
    }

    /** GET /devices: every device on the account, this one included. */
    public async listDevices(): Promise<DeviceDTO[]> {
        return (await this.deviceAdminApi().devices()).devices;
    }

    /** Rename a device; the Boxes group re-reads its names. */
    public async renameDevice(deviceId: number, name: string): Promise<void> {
        await this.deviceAdminApi().renameDevice(deviceId, name);
        void this.loadBoxDefaults();
    }

    /** Set an agent box's tag character, or clear it back to automatic (null). */
    public async setDeviceTag(deviceId: number, tagChar: string | null): Promise<void> {
        await this.deviceAdminApi().setDeviceTag(deviceId, tagChar);
    }

    /**
     * Revoke a device. A 404 means it was already revoked elsewhere and counts as done. Revoking
     * this device is a sign-out: the token is already dead, so the client signs out at once.
     */
    public async revokeDevice(device: Pick<DeviceDTO, "device_id" | "is_self">): Promise<void> {
        try {
            await this.deviceAdminApi().revokeDevice(device.device_id);
        } catch (error) {
            if (!(error instanceof JournalApiError && error.status === 404)) throw error;
        }
        if (device.is_self) {
            await this.logout("This device was revoked. Sign in again to continue.");
            return;
        }
        void this.loadBoxDefaults();
    }

    public pairPreview(pairCode: string): Promise<PairPreview> {
        return this.deviceAdminApi().pairPreview(pairCode);
    }

    public pairApprove(pairCode: string, agentName: string, tagChar: string | null): Promise<void> {
        return this.deviceAdminApi().pairApprove(pairCode, agentName, tagChar);
    }

    public linkStart(): Promise<LinkStart> {
        return this.deviceAdminApi().linkStart();
    }

    public linkStatus(): Promise<LinkStatus> {
        return this.deviceAdminApi().linkStatus();
    }

    public linkApprove(linkCode: string): Promise<void> {
        return this.deviceAdminApi().linkApprove(linkCode);
    }

    public linkDeny(linkCode: string): Promise<void> {
        return this.deviceAdminApi().linkDeny(linkCode);
    }

    // ── Per-box defaults (Settings → Boxes; GET /devices `defaults`, PUT /devices/:id/defaults) ──

    /**
     * A view starts showing the box defaults: load them now, and refetch on every reconnect until
     * the returned release is called (a `box_defaults` frame missed while offline is never replayed).
     */
    public showBoxDefaults(): () => void {
        this.boxDefaultsViewers += 1;
        void this.loadBoxDefaults();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.boxDefaultsViewers -= 1;
        };
    }

    // GET /devices. Agent boxes without a `defaults` block are left out; when no agent box has one
    // the journal predates per-box defaults and the group hides. A box whose journal value changed
    // after this GET was sent keeps that newer value.
    public async loadBoxDefaults(): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.boxDefaultsLoadGen;
        const sentAt = this.boxDefaultsClock;
        this.patchBoxDefaults({ loading: true });
        try {
            const { devices } = await api.devices();
            if (this.api !== api || this.boxDefaultsLoadGen !== gen) return;
            this.rememberBoxStatuses(devices);
            const agents = devices.filter((device) => device.kind === "agent");
            const boxes = agents
                .filter((device) => device.defaults)
                .sort(
                    (left, right) =>
                        Number(right.connected) - Number(left.connected) ||
                        (left.name ?? "").localeCompare(right.name ?? "") ||
                        left.device_id - right.device_id,
                );
            // A box a save's 404 dropped after this GET was sent stays dropped (its stamp is the
            // tombstone); a GET sent after the drop that still lists it brings it back.
            const listed = boxes.filter((box) => {
                const newer = (this.boxDefaultsStamps.get(box.device_id) ?? -1) > sentAt;
                if (newer) return this.boxDefaultsServer.has(box.device_id);
                this.boxDefaultsServer.set(box.device_id, box.defaults!);
                return true;
            });
            this.boxDefaultsList = listed.map(({ device_id, name, connected }) => ({ device_id, name, connected }));
            // An error raised after this GET was sent is newer than its answer: it stays.
            const keepError = this.boxDefaultsErrorAt > sentAt;
            if (!keepError) this.boxDefaultsErrorBox = undefined;
            this.showBoxDefaultsValue({
                loading: false,
                unsupported: agents.length > 0 && boxes.length === 0,
                ...(keepError ? {} : { error: undefined }),
            });
        } catch (error) {
            if (this.api !== api || this.boxDefaultsLoadGen !== gen) return;
            this.boxDefaultsErrorBox = undefined;
            this.patchBoxDefaults({ loading: false, error: `Couldn't load the box defaults: ${errorMessage(error)}` });
        }
    }

    /**
     * PUT /devices/:id/defaults, optimistically: the picks show at once and, if the journal refuses
     * or can't be reached, the box goes back to the journal's latest value with an error. null
     * clears a value. Changing the agent without a model clears the model, as the journal does.
     * Resolves true when the box's last PUT stored its picks.
     */
    public setBoxDefaults(deviceId: number, patch: BoxDefaultsPatch): Promise<boolean> {
        const api = this.api;
        if (!api || !this.boxDefaultsServer.has(deviceId)) return Promise.resolve(false);
        const picks: BoxDefaultsPatch = { ...patch };
        if ("default_agent" in picks && !("default_model" in picks)) picks.default_model = null;
        this.boxDefaultsPending.set(deviceId, { ...this.boxDefaultsPending.get(deviceId), ...picks });
        this.showBoxDefaultsValue({ error: undefined });
        const saving = this.boxDefaultsSaving.get(deviceId);
        if (saving) return saving;
        const run: Promise<boolean> = this.saveBoxDefaultPicks(api, deviceId).finally(() => {
            if (this.boxDefaultsSaving.get(deviceId) === run) this.boxDefaultsSaving.delete(deviceId);
        });
        this.boxDefaultsSaving.set(deviceId, run);
        return run;
    }

    // One box's PUT loop: send the waiting picks, apply the answer, and go round again while newer
    // picks are waiting. Resolves with the outcome of the last PUT.
    private async saveBoxDefaultPicks(api: JournalApi, deviceId: number): Promise<boolean> {
        let saved = false;
        while (this.api === api && this.boxDefaultsPending.has(deviceId)) {
            const body = this.boxDefaultsPending.get(deviceId)!;
            this.boxDefaultsPending.delete(deviceId);
            this.boxDefaultsInFlight.set(deviceId, body);
            try {
                const stored = await api.putBoxDefaults(deviceId, body);
                if (this.api !== api) return false;
                this.boxDefaultsInFlight.delete(deviceId);
                // Only the keys this PUT sent (a sent agent always carries its model) apply: the
                // answer's other keys are never newer than a frame that landed meanwhile. The stamp
                // drops a GET sent before this answer.
                this.boxDefaultsStamps.set(deviceId, ++this.boxDefaultsClock);
                const server = this.boxDefaultsServer.get(deviceId);
                if (server) {
                    this.boxDefaultsServer.set(deviceId, {
                        agent: "default_agent" in body ? stored.default_agent : server.agent,
                        model: "default_model" in body ? stored.default_model : server.model,
                        effort: "default_effort" in body ? stored.default_effort : server.effort,
                    });
                }
                this.showBoxDefaultsValue(this.clearBoxDefaultsError(deviceId));
                saved = true;
            } catch (error) {
                if (this.api !== api) return false;
                this.boxDefaultsInFlight.delete(deviceId);
                const name = this.boxDefaultsList.find((box) => box.device_id === deviceId)?.name ?? "the box";
                this.boxDefaultsErrorBox = deviceId;
                this.boxDefaultsErrorAt = ++this.boxDefaultsClock;
                if (error instanceof JournalApiError && error.status === 404) {
                    // The listing already proved the journal has box defaults, so a 404 means this
                    // box is gone (deleted, or no longer this user's): drop it, keep the others.
                    this.boxDefaultsPending.delete(deviceId);
                    this.boxDefaultsServer.delete(deviceId);
                    this.boxDefaultsStamps.set(deviceId, this.boxDefaultsErrorAt);
                    this.boxDefaultsList = this.boxDefaultsList.filter((box) => box.device_id !== deviceId);
                    this.showBoxDefaultsValue({ error: `Couldn't save ${name}'s defaults: the box is gone.` });
                    return false;
                }
                this.showBoxDefaultsValue({ error: `Couldn't save ${name}'s defaults: ${errorMessage(error)}` });
                saved = false;
            }
        }
        return saved;
    }

    // The live `box_defaults` frame carries one box's full new state (a change from any device or
    // agent, including the echo of this client's own save). Picks still in flight stay on top.
    private handleBoxDefaultsFrame(frame: unknown): void {
        const state = parseBoxDefaultsState(frame);
        if (!state || !this.boxDefaultsServer.has(state.device_id)) return;
        this.boxDefaultsStamps.set(state.device_id, ++this.boxDefaultsClock);
        this.boxDefaultsServer.set(state.device_id, {
            agent: state.default_agent,
            model: state.default_model,
            effort: state.default_effort,
        });
        this.showBoxDefaultsValue(this.clearBoxDefaultsError(state.device_id));
    }

    // A box's save error stands until that box's next successful save or live frame.
    private clearBoxDefaultsError(deviceId: number): Partial<BoxDefaultsState> {
        if (this.boxDefaultsErrorBox !== deviceId) return {};
        this.boxDefaultsErrorBox = undefined;
        return { error: undefined };
    }

    private showBoxDefaultsValue(update: Partial<BoxDefaultsState>): void {
        const boxes = this.boxDefaultsList.flatMap((box) => {
            const server = this.boxDefaultsServer.get(box.device_id);
            if (!server) return [];
            const picks = {
                ...this.boxDefaultsInFlight.get(box.device_id),
                ...this.boxDefaultsPending.get(box.device_id),
            };
            const defaults: BoxDefaults = {
                agent: "default_agent" in picks ? (picks.default_agent ?? null) : server.agent,
                model: "default_model" in picks ? (picks.default_model ?? null) : server.model,
                effort: "default_effort" in picks ? (picks.default_effort ?? null) : server.effort,
            };
            return [{ ...box, defaults }];
        });
        this.patchBoxDefaults({ ...update, boxes });
    }

    private patchBoxDefaults(update: Partial<BoxDefaultsState>): void {
        this.patch({
            boxDefaults: { boxes: [], loading: false, unsupported: false, ...this.state.boxDefaults, ...update },
        });
    }

    // ── Tracker data loaders (fetch → patch; the SAME trackerLoading/trackerError pair as the
    // messageSearch precedent). Each guards on the api instance so a response that races a
    // logout / re-login can never write into a newer session's store. ──────────────────────

    /** Data seam used by the mounted Work view; the hook owns refresh cancellation and ordering. */
    public work(groupBy: WorkViewGroupBy, signal?: AbortSignal): Promise<WorkViewEnvelope> {
        if (!this.api) return Promise.reject(new Error("Not signed in"));
        return this.api.work(groupBy, signal);
    }

    // Whether the pane is showing a tracker list tab (Inbox or Missions). A list load that settles
    // after the user moved to Work or Memories must not write the shared banner there: those tabs
    // surface their own failures, and the list keeps its own error (inboxError / missionsError)
    // for when its tab is shown again.
    private trackerListTabShown(): boolean {
        const view = this.state.trackerView;
        return !!view?.open && (view.view === "inbox" || view.view === "missions");
    }

    public async loadMissions(): Promise<void> {
        const api = this.api;
        if (!api) return;
        // Request-generation guard, matching loadInbox/loadItem/loadMission: the pane primes this on
        // open and mission markers independently restart it, so a slower earlier request must never
        // overwrite a newer one's result (else closed missions / obsolete counts reappear) (F2).
        const gen = ++this.trackerMissionsGen;
        // Like itemLoadError, missionsError stays until a load succeeds: a retry that stalls must not
        // take the "may be out of date" notice off a list it has not replaced yet.
        this.patch({ trackerLoading: true, trackerError: undefined });
        try {
            const { missions } = await api.missions();
            if (this.api !== api || this.trackerMissionsGen !== gen) return;
            this.patch({ missions, trackerLoading: false, missionsError: undefined });
        } catch (error) {
            if (this.api !== api || this.trackerMissionsGen !== gen) return;
            const message = errorMessage(error);
            this.patch({
                ...(this.trackerListTabShown() ? { trackerError: message } : {}),
                missionsError: message,
                trackerLoading: false,
            });
        }
    }

    public async loadProjects(): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.trackerProjectsGen;
        try {
            const { projects } = await api.projects();
            if (this.api !== api || this.trackerProjectsGen !== gen) return;
            this.patch({ projects, projectsError: undefined, projectsUnsupported: false });
        } catch (error) {
            if (this.api !== api || this.trackerProjectsGen !== gen) return;
            // An older journal has no /projects: show the missions list instead of a retry that
            // can never succeed (the Mac treats this 404 as "not supported" too).
            if (error instanceof JournalApiError && error.status === 404) {
                this.patch({ projectsUnsupported: true, projectsError: undefined });
                return;
            }
            this.patch({ projectsError: errorMessage(error) });
        }
    }

    public async loadProject(id: number | string): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.trackerProjectGen;
        const key = String(id).replace(/^#/, "");
        try {
            const detail = await api.project(id);
            if (this.api !== api || this.trackerProjectGen !== gen) return;
            // A merged project answers with the project it went into: follow it, so the page's
            // number guard matches instead of spinning on "Loading…".
            const view = this.state.trackerView;
            const followMerge =
                detail.merged_from && view?.selectedProjectId === Number(key) && detail.project.num !== Number(key);
            this.patch({
                trackerProject: detail,
                projectLoadError: undefined,
                ...(followMerge && view ? { trackerView: { ...view, selectedProjectId: detail.project.num } } : {}),
            });
        } catch (error) {
            if (this.api !== api || this.trackerProjectGen !== gen) return;
            this.patch({ projectLoadError: { id: key, message: errorMessage(error) } });
        }
    }

    /** The project page's "Show more" once every loaded row of its Latest feed shows: the next page
     *  of every roll-up kind that still has one, fetched together and appended. A page that lands
     *  after the page moved to another project is dropped; a failed fetch keeps the list as it is. */
    public async loadMoreProjectActivity(): Promise<void> {
        const api = this.api;
        const detail = this.state.trackerProject;
        if (!api || !detail || this.state.trackerProjectFeedLoading) return;
        const kinds = kindsWithMore(detail);
        if (kinds.length === 0) return;
        const gen = this.trackerProjectGen;
        this.patch({ trackerProjectFeedLoading: true });
        try {
            const pages = await Promise.all(
                kinds.map(
                    async (kind) =>
                        [kind, await api.projectFeed(detail.project.id, kind, detail[kind]!.next_before!)] as const,
                ),
            );
            // The pages continue the detail they were asked for. A refresh that landed meanwhile
            // replaced it (new first pages, new cursors), so they are dropped: the next Show more
            // pages on from the new cursors instead of leaving a gap.
            if (this.api !== api || this.trackerProjectGen !== gen || this.state.trackerProject !== detail) return;
            let current = detail;
            for (const [kind, page] of pages) current = appendFeedPage(current, kind, page);
            this.patch({ trackerProject: current });
        } catch {
            // The rows already on the page stay; the button offers the fetch again.
        } finally {
            if (this.api === api) this.patch({ trackerProjectFeedLoading: false });
        }
    }

    // The inbox is "tracked" once loaded, and also while its first walk is still in flight, so a
    // write or marker that lands mid-walk refetches rather than being dropped.
    private inboxTracked(): boolean {
        return this.state.inboxItems !== undefined || this.inboxWalking;
    }

    // Lay the writes recorded during the walk over its result: a row the walk fetched before the
    // write is replaced (or dropped, if the write closed it) unless the walk's copy is as new.
    private mergeInboxPendingWrites(items: TrackerItem[]): TrackerItem[] {
        if (this.inboxPendingWrites.size === 0) return items;
        const pending = this.inboxPendingWrites;
        this.inboxPendingWrites = new Map();
        const merged: TrackerItem[] = [];
        for (const row of items) {
            const write = pending.get(row.id);
            if (!write || (row.updated_at ?? 0) >= (write.updated_at ?? 0)) merged.push(row);
            else if (write.state === "open") merged.push(write);
        }
        return merged;
    }

    public async loadInbox(): Promise<void> {
        const api = this.api;
        if (!api) return;
        // Request-generation guard: like loadItem/loadMission, a slower earlier load must never
        // overwrite a newer one's result. A marker (WS) can restart loadInbox while an in-flight
        // multi-page walk is mid-pagination; without this the older walk could finish last and
        // restore rows the newer load already dropped (e.g. items closed meanwhile) (F2).
        const gen = ++this.trackerInboxGen;
        this.inboxWalking = true;
        this.patch({ trackerLoading: true, trackerError: undefined, inboxError: undefined });
        try {
            // App-wide open items; the inbox sorts "needs you" (open && awaiting==user) first
            // client-side, so a single open-state fetch feeds every section. The list is
            // cursor-paginated (server clamps limit ≤500), so follow next_cursor to exhaustion —
            // the inbox and its "Needs you" section reason over ALL open items, and a partial first
            // page reads as a false "nothing needs you" / drops user-blocking rows (F3). Bounded to
            // MAX_PAGES / MAX_ITEMS as a runaway guard; deduped by item id across pages.
            const MAX_PAGES = 20;
            const MAX_ITEMS = 10_000;
            const accumulated: TrackerItem[] = [];
            const seen = new Set<string>();
            let cursor: string | undefined;
            let truncated = false;
            for (let page = 0; ; page += 1) {
                const { items, next_cursor } = await api.items({
                    state: "open",
                    limit: OPEN_ITEMS_PAGE,
                    ...(cursor ? { cursor } : {}),
                });
                if (this.api !== api || this.trackerInboxGen !== gen) return;
                for (const item of items) {
                    if (seen.has(item.id)) continue;
                    seen.add(item.id);
                    accumulated.push(item);
                }
                if (!next_cursor) break;
                // Hit the runaway guard while the server still has more pages: publish what we have
                // but surface the truncation loudly rather than presenting a partial list as the
                // authoritative "all open items" (a silent cap re-creates the false-empty bug) (F2).
                if (page + 1 >= MAX_PAGES || accumulated.length >= MAX_ITEMS) {
                    truncated = true;
                    break;
                }
                cursor = next_cursor;
            }
            this.inboxWalking = false;
            const merged = this.mergeInboxPendingWrites(accumulated);
            this.patch({
                inboxItems: merged,
                ...this.doneWithoutOpen(merged),
                trackerLoading: false,
                ...(this.trackerListTabShown()
                    ? {
                          trackerError: truncated
                              ? "Showing a partial inbox — too many open items to load them all. Some rows may be missing."
                              : undefined,
                      }
                    : {}),
            });
        } catch (error) {
            if (this.api !== api || this.trackerInboxGen !== gen) return;
            this.inboxWalking = false;
            const message = errorMessage(error);
            this.patch({
                ...(this.trackerListTabShown() ? { trackerError: message } : {}),
                inboxError: message,
                trackerLoading: false,
            });
        }
    }

    /** Operator-triggered reconnect (Settings menu / connection banner). */
    public reconnect(): void {
        this.connection?.reconnectNow();
    }

    public async loadMemories(): Promise<void> {
        const api = this.api;
        if (!api) return;
        // Same generation guard as loadInbox: a memory marker restarts this while an earlier load
        // is in flight, and the older answer must never overwrite the newer one.
        const gen = ++this.trackerMemoriesGen;
        // memoriesError stays until a load succeeds (as inboxError / missionsError do), so a stalled
        // retry keeps the "may be out of date" notice over the rows it has not replaced yet.
        this.patch({ trackerLoading: true, trackerError: undefined });
        try {
            const { memories } = await api.memories();
            if (this.api !== api || this.trackerMemoriesGen !== gen) return;
            this.patch({
                memories: [...memories].sort((a, b) => a.name.localeCompare(b.name)),
                memoriesError: undefined,
                trackerLoading: false,
            });
        } catch (error) {
            if (this.api !== api || this.trackerMemoriesGen !== gen) return;
            // memoriesError only: the pane-wide banner would follow the user to the Inbox and
            // Missions tabs, and against a journal that predates /memories the 404 is expected.
            this.patch({ memoriesError: errorMessage(error), trackerLoading: false });
        }
    }

    public async loadItem(id: number | string): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.trackerItemGen;
        // itemLoadError is left in place until a load succeeds: a retry that stalls must not take
        // the "may be out of date" note (and its retry) off a record that is still stale.
        this.patch({ trackerLoading: true, trackerError: undefined });
        try {
            const detail = await api.item(id);
            // Guard both API identity (logout/re-login) AND request identity: a superseded/out-of-
            // order response must never patch a newer selection's detail (F1).
            if (this.api !== api || this.trackerItemGen !== gen) return;
            this.patch({ trackerItem: detail, trackerLoading: false, itemLoadError: undefined });
        } catch (error) {
            if (this.api !== api || this.trackerItemGen !== gen) return;
            const message = errorMessage(error);
            this.patch({
                trackerError: message,
                // Keyed in the same "#"-free form isSelectedTrackerItem compares on, so a "#7"
                // refetch still matches a numeric selection of 7.
                itemLoadError: { id: String(id).replace(/^#/, ""), message },
                trackerLoading: false,
            });
        }
    }

    public async loadMission(id: number | string): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.trackerMissionGen;
        // Like itemLoadError, missionLoadError stays until a load succeeds: a retry that stalls
        // must not take the retry offer off a selection that still has nothing (or stale) to show.
        this.patch({ trackerLoading: true, trackerError: undefined });
        try {
            const detail = await api.mission(id);
            if (this.api !== api || this.trackerMissionGen !== gen) return;
            this.patch({ trackerMission: detail, trackerLoading: false, missionLoadError: undefined });
        } catch (error) {
            if (this.api !== api || this.trackerMissionGen !== gen) return;
            const message = errorMessage(error);
            this.patch({
                trackerError: message,
                // Keyed "#"-free so a "#5" refetch still matches a numeric selection of 5.
                missionLoadError: { id: String(id).replace(/^#/, ""), message },
                trackerLoading: false,
            });
        }
    }

    /**
     * Fetch the missions a conversation is or was on, for the chat header's mission chip. The
     * result is kept for that conversation only; the header never shows it against another. A
     * journal without the route (404) reads as "no missions", which hides the chip. Any other
     * failure keeps what was shown.
     */
    // ── The chat's Tasks & decisions pane ──────────────────────────────────────────────────────
    // A side pane beside the conversation (not the main-region tracker): this chat's items, or
    // every chat's, with a create form and drag reorder of the open tasks. The pane mounts while
    // it is open and calls loadChatTasks whenever the conversation or the scope changes.

    /** Opens or closes the pane (toggles without an argument). It stays open across chats. */
    public toggleChatTasks(open = !this.state.chatTasks?.open): void {
        // One pane beside the chat: opening Tasks closes the subagent pane.
        this.patch({
            chatTasks: { ...this.state.chatTasks, open, actionError: undefined },
            ...(open && this.state.subChatPane ? { subChatPane: undefined } : {}),
        });
    }

    /** "This chat" or "All" for the conversation on screen; another conversation starts on its own. */
    public setChatTasksScope(scope: "chat" | "all"): void {
        const convoId = this.state.selectedConversationId;
        if (!convoId) return;
        this.patch({
            chatTasks: {
                ...this.state.chatTasks,
                open: this.state.chatTasks?.open ?? true,
                allFor: scope === "all" ? convoId : undefined,
            },
        });
    }

    /** The list the pane shows for the conversation on screen: its id, or "all". */
    public chatTasksScope(): string | undefined {
        const convoId = this.state.selectedConversationId;
        if (!convoId) return undefined;
        return this.state.chatTasks?.allFor === convoId ? "all" : convoId;
    }

    public dismissChatTasksError(): void {
        const current = this.state.chatTasks;
        if (current?.actionError) this.patch({ chatTasks: { ...current, actionError: undefined } });
    }

    /**
     * Loads the pane's list: the open items (one page, rank order) and the latest closed ones for
     * Done, for this conversation or across all of them. A list for another scope is cleared at
     * once rather than shown under the wrong heading; a failed refresh keeps the rows it had.
     */
    public async loadChatTasks(): Promise<void> {
        const api = this.api;
        const scope = this.chatTasksScope();
        if (!api || !scope) return;
        const gen = ++this.chatTasksGen;
        const prior = this.state.chatTasks;
        this.patch({
            chatTasks: {
                ...prior,
                open: prior?.open ?? false,
                scope,
                items: prior?.scope === scope ? prior.items : undefined,
                error: prior?.scope === scope ? prior.error : undefined,
                // A refused move belongs to the list it was made in.
                actionError: prior?.scope === scope ? prior.actionError : undefined,
                loading: true,
            },
        });
        const convo = scope === "all" ? undefined : scope;
        try {
            const [open, closed] = await Promise.all([
                api.items({ convo, state: "open", sort: "rank", limit: 500 }),
                // The journal sorts closed items by their last change, not by when they closed, so a
                // wider page is read for Done to pick the latest closed from.
                api.items({ convo, state: "closed", sort: "updated", limit: CHAT_TASKS_DONE_FETCH }),
            ]);
            if (this.api !== api || this.chatTasksGen !== gen) return;
            this.patch({
                chatTasks: {
                    ...this.state.chatTasks,
                    open: this.state.chatTasks?.open ?? false,
                    scope,
                    items: [...open.items, ...closed.items].map((item) => {
                        const rank = this.chatTasksStaged.get(item.id);
                        return rank === undefined || item.state !== "open" ? item : { ...item, rank };
                    }),
                    loading: false,
                    error: undefined,
                    unsupported: false,
                },
            });
        } catch (error) {
            if (this.api !== api || this.chatTasksGen !== gen) return;
            const unsupported = error instanceof JournalApiError && error.status === 404;
            this.patch({
                chatTasks: {
                    ...this.state.chatTasks,
                    open: this.state.chatTasks?.open ?? false,
                    loading: false,
                    error: unsupported ? undefined : errorMessage(error),
                    unsupported,
                },
            });
        }
    }

    /**
     * Files a new item from the user into the conversation on screen (whichever scope the pane
     * shows, the item belongs to this chat). It joins the list at once; the refetch then brings the
     * journal's order. A failure comes back with its reason, so the form keeps what was typed.
     * `idempotencyKey`: the form passes the same key for every try of one draft, so a retry after a
     * create that landed but whose answer was lost is deduped instead of filing the item twice.
     */
    public async createChatItem(
        draft: {
            kind: TrackerItemCreate["kind"];
            title: string;
            body: string;
        },
        idempotencyKey?: string,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
        const api = this.api;
        const convoId = this.state.selectedConversationId;
        if (!api || !convoId) return { ok: false, reason: "Open a chat to file a new item." };
        const title = draft.title.trim();
        if (!title || title.length > 200) return { ok: false, reason: "Give the item a title (up to 200 characters)." };
        let created: TrackerItem | undefined;
        try {
            ({ item: created } = await api.createItem(
                { kind: draft.kind, title, body: draft.body, convo_id: convoId },
                idempotencyKey ?? crypto.randomUUID(),
            ));
        } catch (error) {
            return { ok: false, reason: `Couldn't file the item: ${errorMessage(error)}` };
        }
        if (this.api !== api) return { ok: true };
        const current = this.state.chatTasks;
        // Only into a list it belongs to: the pane may have moved to another chat meanwhile.
        if (
            created &&
            typeof created.id === "string" &&
            (current?.scope === "all" || current?.scope === convoId) &&
            current?.items &&
            !current.items.some((i) => i.id === created!.id)
        ) {
            this.patch({ chatTasks: { ...current, items: [...current.items, created] } });
        }
        void this.loadChatTasks();
        if (this.inboxTracked()) void this.loadInbox();
        return { ok: true };
    }

    /**
     * A drag of an open task to `toIndex` among the open tasks (counted without it). Drawn in its
     * new place at once; the journal is told second, and a refusal puts the task back and says why.
     */
    public async moveChatTask(itemId: string, toIndex: number): Promise<void> {
        const api = this.api;
        const current = this.state.chatTasks;
        const items = current?.items;
        if (!api || !current || !items) return;
        const plan = planTaskMove(chatTaskSections(items).tasks, itemId, toIndex);
        if (!plan) return;
        const original = items.find((item) => item.id === itemId)!;
        // A load already in flight read the old order: it must not land over the move.
        this.chatTasksGen += 1;
        // Rank only: a load that landed meanwhile may carry newer fields for the same item.
        const withRank = (list: TrackerItem[], rank: number): TrackerItem[] =>
            list.map((item) => (item.id === itemId ? { ...item, rank } : item));
        const staged = plan.moved.rank;
        this.chatTasksStaged.set(itemId, staged);
        this.patch({ chatTasks: { ...current, items: withRank(items, staged), actionError: undefined } });
        try {
            await api.rankItem(itemId, plan.change);
        } catch (error) {
            // A later move of the same task owns the entry from here on.
            if (this.chatTasksStaged.get(itemId) === staged) this.chatTasksStaged.delete(itemId);
            if (this.api !== api) return;
            const now = this.state.chatTasks;
            this.patch({
                chatTasks: {
                    ...now,
                    open: now?.open ?? false,
                    items: now?.items ? withRank(now.items, original.rank) : now?.items,
                    actionError: `Couldn't move the task: ${errorMessage(error)}`,
                },
            });
            // The refusal may mean the list is stale (a neighbour closed or moved): read it again.
            void this.loadChatTasks();
            return;
        }
        if (this.chatTasksStaged.get(itemId) === staged) this.chatTasksStaged.delete(itemId);
        if (this.api !== api) return;
        void this.loadChatTasks();
    }

    // Item markers refetch the open pane's list, coalesced like the inbox's.
    private scheduleChatTasksRefetch(): void {
        if (this.chatTasksRefetchTimer !== undefined) return;
        this.chatTasksRefetchTimer = window.setTimeout(() => {
            this.chatTasksRefetchTimer = undefined;
            if (this.state.chatTasks?.open) void this.loadChatTasks();
        }, 250);
    }

    public async loadConversationMissions(convoId: string): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.conversationMissionsGen;
        this.conversationMissionsCacheGen.set(convoId, gen);
        const cached = this.conversationMissionsCache.get(convoId);
        if (cached && this.state.conversationMissions?.convoId !== convoId) {
            this.patch({ conversationMissions: { convoId, links: cached } });
        }
        try {
            const links = await api.conversationMissions(convoId);
            if (this.api !== api) return;
            if (this.conversationMissionsCacheGen.get(convoId) === gen)
                this.conversationMissionsCache.set(convoId, links);
            if (this.conversationMissionsGen !== gen) return;
            this.patch({ conversationMissions: { convoId, links } });
        } catch (error) {
            if (this.api !== api) return;
            const missing = error instanceof JournalApiError && error.status === 404;
            if (missing && this.conversationMissionsCacheGen.get(convoId) === gen)
                this.conversationMissionsCache.set(convoId, []);
            if (this.conversationMissionsGen !== gen) return;
            if (missing) this.patch({ conversationMissions: { convoId, links: [] } });
        }
    }

    // Coalesce marker-driven refetches of the chip's missions (see conversationMissionsRefetchTimer).
    // The timer reads the selection when it fires, so a switch in the meantime fetches nothing extra.
    private scheduleConversationMissionsRefetch(): void {
        if (this.conversationMissionsRefetchTimer !== undefined) return;
        this.conversationMissionsRefetchTimer = window.setTimeout(() => {
            this.conversationMissionsRefetchTimer = undefined;
            const convoId = this.state.selectedConversationId;
            if (convoId) void this.loadConversationMissions(convoId);
        }, 250);
    }

    /** Whether a mission marker changes what the chip of the conversation on screen shows: it landed
     *  there (joined, left, made current), or it is about a mission the chip lists — a rename or a
     *  close is written to the mission's origin conversation only. */
    private missionMarkerConcernsChip(event: JournalEvent): boolean {
        const selected = this.state.selectedConversationId;
        if (!selected) return false;
        if (event.convo_id === selected) return true;
        const shown = this.state.conversationMissions;
        if (shown?.convoId !== selected) return false;
        const missionId = typeof event.payload.mission_id === "string" ? event.payload.mission_id : null;
        const num = asNumber(event.payload.num, 0);
        return shown.links.some((link) => link.id === missionId || (num > 0 && link.num === num));
    }

    /**
     * One page of a mission's closed items, most recently updated first. `GET /items` has no
     * mission filter, so this walks the user's closed items newest first (at most
     * MISSION_CLOSED_SCAN_PAGES requests of 500) and keeps the mission's own, stopping once `want`
     * are found. The walk starts no further back than the mission's creation (`since`): the journal
     * bumps an item's `updated_at` whenever it is put on a mission, so none of the mission's items
     * is older than the mission. `cursor` is where the walk stopped, null once every candidate has
     * been seen — pass it back to continue. Not store state: the mission page holds the pages it
     * asked for. Rejects on a failed request, and resolves empty when signed out.
     */
    public async fetchMissionClosedItems(
        mission: Pick<Mission, "id" | "created_at">,
        cursor: string | null = null,
        want: number = MISSION_CLOSED_PAGE,
    ): Promise<{ items: TrackerItem[]; cursor: string | null }> {
        const api = this.api;
        if (!api) return { items: [], cursor: null };
        const since = Number.isInteger(mission.created_at) && mission.created_at > 0 ? mission.created_at : undefined;
        const items: TrackerItem[] = [];
        let next = cursor;
        for (let page = 0; page < MISSION_CLOSED_SCAN_PAGES; page++) {
            const res = await api.items({
                state: "closed",
                sort: "updated",
                limit: 500,
                ...(since !== undefined ? { since } : {}),
                cursor: next ?? undefined,
            });
            for (const item of res.items) if (item.mission_id === mission.id) items.push(item);
            next = res.next_cursor;
            if (!next || items.length >= want) break;
        }
        return { items, cursor: next };
    }

    // ── Tracker mutations (fresh Idempotency-Key per call → refetch the affected row + patch).
    // On failure they surface trackerError but leave the loaded data intact (await-refetch, no
    // optimistic outbox in v1). The inbox / missions list are refetched only when already loaded,
    // so a mutation from a detail view keeps their badges live without forcing a cold load.
    // Each resolves `true` only on a CONFIRMED successful write and `false` on any handled failure
    // (offline/auth-expiry/timeout/5xx, or signed-out) — callers gate destructive UI resets (e.g.
    // clearing a reply draft) on that flag so a failed mutation never silently drops user input (F2).
    // A write that lands but races a logout still resolves true (the write happened). ──

    // A mutation refetches its item only while that item is still the selected one. The user can go
    // Back and open another item while the write is in flight; loadItem bumps the request generation,
    // so an unconditional refetch of the mutated item would discard the newer selection's load and
    // leave the pane on the inbox with the new selection never loaded.
    private isSelectedTrackerItem(id: number | string): boolean {
        const selected = this.state.trackerView?.selectedItemId;
        return selected != null && String(selected) === String(id).replace(/^#/, "");
    }

    // `idempotencyKey`: callers that can RETRY the same write after an AMBIGUOUS delivery (a comment
    // POST that may have committed before the response was lost) must pass a STABLE key so the retry
    // reuses it and the server dedupes the replay instead of minting a duplicate comment (F1). Omit
    // it for one-shot callers to get a fresh key per call. NOTE: end-to-end dedup also needs the
    // deployed transport to FORWARD the Idempotency-Key header — the web fetch path does; the desktop
    // Electron preload currently discards it (see api.ts), tracked as the desktop-PATCH residual.
    public async commentItem(
        id: number | string,
        body: TrackerCommentWrite,
        idempotencyKey?: string,
    ): Promise<boolean> {
        const outcome = await this.postTrackerComment(id, body, idempotencyKey);
        if (!outcome.ok && outcome.reason !== undefined) this.patch({ trackerError: outcome.reason });
        return outcome.ok;
    }

    /**
     * commentItem for the reply box: the same write and refetches, but a failure comes back with
     * its reason instead of raising the tracker's error banner, so the box can say beside the kept
     * draft which reply did not go and why.
     */
    public async postTrackerComment(
        id: number | string,
        body: TrackerCommentWrite,
        idempotencyKey?: string,
    ): Promise<TrackerCommentOutcome> {
        const api = this.api;
        if (!api) return { ok: false };
        let written: TrackerItem | undefined;
        try {
            ({ item: written } = await api.postItemComment(id, body, idempotencyKey ?? crypto.randomUUID()));
        } catch (error) {
            return this.api === api ? { ok: false, reason: commentFailureMessage(error) } : { ok: false };
        }
        if (this.api !== api) return { ok: true };
        // Reflect the written item at once (a Seen tap closes a notice in the same write), so the
        // row leaves "Needs you" and the badge drops before the refetches below land.
        if (written) this.applyWrittenItem(written);
        if (this.isSelectedTrackerItem(id)) await this.loadItem(id);
        if (this.inboxTracked()) await this.loadInbox();
        if (this.state.inboxDone) void this.loadInboxDone();
        if (this.state.missions) await this.loadMissions();
        return { ok: true };
    }

    /**
     * Uploads one file for a tracker comment (POST /media) and returns the attachment to post with
     * it. Unlike a chat attachment there is no outbox: the reply box keeps the staged file and
     * simply tries again. A failure resolves null and surfaces in the tracker's error banner.
     * The same guards as a chat attachment apply before a byte is read: an empty file, or one over
     * BROWSER_MEMORY_SAFETY_MAX_BYTES (whose arrayBuffer() could take the tab down), is refused.
     */
    public async uploadTrackerAttachment(file: File): Promise<TrackerAttachment | null> {
        const api = this.api;
        if (!api) return null;
        if (file.size === 0 || file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES) {
            const why =
                file.size === 0 ? "that file is empty." : "this file is too large for this browser to upload safely.";
            this.patch({ trackerError: `Couldn't upload ${file.name}: ${why}` });
            return null;
        }
        const type = file.type || "application/octet-stream";
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), uploadTimeoutMsFor(file.size));
        try {
            const bytes = await Promise.race([file.arrayBuffer(), abortPromise(controller.signal)]);
            const response = await api.uploadMedia(bytes, type, controller.signal);
            return {
                blob_ref: response.media_id,
                mime: response.content_type || type,
                name: file.name,
                size: Number.isFinite(response.size) ? response.size : file.size,
            };
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: `Couldn't upload ${file.name}: ${errorMessage(error)}` });
            return null;
        } finally {
            window.clearTimeout(timer);
        }
    }

    /** The one-tap "Seen" on a notice: an item action tap, which the journal answers by closing the
     *  item as done. */
    public markItemSeen(id: number | string): Promise<boolean> {
        return this.commentItem(id, { action: SEEN_ACTION, body: SEEN_ACTION });
    }

    /**
     * The Done rows with any of `open` that waits on the user again dropped. A refresh only
     * re-reads the first page, so a row loaded from a later page that has since been reopened would
     * otherwise stay listed as done. An open row the user has answered stays: it is done for them.
     */
    private doneWithoutOpen(open: TrackerItem[]): Partial<ClientState> {
        const done = this.state.inboxDone;
        if (!done || open.length === 0) return {};
        const ids = new Set(open.filter((item) => !inDone(item)).map((item) => item.id));
        const items = done.items.filter((row) => !ids.has(row.id));
        return items.length === done.items.length ? {} : { inboxDone: { ...done, items } };
    }

    /**
     * The Done rows with `item` as just written: an item the user has just answered, seen or closed
     * goes to the top at once, before the refetch lands; one that waits on them again leaves.
     */
    private doneWithWritten(item: TrackerItem): Partial<ClientState> {
        const done = this.state.inboxDone;
        if (!done) return {};
        const others = done.items.filter((row) => row.id !== item.id);
        if (!inDone(item)) return others.length === done.items.length ? {} : { inboxDone: { ...done, items: others } };
        return { inboxDone: { ...done, items: inDoneOrder([item, ...others]) } };
    }

    private applyWrittenItem(item: TrackerItem): void {
        if (!item || typeof item !== "object" || typeof item.id !== "string") return;
        const inbox = this.state.inboxItems;
        const detail = this.state.trackerItem;
        if (this.inboxWalking) {
            const prior = this.inboxPendingWrites.get(item.id);
            if (!prior || (item.updated_at ?? 0) >= (prior.updated_at ?? 0)) this.inboxPendingWrites.set(item.id, item);
        }
        this.patch({
            ...(inbox
                ? {
                      inboxItems:
                          item.state === "open"
                              ? inbox.map((row) => (row.id === item.id ? item : row))
                              : inbox.filter((row) => row.id !== item.id),
                  }
                : {}),
            ...this.doneWithWritten(item),
            ...(detail && detail.item.id === item.id ? { trackerItem: { ...detail, item } } : {}),
        });
    }

    /**
     * For you's Done tab: the newest page of closed questions, decisions and notices (tasks are the
     * agents' work list, not something the user answered or read). Also the refresh: rows already
     * loaded beyond the first page stay, except one the fresh page should have carried and does
     * not, which has been reopened.
     */
    public async loadInboxDone(): Promise<void> {
        const api = this.api;
        if (!api) return;
        const gen = ++this.trackerInboxDoneGen;
        const prior = this.state.inboxDone;
        this.patch({ inboxDone: { items: prior?.items ?? [], nextCursor: prior?.nextCursor ?? null, loading: true } });
        try {
            const { items, next_cursor } = await api.items(INBOX_DONE_FILTER);
            if (this.api !== api || this.trackerInboxDoneGen !== gen) return;
            const fresh = new Set(items.map((item) => item.id));
            const open = new Set((this.state.inboxItems ?? []).filter((item) => !inDone(item)).map((item) => item.id));
            const oldest = items[items.length - 1];
            // Below the fresh page only: anything newer that it does not list is no longer closed.
            // The latest rows in state, not the ones from before the request: a row reopened
            // while it was in flight has already been dropped from them.
            // Kept only when the fresh page reaches the rows already loaded (it lists one of them)
            // and there is more beyond it. A page that shares nothing with them leaves a gap the
            // old cursor would never fetch, so the list starts again from this page.
            const loaded = this.state.inboxDone?.items ?? [];
            const joins = next_cursor !== null && loaded.some((row) => fresh.has(row.id));
            const older =
                oldest && joins
                    ? loaded.filter((row) => !fresh.has(row.id) && !open.has(row.id) && sortsAfter(row, oldest))
                    : [];
            this.patch({
                inboxDone: {
                    items: [...items, ...older],
                    nextCursor: older.length > 0 ? (prior?.nextCursor ?? null) : next_cursor,
                    loading: false,
                },
            });
        } catch (error) {
            if (this.api !== api || this.trackerInboxDoneGen !== gen) return;
            const kept = this.state.inboxDone;
            this.patch({
                inboxDone: {
                    items: kept?.items ?? [],
                    nextCursor: kept?.nextCursor ?? null,
                    loading: false,
                    error: errorMessage(error),
                },
            });
        }
    }

    /** The Done tab's "Show more": the next page, appended. */
    public async loadMoreInboxDone(): Promise<void> {
        const api = this.api;
        const done = this.state.inboxDone;
        if (!api || !done || done.loading || !done.nextCursor) return;
        const gen = ++this.trackerInboxDoneGen;
        this.patch({ inboxDone: { ...done, loading: true, error: undefined } });
        try {
            const { items, next_cursor } = await api.items({ ...INBOX_DONE_FILTER, cursor: done.nextCursor });
            if (this.api !== api || this.trackerInboxDoneGen !== gen) return;
            // The rows in state now, not the ones from before the request: a row reopened while
            // it was in flight has been dropped from them and must stay dropped.
            const rows = this.state.inboxDone?.items ?? done.items;
            const skip = new Set(
                [...rows, ...(this.state.inboxItems ?? []).filter((item) => !inDone(item))].map((item) => item.id),
            );
            this.patch({
                inboxDone: {
                    items: [...rows, ...items.filter((item) => !skip.has(item.id))],
                    nextCursor: next_cursor,
                    loading: false,
                },
            });
        } catch (error) {
            if (this.api !== api || this.trackerInboxDoneGen !== gen) return;
            const kept = this.state.inboxDone ?? done;
            this.patch({ inboxDone: { ...kept, loading: false, error: errorMessage(error) } });
        }
    }

    // PUT is an upsert by name and idempotent by construction, so no Idempotency-Key: a retried
    // save writes the same memory again. The list is reloaded rather than patched from the answer
    // so the row order (by name) and any concurrent edits from an agent stay authoritative.
    public async saveMemory(name: string, body: MemoryWrite): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        try {
            await api.putMemory(name, body);
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: errorMessage(error) });
            return false;
        }
        if (this.api !== api) return true;
        await this.loadMemories();
        return true;
    }

    public async deleteMemory(name: string): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        try {
            await api.deleteMemory(name);
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: errorMessage(error) });
            return false;
        }
        if (this.api !== api) return true;
        if (this.state.trackerView?.selectedMemoryName === name) this.closeTrackerMemory();
        await this.loadMemories();
        return true;
    }

    public async closeTrackerItem(
        id: number | string,
        resolution: TrackerResolution,
        comment?: string,
    ): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        try {
            await api.closeItem(id, { resolution, comment }, crypto.randomUUID());
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: errorMessage(error) });
            return false;
        }
        if (this.api !== api) return true;
        if (this.isSelectedTrackerItem(id)) await this.loadItem(id);
        if (this.inboxTracked()) await this.loadInbox();
        if (this.state.inboxDone) void this.loadInboxDone();
        if (this.state.missions) await this.loadMissions();
        return true;
    }

    public async reopenTrackerItem(id: number | string, comment?: string): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        try {
            await api.reopenItem(id, { comment }, crypto.randomUUID());
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: errorMessage(error) });
            return false;
        }
        if (this.api !== api) return true;
        if (this.isSelectedTrackerItem(id)) await this.loadItem(id);
        if (this.inboxTracked()) await this.loadInbox();
        if (this.state.inboxDone) void this.loadInboxDone();
        if (this.state.missions) await this.loadMissions();
        return true;
    }

    /** PATCH an item's labels — the seam the route-elsewhere toggle uses. Generic on purpose (the
     *  reserved-label constant lives in the tracker UI, not here). Returns false on failure, leaving
     *  state untouched so the caller can keep its optimistic UI honest. */
    public async setItemLabels(id: number | string, labels: string[]): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        try {
            await api.patchItem(id, { labels });
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: errorMessage(error) });
            return false;
        }
        if (this.api !== api) return true;
        if (this.isSelectedTrackerItem(id)) await this.loadItem(id);
        if (this.inboxTracked()) await this.loadInbox();
        if (this.state.missions) await this.loadMissions();
        return true;
    }

    // Mission counterpart of isSelectedTrackerItem: a mission mutation refetches its detail only while
    // that mission is still selected, so a late refetch can't supersede a newer selection's load. The
    // selection is a #num while mission mutators take the mission id, so an id matches through the
    // cached detail of the selected mission (selecting a different mission clears that cache).
    private isSelectedTrackerMission(id: number | string): boolean {
        const selected = this.state.trackerView?.selectedMissionId;
        if (selected == null) return false;
        const key = String(id).replace(/^#/, "");
        if (String(selected) === key) return true;
        const cached = this.state.trackerMission?.mission;
        return !!cached && cached.num === selected && cached.id === key;
    }

    public async saveMissionEdits(id: number | string, fields: { title?: string; body?: string }): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        try {
            await api.patchMission(id, fields, crypto.randomUUID());
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: errorMessage(error) });
            return false;
        }
        if (this.api !== api) return true;
        if (this.isSelectedTrackerMission(id)) await this.loadMission(id);
        if (this.state.missions) await this.loadMissions();
        return true;
    }

    public async closeTrackerMission(id: number | string, summary: string): Promise<boolean> {
        const api = this.api;
        if (!api) return false;
        try {
            await api.closeMission(id, { summary }, crypto.randomUUID());
        } catch (error) {
            if (this.api === api) this.patch({ trackerError: errorMessage(error) });
            return false;
        }
        if (this.api !== api) return true;
        if (this.isSelectedTrackerMission(id)) await this.loadMission(id);
        if (this.state.missions) await this.loadMissions();
        return true;
    }

    // ── Project filing (the Mac's "New project", "Move to project…" and "Merge into…"). ──

    /**
     * "New project": creates it, refreshes the Projects home and opens the new project's page. A
     * failure comes back with its reason for the sheet to show beside what was typed, rather than
     * on the tracker's banner, so the sheet stays open with nothing lost.
     */
    public async createTrackerProject(title: string, body = ""): Promise<{ project: Project } | { error: string }> {
        const api = this.api;
        if (!api) return { error: "Not signed in." };
        let project: Project;
        try {
            ({ project } = await api.createProject({ title: title.trim(), body: body.trim() }, crypto.randomUUID()));
        } catch (error) {
            return { error: errorMessage(error) };
        }
        if (this.api !== api) return { project };
        await this.loadProjects();
        this.openTrackerProject(project.num);
        return { project };
    }

    /**
     * "Move to project…": files the mission into another open project, then refetches what shows
     * it — the mission page when it is the one shown, the missions and projects lists when loaded,
     * and the open project page (which it may just have left). Resolves to why it did not move, for
     * the sheet (which stays open over the pane's banner) to show, or null once moved.
     */
    public async moveTrackerMission(missionId: string, projectId: string): Promise<string | null> {
        const api = this.api;
        if (!api) return "Not signed in.";
        try {
            await api.patchMission(missionId, { project: projectId }, crypto.randomUUID());
        } catch (error) {
            return projectFilingFailure(error, "move");
        }
        if (this.api !== api) return null;
        await Promise.all([
            this.isSelectedTrackerMission(missionId) ? this.loadMission(missionId) : undefined,
            this.state.missions ? this.loadMissions() : undefined,
            this.state.projects ? this.loadProjects() : undefined,
            this.state.trackerProject ? this.loadProject(this.state.trackerProject.project.num) : undefined,
        ]);
        return null;
    }

    /**
     * "Merge into…": the journal moves every mission of `sourceId` to `intoId` and closes the
     * source as merged. The page follows its missions to the project they went into, when the
     * source's page is still the one shown. The journal lets the user merge, and of the agents
     * only the Coordinator. Resolves to why it did not merge, for the sheet to show (the page
     * stays), or null once merged.
     */
    public async mergeTrackerProject(sourceId: string, intoId: string): Promise<string | null> {
        const api = this.api;
        if (!api) return "Not signed in.";
        if (sourceId === intoId) return "A project cannot merge into itself.";
        let into: Project;
        try {
            ({ project: into } = await api.mergeProject(sourceId, intoId));
        } catch (error) {
            return projectFilingFailure(error, "merge");
        }
        if (this.api !== api) return null;
        const shown = this.state.trackerProject?.project;
        if (shown?.id === sourceId && this.state.trackerView?.selectedProjectId === shown.num) {
            this.openTrackerProject(into.num);
        }
        await Promise.all([this.loadProjects(), this.state.missions ? this.loadMissions() : undefined]);
        return null;
    }

    // WS invalidation for tracker markers (`item` / `mission` / `milestone` journal frames).
    // A marker is a change connected clients must reflect without re-polling; we refetch ONLY the
    // tracker data the OPEN pane is showing. A closed pane fetches nothing but the needs-you badge
    // (the mobile nav + header badges outlive the pane); reopening it remounts the pane, which
    // reloads the lists and the selection itself. The inbox/badge refetch is coalesced (see
    // scheduleInboxRefetch), and the missions list refetch the same way (scheduleMissionsRefetch).
    // `mission` is treated as pure invalidation. Item/mission numbers on the wire are the human
    // #num; milestone markers carry `mission_num` for their parent mission.
    private handleTrackerMarker(event: JournalEvent): void {
        // The inbox feeds the For you badge on the rail, so it follows item markers even while the
        // pane is closed; everything else is refetched only for an open pane.
        if (event.type === "item" && (this.inboxTracked() || this.state.inboxDone)) this.scheduleInboxRefetch();
        if (event.type === "item" && this.state.chatTasks?.open) this.scheduleChatTasksRefetch();
        // The header chip of the conversation on screen follows the mission markers that concern it
        // (see missionMarkerConcernsChip) whether or not the pane is open — also while its first load
        // is in flight (the newer load supersedes it) or after a failed one.
        if (event.type === "mission" && this.missionMarkerConcernsChip(event)) {
            // A load already in flight predates the marker: it may neither publish nor cache.
            this.conversationMissionsGen += 1;
            if (this.state.selectedConversationId)
                this.conversationMissionsCacheGen.delete(this.state.selectedConversationId);
            this.scheduleConversationMissionsRefetch();
        }
        if (!this.state.trackerView?.open) return;
        // The open item's `working` block follows the conversation that owns it: a turn starting
        // or ending there changes what the thread's indicator should say, and no item marker
        // announces it.
        if (event.type === "session_status") {
            const open = this.state.trackerItem?.item;
            if (open && open.origin_convo_id === event.convo_id) this.scheduleItemWorkingRefetch(open.num);
            return;
        }
        if (event.type === "item") {
            const num = asNumber(event.payload.num, 0);
            if (num && this.state.trackerItem && this.state.trackerItem.item.num === num) {
                void this.loadItem(num);
            }
            // A mission's open-item and needs-you counts, and its detail's item list, derive from its
            // items, but an item marker does not carry the mission, so refresh whatever is loaded.
            if (this.state.missions || this.state.trackerMission || this.state.projects)
                this.scheduleMissionsRefetch({ detail: true });
            return;
        }
        if (event.type === "mission") {
            const num = asNumber(event.payload.num, 0);
            if (num && this.state.trackerMission && this.state.trackerView?.selectedMissionId === num) {
                void this.loadMission(num);
            }
            if (this.state.missions || this.state.projects) this.scheduleMissionsRefetch();
            return;
        }
        // A memory marker (spec 2026-09-27 memories) is pure invalidation; the journal may append
        // it to two conversations (the writer's and the Coordinator's), so it is coalesced like the
        // inbox refetch and a pair costs one GET /memories.
        if (event.type === "memory") {
            if (this.state.memories) this.scheduleMemoriesRefetch();
            return;
        }
        if (event.type === "milestone") {
            const missionNum = asNumber(event.payload.mission_num, 0);
            if (missionNum && this.state.trackerMission && this.state.trackerView?.selectedMissionId === missionNum) {
                void this.loadMission(missionNum);
            }
            if (this.state.missions || this.state.projects) this.scheduleMissionsRefetch();
        }
    }

    // Coalesce marker-driven inbox refetches: the first marker arms a short timer and any marker that
    // lands before it fires rides along, so a burst costs one paginated walk. The conditions are
    // re-checked when the timer fires, since the pane may have closed (or the session ended) since.
    // With the pane closed, the Work or Memories tab showing (neither reads these lists, and the
    // pane re-primes them when Inbox/Missions is selected again), or the inbox not loaded yet, only the
    // needs-you badge is refreshed, and only once it has been primed (see refreshInboxOrBadge).
    private scheduleInboxRefetch(): void {
        if (this.trackerInboxRefetchTimer !== undefined) return;
        this.trackerInboxRefetchTimer = window.setTimeout(() => {
            this.trackerInboxRefetchTimer = undefined;
            if (this.inboxTracked()) void this.loadInbox();
            if (this.state.inboxDone) void this.loadInboxDone();
        }, 250);
    }

    // A turn ending and the queued one starting arrive back to back; one read covers both. The timer
    // serves one item: an event for a different open item replaces it, so that item's read is not
    // lost to a timer armed for the one before. The item may have been closed by the time it fires.
    private scheduleItemWorkingRefetch(num: number): void {
        if (this.trackerItemWorkingRefetchTimer !== undefined) {
            if (this.trackerItemWorkingRefetchNum === num) return;
            window.clearTimeout(this.trackerItemWorkingRefetchTimer);
        }
        this.trackerItemWorkingRefetchNum = num;
        this.trackerItemWorkingRefetchTimer = window.setTimeout(() => {
            this.trackerItemWorkingRefetchTimer = undefined;
            if (this.state.trackerView?.open && this.state.trackerItem?.item.num === num) void this.loadItem(num);
        }, 250);
    }

    private scheduleMemoriesRefetch(): void {
        if (this.trackerMemoriesRefetchTimer !== undefined) return;
        this.trackerMemoriesRefetchTimer = window.setTimeout(() => {
            this.trackerMemoriesRefetchTimer = undefined;
            if (this.state.trackerView?.open && this.state.memories) void this.loadMemories();
        }, 250);
    }

    private scheduleMissionsRefetch(opts: { detail?: boolean } = {}): void {
        if (opts.detail) this.trackerMissionRefetchPending = true;
        if (this.trackerMissionsRefetchTimer !== undefined) return;
        this.trackerMissionsRefetchTimer = window.setTimeout(() => {
            this.trackerMissionsRefetchTimer = undefined;
            const detail = this.trackerMissionRefetchPending;
            this.trackerMissionRefetchPending = false;
            // Nothing while closed, and nothing for the Work or Memories tabs (see scheduleInboxRefetch).
            const view = this.state.trackerView;
            if (!view?.open || (view.view !== "inbox" && view.view !== "missions")) return;
            if (this.state.missions) void this.loadMissions();
            // Projects roll up their missions (protocol: refresh on any mission marker).
            if (this.state.projects) void this.loadProjects();
            const selectedProject = view.selectedProjectId;
            if (selectedProject != null && this.state.trackerProject?.project.num === selectedProject) {
                void this.loadProject(selectedProject);
            }
            const selected = view.selectedMissionId;
            if (detail && selected != null && this.state.trackerMission?.mission?.num === selected) {
                void this.loadMission(selected);
            }
        }, 250);
    }

    private async startSession(session: Session): Promise<void> {
        this.sessionGen += 1;
        // A genuinely new session (initialise / login) establishes a fresh cursor and
        // connection, so this is the ONLY place the malformed-seq reconnect-loop budget and halt
        // are cleared. They deliberately survive resyncs (replaceSnapshot / resetTransientSyncState)
        // — clearing them there would wipe the budget on every resnapshot, so a server emitting one
        // malformed frame per reconnect would never reach the halt threshold (unbounded loop).
        this.malformedSeqResyncs = [];
        this.journalHalted = false;
        this.pinImportStarted = false;
        this.stagedPins = null;
        this.storeHydrated = { archive: true, pinned: true, favorite: true, unread: true };
        const writeProbeKey = `${archiveStore.storageKey(session)}:__wprobe__`;
        let storeWritable = false;
        try {
            localStorage.setItem(writeProbeKey, "1");
            localStorage.removeItem(writeProbeKey);
            storeWritable = true;
        } catch {
            // The bootstrap reads below may still succeed, but writes are unavailable.
        }
        this.storeWritable = {
            archive: storeWritable,
            pinned: storeWritable,
            favorite: storeWritable,
            unread: storeWritable,
        };
        for (const controller of this.inFlightUploads.values()) controller.abort();
        this.inFlightUploads.clear();
        this.uploadConvos.clear();
        this.dismissedAttachments.clear();
        this.pendingFiles.clear();
        this.transientAttachmentErrors.clear();
        this.connection?.stop();
        this.database?.close();
        this.defaultsServer = undefined;
        this.defaultsPending.clear();
        this.defaultsSaving.clear();
        this.api = new JournalApi(session.serverUrl, session.token);
        this.database = await JournalDatabase.open(session.serverUrl, session.userId, session.username);

        let cursor = await this.database.cursor();
        const freshInstall = cursor === undefined;
        let initialSnapshot: SnapshotResponse | undefined;
        if (freshInstall) {
            initialSnapshot = await this.api.snapshot();
            await this.database.replaceWithSnapshot(initialSnapshot);
            cursor = initialSnapshot.seq;
        }
        try {
            if (freshInstall && initialSnapshot && typeof this.database.markBackfillDone === "function") {
                await this.database.markBackfillDone(initialSnapshot);
            } else if (
                typeof this.database.backfillDone === "function" &&
                !(await this.database.backfillDone()) &&
                (typeof this.database.outcomeBackfillDue !== "function" || (await this.database.outcomeBackfillDue()))
            ) {
                const snapshotController = new AbortController();
                let timeoutTimer: number;
                const timeout = new Promise<never>((_resolve, reject) => {
                    timeoutTimer = window.setTimeout(() => {
                        snapshotController.abort();
                        reject(new Error("snapshot backfill timeout"));
                    }, BACKFILL_SNAPSHOT_TIMEOUT_MS);
                });
                try {
                    await this.database.backfillParentLinks(
                        await Promise.race([this.api.snapshot(snapshotController.signal), timeout]),
                    );
                } finally {
                    window.clearTimeout(timeoutTimer!);
                }
            }
        } catch (error) {
            const permanent = error instanceof Error && error.message.startsWith("malformed");
            if (permanent) await this.database.recordBackfillError(String(error)).catch(() => undefined);
            console.warn(`matron: subchat backfill deferred (${permanent ? "permanent" : "transient"})`, error);
        }
        await this.reconcilePersistedOwnMessages(this.database);
        const outbox = await this.database.outbox();
        for (const message of outbox) {
            if (message.attachState !== "uploading") continue;
            try {
                await this.database.addToOutbox({
                    ...message,
                    attachState: "error",
                    errorKind: "upload_failed",
                });
            } catch {
                this.transientAttachmentErrors.set(message.localId, {
                    ...message,
                    attachState: "error",
                    errorKind: "storage_failed",
                    canRetry: false,
                });
            }
        }

        const conversations = await this.database.conversations();
        const storedConversationId = storedSelectedConversation(session);
        const archiveRead = archiveStore.read(session);
        const pinnedRead = pinnedStore.read(session);
        const favoriteRead = favoriteStore.read(session);
        const unreadRead = unreadStore.read(session);
        this.storeHydrated.archive = archiveRead.ok;
        this.storeHydrated.pinned = pinnedRead.ok;
        this.storeHydrated.favorite = favoriteRead.ok;
        this.storeHydrated.unread = unreadRead.ok;
        if (!archiveRead.ok) this.logStorageDiag("read_fail", "archive", false);
        if (!pinnedRead.ok) this.logStorageDiag("read_fail", "pinned", false);
        if (!favoriteRead.ok) this.logStorageDiag("read_fail", "favorite", false);
        if (!unreadRead.ok) this.logStorageDiag("read_fail", "unread", false);
        const bootstrapTransitionStore = !archiveRead.ok
            ? "archive"
            : !pinnedRead.ok
              ? "pinned"
              : !favoriteRead.ok
                ? "favorite"
                : !unreadRead.ok
                  ? "unread"
                  : "all";
        const bootstrapReadFailed = this.storageUnavailable(bootstrapTransitionStore);
        const archivedIds = archiveRead.ids;
        const pinnedIds = pinnedRead.ids;
        const favoriteIds = favoriteRead.ids;
        const unreadOverrideIds = unreadRead.ids;
        const selectedConversation = firstSelectableConversation(
            conversations,
            storedConversationId,
            archivedIds,
            this.state.collapsedSubagentParentIds,
        );
        this.state = {
            ...blankState(),
            phase: "signed-in",
            config: this.state.config,
            session,
            conversations,
            archivedIds,
            pinnedIds,
            favoriteIds,
            unreadOverrideIds,
            preferencesUnavailable: bootstrapReadFailed,
            selectedConversationId: selectedConversation?.id,
            // The last adopted journal pins, until hello_ok brings the current list — unless
            // browser-local pins still await their carry-over (they show until it lands).
            journalPins: pinnedIds.size > 0 && !pinImportDone(session) ? null : readCachedPins(session),
        };
        if (this.storageListener) window.removeEventListener("storage", this.storageListener);
        this.storageListener = (event: StorageEvent): void => {
            const currentSession = this.state.session;
            if (!currentSession) return;
            if (event.key === archiveStore.storageKey(currentSession)) {
                const read = archiveStore.read(currentSession);
                this.storeHydrated.archive = read.ok;
                if (read.ok) this.storeWritable.archive = true;
                if (!read.ok) this.logStorageDiag("read_fail", "archive", false);
                this.patch({
                    ...(read.ok ? { archivedIds: read.ids } : {}),
                    preferencesUnavailable: this.storageUnavailable("archive"),
                });
                if (read.ok && this.state.selectedConversationId && read.ids.has(this.state.selectedConversationId)) {
                    this.clearSelection();
                }
            } else if (event.key === pinnedStore.storageKey(currentSession)) {
                const read = pinnedStore.read(currentSession);
                this.storeHydrated.pinned = read.ok;
                if (read.ok) this.storeWritable.pinned = true;
                if (!read.ok) this.logStorageDiag("read_fail", "pinned", false);
                this.patch({
                    ...(read.ok ? { pinnedIds: read.ids } : {}),
                    preferencesUnavailable: this.storageUnavailable("pinned"),
                });
            } else if (event.key === favoriteStore.storageKey(currentSession)) {
                const read = favoriteStore.read(currentSession);
                this.storeHydrated.favorite = read.ok;
                if (read.ok) this.storeWritable.favorite = true;
                if (!read.ok) this.logStorageDiag("read_fail", "favorite", false);
                this.patch({
                    ...(read.ok ? { favoriteIds: read.ids } : {}),
                    preferencesUnavailable: this.storageUnavailable("favorite"),
                });
            } else if (event.key === unreadStore.storageKey(currentSession)) {
                const read = unreadStore.read(currentSession);
                this.storeHydrated.unread = read.ok;
                if (read.ok) this.storeWritable.unread = true;
                if (!read.ok) this.logStorageDiag("read_fail", "unread", false);
                this.patch({
                    ...(read.ok ? { unreadOverrideIds: read.ids } : {}),
                    preferencesUnavailable: this.storageUnavailable("unread"),
                });
            }
        };
        window.addEventListener("storage", this.storageListener);
        this.emit();
        if (selectedConversation) await this.selectConversation(selectedConversation.id, { clearUnread: false });

        // bind every callback to the generation that created this connection. A stopped
        // connection keeps draining its processing queue, so a frame (or snapshot_required) queued
        // before logout can run after the NEXT session started — and every handler below reads the
        // client's CURRENT database/api, so an unbound callback would act on the new session (a
        // stale resync would replace the new journal; a stale revoke would log the new account out).
        const connectionGen = this.sessionGen;
        const current = (): boolean => this.sessionGen === connectionGen;
        this.connection = new JournalConnection(session.serverUrl, session.token, {
            cursor: async () => (await this.database?.cursor()) ?? cursor ?? 0,
            onFrame: async (frame) => {
                if (current()) await this.handleFrame(frame);
            },
            onJournalBatch: async (frames) => {
                if (current()) await this.handleJournalBatch(frames);
            },
            onReady: async (hello) => {
                if (current()) await this.handleReady(hello);
            },
            onSnapshotRequired: async () => {
                if (current()) await this.replaceSnapshot();
            },
            onRevoked: () => {
                if (current()) void this.logout("This device was revoked. Sign in again to continue.");
            },
            onState: (connection, error) => {
                if (current()) this.patch({ connection, connectionError: error });
            },
        });
        this.connection.start();
        // Physically purge expired live tool logs only once the session is up: it walks every cached
        // row, and the store holds every row this device has ever received, so awaiting it before
        // the first paint kept a long-lived device on a blank screen for seconds. It runs in short
        // chunked transactions (see expireToolLogs) so reads and live frames interleave with it.
        // Reads already apply the TTL (events() / putHistory / applyJournal run
        // enforceToolLogTtl), so nothing expired is shown meanwhile; this only drops stale payloads
        // from disk.
        const expiringDatabase = this.database;
        void expiringDatabase.expireToolLogs().catch((error) => {
            if (this.database === expiringDatabase) console.warn("matron: tool-log expiry deferred", error);
        });
        void this.openPathLink();
        void this.backfillRoomMembership();
    }

    /**
     * Once per browser: a store that synced before room membership was kept reads one snapshot,
     * a few seconds after start-up, and copies each room's membership onto its rows, so the
     * chat header's Rooms control works without waiting for the next full snapshot. Leaves the
     * live sync alone; a failure just tries again on the next start.
     */
    private async backfillRoomMembership(): Promise<void> {
        const database = this.database;
        const api = this.api;
        const gen = this.sessionGen;
        const current = (): boolean => this.sessionGen === gen && this.database === database;
        if (!database || !api || typeof database.roomMembershipBackfillDue !== "function") return;
        try {
            if (!(await database.roomMembershipBackfillDue())) return;
            await new Promise((resolve) => window.setTimeout(resolve, MEMBERSHIP_BACKFILL_DELAY_MS));
            // A full snapshot meanwhile (a resync) already brought the membership.
            if (!current() || !(await database.roomMembershipBackfillDue())) return;
            const snapshot = await api.snapshot();
            if (!current()) return;
            await database.backfillRoomMembership(snapshot);
            if (!current()) return;
            const stored = new Map((await database.conversations()).map((row) => [row.id, row]));
            if (!current()) return;
            // Only the membership changed: copy it onto the rows on screen, leaving the rest of
            // each row as the live sync has it.
            this.patch({
                conversations: this.state.conversations.map((row) => {
                    const membership = stored.get(row.id);
                    return membership?.participant_convos === undefined
                        ? row
                        : {
                              ...row,
                              participants: membership.participants,
                              participant_convos: membership.participant_convos,
                          };
                }),
            });
        } catch (error) {
            console.warn("matron: room membership backfill deferred", error);
        }
    }

    /**
     * Opens the `/u/<name>/<n>` link the page was loaded at, once, after the first sign-in. Only
     * the signed-in user's own numbers open: the tracker shows that user's rows, so another user's
     * number would open the wrong row. A number that names nothing says so.
     */
    public async openPathLink(): Promise<void> {
        const link = this.pathLink;
        const user = this.state.session?.username;
        if (!link || !user) return;
        this.pathLink = null;
        if (link.user.toLowerCase() !== user.toLowerCase()) return;
        await this.openLinkedNumber(link.num);
    }

    /** Looks the signed-in user's number up and opens it; a number that names nothing says so. */
    private async openLinkedNumber(num: number): Promise<void> {
        const user = this.state.session?.username;
        const outcome = await this.lookupNumber(num);
        if (this.state.session?.username !== user) return;
        if (outcome.status === "found" && this.openNumberHit(outcome.hit, num)) return;
        this.patch({
            controlError:
                outcome.status === "none" ? `Nothing numbered #${num} is visible to you.` : `Couldn't open #${num}.`,
        });
    }

    private setArchived(conversationId: string, archived: boolean): void {
        const session = this.state.session;
        if (!session) return;
        const current = archiveStore.read(session);
        this.storeHydrated.archive = current.ok;
        if (!current.ok) {
            this.logStorageDiag("read_fail", "archive", false);
            this.patch({
                controlError: "Couldn't read saved archive — device storage unavailable.",
                preferencesUnavailable: this.storageUnavailable("archive"),
            });
            return;
        }
        const next = new Set(current.ids);
        if (archived) next.add(conversationId);
        else next.delete(conversationId);
        try {
            archiveStore.write(session, next);
        } catch {
            this.storeWritable.archive = false;
            this.logStorageDiag("write_fail", "archive", false);
            this.patch({
                controlError: "Couldn't save — device storage is full or unavailable.",
                preferencesUnavailable: this.storageUnavailable("archive"),
            });
            return;
        }
        this.storeWritable.archive = true;
        this.patch({
            archivedIds: next,
            controlError: undefined,
            preferencesUnavailable: this.storageUnavailable("archive"),
        });
        if (archived && conversationId === this.state.selectedConversationId) this.clearSelection();
    }

    private setFlag(
        store: IdSetStore,
        stateKey: "pinnedIds" | "favoriteIds" | "unreadOverrideIds",
        id: string,
        on: boolean,
    ): boolean {
        const session = this.state.session;
        if (!session) return false;

        let storeName: "pinned" | "favorite" | "unread";
        switch (stateKey) {
            case "pinnedIds":
                storeName = "pinned";
                break;
            case "favoriteIds":
                storeName = "favorite";
                break;
            case "unreadOverrideIds":
                storeName = "unread";
                break;
            default: {
                const _exhaustive: never = stateKey;
                throw new Error(`unmapped stateKey: ${_exhaustive}`);
            }
        }

        const current = store.read(session);
        this.storeHydrated[storeName] = current.ok;
        if (!current.ok) {
            this.logStorageDiag("read_fail", storeName, false);
            this.patch({
                controlError: "Couldn't read saved preference — device storage unavailable.",
                preferencesUnavailable: this.storageUnavailable(storeName),
            });
            return false;
        }
        const next = new Set(current.ids);
        if (on) next.add(id);
        else next.delete(id);
        try {
            store.write(session, next);
        } catch {
            this.storeWritable[storeName] = false;
            this.logStorageDiag("write_fail", storeName, false);
            this.patch({
                controlError: "Couldn't save — device storage is full or unavailable.",
                preferencesUnavailable: this.storageUnavailable(storeName),
            });
            return false;
        }
        this.storeWritable[storeName] = true;
        this.patch({
            [stateKey]: next,
            controlError: undefined,
            preferencesUnavailable: this.storageUnavailable(storeName),
        } as Partial<ClientState>);
        return true;
    }

    private clearUnreadOverride(id: string): boolean {
        // The in-memory no-op shortcut is only safe after the unread store has hydrated successfully.
        // Otherwise a stale-empty mirror may mask a persisted override, so re-read before deleting.
        if (this.api && this.storeHydrated.unread && !this.state.unreadOverrideIds.has(id)) return true;
        return this.setFlag(unreadStore, "unreadOverrideIds", id, false);
    }

    private agentRpc(agentDeviceId: number, method: string, params: unknown): Promise<RpcReply> {
        return (
            this.connection?.agentRequest(agentDeviceId, method, params) ??
            Promise.resolve({ ok: false, origin: "relay", code: "not_connected" })
        );
    }

    private logRpcCreateDiag(event: "sync_watchdog_fire", conversationId: string): void {
        console.warn("matron:rpc-create", { event, convo_id: conversationId });
    }

    private armRpcCreateWatchdog(conversationId: string): void {
        // A create for a different convo supersedes an older convo's stall notice.
        if (this.rpcCreateStalledConvo !== undefined && this.rpcCreateStalledConvo !== conversationId) {
            this.clearRpcCreateStall();
        }
        this.cancelRpcCreateTimer();
        const gen = this.sessionGen;
        this.rpcCreateWatchdogConvo = conversationId;
        this.rpcCreateWatchdogGen = gen;
        this.rpcCreateWatchdog = window.setTimeout(() => {
            if (this.rpcCreateWatchdogConvo !== conversationId || this.rpcCreateWatchdogGen !== gen) return;
            this.cancelRpcCreateTimer();
            if (this.sessionGen !== gen || this.state.selectedConversationId !== conversationId) return;
            // Its frames can sync before the start RPC replies (and so before this was armed): a convo
            // the client already knows is not stalled, whatever frames follow.
            if (this.state.conversations.some((conversation) => conversation.id === conversationId)) {
                this.clearRpcCreateStall();
                return;
            }
            // Stay armed until a frame for the convo (or logout / snapshot replace) clears it: a
            // reconnect resets connectionError, which must not silently retire the warning.
            this.armRpcCreateWatchdog(conversationId);
            // Never replace an error already on screen (e.g. the first-task send refused while the
            // convo was still unknown): the later clear would then hide that failure too.
            if (this.state.connectionError) return;
            this.logRpcCreateDiag("sync_watchdog_fire", conversationId);
            this.rpcCreateStalledConvo = conversationId;
            this.patch({ connectionError: RPC_CREATE_STALLED_NOTICE });
        }, RPC_CREATE_WATCHDOG_MS);
    }

    private cancelRpcCreateTimer(): void {
        if (this.rpcCreateWatchdog !== undefined) window.clearTimeout(this.rpcCreateWatchdog);
        this.rpcCreateWatchdog = undefined;
        this.rpcCreateWatchdogConvo = undefined;
        this.rpcCreateWatchdogGen = undefined;
    }

    // Lift the stall notice, but only if it is still ours (never clobber an unrelated error).
    private clearRpcCreateStall(): void {
        if (this.rpcCreateStalledConvo === undefined) return;
        this.rpcCreateStalledConvo = undefined;
        if (this.state.connectionError === RPC_CREATE_STALLED_NOTICE) this.patch({ connectionError: undefined });
    }

    /**
     * A frame for `conversationId` means it is syncing: stop watching it and lift its notice. A bare
     * call (logout, snapshot replace) drops any watchdog and notice.
     */
    private clearRpcCreateWatchdog(conversationId?: string): void {
        if (conversationId === undefined || conversationId === this.rpcCreateStalledConvo) this.clearRpcCreateStall();
        if (conversationId !== undefined && this.rpcCreateWatchdogConvo !== conversationId) return;
        this.cancelRpcCreateTimer();
    }

    private async replaceSnapshot(): Promise<void> {
        // capture the session this replace belongs to and use ONLY the captured refs. A
        // logout + login (another account, or the same one in a new generation) can land during
        // any await below; without the guard the old snapshot would be written into the NEW
        // session's database and published into its state. Mirrors handleReady's ownsReplay.
        const gen = this.sessionGen;
        const db = this.database;
        const api = this.api;
        if (!api || !db) return;
        const owns = (): boolean => this.sessionGen === gen && this.database === db;
        const previousSelection = this.state.selectedConversationId;
        this.resetTransientSyncState();
        this.patch({
            connection: "connecting",
            connectionError: undefined,
            events: [],
            pendingMessages: [],
            loadingHistory: false,
            hasOlderHistory: true,
            pendingScrollSeq: undefined,
            viewingHistoryWindow: false,
            activity: undefined,
            sessionStatus: undefined,
            hostVitals: null,
            textStreams: {},
            toolStreams: {},
        });
        const snapshot = await api.snapshot();
        if (!owns()) return;
        await db.replaceWithSnapshot(snapshot);
        if (!owns()) return;
        const removed = await db.reconcilePersistedOwnMessages();
        if (!owns()) return;
        for (const localId of removed) {
            this.pendingFiles.delete(localId);
            this.transientAttachmentErrors.delete(localId);
        }
        const conversations = keepUnchangedConversations(this.state.conversations, await db.conversations());
        if (!owns()) return;
        let { archivedIds, pinnedIds, favoriteIds, unreadOverrideIds } = this.state;
        const session = this.state.session;
        if (session) {
            const archiveRead = archiveStore.read(session);
            this.storeHydrated.archive = archiveRead.ok;
            if (!archiveRead.ok) this.logStorageDiag("read_fail", "archive", false);
            if (archiveRead.ok) archivedIds = archiveRead.ids;
            const pinnedRead = pinnedStore.read(session);
            this.storeHydrated.pinned = pinnedRead.ok;
            if (!pinnedRead.ok) this.logStorageDiag("read_fail", "pinned", false);
            if (pinnedRead.ok) pinnedIds = pinnedRead.ids;
            const favoriteRead = favoriteStore.read(session);
            this.storeHydrated.favorite = favoriteRead.ok;
            if (!favoriteRead.ok) this.logStorageDiag("read_fail", "favorite", false);
            if (favoriteRead.ok) favoriteIds = favoriteRead.ids;
            const unreadRead = unreadStore.read(session);
            this.storeHydrated.unread = unreadRead.ok;
            if (!unreadRead.ok) this.logStorageDiag("read_fail", "unread", false);
            if (unreadRead.ok) unreadOverrideIds = unreadRead.ids;
        }
        const snapshotTransitionStore = !this.storeHydrated.archive
            ? "archive"
            : !this.storeHydrated.pinned
              ? "pinned"
              : !this.storeHydrated.favorite
                ? "favorite"
                : !this.storeHydrated.unread
                  ? "unread"
                  : "all";
        const selectedConversation = firstSelectableConversation(
            conversations,
            previousSelection,
            archivedIds,
            this.state.collapsedSubagentParentIds,
        );
        this.applyJournalPins(pinsFromContainer(snapshot));
        this.patch({
            agents: snapshot.agents ?? this.state.agents,
            conversations,
            archivedIds,
            pinnedIds,
            favoriteIds,
            unreadOverrideIds,
            selectedConversationId: selectedConversation?.id,
            preferencesUnavailable: this.storageUnavailable(snapshotTransitionStore),
        });
        // A snapshot can be the first place THIS tab observes a convo's parent link (→ read-only child).
        // Mirror the journal-event path and abort any in-flight upload to a now-child convo so it can't
        // egress to a read-only transcript (ship-review major 2). Guarded to skip work when idle.
        if (this.uploadConvos.size > 0) this.abortUploadsForChildConvos();
        if (selectedConversation) await this.selectConversation(selectedConversation.id, { clearUnread: false });
        else if (this.state.session) storeSelectedConversation(this.state.session, undefined);
    }

    private async handleReady(hello?: JournalControlFrame): Promise<void> {
        // hello_ok carries the pin list on a journal with pins; its absence means an older journal.
        if (hello !== undefined) this.applyJournalPins(pinsFromContainer(hello));
        const gen = this.sessionGen;
        const db = this.database;
        const connection = this.connection;
        if (!db || !connection) return;
        const ownsReplay = (): boolean =>
            this.sessionGen === gen && this.database === db && this.connection === connection;

        if (hello?.settings !== undefined) this.applySettingsFrame(hello.settings);
        if (hello !== undefined) this.applyHelloCoordinator(hello);
        // A routine marker missed while offline is never replayed: refetch while the sheet shows them.
        if (this.routinesViewers > 0) void this.loadRoutines();
        // The For you badge counts open items awaiting the user, so the inbox loads on every
        // (re)connect, not only when the tracker opens: markers missed while offline never replay.
        void this.loadInbox();
        if (this.state.inboxDone) void this.loadInboxDone();

        // A briefing frame missed while offline is never replayed: refetch the card on (re)connect.
        this.refetchBriefingIfShown();
        // Nor is a defaults frame: refetch while the Settings sheet shows them.
        if (this.defaultsViewers > 0) void this.loadDefaults();
        if (this.boxDefaultsViewers > 0) void this.loadBoxDefaults();

        const outbox = await db.outbox();
        if (!ownsReplay()) return;
        const kept: PendingMessage[] = [];
        const blockedTextIds: string[] = [];
        const blockedAttachments: PendingMessage[] = [];
        for (const message of outbox) {
            if (!this.isChildConvo(message.convoId)) {
                kept.push(message);
                continue;
            }
            if (message.kind === "image" || message.kind === "file") blockedAttachments.push(message);
            else blockedTextIds.push(message.localId);
        }
        if (blockedTextIds.length > 0) {
            if (ownsReplay()) this.patch({ controlError: "Couldn't send to a read-only subagent transcript." });
            try {
                await db.deleteOutboxRows(blockedTextIds);
            } catch {
                if (ownsReplay()) {
                    this.patch({ controlError: "Couldn't update blocked messages — device storage is unavailable." });
                }
            }
        }
        if (!ownsReplay()) return;
        for (const message of blockedAttachments) {
            this.markChildBlocked(message);
            if (!(await this.persistAttachment(message, db, gen))) continue;
            if (!ownsReplay()) return;
            await this.refreshSelectedConversation(message.convoId, db, gen);
            if (!ownsReplay()) return;
        }
        for (const message of kept) this.sendPendingMessage(message, connection);
        if (this.state.selectedConversationId) {
            connection.send({ op: "viewing", convo_id: this.state.selectedConversationId });
            const conversation = this.selectedConversation();
            if (conversation?.unread_count && !this.isViewingHistoricalWindow(conversation.id)) {
                this.scheduleRead(conversation.id, conversation.last_seq, 0);
            }
        }
        for (const [conversationId, upToSeq] of this.readHighWater) {
            this.scheduleRead(conversationId, upToSeq, 0);
        }
        const cursor = await db.cursor();
        if (!ownsReplay()) return;
        if (cursor !== undefined) connection.send({ op: "ack", cursor });
    }

    // Seed each box's stored report from the roster, but never regress a row a live
    // `box_status` frame has already moved past (protocol.md: latest report wins).
    private rememberBoxStatuses(devices: DeviceDTO[]): void {
        let next: Record<number, BoxStatus> | undefined;
        for (const device of devices) {
            if (!device.status) continue;
            const current = this.state.boxStatuses[device.device_id];
            if (current && current.reported_at > device.status.reported_at) continue;
            next ??= { ...this.state.boxStatuses };
            next[device.device_id] = device.status;
        }
        if (next) this.patch({ boxStatuses: next });
    }

    // A live report replaces the stored row for that box wholesale — the blocks the frame
    // omits are gone, not kept (only `box_status` itself carries the full picture).
    private handleBoxStatus(frame: JournalBoxStatusFrame): void {
        const deviceId: unknown = frame.device_id;
        if (typeof deviceId !== "number" || !Number.isFinite(deviceId)) return;
        const status = parseBoxStatus(frame);
        if (!status) return;
        this.patch({ boxStatuses: { ...this.state.boxStatuses, [deviceId]: status } });
    }

    private async handleFrame(frame: ServerFrame): Promise<void> {
        this.emitLive((listener) => listener.frame?.(frame));
        if (frame.kind === "journal") {
            await this.handleJournal(frame);
            return;
        }
        if (frame.kind === "ephemeral") {
            this.handleEphemeral(frame);
            return;
        }
        if (frame.kind === "box_status") {
            this.handleBoxStatus(frame);
            return;
        }
        if (frame.kind === "device_meta") {
            const entry = { device_id: frame.device_id, name: frame.name, tag_char: frame.tag_char ?? null };
            const others = this.state.agents.filter((agent) => agent.device_id !== frame.device_id);
            this.patch({ agents: [...others, entry].sort((a, b) => a.device_id - b.device_id) });
            return;
        }
        if (frame.kind === "briefing") {
            this.refetchBriefingIfShown();
            return;
        }
        if (frame.kind === "defaults") {
            this.handleDefaultsFrame(frame);
            return;
        }
        if (frame.kind === "box_defaults") {
            this.handleBoxDefaultsFrame(frame);
            return;
        }
        if (frame.kind === "pins") {
            const pins = parsePinList(frame.pins);
            if (pins) this.applyJournalPins(pins);
            return;
        }
        if (frame.kind === "control" && frame.op === "settings") {
            this.applySettingsFrame(frame.settings);
            return;
        }
        if (frame.kind === "control" && frame.op === "error") {
            // Read-state reports are fire-and-forget with no reply (a conversation or item the
            // journal refuses, e.g. one removed meanwhile). Advisory, as on the other apps: never
            // an error banner for something the user didn't do.
            if (frame.ref === "seen" || frame.ref === "item_seen") return;
            this.patch({ connectionError: frame.detail || `Journal operation failed: ${frame.code ?? "unknown"}` });
        }
    }

    /**
     * A coalesced run of sequenced journal frames (see JournalConnection.onJournalBatch). One frame
     * takes the ordinary per-frame path unchanged. A longer run — a reconnect replay, or a burst
     * that arrived while the previous run was still being applied — is applied in ONE store
     * transaction, and the sidebar / open timeline are refreshed ONCE for the whole run instead of
     * once per frame. Per-frame side effects (tracker markers, outbox reconciliation, stream
     * retirement, acks, read scheduling) still run for every frame, in order. A malformed frame
     * ends the batched prefix: it and everything after it take the per-frame path, which owns the
     * halt-and-resync handling.
     */
    private async handleJournalBatch(events: JournalEvent[]): Promise<void> {
        if (events.length === 1) {
            await this.handleJournal(events[0]);
            return;
        }
        const database = this.database;
        if (!database || this.journalHalted) return;
        const firstBad = events.findIndex(
            (event) =>
                !Number.isSafeInteger(event.seq) ||
                event.seq < 0 ||
                typeof event.convo_id !== "string" ||
                !event.convo_id,
        );
        const prefix = firstBad === -1 ? events : events.slice(0, firstBad);
        if (prefix.length > 0) await this.applyJournalRun(prefix, database);
        if (firstBad === -1) return;
        // The malformed frame takes the per-frame path (halt, or re-snapshot). Rows after it
        // are NOT applied: committing them would advance the durable cursor past the unrecovered
        // row, so a failed re-snapshot would reconnect beyond it and lose it for good. The resync
        // abandons this socket, and a clean cursor replays them after the malformed row.
        await this.handleJournal(events[firstBad]);
    }

    private async applyJournalRun(events: JournalEvent[], database: JournalDatabase): Promise<void> {
        for (const event of events) this.handleTrackerMarker(event);
        const applied =
            typeof database.applyJournalBatch === "function"
                ? await database.applyJournalBatch(events)
                : await (async () => {
                      const results: boolean[] = [];
                      for (const event of events) results.push(await database.applyJournal(event));
                      return results;
                  })();
        if (this.database !== database) return;
        const selectedId = this.state.selectedConversationId;
        let refreshConversations = false;
        let abortUploads = false;
        let refreshSelected = false;
        let maxAppliedSeq: number | undefined;
        const reads: Array<[string, number]> = [];
        // Every row below is already durable (the run committed with its final cursor), so a
        // failure on one row must not strand the side effects of the rows after it: they would never
        // be replayed. Keep going, then surface the first failure once the run is fully handled.
        let firstError: unknown;
        for (let index = 0; index < events.length; index++) {
            const event = events[index];
            this.clearRpcCreateWatchdog(event.convo_id);
            let removed: string | null = null;
            try {
                removed = await database.reconcileOwnMessage(event);
            } catch (error) {
                firstError ??= error;
            }
            if (removed) {
                this.pendingFiles.delete(removed);
                this.transientAttachmentErrors.delete(removed);
            }
            if (!applied[index]) {
                // Mirrors handleJournal's duplicate-frame branch (P48): a peer tab already wrote it.
                if (removed && event.convo_id === selectedId) refreshSelected = true;
                if (event.type === "session_status") {
                    refreshConversations = true;
                    if (event.convo_id === selectedId && this.history.get(event.convo_id)?.hasMoreNewer !== true) {
                        refreshSelected = true;
                    }
                }
                if (event.type === "convo_meta") {
                    refreshConversations = true;
                    if (this.uploadConvos.size > 0) abortUploads = true;
                }
                continue;
            }
            maxAppliedSeq = Math.max(maxAppliedSeq ?? event.seq, event.seq);
            const messageRef = typeof event.payload.message_ref === "string" ? event.payload.message_ref : undefined;
            if (messageRef) {
                this.retiredStreamRefs.add(`${event.convo_id}:${messageRef}`);
                const text = this.textStreams.get(event.convo_id);
                const tools = this.toolStreams.get(event.convo_id);
                if (text) delete text[messageRef];
                if (tools) delete tools[messageRef];
            }
            refreshConversations = true;
            abortUploads = true;
            if (event.convo_id === selectedId) {
                const history = this.history.get(event.convo_id);
                const viewingHistoryWindow = history?.hasMoreNewer === true;
                if (!viewingHistoryWindow) {
                    if (history) {
                        history.newestSeq = Math.max(history.newestSeq ?? event.seq, event.seq);
                        this.history.set(event.convo_id, history);
                    }
                    refreshSelected = true;
                    if (MESSAGE_EVENT_TYPES.has(event.type) && !event.sender.startsWith("user:")) {
                        reads.push([event.convo_id, event.seq]);
                    }
                }
            }
        }
        if (maxAppliedSeq !== undefined) {
            this.clearHistoryError();
            this.scheduleAck(maxAppliedSeq);
        }
        if (refreshConversations) await this.refreshConversations();
        if (abortUploads) this.abortUploadsForChildConvos();
        if (refreshSelected && selectedId !== undefined && this.state.selectedConversationId === selectedId) {
            await this.refreshSelectedConversation(selectedId);
        }
        for (const [conversationId, seq] of reads) this.scheduleRead(conversationId, seq);
        if (firstError !== undefined) throw firstError;
    }

    private async handleJournal(event: JournalEvent): Promise<void> {
        if (!this.database) return;
        // once the reconnect-loop guard has halted journal processing, ignore every frame
        // (well-formed or not) until the session is reset. Applying a later frame here would advance
        // the cursor past the malformed row that was never recovered — the exact silent gap this
        // recovery exists to prevent — and re-arming the guard on a good frame would let an
        // alternating good/malformed server evade the bound.
        if (this.journalHalted) return;
        // frame-decode passes journal (sequenced) frames through UNVALIDATED by design — a
        // boundary drop would advance the cursor past the dropped seq and lose the row silently
        // (applyJournal has no gap detection). But a frame whose `seq` is not a usable cursor value
        // is a cursor-POISON hazard, not just a bad payload: applyJournal's dedup guard
        // `event.seq <= currentCursor` is FALSE when seq is NaN/non-numeric (NaN comparisons are
        // always false), so the poison frame is applied, `Math.max(last_seq, seq)` becomes NaN, and
        // `meta.put(seq, CURSOR_KEY)` writes the poison as the durable cursor — which is then acked
        // to the server and returned by db.cursor() on every reconnect. So a malformed seq must be
        // neither applied NOR acked NOR allowed to advance the cursor; instead halt and re-snapshot
        //. convo_id is validated too
        // because applyJournal and handleTrackerMarker read it unguarded as an IndexedDB key.
        if (
            !Number.isSafeInteger(event.seq) ||
            event.seq < 0 ||
            typeof event.convo_id !== "string" ||
            !event.convo_id
        ) {
            this.handleMalformedJournalFrame(event);
            return;
        }
        // Tracker markers (item/mission/milestone) drive a live refetch of the open tracker pane's
        // data regardless of whether this event is newly applied below — fire-and-forget so it
        // never blocks (or is blocked by) timeline application. Non-tracker types return at once.
        this.handleTrackerMarker(event);
        this.handleCoordinatorMarker(event);
        const applied = await this.database.applyJournal(event);
        this.clearRpcCreateWatchdog(event.convo_id);
        const removed = await this.database.reconcileOwnMessage(event);
        if (removed) {
            this.pendingFiles.delete(removed);
            this.transientAttachmentErrors.delete(removed);
        }
        if (!applied) {
            if (removed && event.convo_id === this.state.selectedConversationId) {
                await this.refreshSelectedConversation(event.convo_id);
            }
            // A duplicate session_status is not a no-op for our mirror: tabs sharing a server/user
            // share one IndexedDB, so applied=false means a peer tab already wrote the row and
            // advanced the shared cursor — the durable store holds the new run-state and ours is
            // the stale copy (P48). Without this the tab that dropped the ephemeral turn-end frame
            // (the backgrounded one — the exact failure the activity reconcile fixes) keeps
            // rendering a stale "Thinking" until some later frame it wins. session_status is the
            // ONLY frame that mutates session_state (database.ts applyJournal), so this covers the
            // whole run-state surface while keeping ordinary duplicate message frames off the
            // O(conversations) scan. Refresh the selected timeline alongside it, on the applied
            // path's terms, so the sidebar cannot advance past the events list.
            if (event.type === "session_status") {
                await this.refreshConversations();
                if (
                    event.convo_id === this.state.selectedConversationId &&
                    this.history.get(event.convo_id)?.hasMoreNewer !== true
                ) {
                    await this.refreshSelectedConversation(event.convo_id);
                }
            }
            // Same argument for convo_meta, and it is not upload-specific: the frame mutates
            // title, the parent link, agent_kind and the pinned summary, so a peer
            // tab that won the cursor race has already written all of them to the shared store
            // while our mirror still renders the old values — the pinned digest most visibly,
            // since it sits above the live timeline and only this frame refreshes it. Refresh
            // unconditionally against the durable row (P48); the upload abort stays gated on
            // there being uploads to abort.
            if (event.type === "convo_meta") {
                await this.refreshConversations();
                if (this.uploadConvos.size > 0) this.abortUploadsForChildConvos();
            }
            return;
        }
        this.clearHistoryError();
        this.scheduleAck(event.seq);
        const previous = this.state.conversations.find((conversation) => conversation.id === event.convo_id);
        this.emitLive((listener) => listener.journalEvent?.(event, previous));

        const messageRef = typeof event.payload.message_ref === "string" ? event.payload.message_ref : undefined;
        if (messageRef) {
            this.retiredStreamRefs.add(`${event.convo_id}:${messageRef}`);
            const text = this.textStreams.get(event.convo_id);
            const tools = this.toolStreams.get(event.convo_id);
            if (text) delete text[messageRef];
            if (tools) delete tools[messageRef];
        }

        await this.refreshConversations();
        this.abortUploadsForChildConvos();
        if (!previous || this.newVerdictPending.has(event.convo_id)) this.considerNewConversation(event, !previous);
        if (event.convo_id === this.state.selectedConversationId) {
            const history = this.history.get(event.convo_id);
            const viewingHistoryWindow = history?.hasMoreNewer === true;
            if (!viewingHistoryWindow) {
                if (history) {
                    history.newestSeq = Math.max(history.newestSeq ?? event.seq, event.seq);
                    this.history.set(event.convo_id, history);
                }
                await this.refreshSelectedConversation(event.convo_id);
            }
            if (!viewingHistoryWindow && MESSAGE_EVENT_TYPES.has(event.type) && !event.sender.startsWith("user:")) {
                this.scheduleRead(event.convo_id, event.seq);
            }
        }
    }

    /**
     * a live journal frame arrived with a `seq` that cannot serve as a cursor (NaN /
     * non-integer / negative) or a missing convo_id. It has already been kept out of the durable
     * store (handleJournal returns before applyJournal/scheduleAck), so the cursor is still clean.
     * Recover by re-snapshotting through the connection's resync flow (drop socket → replaceSnapshot
     * → reconnect), which is what actually resets the socket so the post-reconnect hello/ack carry
     * the clean cursor — calling replaceSnapshot() in isolation would leave the old socket resuming
     * from the poison ack cursor. Guarded by a reconnect-loop counter so a pathological server
     * cannot drive an unbounded resync loop.
     */
    private handleMalformedJournalFrame(event: JournalEvent): void {
        console.warn("matron:journal", {
            event: "malformed_seq",
            convo_id: typeof event.convo_id === "string" ? event.convo_id : undefined,
            seq: event.seq,
        });
        const now = Date.now();
        this.malformedSeqResyncs = this.malformedSeqResyncs.filter((ts) => now - ts < MALFORMED_SEQ_RESYNC_WINDOW_MS);
        this.malformedSeqResyncs.push(now);
        if (this.malformedSeqResyncs.length > MALFORMED_SEQ_RESYNC_LIMIT) {
            // Loop guard tripped: this is a pathological server (each clean resync cursor is
            // immediately re-poisoned). Enter a real HALT rather than looping OR leaving the socket
            // live: mark journal processing halted (handleJournal now ignores every frame, so no
            // later frame can silently advance the cursor past the unrecovered malformed row), stop
            // the connection so frames stop arriving, and surface the error. Recovery is a reload,
            // which builds a fresh session/connection and clears journalHalted. stop() fires
            // onState("offline") which clears connectionError, so patch the halt banner AFTER it.
            console.warn("matron:journal", { event: "malformed_seq_resync_halted" });
            this.journalHalted = true;
            this.connection?.stop();
            this.patch({ connectionError: MALFORMED_SEQ_HALTED_ERROR });
            return;
        }
        void this.triggerMalformedSeqResync();
    }

    private async triggerMalformedSeqResync(): Promise<void> {
        const connection = this.connection;
        if (!connection) return;
        try {
            await connection.forceResync();
        } catch (error) {
            this.patch({
                connectionError: error instanceof Error ? error.message : "Could not resync after a malformed update.",
            });
        }
    }

    // A conversation this tab sees for the first time, live. One this device asked for is the
    // user's own and opens the way they started it; any other (an agent, the Coordinator or a
    // routine started it) never takes the selection, and is marked "New" in the list until opened.
    // Not for one already on screen, a subagent's child, an agent-chat room, or a reconnect's
    // replay of sessions born while this tab was away.
    //
    // As on the Mac, the verdict waits for a frame that can settle it: a convo_meta carrying the
    // title (which also names the box), or a message. A new session's first frame is usually its
    // session_status, ahead of the meta, and judged on that the title is still empty (a room would
    // pass as a session) and the box unknown (a /start's own session would not answer its ask).
    private considerNewConversation(event: JournalEvent, firstFrame: boolean): void {
        const id = event.convo_id;
        const now = Date.now();
        if (firstFrame) {
            // A reconnect's replay of a conversation born while this tab was away.
            if (typeof event.ts === "number" && event.ts < now - NEW_CONVERSATION_STALE_MS) return;
        } else {
            const since = this.newVerdictPending.get(id);
            if (since === undefined || since < now - NEW_CONVERSATION_STALE_MS) {
                this.newVerdictPending.delete(id);
                return;
            }
        }
        const titled = event.type === "convo_meta" && typeof event.payload.title === "string";
        const conversation = this.state.conversations.find((candidate) => candidate.id === id);
        const box = conversation?.agent_device_id ?? null;
        const settles =
            titled ||
            (MESSAGE_EVENT_TYPES.has(event.type) &&
                // A message from a conversation that has not named its box cannot answer an ask
                // waiting on a particular box, nor rule one out: its title settles it.
                (box !== null || !this.startIntents.awaitsKnownBox(now)));
        if (!settles) {
            if (firstFrame) this.parkNewVerdict(id, now);
            return;
        }
        this.newVerdictPending.delete(id);
        if (id === this.state.selectedConversationId || this.state.newConversationIds.has(id)) return;
        // A child's id carries ":sub:" (Claude) or ":codex:" (Codex) before its parent link, learned
        // from a later convo_meta, lands.
        if (!conversation || isSubChat(conversation) || /:(?:sub|codex):[^:]+$/.test(id)) return;
        if (isAgentRoomTitle(conversation.title)) return;
        if (this.startIntents.claim(conversation, now)) return;
        // Keep only marks a row can still show, so the set stays the size of what is on screen.
        const visible = new Set(
            this.state.conversations
                .filter((candidate) => !isSubChat(candidate) && !isAgentRoomTitle(candidate.title))
                .map((candidate) => candidate.id),
        );
        const kept = [...this.state.newConversationIds].filter((candidate) => visible.has(candidate));
        this.patch({ newConversationIds: new Set([...kept, id]) });
    }

    private clearNewMark(id: string): void {
        if (!this.state.newConversationIds.has(id)) return;
        const newConversationIds = new Set(this.state.newConversationIds);
        newConversationIds.delete(id);
        this.patch({ newConversationIds });
    }

    private parkNewVerdict(id: string, now: number): void {
        for (const [candidate, since] of this.newVerdictPending) {
            if (since < now - NEW_CONVERSATION_STALE_MS) this.newVerdictPending.delete(candidate);
        }
        this.newVerdictPending.set(id, now);
    }

    private async reconcilePersistedOwnMessages(database: JournalDatabase): Promise<void> {
        const removed = await database.reconcilePersistedOwnMessages();
        for (const localId of removed) {
            this.pendingFiles.delete(localId);
            this.transientAttachmentErrors.delete(localId);
        }
    }

    private handleEphemeral(frame: JournalEphemeralFrame): void {
        // Host-global vitals push: host-scoped, NO convo_id. Store the one
        // value globally and repaint every header. This MUST branch before the selected-conversation
        // guard below — a host frame has no convo_id, so that guard would drop it (or, when nothing
        // is selected, both sides are undefined and it would misfire refreshEphemeralState).
        if (frame.host_vitals) {
            this.hostVitals = frame.host_vitals;
            this.patch({ hostVitals: this.hostVitals });
            return;
        }
        // Every remaining branch is conversation-scoped; a frame without convo_id is malformed here.
        const convoId = frame.convo_id;
        if (convoId === undefined) return;
        if (frame.activity) {
            if (frame.activity.state === "idle") this.activities.delete(convoId);
            else this.activities.set(convoId, frame.activity);
        }
        if (frame.status) {
            this.statuses.set(convoId, mergeSessionStatus(this.statuses.get(convoId), frame.status));
        }
        if (frame.tool_stream && frame.message_ref) {
            this.applyToolStream(frame, convoId);
        }
        if (frame.message_ref && (typeof frame.text === "string" || typeof frame.replace_text === "string")) {
            const key = `${convoId}:${frame.message_ref}`;
            if (!this.retiredStreamRefs.has(key)) {
                const streams = this.textStreams.get(convoId) ?? {};
                streams[frame.message_ref] =
                    typeof frame.replace_text === "string"
                        ? frame.replace_text
                        : `${streams[frame.message_ref] ?? ""}${frame.text ?? ""}`;
                this.textStreams.set(convoId, streams);
            }
        }
        if (convoId === this.state.selectedConversationId) this.refreshEphemeralState(convoId);
        // A helper's gauge borrows its parent's window (statusFor): repaint it when that changes.
        else if (frame.status && this.selectedConversation()?.parent_convo_id === convoId)
            this.refreshEphemeralState(this.state.selectedConversationId!);
    }

    private applyToolStream(frame: JournalEphemeralFrame, convoId: string): void {
        const payload = frame.tool_stream;
        const messageRef = frame.message_ref;
        if (!payload || !messageRef || this.retiredStreamRefs.has(`${convoId}:${messageRef}`)) return;
        const streams = this.toolStreams.get(convoId) ?? {};
        if (payload.event === "end") {
            delete streams[messageRef];
        } else if (payload.event === "sync") {
            const capped = capToolStream(payload.content ?? "");
            streams[messageRef] = {
                messageRef,
                command: payload.meta?.command,
                tool: payload.meta?.tool,
                content: capped.content,
                offset: (payload.offset ?? 0) + utf8Length(payload.content ?? ""),
                headTruncated: Boolean(payload.head_truncated) || capped.truncated,
            };
        } else {
            const chunk = payload.chunk ?? "";
            const current = streams[messageRef] ?? {
                messageRef,
                content: "",
                offset: payload.offset ?? 0,
                headTruncated: false,
            };
            const offset = payload.offset ?? current.offset;
            if (offset <= current.offset) {
                const addition = trimUtf8Prefix(chunk, current.offset - offset);
                const capped = capToolStream(current.content + addition);
                current.content = capped.content;
                current.offset += utf8Length(addition);
                current.headTruncated ||= capped.truncated;
                streams[messageRef] = current;
            }
        }
        this.toolStreams.set(convoId, streams);
    }

    /**
     * A conversation's header status. A helper's own conversation (a Claude subagent) has its
     * context gauge sized against the parent's window where the bridge under-reported it.
     */
    private statusFor(conversationId: string): SessionStatus | undefined {
        const status = this.statuses.get(conversationId);
        if (!status?.context) return status;
        const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
        const parentId = conversation?.parent_convo_id;
        if (parentId == null || parentId === conversationId) return status;
        return helperContextStatus(status, this.statuses.get(parentId));
    }

    private refreshEphemeralState(conversationId: string): void {
        const viewingHistoricalWindow = this.isViewingHistoricalWindow(conversationId);
        this.patch({
            activity: viewingHistoricalWindow ? undefined : this.activities.get(conversationId),
            sessionStatus: this.statusFor(conversationId),
            textStreams: viewingHistoricalWindow ? {} : { ...(this.textStreams.get(conversationId) ?? {}) },
            toolStreams: viewingHistoricalWindow ? {} : { ...(this.toolStreams.get(conversationId) ?? {}) },
        });
    }

    private async refreshConversations(): Promise<void> {
        if (!this.database) return;
        const conversations = await this.database.conversations();
        // Reconcile dangling tool-call cards against the durable run-state. The tool_stream 'end'
        // frame is never replayed, so a dropped one strands a 'running'
        // tool card in this.toolStreams until the next turn; session_state is the persisted,
        // replayed signal. The activity indicator is deliberately NOT pruned here (upstream
        // db04c8c): the bridge sends activity 'thinking' immediately at turn start but queues the
        // durable 'running' row behind journalPublish, so a prune in that window deleted the live
        // indicator and nothing re-sent it. The Timeline's sessionRunning view gate hides a stale
        // activity instead.
        for (const conversation of conversations) {
            if (conversation.session_state !== "running") this.toolStreams.delete(conversation.id);
        }
        this.patch({ conversations: keepUnchangedConversations(this.state.conversations, conversations) });
        // Keep the published snapshot in lockstep with the private map. Deleting the private
        // entry above does NOT touch ClientState.toolStreams, so a pruned card would otherwise
        // still sit in the snapshot and re-render on the conversation's next running turn.
        // Republish only when a card was just pruned out from under the snapshot, so a routine
        // refresh cannot clobber live streams.
        const selectedId = this.state.selectedConversationId;
        if (
            selectedId !== undefined &&
            !this.toolStreams.has(selectedId) &&
            Object.keys(this.state.toolStreams).length > 0
        ) {
            this.refreshEphemeralState(selectedId);
        }
    }

    private async refreshSelectedConversation(
        expectedId: string,
        db = this.database,
        gen = this.sessionGen,
        selectionEpoch?: number,
    ): Promise<void> {
        if (!db) return;
        const refreshEpoch = (this.issuedRefreshEpochs.get(expectedId) ?? 0) + 1;
        this.issuedRefreshEpochs.set(expectedId, refreshEpoch);
        const [persistedEvents, pendingMessages] = await Promise.all([db.events(expectedId), db.outbox(expectedId)]);
        if (
            refreshEpoch < (this.appliedRefreshEpochs.get(expectedId) ?? 0) ||
            this.sessionGen !== gen ||
            this.database !== db ||
            this.state.selectedConversationId !== expectedId ||
            (selectionEpoch !== undefined && !this.isCurrentSelection(expectedId, selectionEpoch))
        )
            return;
        this.appliedRefreshEpochs.set(expectedId, refreshEpoch);
        const history = this.history.get(expectedId);
        const events = persistedEvents.filter(
            (event) =>
                (history?.oldestSeq === undefined || event.seq >= history.oldestSeq) &&
                (history?.newestSeq === undefined || event.seq <= history.newestSeq),
        );
        const visiblePending = new Map<string, PendingMessage>();
        if (!history?.hasMoreNewer) {
            for (const message of pendingMessages) visiblePending.set(message.localId, message);
            for (const message of this.transientAttachmentErrors.values()) {
                if (message.convoId === expectedId) visiblePending.set(message.localId, message);
            }
        }
        this.patch({
            events,
            pendingMessages: [...visiblePending.values()].map((message) => ({
                ...message,
                canRetry:
                    (message.errorKind === "upload_failed" && this.pendingFiles.has(message.localId)) ||
                    message.errorKind === "send_failed" ||
                    (message.errorKind === "storage_failed" &&
                        (this.pendingFiles.has(message.localId) || Boolean(message.blobRef))),
            })),
        });
    }

    private async persistAttachment(message: PendingMessage, db: JournalDatabase, gen: number): Promise<boolean> {
        if (this.dismissedAttachments.has(message.localId)) return false;
        try {
            await db.addToOutbox(message);
        } catch {
            if (this.sessionGen !== gen || this.database !== db || this.dismissedAttachments.has(message.localId))
                return false;
            const storageError: PendingMessage = {
                ...message,
                attachState: "error",
                errorKind: "storage_failed",
                canRetry: this.pendingFiles.has(message.localId) || Boolean(message.blobRef),
            };
            this.transientAttachmentErrors.set(message.localId, storageError);
            if (
                this.state.selectedConversationId === message.convoId &&
                !this.isViewingHistoricalWindow(message.convoId)
            ) {
                const pendingMessages = this.state.pendingMessages.filter(
                    (pending) => pending.localId !== message.localId,
                );
                this.patch({ pendingMessages: [...pendingMessages, storageError] });
            }
            return false;
        }
        if (this.sessionGen !== gen || this.database !== db || this.dismissedAttachments.has(message.localId))
            return false;
        this.transientAttachmentErrors.delete(message.localId);
        return true;
    }

    private ownsAttachment(owner: AttachmentOwner, localId: string): boolean {
        return (
            this.sessionGen === owner.gen &&
            this.api === owner.api &&
            this.database === owner.db &&
            !this.dismissedAttachments.has(localId)
        );
    }

    private async runAttachmentOperation(localId: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.attachmentOperations.get(localId);
        const current = previous ? previous.catch(() => undefined).then(operation) : operation();
        this.attachmentOperations.set(localId, current);
        try {
            await current;
        } finally {
            if (this.attachmentOperations.get(localId) === current) this.attachmentOperations.delete(localId);
        }
    }

    private isChildConvo(convoId: string): boolean {
        const conversation = this.state.conversations.find((candidate) => candidate.id === convoId);
        return !!conversation && isSubChat(conversation);
    }

    private abortUploadsForChildConvos(): void {
        for (const [localId, convoId] of this.uploadConvos) {
            if (this.isChildConvo(convoId)) this.inFlightUploads.get(localId)?.abort();
        }
    }

    private markChildBlocked(message: PendingMessage): void {
        message.attachState = "error";
        message.errorKind = "send_failed";
        message.errorMessage = "Can't send to a read-only subagent transcript.";
    }

    private sendPendingMessage(message: PendingMessage, connection = this.connection): void {
        if (this.isChildConvo(message.convoId)) {
            this.patch({ controlError: "Couldn't send to a read-only subagent transcript." });
            return;
        }
        if (message.kind === "image" || message.kind === "file") {
            if (!message.blobRef || this.dismissedAttachments.has(message.localId)) return;
            connection?.send({
                op: "send",
                convo_id: message.convoId,
                type: message.kind,
                blob_ref: message.blobRef,
                payload: this.attachmentPayload(message),
                local_id: message.localId,
            });
            return;
        }
        connection?.send({
            op: "send",
            convo_id: message.convoId,
            type: "text",
            payload: { body: message.body, local_id: message.localId },
            local_id: message.localId,
        });
    }

    private scheduleAck(cursor: number): void {
        this.pendingAck = Math.max(this.pendingAck, cursor);
        if (this.ackTimer !== undefined) return;
        this.ackTimer = window.setTimeout(() => {
            this.ackTimer = undefined;
            if (this.connection?.send({ op: "ack", cursor: this.pendingAck })) this.pendingAck = 0;
        }, 250);
    }

    private scheduleRead(conversationId: string, upToSeq: number, delay = 400): void {
        const previous = this.readHighWater.get(conversationId) ?? 0;
        this.readHighWater.set(conversationId, Math.max(previous, upToSeq));
        const currentTimer = this.readTimers.get(conversationId);
        if (currentTimer !== undefined) window.clearTimeout(currentTimer);
        this.readTimers.set(
            conversationId,
            window.setTimeout(() => void this.flushRead(conversationId), delay),
        );
    }

    private async flushRead(conversationId: string): Promise<void> {
        this.readTimers.delete(conversationId);
        if (!this.database) return;
        const upToSeq = this.readHighWater.get(conversationId);
        if (upToSeq === undefined) return;
        const sent =
            this.connection?.send({ op: "read_marker", convo_id: conversationId, up_to_seq: upToSeq }) ?? false;
        if (!sent) return;
        this.readHighWater.delete(conversationId);
        await this.database.markLocallyRead(conversationId, upToSeq);
        await this.refreshConversations();
    }

    private clearHistoryError(): void {
        if (!this.historyError) return;
        if (this.state.connectionError === this.historyError) this.patch({ connectionError: undefined });
        this.historyError = undefined;
    }

    private resetTransientSyncState(): void {
        this.clearRpcCreateWatchdog();
        // Abort an in-flight message search and bump the guard so any late result is ignored —
        // covers logout and the snapshot/session transition that also call this. Clear the section
        // too: the aborted request's result is guarded off, so leaving it would strand a "Searching…"
        // state that never re-fires (the search effect keys on the query, which is unchanged here).
        this.searchAbort?.abort();
        this.searchAbort = undefined;
        this.searchSeq += 1;
        if (this.state.messageSearch) this.patch({ messageSearch: undefined });
        this.closeGoToNumber();
        for (const timer of this.readTimers.values()) window.clearTimeout(timer);
        if (this.ackTimer !== undefined) window.clearTimeout(this.ackTimer);
        if (this.trackerInboxRefetchTimer !== undefined) window.clearTimeout(this.trackerInboxRefetchTimer);
        this.trackerInboxRefetchTimer = undefined;
        if (this.chatTasksRefetchTimer !== undefined) window.clearTimeout(this.chatTasksRefetchTimer);
        this.chatTasksRefetchTimer = undefined;
        this.chatTasksStaged.clear();
        this.inboxWalking = false;
        this.inboxPendingWrites.clear();
        if (this.trackerMissionsRefetchTimer !== undefined) window.clearTimeout(this.trackerMissionsRefetchTimer);
        this.trackerMissionsRefetchTimer = undefined;
        this.trackerMissionRefetchPending = false;
        if (this.conversationMissionsRefetchTimer !== undefined)
            window.clearTimeout(this.conversationMissionsRefetchTimer);
        this.conversationMissionsRefetchTimer = undefined;
        this.conversationMissionsCache.clear();
        this.conversationMissionsCacheGen.clear();
        if (this.trackerItemWorkingRefetchTimer !== undefined) window.clearTimeout(this.trackerItemWorkingRefetchTimer);
        this.trackerItemWorkingRefetchTimer = undefined;
        if (this.briefingExpiryTimer !== undefined) window.clearTimeout(this.briefingExpiryTimer);
        this.briefingExpiryTimer = undefined;
        this.briefingGen += 1;
        if (this.coordinatorRefetchTimer !== undefined) window.clearTimeout(this.coordinatorRefetchTimer);
        this.coordinatorRefetchTimer = undefined;
        this.coordinatorEpoch += 1;
        this.coordinatorStale = false;
        if (this.routinesRefetchTimer !== undefined) window.clearTimeout(this.routinesRefetchTimer);
        this.routinesRefetchTimer = undefined;
        this.routinesGen += 1;
        this.readTimers.clear();
        this.readHighWater.clear();
        this.ackTimer = undefined;
        this.pendingAck = 0;
        // deliberately do NOT clear malformedSeqResyncs / journalHalted here. This runs on
        // every resync (replaceSnapshot), and the reconnect-loop budget must survive resyncs (it is
        // reset only by startSession, on a genuinely new session). The sliding window expires stale
        // budget entries on its own.
        this.historyError = undefined;
        this.history.clear();
        this.conversationTailFetches.clear();
        this.consentHistoryFetches.clear();
        this.activities.clear();
        this.statuses.clear();
        this.hostVitals = null;
        this.textStreams.clear();
        this.toolStreams.clear();
        this.retiredStreamRefs.clear();
    }

    private patch(update: Partial<ClientState>): void {
        const bump = "connectionError" in update && update.connectionError ? 1 : 0;
        this.state = { ...this.state, ...update, connectionErrorSeq: this.state.connectionErrorSeq + bump };
        this.emit();
    }

    private emit(): void {
        // the desktop badge counts exactly the rows Active renders as top-level
        // (canonical predicate) — a hidden done child (no row, no way to clear it) and a
        // nested child both contribute zero, so the badge can never outlive its rows.
        const index = buildSidebarIndex(
            this.state.conversations,
            this.state.archivedIds,
            this.state.collapsedSubagentParentIds,
        );
        const unread = this.state.conversations.reduce(
            (total, conversation) =>
                total +
                (!this.state.archivedIds.has(conversation.id) && rendersAsTopLevelRow(conversation, index)
                    ? conversation.unread_count
                    : 0),
            0,
        );
        ((window as Window & { electron?: ElectronBadgeBridge }).electron as ElectronBadgeBridge | undefined)?.send(
            "setBadgeCount",
            unread,
        );
        for (const listener of this.listeners) listener();
    }
}

/**
 * Bind a GET /briefings/latest (or refresh 202) body defensively: the journal is a separate
 * service, so a version-skewed or malformed field degrades (no briefing, no refresh) rather than
 * crashing the render. A body that is not an object at all throws, which the loader reports.
 */
export function sanitizeBriefingLatest(raw: unknown): BriefingLatest {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("The journal server returned a malformed briefing.");
    }
    const value = raw as Record<string, unknown>;
    const finite = (candidate: unknown): number | undefined =>
        typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
    const b = value.briefing as Record<string, unknown> | null | undefined;
    const briefing =
        b &&
        typeof b === "object" &&
        typeof b.id === "string" &&
        typeof b.body === "string" &&
        typeof b.convo_id === "string" &&
        finite(b.created_at) !== undefined
            ? {
                  id: b.id,
                  body: b.body,
                  created_at: b.created_at as number,
                  convo_id: b.convo_id,
                  seq: finite(b.seq) ?? 0,
              }
            : null;
    const r = value.refresh as Record<string, unknown> | null | undefined;
    const refresh =
        r &&
        typeof r === "object" &&
        (r.state === "pending" || r.state === "failed" || r.state === "timed_out") &&
        finite(r.requested_at) !== undefined
            ? {
                  requested_at: r.requested_at as number,
                  state: r.state as BriefingRefresh["state"],
                  ...(finite(r.expires_at) !== undefined ? { expires_at: r.expires_at as number } : {}),
                  ...(typeof r.outcome === "string" ? { outcome: r.outcome } : {}),
              }
            : null;
    return {
        briefing,
        refresh,
        next_refresh_at: finite(value.next_refresh_at) ?? null,
        has_coordinator: value.has_coordinator === true,
    };
}

/**
 * Why a filing write (move a mission, merge projects) did not happen, in the user's words where
 * the journal says why: a closed project on either end, or a merge only the user or the
 * Coordinator may make. Anything else is the ordinary error message.
 */
export function projectFilingFailure(error: unknown, write: "move" | "merge"): string {
    if (error instanceof JournalApiError) {
        const blockedBy = error.body?.blocked_by;
        if (error.status === 409 && (blockedBy === "project_closed" || blockedBy === "into_closed")) {
            return "That project is closed, so nothing can move into it.";
        }
        // `closed` names the row the write addresses: the mission on a move, the source on a merge.
        if (error.status === 409 && blockedBy === "closed") {
            return write === "move"
                ? "This mission is closed, so it stays where it is."
                : "This project is already closed.";
        }
        if (error.status === 403 && error.body?.detail === "not_coordinator") {
            return "Only you or your Coordinator can merge projects.";
        }
    }
    return errorMessage(error);
}

/** A `/coordinator` body's `convo_id`: the id, null for none, undefined when it says nothing. */
function coordinatorIdIn(raw: unknown): string | null | undefined {
    if (!raw || typeof raw !== "object" || !("convo_id" in raw)) return undefined;
    const id = (raw as { convo_id?: unknown }).convo_id;
    if (id === null) return null;
    return typeof id === "string" ? id || null : undefined;
}

/** The `{routine}` of a create or edit answer, or null when malformed. */
function routineIn(raw: unknown): Routine | null {
    return parseRoutine(raw && typeof raw === "object" ? (raw as { routine?: unknown }).routine : undefined);
}

/** A failed routines write in the sheet's words. */
function routineFailure(error: unknown, collection: boolean): string {
    if (error instanceof JournalApiError) {
        const message = routineErrorMessage(error.status, error.body, collection);
        if (message) return message;
    }
    return errorMessage(error);
}

export function errorMessage(error: unknown): string {
    if (error instanceof JournalApiError && error.retryAfter) {
        return `${error.message} (${error.retryAfter}s)`;
    }
    return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Why an item comment was not written. A refusal (a 4xx other than an expired or refused session
 * or a rate limit) says what the journal said: its `message`, else — for `too_many_attachments` —
 * the limit (the response's `max`), else its `reason`, else the sentence for an error code this
 * client knows, else that the server refused it and with what status. Anything else — offline, a timeout, a 5xx, auth, a rate
 * limit with its wait — is the ordinary error message.
 */
export function commentFailureMessage(error: unknown): string {
    if (
        !(error instanceof JournalApiError) ||
        error.status < 400 ||
        error.status >= 500 ||
        error.status === 401 ||
        error.status === 403 ||
        error.status === 429
    ) {
        return errorMessage(error);
    }
    const body = error.body ?? {};
    if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
    if (error.code === "too_many_attachments") {
        const max = typeof body.max === "number" && body.max > 0 ? body.max : JOURNAL_ATTACHMENTS_MAX;
        return `The journal takes at most ${max} attachments on one comment.`;
    }
    if (typeof body.reason === "string" && body.reason.trim()) {
        return `The server refused it: ${body.reason.trim().replace(/_/g, " ")}.`;
    }
    return knownErrorMessage(error.code) ?? `The server refused it (HTTP ${error.status}).`;
}

// The journal's largest page. The open-items walk is sequential, so on a real network each extra
// page is another round trip before the inbox can show anything; the default 100 took a dozen.
const OPEN_ITEMS_PAGE = 500;

/** The Done tab's page: what the user answered, decided or read, most recently touched first. */
const INBOX_DONE_FILTER = {
    state: "done",
    kind: ["question", "decision", "notice"],
    sort: "acted",
    limit: 50,
} as const;

/** True when `row` comes after `mark` in the journal's `sort=acted` order (the user's last action
 *  first, then the higher number). */
function sortsAfter(row: TrackerItem, mark: TrackerItem): boolean {
    const r = doneSortKey(row);
    const m = doneSortKey(mark);
    return r < m || (r === m && row.num < mark.num);
}

/** Done rows in the journal's `sort=acted` order. */
function inDoneOrder(rows: TrackerItem[]): TrackerItem[] {
    return [...rows].sort((a, b) => (sortsAfter(a, b) ? 1 : sortsAfter(b, a) ? -1 : 0));
}

/** The label of a notice's one-tap answer; the journal closes the notice when it is tapped. */
const SEEN_ACTION = "Seen";

/** Validate each supported setting independently; absent values keep older journals compatible. */
function parseUserSettings(raw: unknown): UserSettings | null {
    if (typeof raw !== "object" || raw === null) return null;
    const view = raw as Record<string, unknown>;
    const settings: UserSettings = {};
    if (typeof view.notices === "boolean") settings.notices = view.notices;
    if (typeof view.auto_approve_coordinator_spawns === "boolean") {
        settings.auto_approve_coordinator_spawns = view.auto_approve_coordinator_spawns;
    }
    return Object.keys(settings).length ? settings : null;
}
