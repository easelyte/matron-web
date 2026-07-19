/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    coerceParentId,
    type Conversation,
    enforceToolLogTtl,
    eventSnippet,
    type JournalEvent,
    MESSAGE_EVENT_TYPES,
    type PendingMessage,
    type SnapshotResponse,
} from "./types";

const DATABASE_VERSION = 1;
const CURSOR_KEY = "cursor";
const BACKFILL_KEY = "subchat_backfill_v1";
const BACKFILL_ERROR_KEY = "subchat_backfill_error";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    });
}

function emptyConversation(id: string, timestamp: number): Conversation {
    return {
        id,
        title: "",
        session_state: "running",
        last_seq: 0,
        unread_count: 0,
        snippet: "",
        created_at: timestamp,
        parent_convo_id: null,
        last_ts: timestamp,
        read_up_to_seq: 0,
    };
}

function matchesOwnPendingMessage(event: JournalEvent, pending: PendingMessage, ownSender: string): boolean {
    const isText = event.type === "text" && typeof event.payload.body === "string";
    const isAttachment = event.type === "file" || event.type === "image";
    const localId = typeof event.payload.local_id === "string" ? event.payload.local_id : undefined;
    const pendingKind = pending.kind ?? "text";
    return (
        (isText || isAttachment) &&
        event.sender === ownSender &&
        localId === pending.localId &&
        event.convo_id === pending.convoId &&
        pendingKind === event.type
    );
}

export class JournalDatabase {
    private constructor(
        private readonly database: IDBDatabase,
        private readonly ownSender: string,
    ) {}

    public static open(serverUrl: string, userId: number, username: string): Promise<JournalDatabase> {
        const name = `matron-journal:${serverUrl}:${userId}`;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(name, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
                if (!db.objectStoreNames.contains("conversations")) {
                    db.createObjectStore("conversations", { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains("events")) {
                    const events = db.createObjectStore("events", { keyPath: ["convo_id", "seq"] });
                    events.createIndex("byConversation", "convo_id", { unique: false });
                }
                if (!db.objectStoreNames.contains("outbox")) {
                    const outbox = db.createObjectStore("outbox", { keyPath: "localId" });
                    outbox.createIndex("byConversation", "convoId", { unique: false });
                }
            };
            request.onsuccess = () => resolve(new JournalDatabase(request.result, `user:${username}`));
            request.onerror = () => reject(request.error ?? new Error("Could not open the local journal"));
            request.onblocked = () => reject(new Error("The local journal is open in another incompatible tab"));
        });
    }

    public close(): void {
        this.database.close();
    }

    public async cursor(): Promise<number | undefined> {
        const transaction = this.database.transaction("meta", "readonly");
        const value = await requestResult(transaction.objectStore("meta").get(CURSOR_KEY));
        await transactionDone(transaction);
        return typeof value === "number" ? value : undefined;
    }

    public async backfillParentLinks(snapshot: SnapshotResponse): Promise<void> {
        if (!snapshot || !Array.isArray(snapshot.conversations)) throw new Error("malformed snapshot");
        const summaries = snapshot.conversations;
        for (const summary of summaries) {
            if (!summary || typeof summary.id !== "string") throw new Error("malformed snapshot element");
        }

        const transaction = this.database.transaction(["conversations", "meta"], "readwrite");
        try {
            const conversations = transaction.objectStore("conversations");
            for (const summary of summaries) {
                const existing = (await requestResult(conversations.get(summary.id))) as Conversation | undefined;
                if (!existing) continue;
                existing.parent_convo_id = existing.parent_convo_id ?? coerceParentId(summary.parent_convo_id) ?? null;
                if (typeof summary.session_state === "string") existing.session_state = summary.session_state;
                conversations.put(existing);
            }
            transaction.objectStore("meta").put(true, BACKFILL_KEY);
            await transactionDone(transaction);
        } catch (error) {
            try {
                transaction.abort();
            } catch {
                // The transaction is already aborting or complete.
            }
            throw error;
        }
    }

    public async markBackfillDone(): Promise<void> {
        const transaction = this.database.transaction("meta", "readwrite");
        transaction.objectStore("meta").put(true, BACKFILL_KEY);
        await transactionDone(transaction);
    }

    public async backfillDone(): Promise<boolean> {
        const transaction = this.database.transaction("meta", "readonly");
        const done = Boolean(await requestResult(transaction.objectStore("meta").get(BACKFILL_KEY)));
        await transactionDone(transaction);
        return done;
    }

