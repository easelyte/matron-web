/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalConnection, MAX_JOURNAL_BATCH } from "../../../src/journal/connection";
import { type JournalEvent, type ServerFrame } from "../../../src/journal/types";

type FakeSocket = {
    close: jest.Mock;
    send: jest.Mock;
    onopen: (() => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    onerror: (() => void) | null;
    readyState: number;
};

function setup(opts: { cursor?: number; batch?: boolean } = {}) {
    const made: FakeSocket[] = [];
    const websocket = jest.spyOn(globalThis, "WebSocket").mockImplementation(() => {
        const socket: FakeSocket = {
            close: jest.fn(),
            send: jest.fn(),
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            readyState: WebSocket.OPEN,
        };
        made.push(socket);
        return socket as unknown as WebSocket;
    });
    const order: string[] = [];
    const callbacks = {
        cursor: jest.fn().mockResolvedValue(opts.cursor ?? 100),
        onFrame: jest.fn(async (frame: ServerFrame) => {
            order.push(frame.kind === "journal" ? `frame:${(frame as JournalEvent).seq}` : `frame:${frame.kind}`);
        }),
        onJournalBatch: jest.fn(async (frames: JournalEvent[]) => {
            order.push(`batch:${frames.map((frame) => frame.seq).join(",")}`);
        }),
        onReady: jest.fn().mockResolvedValue(undefined),
        onSnapshotRequired: jest.fn().mockResolvedValue(undefined),
        onRevoked: jest.fn(),
        onState: jest.fn(),
    };
    if (opts.batch === false) delete (callbacks as Partial<typeof callbacks>).onJournalBatch;
    const connection = new JournalConnection("https://journal.example", "token", callbacks, () => "id-1");
    return { made, websocket, callbacks, connection, order };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
}

function deliver(socket: FakeSocket, frame: Record<string, unknown>): void {
    socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
}

function journal(seq: number): Record<string, unknown> {
    return { kind: "journal", seq, convo_id: "c1", ts: seq, sender: "agent:x", type: "text", payload: { body: "b" } };
}

async function open(socket: FakeSocket): Promise<void> {
    socket.onopen?.();
    await flush();
}

describe("JournalConnection journal batching", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("coalesces frames that queue behind in-flight work into one run, in order", async () => {
        const { made, connection, callbacks, order } = setup();
        let release!: () => void;
        callbacks.onReady.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
        connection.start();
        await open(made[0]);
        deliver(made[0], { kind: "control", op: "hello_ok", seq: 110 });
        for (let seq = 101; seq <= 105; seq++) deliver(made[0], journal(seq));
        release();
        await flush();
        expect(order).toEqual(["batch:101,102,103,104,105"]);
        expect(callbacks.onFrame).not.toHaveBeenCalled();
        connection.stop();
    });

    it("never merges journal frames across a non-journal frame", async () => {
        const { made, connection, callbacks, order } = setup();
        let release!: () => void;
        callbacks.onReady.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
        connection.start();
        await open(made[0]);
        deliver(made[0], { kind: "control", op: "hello_ok", seq: 110 });
        deliver(made[0], journal(101));
        deliver(made[0], journal(102));
        deliver(made[0], { kind: "ephemeral", convo_id: "c1", activity: { state: "thinking" } });
        deliver(made[0], journal(103));
        release();
        await flush();
        expect(order).toEqual(["batch:101,102", "frame:ephemeral", "batch:103"]);
        connection.stop();
    });

    it("caps a run at MAX_JOURNAL_BATCH frames", async () => {
        const { made, connection, callbacks } = setup({ cursor: 0 });
        let release!: () => void;
        callbacks.onReady.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
        connection.start();
        await open(made[0]);
        deliver(made[0], { kind: "control", op: "hello_ok", seq: 1 });
        for (let seq = 1; seq <= MAX_JOURNAL_BATCH + 3; seq++) deliver(made[0], journal(seq));
        release();
        await flush();
        const sizes = callbacks.onJournalBatch.mock.calls.map(([frames]) => frames.length);
        expect(sizes).toEqual([MAX_JOURNAL_BATCH, 3]);
        connection.stop();
    });

    it("falls back to per-frame onFrame when no batch sink is registered", async () => {
        const { made, connection, order } = setup({ batch: false });
        connection.start();
        await open(made[0]);
        deliver(made[0], { kind: "control", op: "hello_ok", seq: 110 });
        deliver(made[0], journal(101));
        deliver(made[0], journal(102));
        await flush();
        expect(order).toEqual(["frame:101", "frame:102"]);
        connection.stop();
    });
});

describe("JournalConnection abandoned sockets", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("does not apply a queued run after an earlier run failed", async () => {
        const { made, connection, order, callbacks } = setup({ cursor: 100 });
        let fail!: (error: Error) => void;
        callbacks.onJournalBatch.mockReturnValueOnce(new Promise<void>((_, reject) => (fail = reject)));
        connection.start();
        await open(made[0]);
        deliver(made[0], { kind: "control", op: "hello_ok", seq: 103 });
        await flush();
        deliver(made[0], journal(101));
        await flush();
        // A second run, already queued on the socket behind the in-flight one.
        deliver(made[0], journal(102));
        fail(new Error("quota"));
        await flush();
        expect(callbacks.onState).toHaveBeenCalledWith("offline", "quota");
        expect(order).not.toContain("batch:102");
        connection.stop();
    });

    it("does not snapshot twice when the journal sends snapshot_required twice", async () => {
        const { made, connection, callbacks } = setup({ cursor: 100 });
        let release!: () => void;
        callbacks.onSnapshotRequired.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
        connection.start();
        await open(made[0]);
        deliver(made[0], { kind: "control", op: "snapshot_required" });
        deliver(made[0], { kind: "control", op: "snapshot_required" });
        await flush();
        release();
        await flush();
        made[0].onclose?.(new CloseEvent("close", { code: 1000 }));
        jest.advanceTimersByTime(0);
        await flush();

        expect(callbacks.onSnapshotRequired).toHaveBeenCalledTimes(1);
        expect(made).toHaveLength(2);
        connection.stop();
    });
});
