/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalConnection } from "../../../src/journal/connection";
import { type ServerFrame } from "../../../src/journal/types";

interface ConnectionInternals {
    welcomed: boolean;
    socket?: WebSocket;
    handleFrame(frame: ServerFrame, socket: WebSocket): Promise<void>;
}

function callbacks() {
    return {
        cursor: jest.fn().mockResolvedValue(0),
        onFrame: jest.fn().mockResolvedValue(undefined),
        onReady: jest.fn().mockResolvedValue(undefined),
        onSnapshotRequired: jest.fn().mockResolvedValue(undefined),
        onRevoked: jest.fn(),
        onState: jest.fn(),
    };
}

function harness() {
    const connectionCallbacks = callbacks();
    const connection = new JournalConnection(
        "https://journal.example",
        "token",
        connectionCallbacks,
        () => "request-1",
    );
    const socket = { close: jest.fn() } as unknown as WebSocket;
    const internal = connection as unknown as ConnectionInternals;
    return { connection, connectionCallbacks, internal, socket };
}

async function frame(internal: ConnectionInternals, socket: WebSocket, value: Record<string, unknown>): Promise<void> {
    await internal.handleFrame(value as unknown as ServerFrame, socket);
}

describe("JournalConnection RPC transport", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("correlates an rpc response and ignores a duplicate multicast response", async () => {
        const { connection, connectionCallbacks, internal, socket } = harness();
        const send = jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", { browser: true }, 30_000);
        const response = {
            kind: "rpc",
            response: { request_id: "request-1", agent_device_id: 7, ok: true, result: { convo_id: "c1" } },
        };

        await frame(internal, socket, response);
        await expect(reply).resolves.toEqual({ ok: true, origin: "agent", result: { convo_id: "c1" } });
        await frame(internal, socket, response);

        expect(send).toHaveBeenCalledTimes(1);
        expect(connectionCallbacks.onFrame).not.toHaveBeenCalled();
    });

    it("rejects a duplicate generated request id before sending a second operation", async () => {
        const { connection, internal, socket } = harness();
        const send = jest.spyOn(connection, "send").mockReturnValue(true);
        const first = connection.agentRequest(7, "start", {}, 30_000);

        await expect(connection.agentRequest(7, "start", {}, 30_000)).resolves.toEqual({
            ok: false,
            origin: "relay",
            code: "duplicate_request_id",
        });
        expect(send).toHaveBeenCalledTimes(1);

        await frame(internal, socket, {
            kind: "rpc",
            response: { request_id: "request-1", agent_device_id: 7, ok: true, result: "created" },
        });
        await expect(first).resolves.toEqual({ ok: true, origin: "agent", result: "created" });
    });

    it("handles a prompt rpc response while onReady is blocked in the ordered queue", async () => {
        let releaseReady!: () => void;
        const ready = new Promise<void>((resolve) => {
            releaseReady = resolve;
        });
        const connectionCallbacks = callbacks();
        connectionCallbacks.onReady.mockReturnValue(ready);
        const socket = { close: jest.fn() } as unknown as WebSocket;
        const websocket = jest.spyOn(globalThis, "WebSocket").mockImplementation(() => socket);
        const connection = new JournalConnection(
            "https://journal.example",
            "token",
            connectionCallbacks,
            () => "request-1",
        );
        const send = jest.spyOn(connection, "send").mockReturnValue(true);

        connection.start();
        socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "control", op: "hello_ok" }) }));
        await Promise.resolve();
        expect(connectionCallbacks.onReady).toHaveBeenCalledTimes(1);

        const reply = connection.agentRequest(7, "start", {}, 100);
        socket.onmessage?.(
            new MessageEvent("message", {
                data: JSON.stringify({
                    kind: "rpc",
                    response: { request_id: "request-1", agent_device_id: 7, ok: true, result: "created" },
                }),
            }),
        );
        jest.advanceTimersByTime(100);

        await expect(reply).resolves.toEqual({ ok: true, origin: "agent", result: "created" });
        expect(send).toHaveBeenCalledTimes(1);
        releaseReady();
        await Promise.resolve();
        connection.stop();
        websocket.mockRestore();
    });

    it.each([
        ["a missing response", { kind: "rpc" }],
        ["a missing ok field", { kind: "rpc", response: { request_id: "request-1", agent_device_id: 7 } }],
    ])("diagnoses and ignores an rpc frame with %s without cycling the socket", async (_description, response) => {
        const { connection, internal, socket } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const reply = connection.agentRequest(7, "start", {}, 100);

        await frame(internal, socket, response);

        expect(warning).toHaveBeenCalledWith("matron:rpc", {
            event: "malformed_rpc",
            request_id: response.kind === "rpc" && "response" in response ? "request-1" : undefined,
        });
        expect(socket.close as jest.Mock).not.toHaveBeenCalled();
        jest.advanceTimersByTime(100);
        await expect(reply).resolves.toEqual({ ok: false, origin: "timeout", code: "timeout" });
    });

    it("resolves the overall timeout with its origin", async () => {
        const { connection } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", {}, 500);

        jest.advanceTimersByTime(500);

        await expect(reply).resolves.toEqual({ ok: false, origin: "timeout", code: "timeout" });
    });

    it("resolves pending requests as teardown when stopped", async () => {
        const { connection } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", {}, 30_000);

        connection.stop();

        await expect(reply).resolves.toEqual({ ok: false, origin: "teardown", code: "teardown" });
    });

    it("correlates a relay control error", async () => {
        const { connection, internal, socket } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", {}, 30_000);

        await frame(internal, socket, {
            kind: "control",
            op: "error",
            request_id: "request-1",
            code: "agent_offline",
            detail: "Agent disconnected",
        });

        await expect(reply).resolves.toEqual({
            ok: false,
            origin: "relay",
            code: "agent_offline",
            detail: "Agent disconnected",
        });
    });

    it("retries not_ready twice at one-second intervals with the same request id, then surfaces it", async () => {
        const { connection, internal, socket } = harness();
        const send = jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", { workdir: "/repo" }, 30_000);
        const notReady = { kind: "control", op: "error", request_id: "request-1", code: "not_ready" };

        await frame(internal, socket, notReady);
        jest.advanceTimersByTime(1_000);
        await frame(internal, socket, notReady);
        jest.advanceTimersByTime(1_000);
        await frame(internal, socket, notReady);

        await expect(reply).resolves.toEqual({ ok: false, origin: "relay", code: "not_ready" });
        expect(send).toHaveBeenCalledTimes(3);
        expect(send.mock.calls.map(([operation]) => operation)).toEqual([
            {
                op: "agent_request",
                request_id: "request-1",
                agent_device_id: 7,
                method: "start",
                params: { workdir: "/repo" },
            },
            {
                op: "agent_request",
                request_id: "request-1",
                agent_device_id: 7,
                method: "start",
                params: { workdir: "/repo" },
            },
            {
                op: "agent_request",
                request_id: "request-1",
                agent_device_id: 7,
                method: "start",
                params: { workdir: "/repo" },
            },
        ]);
    });

    it("does not resend after a request settles during not_ready backoff", async () => {
        const { connection, internal, socket } = harness();
        const send = jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", {}, 30_000);

        await frame(internal, socket, {
            kind: "control",
            op: "error",
            request_id: "request-1",
            code: "not_ready",
        });
        await frame(internal, socket, {
            kind: "rpc",
            response: { request_id: "request-1", agent_device_id: 7, ok: true, result: "created" },
        });
        jest.advanceTimersByTime(1_000);

        await expect(reply).resolves.toEqual({ ok: true, origin: "agent", result: "created" });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("resolves immediately when a retry send returns false", async () => {
        const { connection, internal, socket } = harness();
        jest.spyOn(connection, "send").mockReturnValueOnce(true).mockReturnValueOnce(false);
        const reply = connection.agentRequest(7, "start", {}, 30_000);

        await frame(internal, socket, {
            kind: "control",
            op: "error",
            request_id: "request-1",
            code: "not_ready",
        });
        jest.advanceTimersByTime(1_000);

        await expect(reply).resolves.toEqual({ ok: false, origin: "relay", code: "not_connected" });
    });

    it("does not schedule a second resend for a duplicate not_ready frame", async () => {
        const { connection, internal, socket } = harness();
        const send = jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", {}, 30_000);
        const notReady = { kind: "control", op: "error", request_id: "request-1", code: "not_ready" };

        await frame(internal, socket, notReady);
        await frame(internal, socket, notReady);
        jest.advanceTimersByTime(1_000);

        expect(send).toHaveBeenCalledTimes(2);
        connection.stop();
        await expect(reply).resolves.toMatchObject({ origin: "teardown" });
    });

    it("returns not_connected when the initial send returns false", async () => {
        const { connection } = harness();
        jest.spyOn(connection, "send").mockReturnValue(false);

        await expect(connection.agentRequest(7, "start", {}, 30_000)).resolves.toEqual({
            ok: false,
            origin: "relay",
            code: "not_connected",
        });
    });

    it("returns not_connected when socket.send throws after the readiness check", async () => {
        const { connection, internal } = harness();
        internal.welcomed = true;
        internal.socket = {
            readyState: WebSocket.OPEN,
            send: jest.fn(() => {
                throw new DOMException("closed", "InvalidStateError");
            }),
        } as unknown as WebSocket;

        await expect(connection.agentRequest(7, "start", {}, 30_000)).resolves.toEqual({
            ok: false,
            origin: "relay",
            code: "not_connected",
        });
    });

    it("ignores an rpc response from a different agent", async () => {
        const { connection, internal, socket } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const reply = connection.agentRequest(7, "start", {}, 30_000);

        await frame(internal, socket, {
            kind: "rpc",
            response: { request_id: "request-1", agent_device_id: 8, ok: true, result: "foreign" },
        });
        await frame(internal, socket, {
            kind: "rpc",
            response: { request_id: "request-1", agent_device_id: 7, ok: true, result: "expected" },
        });

        await expect(reply).resolves.toEqual({ ok: true, origin: "agent", result: "expected" });
    });

    it("drops a non-string detail from an agent error", async () => {
        const { connection, internal, socket } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        const reply = connection.agentRequest(7, "start", {}, 30_000);

        await frame(internal, socket, {
            kind: "rpc",
            response: {
                request_id: "request-1",
                agent_device_id: 7,
                ok: false,
                error: { code: "bad_workdir", detail: { secret: true } },
            },
        });

        await expect(reply).resolves.toEqual({
            ok: false,
            origin: "agent",
            code: "bad_workdir",
            detail: undefined,
        });
    });

    it("diagnoses an agent error without a string code and leaves it pending", async () => {
        const { connection, internal, socket } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const reply = connection.agentRequest(7, "start", {}, 100);

        await frame(internal, socket, {
            kind: "rpc",
            response: { request_id: "request-1", agent_device_id: 7, ok: false, error: { code: 17 } },
        });

        expect(warning).toHaveBeenCalledWith("matron:rpc", {
            event: "malformed_rpc",
            request_id: "request-1",
        });
        jest.advanceTimersByTime(100);
        await expect(reply).resolves.toEqual({ ok: false, origin: "timeout", code: "timeout" });
    });

    it("narrows malformed correlated control-error fields", async () => {
        const { connection, internal, socket } = harness();
        jest.spyOn(connection, "send").mockReturnValue(true);
        const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const reply = connection.agentRequest(7, "start", {}, 30_000);

        await frame(internal, socket, {
            kind: "control",
            op: "error",
            request_id: "request-1",
            code: { malformed: true },
            detail: { secret: true },
        });

        await expect(reply).resolves.toEqual({
            ok: false,
            origin: "relay",
            code: "relay_error",
            detail: undefined,
        });
        expect(warning).toHaveBeenCalledWith("matron:rpc", {
            event: "malformed_control_error",
            request_id: "request-1",
        });
    });
});

