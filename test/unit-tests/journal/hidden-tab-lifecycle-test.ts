/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Connection lifecycle for a hidden tab: the socket is closed 60 s
// after the tab hides, a tab that comes back first keeps it, and a tab that comes back
// after reconnects from the stored cursor and replaces what its live tool output showed.
// All timing runs on fake timers; nothing waits in real time.
//
// The catch-up test replays the rows of the shared recovery fixture 19a (events while
// away) when the pinned conformance package is available (MATRON_CONFORMANCE_TARBALL or
// MATRON_CONFORMANCE_DIR, as for the other conformance tests), and is skipped without it.

import "fake-indexeddb/auto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { IDBFactory } from "fake-indexeddb";

import { MatronJournalClient } from "../../../src/journal/client";
import { ToolStream } from "../../../src/journal/components";
import { JournalConnection } from "../../../src/journal/connection";
import { JournalDatabase } from "../../../src/journal/database";
import type { JournalEphemeralFrame, JournalEvent, ToolStreamState } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const HIDDEN_CLOSE_MS = 60_000;

class FakeSocket {
    public static readonly CONNECTING = 0;
    public static readonly OPEN = 1;
    public static readonly CLOSING = 2;
    public static readonly CLOSED = 3;
    public static instances: FakeSocket[] = [];

    public readyState = 0;
    public sent: Array<Record<string, unknown>> = [];
    public closedWith?: { code?: number; reason?: string };
    public onopen: (() => void) | null = null;
    public onmessage: ((message: { data: string }) => void) | null = null;
    public onerror: (() => void) | null = null;
    public onclose: ((event: { code: number; reason: string }) => void) | null = null;

    public constructor(public readonly url: string) {
        FakeSocket.instances.push(this);
    }

    public send(data: string): void {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    public close(code?: number, reason?: string): void {
        if (this.readyState === FakeSocket.CLOSED) return;
        this.closedWith = { code, reason };
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
    }

    public open(): void {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }

    public receive(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    public get hello(): Record<string, unknown> | undefined {
        return this.sent.find((frame) => frame.op === "hello");
    }
}

let visibility: "visible" | "hidden" = "visible";
function setVisibility(next: "visible" | "hidden"): void {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
}

const settle = async (): Promise<void> => {
    // Runs due timers (storage schedules its work on them) and the microtasks they release; no time passes.
    for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
};

beforeAll(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility === "hidden" });
});

let realWebSocket: typeof WebSocket;
beforeEach(() => {
    realWebSocket = globalThis.WebSocket;
    FakeSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
    visibility = "visible";
    jest.useFakeTimers();
});

