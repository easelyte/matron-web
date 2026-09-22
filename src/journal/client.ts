/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApi, JournalApiError, loadMatronConfig } from "./api";
import { JournalConnection } from "./connection";
import { effectiveUnread, makeIdSetStore, type IdSetStore } from "./conversation-flags";
import { JournalDatabase } from "./database";
import { mergeSessionStatus } from "./status";
import {
    buildSidebarIndex,
    childSidebarPlacement,
    type ClientState,
    type Conversation,
    type DeviceDTO,
    isSubChat,
    type JournalEphemeralFrame,
    type JournalEvent,
    MESSAGE_EVENT_TYPES,
    normalizeServerUrl,
    type PendingMessage,
    type RecentFolder,
    rendersAsTopLevelRow,
    type RpcReply,
    type ServerFrame,
    type Session,
    type SnapshotResponse,
    trimUtf8Prefix,
    type ToolStreamState,
    utf8Length,
} from "./types";

const SESSION_KEY = "matron_journal_session_v1";
const LAST_SERVER_KEY = "matron_journal_last_server";
const SELECTED_CONVERSATION_KEY_PREFIX = "matron_journal_selected_conversation_v1";
const HISTORY_PAGE_SIZE = 80;
const RPC_CREATE_WATCHDOG_MS = 10_000;
const BACKFILL_SNAPSHOT_TIMEOUT_MS = 10_000;
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
export const collapsedSubagentStore: IdSetStore = makeIdSetStore(
    "matron_journal_collapsed_subagents_v1",
    "collapsed-subagents",
);

