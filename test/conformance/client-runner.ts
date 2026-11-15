/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// The web client as a conformance runner: it performs the steps of the `client` role
// from the shared journal fixtures through the app's own code.
//
//   - HTTP goes through JournalApi's request layer (auth header, error mapping).
//   - Every WebSocket frame passes through decodeServerFrame, the app's decoder. A frame
//     it drops is never seen by the fixture; a frame it narrows is matched narrowed.
//   - Decoded frames reach a real MatronJournalClient (live listeners, tool streams,
//     activity) and a real JournalDatabase (IndexedDB, via fake-indexeddb): the store effect.
//   - A real DesktopNotifier watches that client, with a fake Notification constructor
//     and a fake document, and decides what a tab would show.
//
// The socket itself is a plain WebSocket per fixture connection, because a fixture
// sends hello frames of its own choosing (bad tokens, odd cursors); JournalConnection
// owns its hello and would replace them. Its retry and batching behaviour is not covered here.
//
// Test hook (what `expect_model` and `expect_notification` match against): see
// `modelReport` and `NotificationDecision` below, and test/conformance/README.md.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { JournalApi, JournalApiError } from "../../src/journal/api";
import { MatronJournalClient } from "../../src/journal/client";
import { JournalDatabase } from "../../src/journal/database";
import { decodeServerFrame } from "../../src/journal/frame-decode";
import { DesktopNotifier, type NotificationConstructorLike } from "../../src/journal/notifications";
import type { JournalEvent, ServerFrame, Session, SnapshotResponse } from "../../src/journal/types";
import { type Bindings, match, resolve, resolveString } from "./matcher";

export const CLIENT_CAPABILITIES = [
    "http",
    "ws",
    "disconnect",
    "reconnect_from_cursor",
    "advance_clock",
    "set_app_state",
    "expect_model",
    "expect_notification",
];

export interface FixtureStep {
    kind: string;
    [key: string]: unknown;
}

/** The most recent notification decision for a journal event the client newly applied. */
export interface NotificationDecision {
    /** False when the notifier decided not to show anything for the latest applied event. */
    shown: boolean;
    convo_id: string | null;
    seq: number | null;
    title?: string;
    body?: string;
    silent?: boolean;
}

interface Conn {
    ws: WebSocket;
    frames: ServerFrame[];
    nextIdx: number;
    closed: boolean;
    closeCode?: number;
    hello?: Record<string, unknown>;
    /** Applies frames one at a time, in arrival order. */
    queue: Promise<void>;
    maxSeq: number;
    /** Every message that reached the socket, decoded or dropped. */
    arrived: number;
}

class StepFailure extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// The stable sample session the notifier reads settings with.
function blankSession(base: string): Session {
    return { serverUrl: base, token: "", deviceId: 0, userId: 0, username: "conformance" };
}

export interface ClientRunnerOptions {
    base: string;
    /** Wall clock for staleness and mute expiry; advance_clock adds to it. */
    now?: () => number;
}

