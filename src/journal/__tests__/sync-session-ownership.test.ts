/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../client";
import type { ClientState, Session, SnapshotResponse } from "../types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 1,
    username: "tester",
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

function fakeDatabase() {
    return {
        replaceWithSnapshot: jest.fn().mockResolvedValue(undefined),
        putHistory: jest.fn().mockResolvedValue(undefined),
        reconcilePersistedOwnMessages: jest.fn().mockResolvedValue([]),
        conversations: jest.fn().mockResolvedValue([]),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
    };
}

type Internals = {
    state: ClientState;
    database: unknown;
    api: unknown;
    sessionGen: number;
    replaceSnapshot(): Promise<void>;
};

function makeClient(): { client: MatronJournalClient; internals: Internals } {
    const client = new MatronJournalClient();
    const internals = client as unknown as Internals;
    internals.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        selectedConversationId: "c1",
        conversations: [],
        events: [],
    } as ClientState;
    return { client, internals };
}

// A sign-out and sign-in lands while a request is in flight: the database, the api and the
// generation all belong to the new session by the time the old response arrives.
function switchSession(internals: Internals): ReturnType<typeof fakeDatabase> {
    const next = fakeDatabase();
    internals.database = next;
    internals.api = {};
    internals.sessionGen += 1;
    return next;
}

describe("sync session ownership", () => {
    it("replaceSnapshot does not write a snapshot into the next session's database", async () => {
        const { internals } = makeClient();
        const oldDb = fakeDatabase();
        const snapshot = deferred<SnapshotResponse>();
        internals.database = oldDb;
        internals.api = { snapshot: () => snapshot.promise };

        const done = internals.replaceSnapshot();
        const nextDb = switchSession(internals);
        snapshot.resolve({ seq: 5, conversations: [] });
        await done;

        expect(oldDb.replaceWithSnapshot).not.toHaveBeenCalled();
        expect(nextDb.replaceWithSnapshot).not.toHaveBeenCalled();
    });

    it("replaceSnapshot stops after a database write that outlived its session", async () => {
        const { internals } = makeClient();
        const oldDb = fakeDatabase();
        const write = deferred<void>();
        oldDb.replaceWithSnapshot.mockReturnValue(write.promise);
        internals.database = oldDb;
        internals.api = { snapshot: () => Promise.resolve({ seq: 5, conversations: [] }) };

        const done = internals.replaceSnapshot();
        await jest.requireActual<typeof import("timers")>("timers").promises.setImmediate();
        expect(oldDb.replaceWithSnapshot).toHaveBeenCalledTimes(1);
        const nextDb = switchSession(internals);
        write.resolve();
        await done;

        expect(oldDb.reconcilePersistedOwnMessages).not.toHaveBeenCalled();
        expect(nextDb.reconcilePersistedOwnMessages).not.toHaveBeenCalled();
        expect(nextDb.conversations).not.toHaveBeenCalled();
    });

    it("loadOlderHistory does not write an old page into the next session's database", async () => {
        const { client, internals } = makeClient();
        const oldDb = fakeDatabase();
        const page = deferred<{ events: never[] }>();
        internals.database = oldDb;
        internals.api = { messages: () => page.promise };

        const done = client.loadOlderHistory();
        const nextDb = switchSession(internals);
        page.resolve({ events: [] });
        await done;

        expect(oldDb.putHistory).not.toHaveBeenCalled();
        expect(nextDb.putHistory).not.toHaveBeenCalled();
        expect(nextDb.reconcilePersistedOwnMessages).not.toHaveBeenCalled();
    });

    it("loadOlderHistory still loads the page when the session is unchanged", async () => {
        const { client, internals } = makeClient();
        const db = fakeDatabase();
        internals.database = db;
        internals.api = { messages: () => Promise.resolve({ events: [] }) };

        await client.loadOlderHistory();

        expect(db.reconcilePersistedOwnMessages).toHaveBeenCalledTimes(1);
    });
});