    public async recordBackfillError(reason: string): Promise<void> {
        const transaction = this.database.transaction("meta", "readwrite");
        transaction.objectStore("meta").put({ ts: Date.now(), reason }, BACKFILL_ERROR_KEY);
        await transactionDone(transaction);
    }

    public async replaceWithSnapshot(snapshot: SnapshotResponse): Promise<void> {
        const transaction = this.database.transaction(["meta", "conversations", "events", "outbox"], "readwrite");
        const conversations = transaction.objectStore("conversations");
        const existingParents = new Map(
            ((await requestResult(conversations.getAll())) as Conversation[]).map((conversation) => [
                conversation.id,
                conversation.parent_convo_id ?? null,
            ]),
        );
        conversations.clear();
        transaction.objectStore("events").clear();
        const validConversationIds = new Set(snapshot.conversations.map((conversation) => conversation.id));
        const outbox = transaction.objectStore("outbox");
        const pendingMessages = (await requestResult(outbox.getAll())) as PendingMessage[];
        for (const message of pendingMessages) {
            if (!validConversationIds.has(message.convoId)) outbox.delete(message.localId);
        }
        for (const summary of snapshot.conversations) {
            let incomingParent = coerceParentId(summary.parent_convo_id);
            if (incomingParent === summary.id) incomingParent = null;
            conversations.put({
                ...summary,
                parent_convo_id: existingParents.get(summary.id) ?? incomingParent ?? null,
                last_ts: summary.last_ts ?? summary.created_at,
                read_up_to_seq: summary.read_up_to_seq ?? (summary.unread_count === 0 ? summary.last_seq : 0),
            } satisfies Conversation);
        }
        transaction.objectStore("meta").put(snapshot.seq, CURSOR_KEY);
        await transactionDone(transaction);
    }

    public async reset(): Promise<void> {
        const transaction = this.database.transaction(["meta", "conversations", "events", "outbox"], "readwrite");
        transaction.objectStore("meta").clear();
        transaction.objectStore("conversations").clear();
        transaction.objectStore("events").clear();
        transaction.objectStore("outbox").clear();
        await transactionDone(transaction);
    }

    public async conversations(): Promise<Conversation[]> {
        const transaction = this.database.transaction("conversations", "readonly");
        const conversations = (await requestResult(
            transaction.objectStore("conversations").getAll(),
        )) as Conversation[];
        await transactionDone(transaction);
        return conversations.sort((left, right) => {
            const activity = (right.last_ts ?? right.created_at) - (left.last_ts ?? left.created_at);
            return activity || right.last_seq - left.last_seq;
        });
    }

    public async events(conversationId: string): Promise<JournalEvent[]> {
        const transaction = this.database.transaction("events", "readonly");
        const events = (await requestResult(
            transaction.objectStore("events").index("byConversation").getAll(conversationId),
        )) as JournalEvent[];
        await transactionDone(transaction);
        return events.map((event) => enforceToolLogTtl(event)).sort((left, right) => left.seq - right.seq);
    }

    public async putHistory(events: JournalEvent[]): Promise<void> {
        if (events.length === 0) return;
        const transaction = this.database.transaction("events", "readwrite");
        const store = transaction.objectStore("events");
        for (const event of events) store.put(enforceToolLogTtl(event));
        await transactionDone(transaction);
    }

    /** Applies one strictly ordered replay/live row and advances the durable cursor atomically. */
    public async applyJournal(incomingEvent: JournalEvent): Promise<boolean> {
        const event = enforceToolLogTtl(incomingEvent);
        const transaction = this.database.transaction(["meta", "conversations", "events"], "readwrite");
        const meta = transaction.objectStore("meta");
        const currentCursor = (await requestResult(meta.get(CURSOR_KEY))) as number | undefined;
        if (currentCursor !== undefined && event.seq <= currentCursor) {
            transaction.abort();
            try {
                await transactionDone(transaction);
            } catch {
                // The abort is deliberate: no writes were needed for a duplicate frame.
            }
            return false;
        }

        const conversations = transaction.objectStore("conversations");
        const existing = (await requestResult(conversations.get(event.convo_id))) as Conversation | undefined;
        const conversation = existing ?? emptyConversation(event.convo_id, event.ts);

        transaction.objectStore("events").put(event);
        conversation.last_seq = Math.max(conversation.last_seq, event.seq);
        conversation.last_ts = Math.max(conversation.last_ts ?? 0, event.ts);

        if (event.type === "convo_meta") {
            if (typeof event.payload.title === "string") conversation.title = event.payload.title;
            let incomingParent = coerceParentId(event.payload.parent_convo_id);
            if (incomingParent === conversation.id) incomingParent = null;
            if (conversation.parent_convo_id == null && incomingParent) {
                conversation.parent_convo_id = incomingParent;
            }
        } else if (event.type === "session_status" && typeof event.payload.state === "string") {
            conversation.session_state = event.payload.state;
        } else if (MESSAGE_EVENT_TYPES.has(event.type)) {
            conversation.snippet = eventSnippet(event.type, event.payload);
            if (!event.sender.startsWith("user:")) conversation.unread_count += 1;
        } else if (event.type === "read_marker") {
            const upToSeq = typeof event.payload.up_to_seq === "number" ? event.payload.up_to_seq : 0;
            conversation.read_up_to_seq = Math.max(conversation.read_up_to_seq, upToSeq);
            const storedEvents = (await requestResult(
                transaction.objectStore("events").index("byConversation").getAll(event.convo_id),
            )) as JournalEvent[];
            conversation.unread_count = storedEvents.filter(
                (candidate) =>
                    candidate.seq > upToSeq &&
                    MESSAGE_EVENT_TYPES.has(candidate.type) &&
                    !candidate.sender.startsWith("user:"),
            ).length;
        }

        conversations.put(conversation);
        meta.put(event.seq, CURSOR_KEY);
        await transactionDone(transaction);
        return true;
    }