interface ConversationHistoryState {
    initialized: boolean;
    oldestSeq?: number;
    hasMore: boolean;
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

export type StartOutcome =
    { kind: "created"; convoId: string } | { kind: "error"; message: string } | { kind: "uncertain" };

export type WorkerKind = "claude" | "codex";

export function workerKind(conversation: Conversation): WorkerKind | null {
    if (!isSubChat(conversation)) return null;
    if (/:codex:[^:]+$/.test(conversation.id)) return "codex";
    if (/:sub:[^:]+$/.test(conversation.id)) return "claude";
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
        favoriteIds: new Set(),
        unreadOverrideIds: new Set(),
        collapsedSubagentParentIds: new Set(),
        controlError: undefined,
        events: [],
        pendingMessages: [],
        connection: "offline",
        connectionErrorSeq: 0,
        loadingHistory: false,
        hasOlderHistory: false,
        textStreams: {},
        toolStreams: {},
        dragActive: false,
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
    // silently auto-selected on reload; skip to the next selectable top-level row. The collapsed
    // set matches render/mark-all/badge, so a collapsed (hidden) child is never auto-selected.
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

function abortPromise(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        const rejectAbort = (): void => reject(new DOMException("The upload timed out.", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
    });
}

export class MatronJournalClient {
    private state = blankState();
    private readonly listeners = new Set<() => void>();
    private api?: JournalApi;
    private database?: JournalDatabase;
    private connection?: JournalConnection;
    private readonly history = new Map<string, ConversationHistoryState>();
    private readonly activities = new Map<string, JournalEphemeralFrame["activity"]>();
    private readonly statuses = new Map<string, NonNullable<JournalEphemeralFrame["status"]>>();
    private readonly textStreams = new Map<string, Record<string, string>>();
    private readonly toolStreams = new Map<string, Record<string, ToolStreamState>>();
    private readonly retiredStreamRefs = new Set<string>();
    private readonly mediaUrls = new Map<string, string>();
    private readonly mediaUrlRequests = new Map<string, Promise<string>>();
    private readonly readHighWater = new Map<string, number>();
    private readonly readTimers = new Map<string, number>();
    private pendingFiles = new Map<string, File>();
    private stagedSendChain: Promise<void> = Promise.resolve();
    private transientAttachmentErrors = new Map<string, PendingMessage>();
    private readonly dismissedAttachments = new Set<string>();
    private readonly attachmentOperations = new Map<string, Promise<void>>();
    private readonly retryingAttachments = new Set<string>();
    private inFlightUploads = new Map<string, AbortController>();
    private readonly uploadConvos = new Map<string, string>();
    private readonly issuedRefreshEpochs = new Map<string, number>();
    private readonly appliedRefreshEpochs = new Map<string, number>();
    private sessionGen = 0;
    private ackTimer?: number;
    private pendingAck = 0;
    private historyError?: string;
    private startSessionRequest?: Promise<StartOutcome>;
    private rpcCreateWatchdog?: number;
    private rpcCreateWatchdogConvo?: string;
    private rpcCreateWatchdogGen?: number;
    private storageListener?: (event: StorageEvent) => void;
    private storeHydrated = { archive: true, pinned: true, favorite: true, unread: true, collapsed: true };
    private storeWritable = { archive: true, pinned: true, favorite: true, unread: true, collapsed: true };

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

        const session = storedSession();
        if (!session) {
            this.patch({ phase: "signed-out" });
            return;
        }

        try {
            await this.startSession(session);
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
    }

    public async logout(message?: string): Promise<void> {
        this.sessionGen += 1;
        for (const controller of this.inFlightUploads.values()) controller.abort();
        this.inFlightUploads.clear();
        this.uploadConvos.clear();
        this.dismissedAttachments.clear();
        this.pendingFiles.clear();
        this.transientAttachmentErrors.clear();
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
        for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
        this.mediaUrls.clear();
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
        const reply = await this.agentRpc(agentDeviceId, "recent_folders", {});
        if (!reply.ok || typeof reply.result !== "object" || reply.result === null || Array.isArray(reply.result)) {
            return [];
        }
        const folders = (reply.result as Record<string, unknown>).folders;
        if (!Array.isArray(folders)) return [];
        return folders.flatMap((raw): RecentFolder[] => {
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
            const folder = raw as Record<string, unknown>;
            if (
                typeof folder.path !== "string" ||
                folder.path.length === 0 ||
                (folder.last_used !== null &&
                    (typeof folder.last_used !== "number" || !Number.isFinite(folder.last_used)))
            ) {
                return [];
            }
            return [{ path: folder.path, last_used: folder.last_used }];
        });
    }

    public startSessionRpc(agentDeviceId: number, workdir: string, browser: boolean): Promise<StartOutcome> {
        if (this.startSessionRequest) {
            return Promise.resolve({ kind: "error", message: "A session is already starting — please wait." });
        }

        const request = this.performStartSessionRpc(agentDeviceId, workdir, browser);
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
    ): Promise<StartOutcome> {
        const params: { workdir?: string; browser?: true } = {};
        const normalizedWorkdir = workdir.trim();
        if (normalizedWorkdir) params.workdir = normalizedWorkdir;
        if (browser) params.browser = true;

        const reply = await this.agentRpc(agentDeviceId, "start", params);
        if (reply.ok) {
            if (typeof reply.result !== "object" || reply.result === null || Array.isArray(reply.result)) {
                return { kind: "uncertain" };
            }
            const convoId = (reply.result as Record<string, unknown>).convo_id;
            return typeof convoId === "string" && convoId.length > 0
                ? { kind: "created", convoId }
                : { kind: "uncertain" };
        }
        if (reply.origin === "relay") {
            return {
                kind: "error",
                message:
                    reply.code === "not_connected" || reply.code === "not_ready"
                        ? "Still connecting — try again in a moment."
                        : "Couldn't reach that box — try again.",
            };
        }
        if (reply.origin === "agent" && reply.code === "bad_workdir") {
            return { kind: "error", message: "That folder doesn't exist on the box." };
        }
        return { kind: "uncertain" };
    }

    public async selectConversation(
        conversationId: string,
        opts?: { clearUnread?: boolean; fromRpcCreate?: boolean; suppressNotFound?: boolean },
    ): Promise<void> {
        if (!this.database || !this.state.session) return;
        // fromRpcCreate is for a room created milliseconds ago by this client's own RPC: it arms
        // the sync watchdog (frames must follow shortly) AND tolerates a young room's 404 on
        // history. suppressNotFound wants only the latter — opening a spawn-created room long
        // after the fact must not arm a watchdog that only an incoming frame can clear, or an
        // idle session reports "not syncing" as an error.
        if (opts?.fromRpcCreate) this.armRpcCreateWatchdog(conversationId);
        if (opts?.clearUnread ?? true) this.clearUnreadOverride(conversationId);
        storeSelectedConversation(this.state.session, conversationId);
        this.patch({
            selectedConversationId: conversationId,
            events: [],
            pendingMessages: [],
            loadingHistory: false,
            hasOlderHistory: this.history.get(conversationId)?.hasMore ?? true,
            activity: this.activities.get(conversationId),
            sessionStatus: this.statuses.get(conversationId),
            textStreams: { ...(this.textStreams.get(conversationId) ?? {}) },
            toolStreams: { ...(this.toolStreams.get(conversationId) ?? {}) },
        });
        await this.refreshSelectedConversation(conversationId);
        if (this.state.selectedConversationId !== conversationId) return;
        this.connection?.send({ op: "viewing", convo_id: conversationId });

        const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
        if (conversation?.unread_count) this.scheduleRead(conversationId, conversation.last_seq, 0);

        if (!this.history.get(conversationId)?.initialized) {
            await this.loadOlderHistory({ suppressNotFound: opts?.fromRpcCreate || opts?.suppressNotFound });
        }
    }

    public clearSelection(): void {
        this.connection?.send({ op: "viewing", convo_id: null });
        if (this.state.session) storeSelectedConversation(this.state.session, undefined);
        this.patch({ selectedConversationId: undefined, events: [], pendingMessages: [] });
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
     * Toggle whether a parent conversation's subagent child rows are collapsed in the sidebar.
     * Persisted per session/user like the other row flags; the collapsed set is threaded into
     * every buildSidebarIndex call, so collapsing suppresses the child rows across render,
     * selection, unread aggregation, the desktop badge, and mark-all in lock-step.
     */
    public toggleSubagentCollapse(parentId: string): void {
        const collapse = !this.state.collapsedSubagentParentIds.has(parentId);
        const applied = this.setFlag(collapsedSubagentStore, "collapsedSubagentParentIds", parentId, collapse);
        // Collapsing suppresses the parent's child rows. If the reading pane is pointed at one of
        // those now-hidden children, leaving selection there lets the next snapshot resync reject it
        // and swap the pane to an unrelated top-level convo. Fold selection UP to the (still-visible)
        // host parent — matching the collapse mental model (cf. archive's deselect precedent).
        if (applied && collapse) this.foldSelectionUnderCollapsedParent();
    }

    /**
     * After a subagent parent is collapsed (locally or cross-tab), a RUNNING child that was the
     * reading-pane selection just became a hidden row. Fold selection up to that child's host
     * parent so the resync can't yank the pane elsewhere. No-op unless the current selection is a
     * running child that the canonical index now resolves to "hidden" under a visible parent, so a
     * done child (hidden for an unrelated reason) is never dragged into its parent.
     */
    private foldSelectionUnderCollapsedParent(): void {
        const selectedId = this.state.selectedConversationId;
        if (!selectedId) return;
        const selected = this.state.conversations.find((conversation) => conversation.id === selectedId);
        if (!selected || selected.session_state !== "running") return;
        const parentId = selected.parent_convo_id;
        if (parentId == null || parentId === "") return;
        const index = buildSidebarIndex(
            this.state.conversations,
            this.state.archivedIds,
            this.state.collapsedSubagentParentIds,
        );
        if (childSidebarPlacement(selected, index) !== "hidden") return;
        const parent = this.state.conversations.find((conversation) => conversation.id === parentId);
        if (parent && rendersAsTopLevelRow(parent, index)) void this.selectConversation(parentId);
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
        const history = this.history.get(conversationId) ?? { initialized: false, hasMore: true };
        if (history.initialized && !history.hasMore) return;

        this.patch({ loadingHistory: true });
        try {
            const response = await this.api.messages(
                conversationId,
                history.initialized ? history.oldestSeq : undefined,
                HISTORY_PAGE_SIZE,
            );
            await this.database.putHistory(response.events);
            await this.reconcilePersistedOwnMessages(this.database);
            const minimum = response.events.reduce<number | undefined>(
                (current, event) => (current === undefined ? event.seq : Math.min(current, event.seq)),
                history.oldestSeq,
            );
            const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
            const emptyInitialPageWithKnownHistory =
                !history.initialized && response.events.length === 0 && (conversation?.last_seq ?? 0) > 0;
            this.history.set(conversationId, {
                initialized: !emptyInitialPageWithKnownHistory,
                oldestSeq: minimum,
                hasMore: emptyInitialPageWithKnownHistory || response.events.length === HISTORY_PAGE_SIZE,
            });
            if (this.state.selectedConversationId === conversationId)
                await this.refreshSelectedConversation(conversationId);
            this.clearHistoryError();
        } catch (error) {
            if (
                opts?.suppressNotFound &&
                error instanceof JournalApiError &&
                error.status === 404 &&
                error.code === "not_found"
            ) {
                this.history.set(conversationId, { initialized: true, hasMore: false });
                this.clearHistoryError();
                return;
            }
            this.historyError = error instanceof Error ? error.message : "Could not load message history";
            this.patch({ connectionError: this.historyError });
        } finally {
            if (this.state.selectedConversationId === conversationId) {
                this.patch({
                    loadingHistory: false,
                    hasOlderHistory: this.history.get(conversationId)?.hasMore ?? false,
                });
            }
        }
    }

    public async sendMessage(bodyInput: string, targetConvoId?: string): Promise<boolean> {
        const body = bodyInput.trim();
        const conversationId = targetConvoId ?? this.state.selectedConversationId;
        if (!body || !conversationId || !this.database) return false;
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
                    this.state.selectedConversationId === message.convoId
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

    public async sendVoiceNote(
        blob: Blob,
        convoId?: string,
        sessionGen = this.sessionGen,
    ): Promise<"sent" | "persisted-terminal" | "persist-failed" | "skipped"> {
        if (sessionGen !== this.sessionGen) return "skipped";
        const cid = convoId ?? this.state.selectedConversationId;
        if (!cid || this.isChildConvo(cid) || this.state.archivedIds.has(cid)) return "skipped";
        if (blob.size === 0) return "skipped";

        const type = blob.type || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `voice-note.${ext}`, { type });
        return await this.sendAttachment(file, cid, undefined, sessionGen);
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
        // (three-layer model, a documented server follow-up).
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

    public stageFiles(files: File[]): void {
        if (files.length === 0) return;
        const staged = this.state.stagedUploads;
        if (staged) {
            if (this.isChildConvo(staged.convoId)) return;
            if (staged.error) return;
            this.patch({
                stagedUploads: {
                    ...staged,
                    items: [...staged.items, ...files.map((file) => ({ id: crypto.randomUUID(), file }))],
                    total: staged.total + files.length,
                },
            });
            return;
        }
        const convoId = this.state.selectedConversationId;
        if (!convoId) return;
        if (this.isChildConvo(convoId)) return;
        this.patch({
            stagedUploads: {
                convoId,
                items: files.map((file) => ({ id: crypto.randomUUID(), file })),
                total: files.length,
                confirming: false,
            },
        });
    }

    public async confirmStagedFile(itemId: string, captionInput?: string): Promise<void> {
        const staged = this.state.stagedUploads;
        if (!staged || staged.confirming || staged.error) return;
        const head = staged.items[0];
        if (!head || head.id !== itemId) return;
        if (this.isChildConvo(staged.convoId)) return;
        this.patch({ stagedUploads: { ...staged, confirming: true } });

        const gen = this.sessionGen;
        const api = this.api;
        const db = this.database;
        if (!api || !db) {
            const current = this.state.stagedUploads;
            if (current) this.patch({ stagedUploads: { ...current, confirming: false } });
            return;
        }
        const owner: AttachmentOwner = { gen, api, db };
        const convoId = staged.convoId;

        if (!this.stagedConvoValid(convoId)) {
            this.patch({ stagedUploads: { ...staged, items: [], confirming: false, error: "archived" } });
            return;
        }

        const caption = captionInput?.trim() ? captionInput.trim() : undefined;
        const message = head.message ?? this.buildPendingAttachment(head.file, convoId, caption);
        head.message = message;
        if (caption) message.caption = caption;
        else delete message.caption;

        const persistOutcome = await this.persistPendingAttachment(message, head.file, db, gen);
        if (this.sessionGen !== gen) return;
        const current = this.state.stagedUploads;
        if (!current) return;
        if (persistOutcome.kind === "persist-failed") {
            this.transientAttachmentErrors.delete(message.localId);
            this.pendingFiles.delete(message.localId);
            if (this.state.selectedConversationId === convoId) {
                await this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
            }
            const afterPurge = this.state.stagedUploads;
            if (!afterPurge) return;
            this.patch({ stagedUploads: { ...afterPurge, confirming: false, persistError: true } });
            return;
        }
        if (this.state.selectedConversationId === convoId) {
            this.patch({ sendTick: this.state.sendTick + 1 });
        }
        void this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
        const rest = current.items.slice(1);
        this.patch({
            stagedUploads: rest.length
                ? { ...current, items: rest, confirming: false, persistError: false }
                : undefined,
        });

        if (persistOutcome.kind === "persisted-terminal") return;

        this.stagedSendChain = this.stagedSendChain.then(async () => {
            try {
                if (this.sessionGen !== gen || this.database !== db) return;
                if (!this.stagedConvoValid(convoId)) {
                    message.attachState = "error";
                    message.errorKind = "upload_failed";
                    message.errorMessage = "Conversation was archived in another tab — unarchive to retry.";
                    if (await this.persistAttachment(message, db, gen)) {
                        await this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
                    }
                    return;
                }
                await this.runPendingUpload(message, head.file, owner);
            } catch {
                // Rejection isolation: one failed upload must not poison the chain.
            }
        });
    }

    public skipStagedFile(itemId: string): void {
        const staged = this.state.stagedUploads;
        if (!staged || staged.confirming || staged.error) return;
        const head = staged.items[0];
        if (!head || head.id !== itemId) return;
        const rest = staged.items.slice(1);
        this.patch({
            stagedUploads: rest.length ? { ...staged, items: rest, persistError: false } : undefined,
        });
    }

    public cancelStagedFiles(): void {
        const staged = this.state.stagedUploads;
        if (!staged) return;
        // The confirming lock guards all mutations at the client boundary.
        if (staged.confirming) return;
        this.patch({ stagedUploads: undefined });
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
        if (this.isChildConvo(this.state.selectedConversationId ?? "")) return false;
        const conversationId = this.state.selectedConversationId;
        if (!conversationId) return false;
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
        if (!this.api) throw new Error("Not signed in.");
        await this.api.answerAgentSpawn(requestId, decision, signal);
    }

    // Concurrent callers for the same id (the viewer body and its DownloadLink mount in the
    // same commit) share one in-flight request: without the dedupe map each miss fetched the
    // blob again and the loser's object URL was overwritten in the cache — never revoked, a
    // permanent leak of the whole blob.
    public mediaUrl(mediaId: string): Promise<string> {
        const cached = this.mediaUrls.get(mediaId);
        if (cached) return Promise.resolve(cached);
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
            } finally {
                this.mediaUrlRequests.delete(mediaId);
            }
        })();
        this.mediaUrlRequests.set(mediaId, request);
        return request;
    }

    public selectedConversation(): Conversation | undefined {
        return this.state.conversations.find((conversation) => conversation.id === this.state.selectedConversationId);
    }

    private async startSession(session: Session): Promise<void> {
        this.sessionGen += 1;
        this.storeHydrated = { archive: true, pinned: true, favorite: true, unread: true, collapsed: true };
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
            collapsed: storeWritable,
        };
        for (const controller of this.inFlightUploads.values()) controller.abort();
        this.inFlightUploads.clear();
        this.uploadConvos.clear();
        this.dismissedAttachments.clear();
        this.pendingFiles.clear();
        this.stagedSendChain = Promise.resolve();
        this.transientAttachmentErrors.clear();
        this.connection?.stop();
        this.database?.close();
        this.api = new JournalApi(session.serverUrl, session.token);
        this.database = await JournalDatabase.open(session.serverUrl, session.userId, session.username);
        await this.database.expireToolLogs();

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
        const collapsedRead = collapsedSubagentStore.read(session);
        this.storeHydrated.archive = archiveRead.ok;
        this.storeHydrated.pinned = pinnedRead.ok;
        this.storeHydrated.favorite = favoriteRead.ok;
        this.storeHydrated.unread = unreadRead.ok;
        this.storeHydrated.collapsed = collapsedRead.ok;
        if (!archiveRead.ok) this.logStorageDiag("read_fail", "archive", false);
        if (!pinnedRead.ok) this.logStorageDiag("read_fail", "pinned", false);
        if (!favoriteRead.ok) this.logStorageDiag("read_fail", "favorite", false);
        if (!unreadRead.ok) this.logStorageDiag("read_fail", "unread", false);
        if (!collapsedRead.ok) this.logStorageDiag("read_fail", "collapsed", false);
        const bootstrapTransitionStore = !archiveRead.ok
            ? "archive"
            : !pinnedRead.ok
              ? "pinned"
              : !favoriteRead.ok
                ? "favorite"
                : !unreadRead.ok
                  ? "unread"
                  : !collapsedRead.ok
                    ? "collapsed"
                    : "all";
        const bootstrapReadFailed = this.storageUnavailable(bootstrapTransitionStore);
        const archivedIds = archiveRead.ids;
        const pinnedIds = pinnedRead.ids;
        const favoriteIds = favoriteRead.ids;
        const unreadOverrideIds = unreadRead.ids;
        const collapsedSubagentParentIds = collapsedRead.ids;
        const selectedConversation = firstSelectableConversation(
            conversations,
            storedConversationId,
            archivedIds,
            collapsedSubagentParentIds,
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
            collapsedSubagentParentIds,
            preferencesUnavailable: bootstrapReadFailed,
            selectedConversationId: selectedConversation?.id,
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
            } else if (event.key === collapsedSubagentStore.storageKey(currentSession)) {
                const read = collapsedSubagentStore.read(currentSession);
                this.storeHydrated.collapsed = read.ok;
                if (read.ok) this.storeWritable.collapsed = true;
                if (!read.ok) this.logStorageDiag("read_fail", "collapsed", false);
                this.patch({
                    ...(read.ok ? { collapsedSubagentParentIds: read.ids } : {}),
                    preferencesUnavailable: this.storageUnavailable("collapsed"),
                });
                // Mirror the local toggle: a cross-tab collapse can hide the selected child too.
                if (read.ok) this.foldSelectionUnderCollapsedParent();
            }
        };
        window.addEventListener("storage", this.storageListener);
        this.emit();
        if (selectedConversation) await this.selectConversation(selectedConversation.id, { clearUnread: false });