describe("JournalConnection.forceResync (#766)", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("drops the socket, re-snapshots, then reconnects — mirroring snapshot_required", async () => {
        const connectionCallbacks = callbacks();
        const oldSocket = { close: jest.fn() } as unknown as WebSocket;
        const newSocket = { close: jest.fn() } as unknown as WebSocket;
        const websocket = jest.spyOn(globalThis, "WebSocket").mockImplementation(() => newSocket);
        const connection = new JournalConnection("https://journal.example", "token", connectionCallbacks, () => "id-1");
        const internal = connection as unknown as ConnectionInternals & {
            stopped: boolean;
            replacingSnapshot: boolean;
        };
        // Simulate a live, welcomed connection with an open socket.
        internal.stopped = false;
        internal.socket = oldSocket;

        await connection.forceResync();

        // The current socket is dropped and a fresh snapshot is fetched (the cursor reset lives in
        // the client's onSnapshotRequired callback).
        expect(oldSocket.close).toHaveBeenCalledWith(1000, "client resync");
        expect(connectionCallbacks.onSnapshotRequired).toHaveBeenCalledTimes(1);
        // The resync flag is cleared once the re-snapshot resolves.
        expect(internal.replacingSnapshot).toBe(false);

        // scheduleReconnect(0) then reopens the socket.
        jest.advanceTimersByTime(0);
        expect(websocket).toHaveBeenCalledTimes(1);

        connection.stop();
        websocket.mockRestore();
    });

    it("is a no-op on a stopped connection", async () => {
        const connectionCallbacks = callbacks();
        const connection = new JournalConnection("https://journal.example", "token", connectionCallbacks, () => "id-1");
        // Default state is stopped=true until start().
        await connection.forceResync();
        expect(connectionCallbacks.onSnapshotRequired).not.toHaveBeenCalled();
    });

    it("collapses a concurrent resync while one is already in flight", async () => {
        const connectionCallbacks = callbacks();
        let releaseSnapshot!: () => void;
        connectionCallbacks.onSnapshotRequired.mockReturnValue(
            new Promise<void>((resolve) => {
                releaseSnapshot = resolve;
            }),
        );
        const websocket = jest
            .spyOn(globalThis, "WebSocket")
            .mockImplementation(() => ({ close: jest.fn() }) as unknown as WebSocket);
        const connection = new JournalConnection("https://journal.example", "token", connectionCallbacks, () => "id-1");
        const internal = connection as unknown as ConnectionInternals & { stopped: boolean };
        internal.stopped = false;
        internal.socket = { close: jest.fn() } as unknown as WebSocket;

        const first = connection.forceResync();
        // A second call while the first is mid-flight (replacingSnapshot set) must not re-enter.
        await connection.forceResync();
        expect(connectionCallbacks.onSnapshotRequired).toHaveBeenCalledTimes(1);

        releaseSnapshot();
        await first;
        jest.advanceTimersByTime(0);

        connection.stop();
        websocket.mockRestore();
    });

    it("reconnects even when the re-snapshot fails, so a transient error cannot wedge sync (F2)", async () => {
        const connectionCallbacks = callbacks();
        connectionCallbacks.onSnapshotRequired.mockRejectedValue(new Error("offline"));
        const newSocket = { close: jest.fn() } as unknown as WebSocket;
        const websocket = jest.spyOn(globalThis, "WebSocket").mockImplementation(() => newSocket);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const connection = new JournalConnection("https://journal.example", "token", connectionCallbacks, () => "id-1");
        const internal = connection as unknown as ConnectionInternals & {
            stopped: boolean;
            replacingSnapshot: boolean;
        };
        internal.stopped = false;
        internal.socket = { close: jest.fn() } as unknown as WebSocket;

        // forceResync must swallow the snapshot rejection (not throw) and still clear the flag.
        await expect(connection.forceResync()).resolves.toBeUndefined();
        expect(connectionCallbacks.onSnapshotRequired).toHaveBeenCalledTimes(1);
        expect(internal.replacingSnapshot).toBe(false);

        // A reconnect is scheduled despite the failure — the socket-less/no-timer wedge is avoided.
        jest.advanceTimersByTime(0);
        expect(websocket).toHaveBeenCalledTimes(1);

        connection.stop();
        websocket.mockRestore();
    });

    it("ignores a delayed close from the superseded socket so it cannot disable the replacement (F4)", async () => {
        const connectionCallbacks = callbacks();
        type FakeSocket = {
            close: jest.Mock;
            send: jest.Mock;
            onopen: (() => void) | null;
            onmessage: ((event: MessageEvent) => void) | null;
            onclose: ((event: CloseEvent) => void) | null;
            onerror: (() => void) | null;
            readyState: number;
        };
        const made: FakeSocket[] = [];
        const factory = (): FakeSocket => {
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
            return socket;
        };
        const websocket = jest
            .spyOn(globalThis, "WebSocket")
            .mockImplementation(() => factory() as unknown as WebSocket);
        const connection = new JournalConnection("https://journal.example", "token", connectionCallbacks, () => "id-1");
        const internal = connection as unknown as ConnectionInternals & { welcomed: boolean; socket?: WebSocket };

        const welcome = async (socket: FakeSocket): Promise<void> => {
            socket.onopen?.();
            await Promise.resolve();
            await Promise.resolve();
            socket.onmessage?.(
                new MessageEvent("message", { data: JSON.stringify({ kind: "control", op: "hello_ok" }) }),
            );
            await Promise.resolve();
        };

        connection.start();
        const socketA = made[0];
        await welcome(socketA);
        expect(internal.welcomed).toBe(true);

        // Client resync: closes socket A, clears this.socket, reconnects to socket B.
        await connection.forceResync();
        jest.advanceTimersByTime(0);
        const socketB = made[1];
        expect(socketB).toBeDefined();
        await welcome(socketB);
        expect(internal.welcomed).toBe(true);
        expect(internal.socket).toBe(socketB as unknown as WebSocket);

        // The discarded socket A finally fires its (stale) close event. It must be a no-op: no
        // welcomed=false, no state regression, socket B stays current.
        connectionCallbacks.onState.mockClear();
        socketA.onclose?.(new CloseEvent("close", { code: 1000 }));
        expect(internal.welcomed).toBe(true);
        expect(internal.socket).toBe(socketB as unknown as WebSocket);
        expect(connectionCallbacks.onState).not.toHaveBeenCalled();

        connection.stop();
        websocket.mockRestore();
    });
});

