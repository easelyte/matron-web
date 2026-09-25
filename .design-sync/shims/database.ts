// design-sync shim for src/journal/database.ts (bundle + previews only; the app is untouched).
// The real module persists the journal to IndexedDB. In the design canvas nothing should touch
// storage, so open() rejects: a client that is (wrongly) initialised fails into its error path
// instead of creating a database. Fixture clients never call initialise(), so this is defence in
// depth. The instance methods mirror the real public surface (same signatures, inert bodies) so
// client.ts type-checks against the copy; keep them in step when database.ts gains a method.
import type { Conversation, JournalEvent, PendingMessage, SnapshotResponse } from "./types";

export class JournalDatabase {
    private constructor() {}

    public static open(_serverUrl: string, _userId: number, _username: string): Promise<JournalDatabase> {
        return Promise.reject(new Error("design canvas: journal storage is disabled"));
    }

    public close(): void {}
    public async cursor(): Promise<number | undefined> {
        return undefined;
    }
    public async backfillParentLinks(_snapshot: SnapshotResponse): Promise<void> {}
    public async markBackfillDone(_snapshot: SnapshotResponse): Promise<void> {}
    public async backfillDone(): Promise<boolean> {
        return true;
    }
    public async outcomeBackfillDue(): Promise<boolean> {
        return false;
    }
    public async recordBackfillError(_reason: string): Promise<void> {}
    public async replaceWithSnapshot(_snapshot: SnapshotResponse): Promise<void> {}
    public async reset(): Promise<void> {}
    public async conversations(): Promise<Conversation[]> {
        return [];
    }
    public async events(_conversationId: string): Promise<JournalEvent[]> {
        return [];
    }
    public async putHistory(_events: JournalEvent[]): Promise<void> {}
    public async applyJournal(_incomingEvent: JournalEvent): Promise<boolean> {
        return false;
    }
    public async markLocallyRead(_conversationId: string, _upToSeq: number): Promise<void> {}
    public async addToOutbox(_message: PendingMessage): Promise<void> {}
    public async deleteOutboxRow(_localId: string): Promise<void> {}
    public async deleteOutboxRows(_localIds: string[]): Promise<void> {}
    public async outbox(_conversationId?: string): Promise<PendingMessage[]> {
        return [];
    }
    public async reconcileOwnMessage(_event: JournalEvent): Promise<string | null> {
        return null;
    }
    public async reconcilePersistedOwnMessages(): Promise<string[]> {
        return [];
    }
    public async expireToolLogs(_now = Date.now()): Promise<void> {}
}
