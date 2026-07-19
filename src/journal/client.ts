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
    type ClientState,
    type Conversation,
    isSubChat,
    type JournalEphemeralFrame,
    type JournalEvent,
    MESSAGE_EVENT_TYPES,
    normalizeServerUrl,
    type PendingMessage,
    parentPresent,
    type ServerFrame,
    type Session,
    trimUtf8Prefix,
    type ToolStreamState,
    utf8Length,
} from "./types";

const SESSION_KEY = "matron_journal_session_v1";
const LAST_SERVER_KEY = "matron_journal_last_server";
const SELECTED_CONVERSATION_KEY_PREFIX = "matron_journal_selected_conversation_v1";
const HISTORY_PAGE_SIZE = 80;
const TOOL_STREAM_DISPLAY_BYTES = 65_536;
const MARK_ALL_READ_ERROR = "Some conversations couldn't be updated — device storage is full or unavailable.";
// This is only a browser memory-safety ceiling. The server's 413 response is
// authoritative for deployment-specific upload policy.
export const BROWSER_MEMORY_SAFETY_MAX_BYTES = 512 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;

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
    | { kind: "persisted-uploadable" }
    | { kind: "persisted-terminal" }
    | { kind: "persist-failed" };

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
        controlError: undefined,
        events: [],
        pendingMessages: [],
        connection: "offline",
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
): Conversation | undefined {
    const ids = new Set(
        conversations
            .filter((conversation) => !archivedIds.has(conversation.id))
            .map((conversation) => conversation.id),
    );
    const preferred = conversations.find(
        (conversation) =>
            conversation.id === preferredId && !archivedIds.has(conversation.id) && !parentPresent(conversation, ids),
    );
    return (
        preferred ??
        conversations.find((conversation) => !archivedIds.has(conversation.id) && !parentPresent(conversation, ids))
    );
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
    private readonly readHighWater = new Map<string, number>();
    private readonly readTimers = new Map<string, number>();
    private pendingFiles = new Map<string, File>();
    private stagedSendChain: Promise<void> = Promise.resolve();
    private transientAttachmentErrors = new Map<string, PendingMessage>();
    private readonly dismissedAttachments = new Set<string>();
    private readonly attachmentOperations = new Map<string, Promise<void>>();
    private readonly retryingAttachments = new Set<string>();
    private inFlightUploads = new Map<string, AbortController>();
    private readonly issuedRefreshEpochs = new Map<string, number>();
    private readonly appliedRefreshEpochs = new Map<string, number>();
    private sessionGen = 0;
    private ackTimer?: number;
    private pendingAck = 0;
    private historyError?: string;
    private storageListener?: (event: StorageEvent) => void;
    private unreadHydrated = false;

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
        // Per spec §3.1, retain this per-device preference so re-login can restore it without a null storage event.
        localStorage.removeItem(SESSION_KEY);
        this.state = {
            ...blankState(),
            phase: "signed-out",
            config: this.state.config,
            connectionError: message,
        };
        this.emit();
    }

    public async selectConversation(conversationId: string, opts?: { clearUnread?: boolean }): Promise<void> {
        if (!this.database || !this.state.session) return;
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

        if (!this.history.get(conversationId)?.initialized) await this.loadOlderHistory();
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

    public markConversationRead(conversationId: string): boolean {
        const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
        if (!conversation) return true;
        const cleared = this.clearUnreadOverride(conversationId);
        if (conversation.unread_count > 0) this.scheduleRead(conversationId, conversation.last_seq, 0);
        return cleared;
    }

    public markAllRead(): void {
        const previousControlError = this.state.controlError;
        const ids = new Set(
            this.state.conversations
                .filter((conversation) => !this.state.archivedIds.has(conversation.id))
                .map((conversation) => conversation.id),
        );
        let anyFailed = false;
        for (const conversation of this.state.conversations) {
            if (parentPresent(conversation, ids)) continue;
            if (this.state.archivedIds.has(conversation.id)) continue;
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

    public async loadOlderHistory(): Promise<void> {
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

    public async sendMessage(bodyInput: string): Promise<boolean> {
        const body = bodyInput.trim();
        const conversationId = this.state.selectedConversationId;
        if (!body || !conversationId || !this.database) return false;
        if (this.isChildConvo(conversationId)) return false;
        const message: PendingMessage = {
            localId: crypto.randomUUID(),
            convoId: conversationId,
            body,
            createdAt: Date.now(),
        };
        await this.database.addToOutbox(message);
        await this.refreshSelectedConversation(conversationId);
        if (this.state.selectedConversationId === conversationId) {
            this.patch({ sendTick: this.state.sendTick + 1 });
        }
        this.sendPendingMessage(message);
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

    public async sendAttachment(file: File, convoId: string, caption?: string): Promise<void> {
        const gen = this.sessionGen;
        const api = this.api;
        const db = this.database;
        if (!api || !db) return;
        if (this.isChildConvo(convoId)) return;
        const owner = { gen, api, db };
        const message = this.buildPendingAttachment(file, convoId, caption);
        const persistOutcome = await this.persistPendingAttachment(message, file, db, gen);
        if (persistOutcome.kind !== "persisted-uploadable") return;
        const optimisticRefresh = this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
        await Promise.all([optimisticRefresh, this.runPendingUpload(message, file, owner)]);
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
        const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        this.inFlightUploads.set(message.localId, controller);
        let mediaId: string;
        try {
            const bytes = await Promise.race([file.arrayBuffer(), abortPromise(controller.signal)]);
            if (!this.ownsAttachment(owner, message.localId)) return;
            const response = await owner.api.uploadMedia(bytes, message.contentType ?? file.type, controller.signal);
            if (!this.ownsAttachment(owner, message.localId)) return;
            if (typeof response.media_id !== "string" || response.media_id.trim() === "") {
                throw new Error("The journal server returned a malformed media response.");
            }
            mediaId = response.media_id;
        } catch (error) {
            if (!this.ownsAttachment(owner, message.localId)) return;
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

    public async mediaUrl(mediaId: string): Promise<string> {
        const cached = this.mediaUrls.get(mediaId);
        if (cached) return cached;
        if (!this.api) throw new Error("Not signed in");
        const blob = await this.api.media(mediaId);
        const url = URL.createObjectURL(blob);
        this.mediaUrls.set(mediaId, url);
        return url;
    }

    public selectedConversation(): Conversation | undefined {
        return this.state.conversations.find((conversation) => conversation.id === this.state.selectedConversationId);
    }

    private async startSession(session: Session): Promise<void> {
        this.sessionGen += 1;
        for (const controller of this.inFlightUploads.values()) controller.abort();
        this.inFlightUploads.clear();
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
        if (cursor === undefined) {
            const snapshot = await this.api.snapshot();
            await this.database.replaceWithSnapshot(snapshot);
            if (typeof this.database.markBackfillDone === "function") await this.database.markBackfillDone();
            cursor = snapshot.seq;
        } else if (typeof this.database.backfillDone === "function" && !(await this.database.backfillDone())) {
            try {
                await this.database.backfillParentLinks(await this.api.snapshot());
            } catch (error) {
                const permanent = error instanceof Error && error.message.startsWith("malformed");
                if (permanent) await this.database.recordBackfillError(String(error)).catch(() => undefined);
                console.warn(`matron: subchat backfill deferred (${permanent ? "permanent" : "transient"})`, error);
            }
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
        this.unreadHydrated = unreadRead.ok;
        const bootstrapReadFailed = !archiveRead.ok || !pinnedRead.ok || !favoriteRead.ok || !unreadRead.ok;
        const archivedIds = archiveRead.ids;
        const pinnedIds = pinnedRead.ids;
        const favoriteIds = favoriteRead.ids;
        const unreadOverrideIds = unreadRead.ids;
        const selectedConversation = firstSelectableConversation(conversations, storedConversationId, archivedIds);
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
            controlError: bootstrapReadFailed
                ? "Couldn't load saved preferences — device storage unavailable."
                : undefined,
            selectedConversationId: selectedConversation?.id,
        };
        if (this.storageListener) window.removeEventListener("storage", this.storageListener);
        this.storageListener = (event: StorageEvent): void => {
            const currentSession = this.state.session;
            if (!currentSession || event.newValue === null) return;
            if (event.key === archiveStore.storageKey(currentSession)) {
                const archivedIds = archiveStore.parse(event.newValue);
                this.patch({ archivedIds });
                if (this.state.selectedConversationId && archivedIds.has(this.state.selectedConversationId)) {
                    this.clearSelection();
                }
            } else if (event.key === pinnedStore.storageKey(currentSession)) {
                this.patch({ pinnedIds: pinnedStore.parse(event.newValue) });
            } else if (event.key === favoriteStore.storageKey(currentSession)) {
                this.patch({ favoriteIds: favoriteStore.parse(event.newValue) });
            } else if (event.key === unreadStore.storageKey(currentSession)) {
                if (!this.unreadHydrated) this.unreadHydrated = true;
                this.patch({ unreadOverrideIds: unreadStore.parse(event.newValue) });
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
        if (!current.ok) {
            this.patch({ controlError: "Couldn't read saved archive — device storage unavailable." });
            return;
        }
        const next = new Set(current.ids);
        if (archived) next.add(conversationId);
        else next.delete(conversationId);
        try {
            archiveStore.write(session, next);
        } catch {
            this.patch({ controlError: "Couldn't save — device storage is full or unavailable." });
            return;
        }
        this.patch({ archivedIds: next, controlError: undefined });
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

        const current = store.read(session);
        if (!current.ok) {
            this.patch({ controlError: "Couldn't read saved preference — device storage unavailable." });
            return false;
        }
        const next = new Set(current.ids);
        if (on) next.add(id);
        else next.delete(id);
        try {
            store.write(session, next);
        } catch {
            this.patch({ controlError: "Couldn't save — device storage is full or unavailable." });
            return false;
        }
        this.patch({ [stateKey]: next, controlError: undefined } as Partial<ClientState>);
        return true;
    }

    private clearUnreadOverride(id: string): boolean {
        // The in-memory no-op shortcut is only safe after the unread store has hydrated successfully.
        // Otherwise a stale-empty mirror may mask a persisted override, so re-read before deleting.
        if (this.unreadHydrated && !this.state.unreadOverrideIds.has(id)) return true;
        return this.setFlag(unreadStore, "unreadOverrideIds", id, false);
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
        let { archivedIds, pinnedIds, favoriteIds, unreadOverrideIds } = this.state;
        const session = this.state.session;
        if (session) {
            const archiveRead = archiveStore.read(session);
            if (archiveRead.ok) archivedIds = archiveRead.ids;
            const pinnedRead = pinnedStore.read(session);
            if (pinnedRead.ok) pinnedIds = pinnedRead.ids;
            const favoriteRead = favoriteStore.read(session);
            if (favoriteRead.ok) favoriteIds = favoriteRead.ids;
            const unreadRead = unreadStore.read(session);
            if (unreadRead.ok) {
                unreadOverrideIds = unreadRead.ids;
                this.unreadHydrated = true;
            }
        }
        const selectedConversation = firstSelectableConversation(conversations, previousSelection, archivedIds);
        this.patch({
            conversations,
            archivedIds,
            pinnedIds,
            favoriteIds,
            unreadOverrideIds,
            selectedConversationId: selectedConversation?.id,
        });
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
            try {
                await db.deleteOutboxRows(blockedTextIds);
                if (ownsReplay()) this.patch({ controlError: "Couldn't send to a read-only subagent transcript." });
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
        const removed = await this.database.reconcileOwnMessage(event);
        if (removed) {
            this.pendingFiles.delete(removed);
            this.transientAttachmentErrors.delete(removed);
        }
        if (!applied) {
            if (removed && event.convo_id === this.state.selectedConversationId) {
                await this.refreshSelectedConversation(event.convo_id);
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
        this.state = { ...this.state, ...update };
        this.emit();
    }

    private emit(): void {
        const ids = new Set(
            this.state.conversations
                .filter((conversation) => !this.state.archivedIds.has(conversation.id))
                .map((conversation) => conversation.id),
        );
        const unread = this.state.conversations.reduce(
            (total, conversation) => total + (parentPresent(conversation, ids) ? 0 : conversation.unread_count),
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