const started: JournalConnection[] = [];
afterEach(() => {
    // A failed assertion must not leave a connection listening to the next test's visibility changes.
    for (const connection of started.splice(0)) connection.stop();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

function callbacks(cursor = 0) {
    return {
        cursor: jest.fn().mockImplementation(async () => cursor),
        onFrame: jest.fn().mockResolvedValue(undefined),
        onReady: jest.fn().mockResolvedValue(undefined),
        onSnapshotRequired: jest.fn().mockResolvedValue(undefined),
        onRevoked: jest.fn(),
        onState: jest.fn(),
        onSuspend: jest.fn(),
    };
}

const HELLO_OK = {
    kind: "control",
    op: "hello_ok",
    seq: 0,
    device_id: 1,
    name: "web",
    settings: { notices: true, auto_archive_days: 30 },
    pins: [],
};

/** A connection started and welcomed on its first socket. */
async function online(cb = callbacks()) {
    const connection = new JournalConnection("https://journal.example", "token", cb);
    started.push(connection);
    connection.start();
    const socket = FakeSocket.instances[0];
    socket.open();
    await settle();
    socket.receive(HELLO_OK);
    await settle();
    return { connection, cb, socket };
}

describe("hidden tab closes its socket", () => {
    it("keeps the socket after 59 s hidden", async () => {
        const { connection, socket } = await online();
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS - 1_000);
        expect(socket.readyState).toBe(FakeSocket.OPEN);
        expect(socket.closedWith).toBeUndefined();
        connection.stop();
    });

    it("closes the socket at 60 s hidden, cleanly, and does not retry while hidden", async () => {
        const { connection, cb, socket } = await online();
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS);
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
        expect(socket.closedWith?.code).toBe(1000);
        expect(cb.onSuspend).toHaveBeenCalledTimes(1);
        // No backoff reconnect for as long as the tab stays hidden.
        jest.advanceTimersByTime(10 * 60_000);
        await settle();
        expect(FakeSocket.instances).toHaveLength(1);
        connection.stop();
    });

    it("a tab visible again at 59 s cancels the close", async () => {
        const { connection, cb, socket } = await online();
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS - 1_000);
        setVisibility("visible");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS * 2);
        expect(socket.readyState).toBe(FakeSocket.OPEN);
        expect(FakeSocket.instances).toHaveLength(1);
        expect(cb.onSuspend).not.toHaveBeenCalled();
        connection.stop();
    });

    it("hiding again restarts the 60 s count from the new hide", async () => {
        const { connection, socket } = await online();
        setVisibility("hidden");
        jest.advanceTimersByTime(40_000);
        setVisibility("visible");
        setVisibility("hidden");
        jest.advanceTimersByTime(40_000);
        expect(socket.readyState).toBe(FakeSocket.OPEN);
        jest.advanceTimersByTime(20_000);
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
        connection.stop();
    });

    it("reconnects on visible from the stored cursor", async () => {
        const cb = callbacks(7);
        const { connection, socket } = await online(cb);
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS);
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
        cb.cursor.mockImplementation(async () => 9);
        setVisibility("visible");
        expect(FakeSocket.instances).toHaveLength(2);
        const next = FakeSocket.instances[1];
        next.open();
        await settle();
        expect(next.hello).toMatchObject({ op: "hello", token: "token", cursor: 9 });
        connection.stop();
    });

    it("an online event while the tab is hidden and closed does not reopen the socket", async () => {
        const { connection } = await online();
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS);
        window.dispatchEvent(new Event("online"));
        jest.advanceTimersByTime(60_000);
        expect(FakeSocket.instances).toHaveLength(1);
        connection.stop();
    });

    it("a connection waiting in backoff when the tab is hidden stops retrying", async () => {
        const { connection, socket } = await online();
        socket.close(1006, "network"); // drops: a retry is scheduled
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS + 60_000);
        const attempts = FakeSocket.instances.length;
        // Whatever the retry opened before the close is closed, and nothing more is tried.
        expect(FakeSocket.instances[attempts - 1].readyState).toBe(FakeSocket.CLOSED);
        jest.advanceTimersByTime(10 * 60_000);
        expect(FakeSocket.instances).toHaveLength(attempts);
        setVisibility("visible");
        expect(FakeSocket.instances).toHaveLength(attempts + 1);
        connection.stop();
    });

    it("a tab that starts hidden closes the socket 60 s in", async () => {
        visibility = "hidden";
        const connection = new JournalConnection("https://journal.example", "token", callbacks());
        started.push(connection);
        connection.start();
        const socket = FakeSocket.instances[0];
        socket.open();
        await settle();
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS);
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
        connection.stop();
    });

    it("settles a pending request as not connected when the socket closes", async () => {
        const { connection } = await online();
        const reply = connection.agentRequest(7, "go", {}, 10 * 60_000);
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS);
        await expect(reply).resolves.toEqual({ ok: false, origin: "relay", code: "not_connected" });
    });

    it("stop() removes the visibility handling", async () => {
        const { connection, cb } = await online();
        connection.stop();
        FakeSocket.instances[0].readyState = FakeSocket.OPEN;
        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS * 2);
        expect(cb.onSuspend).not.toHaveBeenCalled();
        expect(FakeSocket.instances).toHaveLength(1);
    });
});

// ── Live tool output across a hidden tab ──

interface ClientInternals {
    toolStreams: Map<string, Record<string, ToolStreamState>>;
    handleEphemeral(frame: JournalEphemeralFrame): void;
    suspendLiveStreams?(): void;
    handleJournal(event: JournalEvent): Promise<void>;
}

function toolFrame(payload: JournalEphemeralFrame["tool_stream"]): JournalEphemeralFrame {
    return { kind: "ephemeral", convo_id: "c1", message_ref: "tu1", tool_stream: payload };
}