export function createClientRunner({ base, now = () => Date.now() }: ClientRunnerOptions) {
    // A fresh store per runner: a fixture run starts from an empty device.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

    const conns: Record<string, Conn> = {};
    let session = blankSession(base);
    let clockMs = 0;
    let database: JournalDatabase | undefined;
    let appState: "foreground" | "background" = "foreground";
    let muted = false;
    let decision: NotificationDecision | undefined;
    const shown: Array<{ title: string; options: Record<string, unknown> }> = [];

    const client = new MatronJournalClient();
    const internals = client as unknown as {
        database?: JournalDatabase;
        handleFrame(frame: ServerFrame): Promise<void>;
        patch(update: Record<string, unknown>): void;
        toolStreams: Map<string, Record<string, unknown>>;
        activities: Map<string, unknown>;
    };

    // A Notification that records instead of showing.
    class FakeNotification {
        public static readonly permission = "granted" as NotificationPermission;
        public static requestPermission(): Promise<NotificationPermission> {
            return Promise.resolve("granted");
        }
        public onclick: ((event: Event) => unknown) | null = null;
        public constructor(title: string, options: Record<string, unknown> = {}) {
            shown.push({ title, options });
        }
        public close(): void {}
    }
    const fakeDocument = {
        title: "Matron",
        get visibilityState() {
            return appState === "foreground" ? "visible" : "hidden";
        },
        hasFocus: () => appState === "foreground",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const clientNow = (): number => now() + clockMs;
    const memoryStorage: Storage = (() => {
        const data = new Map<string, string>();
        return {
            get length() {
                return data.size;
            },
            clear: () => data.clear(),
            getItem: (key: string) => data.get(key) ?? null,
            key: (index: number) => [...data.keys()][index] ?? null,
            removeItem: (key: string) => void data.delete(key),
            setItem: (key: string, value: string) => void data.set(key, value),
        };
    })();
    const notifier = new DesktopNotifier(client, {
        Notification: FakeNotification as unknown as NotificationConstructorLike,
        document: fakeDocument as unknown as Document,
        window: undefined,
        channel: () => undefined,
        storage: memoryStorage,
        now: clientNow,
        api: (current) => new JournalApi(current.serverUrl, current.token),
    });
    let stopNotifier: (() => void) | undefined;

    // Opened once, however many connections deliver their first frame at the same time.
    let opening: Promise<JournalDatabase> | undefined;
    function ensureStore(): Promise<JournalDatabase> {
        opening ??= (async () => {
            const opened = await JournalDatabase.open(session.serverUrl, session.userId, session.username);
            if ((await opened.cursor()) === undefined) {
                await opened.replaceWithSnapshot({ conversations: [], seq: 0 } as SnapshotResponse);
            }
            database = opened;
            internals.database = opened;
            internals.patch({ phase: "signed-in", session });
            await notifier.enable();
            stopNotifier = notifier.start();
            return opened;
        })();
        return opening;
    }

    // One decoded frame, applied the way the client applies it from its own socket.
    async function deliver(raw: unknown, conn?: Conn): Promise<ServerFrame | undefined> {
        const decoded = decodeServerFrame(raw);
        if (!decoded.ok) return undefined;
        const frame = decoded.frame;
        if (conn) conn.frames.push(frame);
        const db = await ensureStore();
        const before = shown.length;
        const cursorBefore = (await db.cursor()) ?? 0;
        await internals.handleFrame(frame);
        if (frame.kind === "journal") {
            const event = frame as JournalEvent;
            if (conn) conn.maxSeq = Math.max(conn.maxSeq, event.seq);
            // A row the store already held (the same row on a second connection) decides nothing new.
            if (event.seq <= cursorBefore) return frame;
            const last = shown[shown.length - 1];
            decision =
                shown.length > before
                    ? {
                          shown: true,
                          convo_id: event.convo_id,
                          seq: event.seq,
                          title: last.title,
                          body: last.options.body as string | undefined,
                          silent: last.options.silent as boolean | undefined,
                      }
                    : { shown: false, convo_id: event.convo_id, seq: event.seq };
        }
        return frame;
    }

    async function openConn(name: string, hello?: Record<string, unknown>): Promise<Conn> {
        const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
        const conn: Conn = {
            ws,
            frames: [],
            nextIdx: 0,
            closed: false,
            hello,
            queue: Promise.resolve(),
            maxSeq: 0,
            arrived: 0,
        };
        ws.addEventListener("message", (event: MessageEvent) => {
            conn.arrived += 1;
            let raw: unknown;
            try {
                raw = JSON.parse(String(event.data));
            } catch {
                return;
            }
            conn.queue = conn.queue
                .then(async () => {
                    await deliver(raw, conn);
                })
                .catch(() => undefined);
        });
        ws.addEventListener("close", (event: CloseEvent) => {
            conn.closed = true;
            conn.closeCode = event.code;
        });
        conns[name] = conn;
        await new Promise<void>((done, fail) => {
            ws.addEventListener("open", () => done());
            ws.addEventListener("error", () => fail(new StepFailure("socket error while opening")));
        });
        return conn;
    }

    async function doHttp(step: FixtureStep, bindings: Bindings): Promise<Bindings> {
        const method = ((step.method as string | undefined) ?? "GET") as "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        const path = resolveString(step.path as string, bindings);
        const token = step.token === undefined ? undefined : String(resolve(step.token, bindings));
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries((step.headers as Record<string, unknown> | undefined) ?? {})) {
            headers[name] = resolveString(String(value), bindings);
        }
        const api = new JournalApi(base, token);
        const options: Parameters<JournalApi["snapshot"]>[0] extends never ? never : Record<string, unknown> = {
            method,
            authenticated: token !== undefined,
            headers,
        };
        if (step.body_base64 !== undefined) {
            const bytes = Buffer.from(step.body_base64 as string, "base64");
            options.rawBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            if (step.content_type) options.contentType = step.content_type;
        } else if (step.body !== undefined) {
            options.body = resolve(step.body, bindings);
        }
        const call = api as unknown as {
            request(
                path: string,
                options: Record<string, unknown>,
            ): Promise<{ status: number; headers: Headers; body: ArrayBuffer }>;
        };
        let status: number;
        let json: unknown = null;
        let bytes: Buffer | null = null;
        let responseHeaders: Headers | undefined;
        try {
            const response = await call.request(path, options);
            status = response.status;
            responseHeaders = response.headers;
            if ((response.headers.get("content-type") ?? "").includes("application/json")) {
                try {
                    json = JSON.parse(new TextDecoder().decode(response.body));
                } catch {
                    json = null;
                }
            } else {
                bytes = Buffer.from(response.body);
            }
        } catch (error) {
            if (!(error instanceof JournalApiError) || error.status === 0) throw error;
            status = error.status;
            json = error.body ?? null;
            // The app's error type drops response headers but keeps the retry time it read from
            // a 429, so that is the only header an error response can show here.
            if (error.retryAfter !== undefined)
                responseHeaders = new Headers({ "retry-after": String(error.retryAfter) });
        }
        const expected = (step.expect as Record<string, unknown> | undefined) ?? {};
        const next = { ...bindings };
        if (expected.status !== undefined && status !== expected.status) {
            throw new StepFailure(`expected status ${String(expected.status)}, got ${status}`);
        }
        if (expected.headers) {
            if (!responseHeaders)
                throw new StepFailure(
                    "expect.headers on an error response: the app's request layer does not keep them",
                );
            for (const [name, want] of Object.entries(expected.headers as Record<string, unknown>)) {
                const result = match(want, responseHeaders.get(name), next, `headers.${name}`);
                if (!result.ok) throw new StepFailure(result.reason);
            }
        }
        if (expected.body !== undefined) {
            const result = match(expected.body, json, next, "body");
            if (!result.ok) throw new StepFailure(`${result.reason}\nfull actual body: ${JSON.stringify(json)}`);
        }
        if (expected.body_base64 !== undefined) {
            if (!(bytes && bytes.equals(Buffer.from(expected.body_base64 as string, "base64")))) {
                throw new StepFailure("binary response body did not match expect.body_base64");
            }
        }
        // What the app does with the answers it would act on.
        if (status === 200 && method === "POST" && path === "/login" && json && typeof json === "object") {
            const login = json as { token?: string; device_id?: number; user_id?: number; username?: string };
            if (typeof login.token === "string" && !database) {
                session = {
                    serverUrl: base,
                    token: login.token,
                    deviceId: login.device_id ?? 0,
                    userId: login.user_id ?? 0,
                    username: login.username ?? "conformance",
                };
            }
        }
        if (status === 200 && method === "GET" && path === "/snapshot" && json && token !== undefined) {
            const db = await ensureStore();
            await db.replaceWithSnapshot(json as SnapshotResponse);
            internals.patch({ conversations: await db.conversations() });
        }
        return next;
    }

    async function expectFrame(conn: Conn | undefined, step: FixtureStep, bindings: Bindings): Promise<Bindings> {
        if (!conn) throw new StepFailure("ws_expect: no such connection (ws_open/ws_send it first)");
        const started = Date.now();
        while (conn.nextIdx >= conn.frames.length) {
            if (Date.now() - started > 2000) {
                throw new StepFailure(
                    `timed out waiting for a frame (received so far: ${JSON.stringify(conn.frames.slice(conn.nextIdx))})`,
                );
            }
            await sleep(10);
        }
        const actual = conn.frames[conn.nextIdx++];
        // The decoder's output reaches the store before the step ends.
        await conn.queue;
        const next = { ...bindings };
        const result = match(step.frame, actual, next, "frame");
        if (!result.ok) throw new StepFailure(`${result.reason}\nfull actual frame: ${JSON.stringify(actual)}`);
        return next;
    }

    /** The model the client holds, as `expect_model` sees it. */
    async function modelReport(): Promise<Record<string, unknown>> {
        const db = await ensureStore();
        const events: Record<string, Array<{ seq: number; type: string; sender: string }>> = {};
        for (const row of await db.conversations()) {
            events[row.id] = (await db.events(row.id)).map((event) => ({
                seq: event.seq,
                type: event.type,
                sender: event.sender,
            }));
        }
        const toolStreams: Record<string, Record<string, unknown>> = {};
        for (const [convoId, streams] of internals.toolStreams)
            toolStreams[convoId] = JSON.parse(JSON.stringify(streams));
        return {
            cursor: (await db.cursor()) ?? null,
            app: appState,
            muted,
            conversations: (await db.conversations()).map((row) => ({
                id: row.id,
                title: row.title,
                session_state: row.session_state,
                last_seq: row.last_seq,
                unread_count: row.unread_count,
                snippet: row.snippet,
            })),
            events,
            tool_streams: toolStreams,
            activities: Object.fromEntries(internals.activities as Map<string, unknown>),
        };
    }

    async function applyMuted(value: boolean): Promise<void> {
        muted = value;
        const db = await ensureStore();
        for (const row of await db.conversations()) {
            if (value) await notifier.muteConvo(row.id, "eight_hours");
            else await notifier.unmuteConvo(row.id);
        }
    }

    async function run(step: FixtureStep, bindings: Bindings): Promise<{ bindings: Bindings; observed: unknown }> {
        let out = bindings;
        let observed: unknown;
        switch (step.kind) {
            case "http":
                out = await doHttp(step, bindings);
                break;
            case "ws_open":
                await openConn(step.conn as string);
                break;
            case "ws_send": {
                const conn = conns[step.conn as string];
                if (!conn) throw new StepFailure(`no open connection named '${String(step.conn)}'`);
                const frame = resolve(step.frame, bindings) as Record<string, unknown>;
                if (frame && frame.op === "hello") conn.hello = frame;
                // `viewing` is what the app sends when a conversation is open on screen: the
                // notifier asks the client which one that is, so the model follows the frame.
                if (frame && frame.op === "viewing") {
                    internals.patch({
                        selectedConversationId: typeof frame.convo_id === "string" ? frame.convo_id : undefined,
                    });
                }
                conn.ws.send(JSON.stringify(frame));
                break;
            }
            case "ws_expect":
                out = await expectFrame(conns[step.conn as string], step, bindings);
                break;
            case "ws_expect_none": {
                const conn = conns[step.conn as string];
                if (!conn) throw new StepFailure("ws_expect_none: no such connection");
                const arrivedBefore = conn.arrived;
                await sleep((step.ms as number | undefined) ?? 200);
                await conn.queue;
                // A frame the decoder dropped still arrived: it must not pass as silence.
                if (conn.arrived !== arrivedBefore)
                    throw new StepFailure(
                        `expected no new frame, but ${conn.arrived - arrivedBefore} arrived (decoded or dropped)`,
                    );
                if (conn.closed) throw new StepFailure("ws_expect_none: the connection closed during the quiet window");
                if (conn.nextIdx !== conn.frames.length) {
                    throw new StepFailure(
                        `expected no new frame, but got: ${JSON.stringify(conn.frames.slice(conn.nextIdx))}`,
                    );
                }
                break;
            }
            case "ws_expect_close": {
                const conn = conns[step.conn as string];
                if (!conn) throw new StepFailure("ws_expect_close: no such connection");
                const started = Date.now();
                while (!conn.closed) {
                    if (Date.now() - started > 2000)
                        throw new StepFailure("timed out waiting for the connection to close");
                    await sleep(10);
                }
                if (step.code !== undefined && conn.closeCode !== step.code) {
                    throw new StepFailure(`expected close code ${String(step.code)}, got ${String(conn.closeCode)}`);
                }
                break;
            }
            case "wait":
                await sleep(step.ms as number);
                break;
            case "disconnect": {
                const conn = conns[step.conn as string];
                if (!conn) throw new StepFailure(`disconnect: no open connection named '${String(step.conn)}'`);
                // The browser socket cannot be cut without a close frame; the server sees the same
                // closed socket and replays from the cursor on the next hello.
                conn.ws.close();
                const started = Date.now();
                while (!conn.closed) {
                    if (Date.now() - started > 2000) throw new StepFailure("disconnect: the socket did not close");
                    await sleep(5);
                }
                await conn.queue;
                break;
            }
            case "reconnect_from_cursor": {
                const previous = conns[step.conn as string];
                if (!previous?.hello)
                    throw new StepFailure(`reconnect_from_cursor: '${String(step.conn)}' never sent a hello`);
                if (!previous.closed)
                    throw new StepFailure(
                        `reconnect_from_cursor: '${String(step.conn)}' is still connected, disconnect it first`,
                    );
                const hello = { ...previous.hello };
                if (step.cursor !== undefined) hello.cursor = resolve(step.cursor, bindings);
                else {
                    // The client's own durable cursor, never behind what the earlier hello asked for.
                    const durable = database ? await database.cursor() : undefined;
                    const asked = Number.isInteger(previous.hello.cursor)
                        ? (previous.hello.cursor as number)
                        : undefined;
                    const known = [durable, asked].filter((value): value is number => value !== undefined && value > 0);
                    hello.cursor = known.length > 0 ? Math.max(...known) : (previous.hello.cursor ?? null);
                }
                const conn = await openConn(step.conn as string, hello);
                conn.ws.send(JSON.stringify(hello));
                break;
            }
            case "advance_clock":
                clockMs += step.ms as number;
                break;
            case "set_app_state":
                if (step.app === "foreground" || step.app === "background") appState = step.app;
                if (typeof step.muted === "boolean") await applyMuted(step.muted);
                break;
            case "expect_model": {
                const report = await modelReport();
                const next = { ...bindings };
                const result = match(step.expect, report, next, "model");
                if (!result.ok) throw new StepFailure(`${result.reason}\nfull model: ${JSON.stringify(report)}`);
                out = next;
                observed = report;
                break;
            }
            case "expect_notification": {
                const report = decision ?? { shown: false, convo_id: null, seq: null };
                const next = { ...bindings };
                const result = match(step.expect, report, next, "notification");
                if (!result.ok) throw new StepFailure(`${result.reason}\nfull decision: ${JSON.stringify(report)}`);
                out = next;
                observed = report;
                break;
            }
            default:
                throw new StepFailure(`this runner cannot perform step kind '${step.kind}'`);
        }
        const added: Bindings = {};
        for (const [key, value] of Object.entries(out))
            if (!(key in bindings) || bindings[key] !== value) added[key] = value;
        return { bindings: added, observed };
    }

    async function close(): Promise<void> {
        for (const conn of Object.values(conns)) {
            try {
                conn.ws.close();
            } catch {
                // already closed
            }
        }
        stopNotifier?.();
        database?.close();
    }

    return { capabilities: CLIENT_CAPABILITIES, run, close, deliver, modelReport };
}
