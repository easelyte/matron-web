/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApi, JournalApiError, loadMatronConfig } from "./api";
import { JournalConnection } from "./connection";
import { JournalDatabase } from "./database";
import { mergeSessionStatus } from "./status";
import {
    type ClientState,
    type Conversation,
    type JournalEphemeralFrame,
    type JournalEvent,
    MESSAGE_EVENT_TYPES,
    normalizeServerUrl,
    type PendingMessage,
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
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;

interface ConversationHistoryState {
    initialized: boolean;
    oldestSeq?: number;
    hasMore: boolean;
}

interface ElectronBadgeBridge {
    send(channel: "setBadgeCount", count: number): void;
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
        events: [],
        pendingMessages: [],
        connection: "offline",
        loadingHistory: false,
        hasOlderHistory: false,
        textStreams: {},
        toolStreams: {},
        dragActive: false,
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
    private inFlightUploads = new Set<AbortController>();
    private sessionGen = 0;
    private ackTimer?: number;
    private pendingAck = 0;
    private historyError?: string;

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
        for (const controller of this.inFlightUploads) controller.abort();
        this.inFlightUploads.clear();
        this.pendingFiles.clear();
        this.connection?.stop();
        this.connection = undefined;
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
        localStorage.removeItem(SESSION_KEY);
        this.state = {
            ...blankState(),
            phase: "signed-out",
            config: this.state.config,
            connectionError: message,
        };
        this.emit();
    }

    public async selectConversation(conversationId: string): Promise<void> {
        if (!this.database || !this.state.session) return;
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

    public markConversationRead(conversationId: string): void {
        const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
        if (!conversation?.unread_count) return;
        this.scheduleRead(conversationId, conversation.last_seq, 0);
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
        const message: PendingMessage = {
            localId: crypto.randomUUID(),
            convoId: conversationId,
            body,
            createdAt: Date.now(),
        };
        await this.database.addToOutbox(message);
        await this.refreshSelectedConversation(conversationId);
        this.sendPendingMessage(message);
        return true;
    }

    public async sendAttachment(file: File, convoId: string): Promise<void> {
        const gen = this.sessionGen;
        const api = this.api;
        const db = this.database;
        if (!api || !db) return;

        const localId = crypto.randomUUID();
        const kind = file.type.startsWith("image/") ? "image" : "file";
        const contentType = file.type || "application/octet-stream";
        const message: PendingMessage = {
            localId,
            convoId,
            body: "",
            createdAt: Date.now(),
            kind,
            filename: file.name,
            size: file.size,
            contentType,
            blobRef: null,
            attachState: "uploading",
        };

        if (file.size > MEDIA_MAX_BYTES || file.size === 0) {
            message.attachState = "error";
            message.errorKind = file.size > MEDIA_MAX_BYTES ? "too_large" : "empty";
            await db.addToOutbox(message);
            if (this.sessionGen !== gen) return;
            await this.refreshSelectedConversation(convoId);
            if (this.sessionGen !== gen) return;
            return;
        }

        this.pendingFiles.set(localId, file);
        await db.addToOutbox(message);
        if (this.sessionGen !== gen) return;
        await this.refreshSelectedConversation(convoId);
        if (this.sessionGen !== gen) return;

        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        this.inFlightUploads.add(controller);
        let mediaId: string;
        try {
            const bytes = await Promise.race([file.arrayBuffer(), abortPromise(controller.signal)]);
            if (this.sessionGen !== gen) return;
            const response = await api.uploadMedia(bytes, contentType, controller.signal);
            if (this.sessionGen !== gen) return;
            if (typeof response.media_id !== "string" || response.media_id.trim() === "") {
                throw new Error("The journal server returned a malformed media response.");
            }
            mediaId = response.media_id;
        } catch (error) {
            if (this.sessionGen !== gen) return;
            message.blobRef = null;
            message.attachState = "error";
            message.errorKind =
                error instanceof JournalApiError && (error.code === "too_large" || error.code === "empty")
                    ? error.code
                    : "upload_failed";
            if (message.errorKind !== "upload_failed") this.pendingFiles.delete(localId);
            await db?.addToOutbox(message);
            if (this.sessionGen !== gen) return;
            await this.refreshSelectedConversation(convoId);
            if (this.sessionGen !== gen) return;
            return;
        } finally {
            window.clearTimeout(timer);
            this.inFlightUploads.delete(controller);
        }

        message.blobRef = mediaId;
        message.attachState = "sending";
        delete message.errorKind;
        this.pendingFiles.delete(localId);
        await db.addToOutbox(message);
        if (this.sessionGen !== gen) return;
        await this.refreshSelectedConversation(convoId);
        if (this.sessionGen !== gen) return;

        const ok = this.connection?.send({
            op: "send",
            convo_id: convoId,
            type: kind,
            blob_ref: mediaId,
            payload: {
                blob_ref: mediaId,
                name: file.name,
                filename: file.name,
                content_type: contentType,
                size: file.size,
                local_id: localId,
            },
            local_id: localId,
        });
        if (ok === true) return;

        message.attachState = "error";
        message.errorKind = "send_failed";
        if (this.sessionGen !== gen) return;
        await db?.addToOutbox(message);
        if (this.sessionGen !== gen) return;
        await this.refreshSelectedConversation(convoId);
        if (this.sessionGen !== gen) return;
    }

    public async attachFiles(files: File[]): Promise<void> {
        const convoId = this.state.selectedConversationId;
        if (!convoId) return;

        for (const file of files) {
            try {
                await this.sendAttachment(file, convoId);
            } catch {
                // Continue so one failed attachment does not block the rest of the batch.
            }
        }
    }

    public async dismissAttachment(localId: string): Promise<void> {
        const gen = this.sessionGen;
        const db = this.database;
        if (!db) return;

        await db.deleteOutboxRow(localId);
        if (this.sessionGen !== gen || this.database !== db) return;
        this.pendingFiles.delete(localId);
        const conversationId = this.state.selectedConversationId;
        if (conversationId) await this.refreshSelectedConversation(conversationId);
    }

    public sendPromptReply(targetSeq: number, choice?: string, text?: string): boolean {
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
        for (const controller of this.inFlightUploads) controller.abort();
        this.inFlightUploads.clear();
        this.pendingFiles.clear();
        this.connection?.stop();
        this.database?.close();
        this.api = new JournalApi(session.serverUrl, session.token);
        this.database = await JournalDatabase.open(session.serverUrl, session.userId);
        await this.database.expireToolLogs();

        let cursor = await this.database.cursor();
        if (cursor === undefined) {
            const snapshot = await this.api.snapshot();
            await this.database.replaceWithSnapshot(snapshot);
            cursor = snapshot.seq;
        }
        const conversations = await this.database.conversations();
        const storedConversationId = storedSelectedConversation(session);
        const selectedConversation =
            conversations.find((conversation) => conversation.id === storedConversationId) ?? conversations[0];
        this.state = {
            ...blankState(),
            phase: "signed-in",
            config: this.state.config,
            session,
            conversations,
            selectedConversationId: selectedConversation?.id,
        };
        this.emit();
        if (selectedConversation) await this.selectConversation(selectedConversation.id);

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
        const conversations = await this.database.conversations();
        const selectedConversation =
            conversations.find((conversation) => conversation.id === previousSelection) ?? conversations[0];
        this.patch({ conversations, selectedConversationId: selectedConversation?.id });
        if (selectedConversation) await this.selectConversation(selectedConversation.id);
        else if (this.state.session) storeSelectedConversation(this.state.session, undefined);
    }

    private async handleReady(): Promise<void> {
        const outbox = await this.database?.outbox();
        for (const message of outbox ?? []) this.sendPendingMessage(message);
        if (this.state.selectedConversationId) {
            this.connection?.send({ op: "viewing", convo_id: this.state.selectedConversationId });
            const conversation = this.selectedConversation();
            if (conversation?.unread_count) this.scheduleRead(conversation.id, conversation.last_seq, 0);
        }
        for (const [conversationId, upToSeq] of this.readHighWater) {
            this.scheduleRead(conversationId, upToSeq, 0);
        }
        const cursor = await this.database?.cursor();
        if (cursor !== undefined) this.connection?.send({ op: "ack", cursor });
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
        if (!applied) return;
        this.clearHistoryError();
        const removed = await this.database.reconcileOwnMessage(event);
        if (removed) this.pendingFiles.delete(removed);
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

    private async refreshSelectedConversation(expectedId: string): Promise<void> {
        if (!this.database) return;
        const [events, pendingMessages] = await Promise.all([
            this.database.events(expectedId),
            this.database.outbox(expectedId),
        ]);
        if (this.state.selectedConversationId !== expectedId) return;
        this.patch({
            events,
            pendingMessages: pendingMessages.map((message) => ({
                ...message,
                canRetry:
                    (message.errorKind === "upload_failed" && this.pendingFiles.has(message.localId)) ||
                    message.errorKind === "send_failed",
            })),
        });
    }

    private sendPendingMessage(message: PendingMessage): void {
        this.connection?.send({
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
        const unread = this.state.conversations.reduce((total, conversation) => total + conversation.unread_count, 0);
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