    public async markLocallyRead(conversationId: string, upToSeq: number): Promise<void> {
        const transaction = this.database.transaction("conversations", "readwrite");
        const store = transaction.objectStore("conversations");
        const conversation = (await requestResult(store.get(conversationId))) as Conversation | undefined;
        if (conversation) {
            conversation.unread_count = 0;
            conversation.read_up_to_seq = Math.max(conversation.read_up_to_seq, upToSeq);
            store.put(conversation);
        }
        await transactionDone(transaction);
    }

    public async addToOutbox(message: PendingMessage): Promise<void> {
        const transaction = this.database.transaction("outbox", "readwrite");
        transaction.objectStore("outbox").put(message);
        await transactionDone(transaction);
    }

    public async deleteOutboxRow(localId: string): Promise<void> {
        const transaction = this.database.transaction("outbox", "readwrite");
        transaction.objectStore("outbox").delete(localId);
        await transactionDone(transaction);
    }

    public async outbox(conversationId?: string): Promise<PendingMessage[]> {
        const transaction = this.database.transaction("outbox", "readonly");
        const store = transaction.objectStore("outbox");
        const values = (await requestResult(
            conversationId ? store.index("byConversation").getAll(conversationId) : store.getAll(),
        )) as PendingMessage[];
        await transactionDone(transaction);
        return values.sort((left, right) => left.createdAt - right.createdAt);
    }

    public async reconcileOwnMessage(event: JournalEvent): Promise<string | null> {
        const localId = typeof event.payload.local_id === "string" ? event.payload.local_id : undefined;
        if (!localId) return null;
        const transaction = this.database.transaction("outbox", "readwrite");
        const outbox = transaction.objectStore("outbox");
        const pending = (await requestResult(outbox.get(localId))) as PendingMessage | undefined;
        const matchesPending = pending ? matchesOwnPendingMessage(event, pending, this.ownSender) : false;
        if (matchesPending) outbox.delete(localId);
        await transactionDone(transaction);
        return matchesPending ? localId : null;
    }

    public async reconcilePersistedOwnMessages(): Promise<string[]> {
        const transaction = this.database.transaction(["events", "outbox"], "readwrite");
        const outbox = transaction.objectStore("outbox");
        const [events, pendingMessages] = await Promise.all([
            requestResult(transaction.objectStore("events").getAll()) as Promise<JournalEvent[]>,
            requestResult(outbox.getAll()) as Promise<PendingMessage[]>,
        ]);
        const candidates = pendingMessages.filter(
            (message) => message.attachState === "sending" || message.errorKind === "send_failed",
        );
        const removed: string[] = [];
        for (const pending of candidates) {
            if (!events.some((event) => matchesOwnPendingMessage(event, pending, this.ownSender))) continue;
            outbox.delete(pending.localId);
            removed.push(pending.localId);
        }
        await transactionDone(transaction);
        return removed;
    }

    public async expireToolLogs(now = Date.now()): Promise<void> {
        const transaction = this.database.transaction("events", "readwrite");
        const store = transaction.objectStore("events");
        const events = (await requestResult(store.getAll())) as JournalEvent[];
        for (const event of events) {
            const expired = enforceToolLogTtl(event, now);
            if (expired !== event) store.put(expired);
        }
        await transactionDone(transaction);
    }
}