        this.connection = new JournalConnection(session.serverUrl, session.token, {
            cursor: async () => (await this.database?.cursor()) ?? cursor ?? 0,
            onFrame: async (frame) => this.handleFrame(frame),
            onReady: async () => this.handleReady(),
            onSnapshotRequired: async () => this.replaceSnapshot(),
            onRevoked: () => void this.logout("This device was revoked. Sign in again to continue."),
            onState: (connection, error) => this.patch({ connection, connectionError: error }),
        });
        this.connection.start();
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
        stateKey: "pinnedIds" | "favoriteIds" | "unreadOverrideIds" | "collapsedSubagentParentIds",
        id: string,
        on: boolean,
    ): boolean {
        const session = this.state.session;
        if (!session) return false;

        let storeName: "pinned" | "favorite" | "unread" | "collapsed";
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
            case "collapsedSubagentParentIds":
                storeName = "collapsed";
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
        this.clearRpcCreateWatchdog();
        const gen = this.sessionGen;
        this.rpcCreateWatchdogConvo = conversationId;
        this.rpcCreateWatchdogGen = gen;
        this.rpcCreateWatchdog = window.setTimeout(() => {
            if (this.rpcCreateWatchdogConvo !== conversationId || this.rpcCreateWatchdogGen !== gen) return;
            this.rpcCreateWatchdog = undefined;
            this.rpcCreateWatchdogConvo = undefined;
            this.rpcCreateWatchdogGen = undefined;
            if (this.sessionGen !== gen || this.state.selectedConversationId !== conversationId) return;
            this.logRpcCreateDiag("sync_watchdog_fire", conversationId);
            this.patch({ connectionError: "Session created but not syncing yet — refresh to retry." });
        }, RPC_CREATE_WATCHDOG_MS);
    }

    private clearRpcCreateWatchdog(conversationId?: string): void {
        if (conversationId !== undefined && this.rpcCreateWatchdogConvo !== conversationId) return;
        if (this.rpcCreateWatchdog !== undefined) window.clearTimeout(this.rpcCreateWatchdog);
        this.rpcCreateWatchdog = undefined;
        this.rpcCreateWatchdogConvo = undefined;
        this.rpcCreateWatchdogGen = undefined;
    }

    private async replaceSnapshot(): Promise<void> {
        if (!this.api || !this.database) return;
        const previousSelection = this.state.selectedConversationId;
        this.resetTransientSyncState();
        this.patch({
            connection: "connecting",
            connectionError: undefined,
            events: [],
            pendingMessages: [],
            loadingHistory: false,
            hasOlderHistory: true,
            activity: undefined,
            sessionStatus: undefined,
            textStreams: {},
            toolStreams: {},
        });
        const snapshot = await this.api.snapshot();
        await this.database.replaceWithSnapshot(snapshot);
        await this.reconcilePersistedOwnMessages(this.database);
        const conversations = await this.database.conversations();
        let { archivedIds, pinnedIds, favoriteIds, unreadOverrideIds, collapsedSubagentParentIds } = this.state;
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
            const collapsedRead = collapsedSubagentStore.read(session);
            this.storeHydrated.collapsed = collapsedRead.ok;
            if (!collapsedRead.ok) this.logStorageDiag("read_fail", "collapsed", false);
            if (collapsedRead.ok) collapsedSubagentParentIds = collapsedRead.ids;
        }
        const snapshotTransitionStore = !this.storeHydrated.archive
            ? "archive"
            : !this.storeHydrated.pinned
              ? "pinned"
              : !this.storeHydrated.favorite
                ? "favorite"
                : !this.storeHydrated.unread
                  ? "unread"
                  : !this.storeHydrated.collapsed
                    ? "collapsed"
                    : "all";
        const selectedConversation = firstSelectableConversation(
            conversations,
            previousSelection,
            archivedIds,
            collapsedSubagentParentIds,
        );
        this.patch({
            conversations,
            archivedIds,
            pinnedIds,
            favoriteIds,
            unreadOverrideIds,
            collapsedSubagentParentIds,
            selectedConversationId: selectedConversation?.id,
            preferencesUnavailable: this.storageUnavailable(snapshotTransitionStore),
        });
        // A snapshot can be the first place THIS tab observes a convo's parent link (→ read-only child).
        // Mirror the journal-event path and abort any in-flight upload to a now-child convo so it can't
        // egress to a read-only transcript. Guarded to skip work when idle.
        if (this.uploadConvos.size > 0) this.abortUploadsForChildConvos();
        if (selectedConversation) await this.selectConversation(selectedConversation.id, { clearUnread: false });
        else if (this.state.session) storeSelectedConversation(this.state.session, undefined);
    }

    private async handleReady(): Promise<void> {
        const gen = this.sessionGen;
        const db = this.database;
        const connection = this.connection;
        if (!db || !connection) return;
        const ownsReplay = (): boolean =>
            this.sessionGen === gen && this.database === db && this.connection === connection;

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
            if (conversation?.unread_count) this.scheduleRead(conversation.id, conversation.last_seq, 0);
        }
        for (const [conversationId, upToSeq] of this.readHighWater) {
            this.scheduleRead(conversationId, upToSeq, 0);
        }
        const cursor = await db.cursor();
        if (!ownsReplay()) return;
        if (cursor !== undefined) connection.send({ op: "ack", cursor });
    }

    private async handleFrame(frame: ServerFrame): Promise<void> {
        if (frame.kind === "journal") {
            await this.handleJournal(frame);
            return;
        }
        if (frame.kind === "ephemeral") {
            this.handleEphemeral(frame);
            return;
        }
        if (frame.kind === "control" && frame.op === "error") {
            this.patch({ connectionError: frame.detail || `Journal operation failed: ${frame.code ?? "unknown"}` });
        }
    }

    private async handleJournal(event: JournalEvent): Promise<void> {
        if (!this.database) return;
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
            if (event.type === "convo_meta" && this.uploadConvos.size > 0) {
                await this.refreshConversations();
                this.abortUploadsForChildConvos();
            }
            return;
        }
        this.clearHistoryError();
        this.scheduleAck(event.seq);

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
        if (event.convo_id === this.state.selectedConversationId) {
            await this.refreshSelectedConversation(event.convo_id);
            if (MESSAGE_EVENT_TYPES.has(event.type) && !event.sender.startsWith("user:")) {
                this.scheduleRead(event.convo_id, event.seq);
            }
        }
    }

    private async reconcilePersistedOwnMessages(database: JournalDatabase): Promise<void> {
        const removed = await database.reconcilePersistedOwnMessages();
        for (const localId of removed) {
            this.pendingFiles.delete(localId);
            this.transientAttachmentErrors.delete(localId);
        }
    }

    private handleEphemeral(frame: JournalEphemeralFrame): void {
        if (frame.activity) {
            if (frame.activity.state === "idle") this.activities.delete(frame.convo_id);
            else this.activities.set(frame.convo_id, frame.activity);
        }
        if (frame.status) {
            this.statuses.set(frame.convo_id, mergeSessionStatus(this.statuses.get(frame.convo_id), frame.status));
        }
        if (frame.tool_stream && frame.message_ref) {
            this.applyToolStream(frame);
        }
        if (frame.message_ref && (typeof frame.text === "string" || typeof frame.replace_text === "string")) {
            const key = `${frame.convo_id}:${frame.message_ref}`;
            if (!this.retiredStreamRefs.has(key)) {
                const streams = this.textStreams.get(frame.convo_id) ?? {};
                streams[frame.message_ref] =
                    typeof frame.replace_text === "string"
                        ? frame.replace_text
                        : `${streams[frame.message_ref] ?? ""}${frame.text ?? ""}`;
                this.textStreams.set(frame.convo_id, streams);
            }
        }
        if (frame.convo_id === this.state.selectedConversationId) this.refreshEphemeralState(frame.convo_id);
    }

    private applyToolStream(frame: JournalEphemeralFrame): void {
        const payload = frame.tool_stream;
        const messageRef = frame.message_ref;
        if (!payload || !messageRef || this.retiredStreamRefs.has(`${frame.convo_id}:${messageRef}`)) return;
        const streams = this.toolStreams.get(frame.convo_id) ?? {};
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
        this.toolStreams.set(frame.convo_id, streams);
    }

    private refreshEphemeralState(conversationId: string): void {
        this.patch({
            activity: this.activities.get(conversationId),
            sessionStatus: this.statuses.get(conversationId),
            textStreams: { ...(this.textStreams.get(conversationId) ?? {}) },
            toolStreams: { ...(this.toolStreams.get(conversationId) ?? {}) },
        });
    }

    private async refreshConversations(): Promise<void> {
        if (!this.database) return;
        this.patch({ conversations: await this.database.conversations() });
    }

    private async refreshSelectedConversation(
        expectedId: string,
        db = this.database,
        gen = this.sessionGen,
    ): Promise<void> {
        if (!db) return;
        const refreshEpoch = (this.issuedRefreshEpochs.get(expectedId) ?? 0) + 1;
        this.issuedRefreshEpochs.set(expectedId, refreshEpoch);
        const [events, pendingMessages] = await Promise.all([db.events(expectedId), db.outbox(expectedId)]);
        if (
            refreshEpoch < (this.appliedRefreshEpochs.get(expectedId) ?? 0) ||
            this.sessionGen !== gen ||
            this.database !== db ||
            this.state.selectedConversationId !== expectedId
        )
            return;
        this.appliedRefreshEpochs.set(expectedId, refreshEpoch);
        const visiblePending = new Map(pendingMessages.map((message) => [message.localId, message]));
        for (const message of this.transientAttachmentErrors.values()) {
            if (message.convoId === expectedId) visiblePending.set(message.localId, message);
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
            if (this.state.selectedConversationId === message.convoId) {
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
        for (const timer of this.readTimers.values()) window.clearTimeout(timer);
        if (this.ackTimer !== undefined) window.clearTimeout(this.ackTimer);
        this.readTimers.clear();
        this.readHighWater.clear();
        this.ackTimer = undefined;
        this.pendingAck = 0;
        this.historyError = undefined;
        this.history.clear();
        this.activities.clear();
        this.statuses.clear();
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
        // The desktop badge counts exactly the rows Active renders as top-level. Archived
        // conversations are hidden from the active list and skipped by mark-all-read, so they
        // must not inflate the badge; likewise a hidden done child (no row, no way to clear it)
        // and a nested child both contribute zero, so the badge can never outlive its rows.
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

export function errorMessage(error: unknown): string {
    if (error instanceof JournalApiError && error.retryAfter) {
        return `${error.message} (${error.retryAfter}s)`;
    }
    return error instanceof Error ? error.message : "Something went wrong.";
}
