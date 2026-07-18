/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApi } from "../../../src/journal/api";
import {
    archivedStorageKey,
    MatronJournalClient,
    storedArchivedIds,
    storeArchivedIds,
} from "../../../src/journal/client";
import { JournalConnection } from "../../../src/journal/connection";
import { JournalDatabase } from "../../../src/journal/database";
import { type ClientState, type Conversation, type PendingMessage, type Session } from "../../../src/journal/types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

const CONVERSATIONS: Conversation[] = [
    {
        id: "c1",
        title: "One",
        session_state: "running",
        last_seq: 10,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        read_up_to_seq: 0,
    },
    {
        id: "c2",
        title: "Two",
        session_state: "running",
        last_seq: 20,
        unread_count: 0,
        snippet: "",
        created_at: 2,
        read_up_to_seq: 0,
    },
];

interface FakeDatabase {
    expireToolLogs(): Promise<void>;
    cursor(): Promise<number | undefined>;
    conversations(): Promise<Conversation[]>;
    replaceWithSnapshot(snapshot: { seq: number; conversations: Conversation[] }): Promise<void>;
    events(conversationId: string): Promise<[]>;
    outbox(conversationId?: string): Promise<PendingMessage[]>;
    putHistory(events: []): Promise<void>;
    markLocallyRead(conversationId: string, upToSeq: number): Promise<void>;
    reconcilePersistedOwnMessages(): Promise<string[]>;
    reset(): Promise<void>;
    close(): void;
}

interface ClientInternals {
    state: ClientState;
    connection?: JournalConnection;
    startSession(session: Session): Promise<void>;
    replaceSnapshot(): Promise<void>;
}

interface ConnectionInternals {
    callbacks: {
        onState(connection: "offline" | "connecting" | "online", error?: string): void;
    };
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function connectionInternals(connection: JournalConnection): ConnectionInternals {
    return connection as unknown as ConnectionInternals;
}

function signedInState(client: MatronJournalClient, selectedConversationId?: string): ClientState {
    return {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: CONVERSATIONS,
        selectedConversationId,
        connection: "online",
    };
}

function fakeDatabase(conversations = CONVERSATIONS): FakeDatabase {
    return {
        expireToolLogs: jest.fn().mockResolvedValue(undefined),
        cursor: jest.fn().mockResolvedValue(1),
        conversations: jest.fn().mockResolvedValue(conversations),
        replaceWithSnapshot: jest.fn().mockResolvedValue(undefined),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
        putHistory: jest.fn().mockResolvedValue(undefined),
        markLocallyRead: jest.fn().mockResolvedValue(undefined),
        reconcilePersistedOwnMessages: jest.fn().mockResolvedValue([]),
        reset: jest.fn().mockResolvedValue(undefined),
        close: jest.fn(),
    };
}

function mockSessionDependencies(database: FakeDatabase, snapshotConversations = CONVERSATIONS): void {
    jest.spyOn(JournalDatabase, "open").mockResolvedValue(database as unknown as JournalDatabase);
    jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue({ seq: 2, conversations: snapshotConversations });
    jest.spyOn(JournalApi.prototype, "messages").mockResolvedValue({ events: [] });
    jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
    jest.spyOn(JournalConnection.prototype, "stop").mockImplementation(() => undefined);
}

describe("archived conversation storage", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("round-trips archived ids", () => {
        storeArchivedIds(SESSION, new Set(["c1", "c2"]));

        expect(storedArchivedIds(SESSION)).toEqual(new Set(["c1", "c2"]));
    });

    it("returns an empty set without warning for a missing key", () => {
        const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(storedArchivedIds(SESSION)).toEqual(new Set());
        expect(warning).not.toHaveBeenCalled();
    });

    it("returns an empty set and warns when storage cannot be read", () => {
        const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new DOMException("blocked", "SecurityError");
        });

        expect(storedArchivedIds(SESSION)).toEqual(new Set());
        expect(warning).toHaveBeenCalledWith("matron: archived-conversations read failed (storage unavailable)");
    });

    it.each([
        ["malformed JSON", "{"],
        ["a valid non-array", "{}"],
    ])("returns an empty set and warns for %s", (_label, storedValue) => {
        const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        localStorage.setItem(archivedStorageKey(SESSION), storedValue);

        expect(storedArchivedIds(SESSION)).toEqual(new Set());
        expect(warning).toHaveBeenCalledTimes(1);
    });

    it("scopes the archive key by encoded server URL and user id", () => {
        const otherSession = { ...SESSION, serverUrl: "https://other.example/a b", userId: 9 };

        expect(archivedStorageKey(SESSION)).not.toBe(archivedStorageKey(otherSession));
        storeArchivedIds(SESSION, new Set(["c1"]));
        storeArchivedIds(otherSession, new Set(["c2"]));

        expect(storedArchivedIds(SESSION)).toEqual(new Set(["c1"]));
        expect(storedArchivedIds(otherSession)).toEqual(new Set(["c2"]));
    });
});