describe("JournalConnection.reconnectNow (manual reconnect from Settings)", () => {
    interface ReconnectInternals {
        stopped: boolean;
        socket?: WebSocket;
        retryTimer?: number;
        retryAttempt: number;
        open(): void;
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("skips the pending backoff and opens a socket immediately", () => {
        const { connection } = harness();
        const internal = connection as unknown as ReconnectInternals;
        const open = jest.spyOn(internal, "open").mockImplementation(() => undefined);
        internal.stopped = false;
        internal.retryAttempt = 5;
        internal.retryTimer = window.setTimeout(() => internal.open(), 60_000);

        connection.reconnectNow();

        expect(open).toHaveBeenCalledTimes(1);
        expect(internal.retryTimer).toBeUndefined();
        expect(internal.retryAttempt).toBe(0);
        jest.advanceTimersByTime(60_000);
        expect(open).toHaveBeenCalledTimes(1); // the cancelled backoff never fires a second open
    });

    it("is a no-op while a welcomed socket is live", () => {
        const { connection, socket } = harness();
        const internal = connection as unknown as ReconnectInternals & { welcomed: boolean };
        const open = jest.spyOn(internal, "open").mockImplementation(() => undefined);
        internal.stopped = false;
        internal.socket = socket;
        internal.welcomed = true;

        connection.reconnectNow();

        expect(open).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();
    });

    it("replaces a socket that was never welcomed (stalled before hello_ok)", () => {
        const { connection, socket } = harness();
        const internal = connection as unknown as ReconnectInternals & { welcomed: boolean };
        const open = jest.spyOn(internal, "open").mockImplementation(() => undefined);
        internal.stopped = false;
        internal.socket = socket;
        internal.welcomed = false;

        connection.reconnectNow();

        expect(socket.close).toHaveBeenCalledTimes(1);
        expect(internal.socket).toBeUndefined();
        expect(open).toHaveBeenCalledTimes(1);
    });

    it("is a no-op on a stopped connection", () => {
        const { connection } = harness();
        const internal = connection as unknown as ReconnectInternals;
        const open = jest.spyOn(internal, "open").mockImplementation(() => undefined);

        connection.reconnectNow();

        expect(open).not.toHaveBeenCalled();
    });
});

describe("JournalConnection welcome timeout", () => {
    class FakeSocket {
        public static instances: FakeSocket[] = [];
        public readyState = 0;
        public onopen: (() => void) | null = null;
        public onclose: ((event: { code: number; reason: string }) => void) | null = null;
        public onmessage: unknown = null;
        public onerror: unknown = null;
        public close = jest.fn((code = 1000, reason = "") => {
            this.onclose?.({ code, reason });
        });
        public constructor() {
            FakeSocket.instances.push(this);
        }
    }
    const realWebSocket = globalThis.WebSocket;

    beforeEach(() => {
        jest.useFakeTimers();
        FakeSocket.instances = [];
        (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
    });
    afterEach(() => {
        (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
        jest.useRealTimers();
    });

    it("closes a socket that never receives hello_ok and retries", () => {
        const { connection } = harness();
        connection.start();
        expect(FakeSocket.instances).toHaveLength(1);

        jest.advanceTimersByTime(20_000);

        expect(FakeSocket.instances[0].close).toHaveBeenCalledWith(4000, "welcome timeout");
        jest.advanceTimersByTime(60_000);
        expect(FakeSocket.instances.length).toBeGreaterThan(1);
        connection.stop();
    });

    it("does not close a welcomed socket", async () => {
        const { connection } = harness();
        connection.start();
        const socket = FakeSocket.instances[0] as unknown as WebSocket;
        await (connection as unknown as ConnectionInternals).handleFrame(
            { kind: "control", op: "hello_ok" } as unknown as ServerFrame,
            socket,
        );

        jest.advanceTimersByTime(20_000);

        expect(FakeSocket.instances[0].close).not.toHaveBeenCalled();
        connection.stop();
    });
});