describe("tool output across a hidden tab", () => {
    function liveClient() {
        const client = new MatronJournalClient();
        const internals = client as unknown as ClientInternals;
        internals.handleEphemeral(toolFrame({ event: "append", offset: 0, chunk: "a\nb\n", meta: { tool: "Bash", command: "make" } }));
        internals.handleEphemeral(toolFrame({ event: "append", offset: 4, chunk: "c\n" }));
        return { client, internals };
    }

    it("suspending marks what was shown as no longer live, keeping the text", () => {
        const { internals } = liveClient();
        expect(internals.toolStreams.get("c1")?.tu1.content).toBe("a\nb\nc\n");
        internals.suspendLiveStreams?.();
        expect(internals.toolStreams.get("c1")?.tu1).toMatchObject({ content: "a\nb\nc\n", stale: true });
    });

    it("a snapshot after the hidden period replaces the shown output and is live again", () => {
        const { internals } = liveClient();
        internals.suspendLiveStreams?.();
        // The journal's snapshot holds more than the tab showed; none of the old text is kept twice.
        internals.handleEphemeral(
            toolFrame({ event: "sync", offset: 0, content: "a\nb\nc\nd\ne\n", head_truncated: false, meta: { tool: "Bash", command: "make" } }),
        );
        const stream = internals.toolStreams.get("c1")?.tu1;
        expect(stream?.content).toBe("a\nb\nc\nd\ne\n");
        expect(stream?.stale).toBeFalsy();
        expect(stream?.offset).toBe(10);
    });

    it("a snapshot that starts after byte 0 is marked trimmed", () => {
        const { internals } = liveClient();
        internals.suspendLiveStreams?.();
        internals.handleEphemeral(
            toolFrame({ event: "sync", offset: 2048, content: "tail\n", head_truncated: true, meta: { tool: "Bash", command: "make" } }),
        );
        expect(internals.toolStreams.get("c1")?.tu1).toMatchObject({ content: "tail\n", headTruncated: true });
    });

    it("an offset-less chunk is not appended to a card that is no longer live", () => {
        const { internals } = liveClient();
        internals.suspendLiveStreams?.();
        internals.handleEphemeral(toolFrame({ event: "append", chunk: "late\n" }));
        expect(internals.toolStreams.get("c1")?.tu1.content).toBe("a\nb\nc\n");
    });

    it("a stream the journal no longer has stays marked until its final row retires it", async () => {
        const { internals } = liveClient();
        internals.suspendLiveStreams?.();
        // Reconnected, but no snapshot comes for tu1: it stays shown as no longer live.
        expect(internals.toolStreams.get("c1")?.tu1.stale).toBe(true);
        internals.handleEphemeral(toolFrame({ event: "end" }));
        expect(internals.toolStreams.get("c1")?.tu1).toBeUndefined();
    });

    it("shows 'live output no longer available' on a card that is no longer live, and not on a live one", async () => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement("div");
        const root = createRoot(container);
        const stream: ToolStreamState = { messageRef: "tu1", command: "make", content: "a\n", offset: 2, headTruncated: false };
        await act(async () => {
            root.render(React.createElement(ToolStream, { stream }));
        });
        expect(container.textContent).not.toContain("live output no longer available");
        await act(async () => {
            root.render(React.createElement(ToolStream, { stream: { ...stream, stale: true } }));
        });
        expect(container.textContent).toContain("live output no longer available");
        await act(async () => root.unmount());
    });
});

// ── Cursor catch-up on top of the shared recovery fixture ──

function fixtureRows(): JournalEvent[] | undefined {
    let dir = process.env.MATRON_CONFORMANCE_DIR;
    const tarball = process.env.MATRON_CONFORMANCE_TARBALL;
    if (!dir && tarball) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "matron-conformance-"));
        execFileSync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"]);
    }
    if (!dir) return undefined;
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, "19a_recovery_events_while_away.json"), "utf8")) as {
        steps: Array<{ role: string; kind: string; frame?: Record<string, unknown> }>;
    };
    const resolveNode = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(resolveNode);
        if (node && typeof node === "object") {
            const record = node as Record<string, unknown>;
            if ("$type" in record) return 1_700_000_000_000;
            if ("$ref" in record) return 7;
            return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, resolveNode(value)]));
        }
        return node;
    };
    const bySeq = new Map<number, JournalEvent>();
    for (const step of fixture.steps) {
        if (step.role === "client" && step.kind === "ws_expect" && step.frame?.kind === "journal") {
            const row = resolveNode(step.frame) as unknown as JournalEvent;
            if (!bySeq.has(row.seq)) bySeq.set(row.seq, row);
        }
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const rows = fixtureRows();
const itWithFixture = rows ? it : it.skip;

describe("cursor catch-up after a hidden-tab close (recovery fixture 19a)", () => {
    itWithFixture("replays the rows missed while hidden from the stored cursor, in order, once", async () => {
        (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
        const database = await JournalDatabase.open("https://journal.example", 1, "alice");
        await database.replaceWithSnapshot({ conversations: [], seq: 0 } as never);
        const journal = rows!; // seq 1, 2 held before the tab hid; 3 and 4 arrive while it was hidden
        const available = [...journal.filter((row) => row.seq <= 2)];

        const cb = {
            ...callbacks(),
            cursor: async () => (await database.cursor()) ?? 0,
            onJournalBatch: async (frames: JournalEvent[]) => {
                for (const frame of frames) await database.applyJournal(frame);
            },
        };
        const connection = new JournalConnection("https://journal.example", "token", cb);
        started.push(connection);
        const serve = (socket: FakeSocket): void => {
            const hello = socket.hello!;
            const cursor = hello.cursor as number;
            const head = Math.max(...available.map((row) => row.seq));
            socket.receive({ ...HELLO_OK, seq: head });
            for (const row of available.filter((candidate) => candidate.seq > cursor)) socket.receive(row);
        };

        connection.start();
        const first = FakeSocket.instances[0];
        first.open();
        await settle();
        serve(first);
        await settle();
        expect(await database.cursor()).toBe(2);

        setVisibility("hidden");
        jest.advanceTimersByTime(HIDDEN_CLOSE_MS);
        expect(first.readyState).toBe(FakeSocket.CLOSED);
        available.push(...journal.filter((row) => row.seq > 2)); // the agent journals while the tab is hidden

        setVisibility("visible");
        expect(FakeSocket.instances).toHaveLength(2);
        const second = FakeSocket.instances[1];
        second.open();
        await settle();
        expect(second.hello?.cursor).toBe(2);
        serve(second);
        await settle();

        expect((await database.events("c1")).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
        expect(await database.cursor()).toBe(4);
        connection.stop();
        database.close();
    });
});