describe("archiving conversations", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("reads live storage, writes the merged set, then patches state", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = { ...signedInState(client), archivedIds: new Set(["stale"]) };
        storeArchivedIds(SESSION, new Set(["concurrent"]));
        const originalSetItem = Storage.prototype.setItem;
        const write = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
            expect(client.getSnapshot().archivedIds).toEqual(new Set(["stale"]));
            return originalSetItem.call(this, key, value);
        });

        client.archiveConversation("c2");

        expect(write).toHaveBeenCalledWith(archivedStorageKey(SESSION), JSON.stringify(["concurrent", "c2"]));
        expect(storedArchivedIds(SESSION)).toEqual(new Set(["concurrent", "c2"]));
        expect(client.getSnapshot().archivedIds).toEqual(new Set(["concurrent", "c2"]));
    });

    it("leaves memory unchanged and reports a dedicated error when a write fails", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const database = fakeDatabase();
        mockSessionDependencies(database);
        await state.startSession(SESSION);
        const before = client.getSnapshot().archivedIds;
        jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("full", "QuotaExceededError");
        });

        client.archiveConversation("c1");

        expect(client.getSnapshot().archivedIds).toBe(before);
        expect(client.getSnapshot().controlError).toBe("Couldn't save — device storage is full or unavailable.");
        expect(client.getSnapshot().connectionError).toBeUndefined();

        connectionInternals(state.connection!).callbacks.onState("offline", "network unavailable");
        expect(client.getSnapshot().controlError).toBe("Couldn't save — device storage is full or unavailable.");
        expect(client.getSnapshot().connectionError).toBe("network unavailable");
        await client.logout();
    });

    it("aborts without writing when live storage cannot be read", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client);
        const write = jest.spyOn(Storage.prototype, "setItem");
        jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new DOMException("blocked", "SecurityError");
        });

        client.archiveConversation("c1");

        expect(write).not.toHaveBeenCalled();
        expect(client.getSnapshot().archivedIds).toEqual(new Set());
        expect(client.getSnapshot().controlError).toBe("Couldn't read saved archive — device storage unavailable.");
    });

    it("clears selection when archiving the selected conversation", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client, "c1");

        client.archiveConversation("c1");

        expect(client.getSnapshot().selectedConversationId).toBeUndefined();
        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c1"]));
    });

    it("is idempotent when the conversation is already archived", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = { ...signedInState(client), archivedIds: new Set(["c1"]) };
        storeArchivedIds(SESSION, new Set(["c1"]));

        client.archiveConversation("c1");

        expect(storedArchivedIds(SESSION)).toEqual(new Set(["c1"]));
        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c1"]));
        expect(client.getSnapshot().controlError).toBeUndefined();
    });
});

describe("archive hydration, selection, and cross-tab synchronization", () => {
    const startedClients: MatronJournalClient[] = [];

    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(async () => {
        for (const client of startedClients) await client.logout();
        startedClients.length = 0;
        jest.restoreAllMocks();
    });

    async function start(
        conversations = CONVERSATIONS,
    ): Promise<{ client: MatronJournalClient; database: FakeDatabase }> {
        const client = new MatronJournalClient();
        const database = fakeDatabase(conversations);
        mockSessionDependencies(database, conversations);
        await internals(client).startSession(SESSION);
        startedClients.push(client);
        return { client, database };
    }

    it("hydrates the archive before selecting the first available conversation", async () => {
        storeArchivedIds(SESSION, new Set(["c1"]));

        const { client } = await start();

        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c1"]));
        expect(client.getSnapshot().selectedConversationId).toBe("c2");
    });

    it("excludes an archived first conversation when replacing a snapshot", async () => {
        storeArchivedIds(SESSION, new Set(["c1"]));
        const { client } = await start();
        internals(client).state = { ...client.getSnapshot(), selectedConversationId: undefined };

        await internals(client).replaceSnapshot();

        expect(client.getSnapshot().selectedConversationId).toBe("c2");
    });

    it("keeps the in-memory archive and selection exclusion if snapshot refresh cannot read storage", async () => {
        storeArchivedIds(SESSION, new Set(["c1"]));
        const { client } = await start();
        internals(client).state = { ...client.getSnapshot(), selectedConversationId: undefined };
        jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new DOMException("blocked", "SecurityError");
        });

        await internals(client).replaceSnapshot();

        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c1"]));
        expect(client.getSnapshot().selectedConversationId).toBe("c2");
    });

    it("applies matching non-null storage events and ignores null or non-matching events", async () => {
        const { client } = await start();
        const key = archivedStorageKey(SESSION);

        window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(["c2"]) }));
        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c2"]));

        window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));
        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c2"]));

        window.dispatchEvent(new StorageEvent("storage", { key: "another-key", newValue: JSON.stringify(["c1"]) }));
        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c2"]));
    });

    it("ignores a stray storage event when the current session is absent", async () => {
        const { client } = await start();
        internals(client).state = { ...client.getSnapshot(), session: undefined };

        expect(() =>
            window.dispatchEvent(
                new StorageEvent("storage", {
                    key: archivedStorageKey(SESSION),
                    newValue: JSON.stringify(["c1"]),
                }),
            ),
        ).not.toThrow();
        expect(client.getSnapshot().archivedIds).toEqual(new Set());
    });

    it("keeps the storage listener active through snapshot replacement", async () => {
        const { client } = await start();

        await internals(client).replaceSnapshot();
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: archivedStorageKey(SESSION),
                newValue: JSON.stringify(["c1"]),
            }),
        );

        expect(client.getSnapshot().archivedIds).toEqual(new Set(["c1"]));
    });

    it("removes the listener once on logout and retains the archived key", async () => {
        storeArchivedIds(SESSION, new Set(["c1"]));
        const { client } = await start();
        const remove = jest.spyOn(window, "removeEventListener");

        await client.logout();
        startedClients.splice(startedClients.indexOf(client), 1);

        expect(remove.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
        expect(storedArchivedIds(SESSION)).toEqual(new Set(["c1"]));
    });
});
