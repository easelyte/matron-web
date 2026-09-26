/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { decodeServerFrame } from "./frame-decode";
import { type ConnectionState, type JournalEvent, type RpcReply, type ServerFrame, websocketUrl } from "./types";

interface JournalConnectionCallbacks {
    cursor(): Promise<number>;
    onFrame(frame: ServerFrame): Promise<void>;
    /**
     * Optional batched sink for sequenced journal frames. When present, consecutive journal frames
     * that arrive while earlier work is still being processed are coalesced (in arrival order,
     * never across a non-journal frame) and handed over as one run, so a replay backlog costs one
     * store transaction and one render per run instead of per frame. Absent → onFrame per frame.
     */
    onJournalBatch?(frames: JournalEvent[]): Promise<void>;
    onReady(): Promise<void>;
    onSnapshotRequired(): Promise<void>;
    onRevoked(): void;
    onState(state: ConnectionState, error?: string): void;
}

const RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
// A socket that upgrades but never receives hello_ok would otherwise sit in "connecting" forever
// (no close → no retry). Past this deadline it is closed, and the normal onclose retry takes over.
export const WELCOME_TIMEOUT_MS = 20_000;
// Upper bound on one coalesced journal run: keeps a single IndexedDB transaction and the render
// that follows it bounded, and lets the UI paint between runs during a long replay.
export const MAX_JOURNAL_BATCH = 500;
// Client-side replay valve. Replaying a large gap frame by frame is far slower than re-snapshotting
// (the server's own valve, MATRON_MAX_REPLAY, defaults to 50000). Measured on a 3,029-conversation
// journal: a 1,000-frame replay moves ~2.2 MB and took ~5.5 s even batched; a re-snapshot is one
// ~250 KB gzipped GET and took ~3 s whatever the gap. The limit is sent in `hello` as
// `max_replay` (a journal that knows the field answers snapshot_required before replaying anything);
// a journal that ignores it is caught on hello_ok, whose `seq` is the head, and resynced the same way.
export const MAX_CLIENT_REPLAY = 500;

export class JournalConnection {
    private socket?: WebSocket;
    private retryTimer?: number;
    private retryAttempt = 0;
    private stopped = true;
    private welcomed = false;
    private welcomeTimer?: number;
    // The socket whose hello_ok has ARRIVED (recorded on receipt, before the processing queue):
    // a welcome stuck behind earlier queued work (e.g. a slow onReady) must neither trip the
    // welcome timeout nor make a manual reconnect replace an in-fact-welcomed socket.
    private helloSocket?: WebSocket;
    private replacingSnapshot = false;
    private processing = Promise.resolve();
    // The journal run still accepting frames (queued, not yet started). Closed by any non-journal
    // frame, by the run starting, or by reaching MAX_JOURNAL_BATCH, so order is always preserved.
    private openJournalBatch?: { socket: WebSocket; frames: JournalEvent[] };
    // Cursor each socket said hello with, for the hello_ok gap check (old-journal fallback).
    private helloCursor = new WeakMap<WebSocket, number>();
    // A socket abandoned by the replay valve: its already-received replay frames are stale (the
    // snapshot that follows supersedes them) and are dropped instead of applied.
    private abandonedSocket?: WebSocket;
    private pendingRpc = new Map<
        string,
        {
            resolve: (reply: RpcReply) => void;
            timeoutTimer: number;
            backoffTimer?: number;
            retriesLeft: number;
            method: string;
            params: unknown;
            agentDeviceId: number;
        }
    >();

    public constructor(
        private readonly serverUrl: string,
        private readonly token: string,
        private readonly callbacks: JournalConnectionCallbacks,
        private readonly makeId: () => string = () => crypto.randomUUID(),
    ) {}

    public start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        window.addEventListener("online", this.onOnline);
        window.addEventListener("offline", this.onOffline);
        this.open();
    }

    public stop(): void {
        this.stopped = true;
        this.welcomed = false;
        this.clearWelcomeTimer();
        this.replacingSnapshot = false;
        if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        window.removeEventListener("online", this.onOnline);
        window.removeEventListener("offline", this.onOffline);
        this.socket?.close(1000, "client stopped");
        this.socket = undefined;
        for (const [requestId, pending] of this.pendingRpc) {
            window.clearTimeout(pending.timeoutTimer);
            if (pending.backoffTimer !== undefined) window.clearTimeout(pending.backoffTimer);
            this.pendingRpc.delete(requestId);
            pending.resolve({ ok: false, origin: "teardown", code: "teardown" });
        }
        this.callbacks.onState("offline");
    }

    public send(operation: Record<string, unknown>): boolean {
        if (!this.welcomed || this.socket?.readyState !== WebSocket.OPEN) return false;
        try {
            this.socket.send(JSON.stringify(operation));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Client-triggered full resync (#766). Mirrors the server's `snapshot_required` control-frame
     * handler (see handleFrame): drop the socket, re-snapshot via onSnapshotRequired (which resets
     * the durable cursor to the snapshot's clean seq), then reconnect at delay 0. Used when the
     * client detects an unrecoverable local hazard in a LIVE journal frame — a `seq` that is not a
     * usable cursor value (NaN / non-integer / negative). Applying such a frame would poison the
     * durable cursor AND the ack sent to the server, so the client halts and re-snapshots instead
     * of a boundary drop (a drop would silently advance the cursor past the row — applyJournal has
     * no gap detection). On reconnect the client acks the CLEAN snapshot cursor, and because the
     * malformed frame was a live push (not part of the snapshot) a fresh snapshot does not
     * redeliver it: one malformed frame => one resync => recovered.
     *
     * Idempotent: a resync already in flight (replacingSnapshot), or a stopped connection, is a
     * no-op — so several malformed frames arriving back-to-back on one socket collapse into a
     * single re-snapshot rather than stacking sockets.
     */
    public async forceResync(): Promise<void> {
        if (this.stopped || this.replacingSnapshot) return;
        this.replacingSnapshot = true;
        // Drop the socket, then clear our reference deterministically. onclose also clears it (and,
        // because replacingSnapshot is set, suppresses its own reconnect — this method owns the
        // reconnect below), but clearing here removes the dependency on the async close event firing
        // before scheduleReconnect's open() runs; open() early-returns while this.socket is set. The
        // onclose `this.socket === socket` guard makes the later event a no-op. Await the re-snapshot
        // before reconnecting so hello carries the clean cursor, exactly as snapshot_required does.
        this.socket?.close(1000, "client resync");
        this.socket = undefined;
        try {
            await this.callbacks.onSnapshotRequired();
        } catch (error) {
            // A transient snapshot failure (offline, timeout, HTTP, storage) must NOT wedge the
            // connection socket-less with no retry timer. Swallow it and fall through to the
            // reconnect below, which resumes from the last good (still-clean) cursor — the client's
            // malformed-seq guard bounds a snapshot that keeps failing, so this cannot loop forever.
            console.warn("matron:resync", { event: "snapshot_failed" });
        } finally {
            this.replacingSnapshot = false;
        }
        // Reconnect on BOTH the success and the swallowed-failure path (unless stopped meanwhile).
        if (!this.stopped) this.scheduleReconnect(0);
    }

    /**
     * Operator-triggered reconnect (Settings / connection banner). Skips any pending backoff and
     * opens a socket now, resetting the backoff ladder so a later drop starts short again. A no-op
     * on a stopped connection, during a snapshot resync (which owns its own reconnect), or while a
     * welcomed socket is live. A socket that has not been welcomed yet is replaced.
     */
    public reconnectNow(): void {
        if (this.stopped || this.replacingSnapshot) return;
        if (this.socket) {
            // A welcomed socket (or one whose hello_ok is queued for processing) is healthy.
            if (this.welcomed || this.helloSocket === this.socket) return;
            // A socket still waiting for hello_ok may be stalled: detach and close it, then open a
            // fresh one. Its late close event is dropped by onclose's socket-identity guard, so
            // this never leaves two live sockets or a double-scheduled retry.
            const stale = this.socket;
            this.socket = undefined;
            this.clearWelcomeTimer();
            stale.close(1000, "manual reconnect");
        }
        if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.retryAttempt = 0;
        this.open();
    }

    public async agentRequest(
        agentDeviceId: number,
        method: string,
        params: unknown,
        timeoutMs = 30_000,
    ): Promise<RpcReply> {
        const requestId = this.makeId();
        if (this.pendingRpc.has(requestId)) {
            return { ok: false, origin: "relay", code: "duplicate_request_id" };
        }
        const operation = {
            op: "agent_request",
            request_id: requestId,
            agent_device_id: agentDeviceId,
            method,
            params,
        };
        if (!this.send(operation)) return { ok: false, origin: "relay", code: "not_connected" };

        return new Promise<RpcReply>((resolve) => {
            const timeoutTimer = window.setTimeout(() => {
                const pending = this.pendingRpc.get(requestId);
                if (!pending) return;
                if (pending.backoffTimer !== undefined) window.clearTimeout(pending.backoffTimer);
                this.pendingRpc.delete(requestId);
                resolve({ ok: false, origin: "timeout", code: "timeout" });
            }, timeoutMs);
            this.pendingRpc.set(requestId, {
                resolve,
                timeoutTimer,
                retriesLeft: 2,
                method,
                params,
                agentDeviceId,
            });
        });
    }

    private readonly onOnline = (): void => {
        if (!this.stopped && !this.socket) this.scheduleReconnect(0);
    };

    private readonly onOffline = (): void => {
        this.callbacks.onState("offline", "No network connection");
        this.socket?.close();
    };

    private open(): void {
        if (this.stopped || this.socket || !navigator.onLine) return;
        this.callbacks.onState("connecting");
        const socket = new WebSocket(websocketUrl(this.serverUrl));
        this.socket = socket;
        this.welcomed = false;
        this.clearWelcomeTimer();
        this.welcomeTimer = window.setTimeout(() => {
            this.welcomeTimer = undefined;
            if (this.socket === socket && !this.welcomed) socket.close(4000, "welcome timeout");
        }, WELCOME_TIMEOUT_MS);

        socket.onopen = () => {
            void this.callbacks
                .cursor()
                .then((cursor) => {
                    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
                    if (typeof cursor === "number") this.helloCursor.set(socket, cursor);
                    socket.send(
                        JSON.stringify({ op: "hello", token: this.token, cursor, max_replay: MAX_CLIENT_REPLAY }),
                    );
                })
                .catch((error) => {
                    this.callbacks.onState(
                        "offline",
                        error instanceof Error ? error.message : "Could not read sync cursor",
                    );
                    socket.close();
                });
        };

        socket.onmessage = (message) => {
            if (typeof message.data !== "string") return;
            this.ingestMessage(message.data, socket);
        };

        socket.onerror = () => {
            // The close event owns retry scheduling and carries a more useful state transition.
        };

        socket.onclose = (event) => {
            // #766: guard the ENTIRE handler by socket identity. forceResync clears this.socket and
            // reconnects at delay 0, so a superseded socket's (late) close event can fire after the
            // replacement socket is open and welcomed. Without this guard the stale close would set
            // the shared `welcomed` flag false and publish "connecting", disabling sends/acks on an
            // otherwise-live socket, and its scheduled retry would no-op (open() sees the new
            // socket). A stale close carries no state that applies to the current socket, so drop it.
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.welcomed = false;
            this.clearWelcomeTimer();
            if (this.stopped || this.replacingSnapshot) return;
            const reason = event.code === 1000 ? undefined : event.reason || "Connection interrupted";
            this.callbacks.onState(navigator.onLine ? "connecting" : "offline", reason);
            this.scheduleReconnect();
        };
    }

    private async handleFrame(frame: ServerFrame, socket: WebSocket): Promise<void> {
        if (frame.kind === "rpc") {
            const response: unknown = frame.response;
            if (typeof response !== "object" || response === null) {
                this.logRpcDiag("malformed_rpc");
                return;
            }
            const candidate = response as Record<string, unknown>;
            const requestId = typeof candidate.request_id === "string" ? candidate.request_id : undefined;
            if (
                requestId === undefined ||
                typeof candidate.ok !== "boolean" ||
                typeof candidate.agent_device_id !== "number" ||
                !Number.isFinite(candidate.agent_device_id)
            ) {
                this.logRpcDiag("malformed_rpc", requestId);
                return;
            }

            let errorCode: string | undefined;
            let errorDetail: string | undefined;
            if (!candidate.ok) {
                if (typeof candidate.error !== "object" || candidate.error === null) {
                    this.logRpcDiag("malformed_rpc", requestId);
                    return;
                }
                const error = candidate.error as Record<string, unknown>;
                if (typeof error.code !== "string" || error.code.length === 0) {
                    this.logRpcDiag("malformed_rpc", requestId);
                    return;
                }
                errorCode = error.code;
                errorDetail = typeof error.detail === "string" ? error.detail : undefined;
            }

            const pending = this.pendingRpc.get(requestId);
            if (!pending) return;
            if (candidate.agent_device_id !== pending.agentDeviceId) {
                this.logRpcDiag("malformed_rpc", requestId);
                return;
            }
            if (candidate.ok) {
                this.resolveRpc(requestId, pending, { ok: true, origin: "agent", result: candidate.result });
            } else {
                this.resolveRpc(requestId, pending, {
                    ok: false,
                    origin: "agent",
                    code: errorCode!,
                    detail: errorDetail,
                });
            }
            return;
        }

        if (
            frame.kind === "control" &&
            frame.op === "error" &&
            typeof frame.request_id === "string" &&
            this.pendingRpc.has(frame.request_id)
        ) {
            const requestId = frame.request_id;
            const pending = this.pendingRpc.get(requestId)!;
            const code = typeof frame.code === "string" && frame.code.length > 0 ? frame.code : "relay_error";
            const detail = typeof frame.detail === "string" ? frame.detail : undefined;
            if (code === "relay_error") this.logRpcDiag("malformed_control_error", requestId);

            if (code === "not_ready" && pending.retriesLeft > 0) {
                if (pending.backoffTimer !== undefined) return;
                pending.retriesLeft -= 1;
                pending.backoffTimer = window.setTimeout(() => {
                    pending.backoffTimer = undefined;
                    if (!this.pendingRpc.has(requestId)) return;
                    const sent = this.send({
                        op: "agent_request",
                        request_id: requestId,
                        agent_device_id: pending.agentDeviceId,
                        method: pending.method,
                        params: pending.params,
                    });
                    if (!sent) {
                        this.resolveRpc(requestId, pending, {
                            ok: false,
                            origin: "relay",
                            code: "not_connected",
                        });
                    }
                }, 1_000);
                return;
            }

            this.resolveRpc(requestId, pending, { ok: false, origin: "relay", code, detail });
            return;
        }

        if (frame.kind === "control") {
            if (frame.op === "hello_ok") {
                // A welcome drained from the queue after its socket was replaced belongs to a dead
                // socket: it must not mark the replacement online or clear its welcome deadline.
                if (socket !== this.socket) return;
                const helloCursor = this.helloCursor.get(socket);
                if (
                    helloCursor !== undefined &&
                    typeof frame.seq === "number" &&
                    frame.seq - helloCursor > MAX_CLIENT_REPLAY
                ) {
                    // A journal that ignored hello.max_replay is about to replay a gap too large to be
                    // worth it. Abandon this socket (its queued replay frames are dropped) and take the
                    // same path as the server's snapshot_required valve.
                    this.abandonedSocket = socket;
                    await this.resyncFromSnapshot(socket);
                    return;
                }
                this.welcomed = true;
                this.clearWelcomeTimer();
                this.retryAttempt = 0;
                this.callbacks.onState("online");
                await this.callbacks.onReady();
                return;
            }
            if (frame.op === "snapshot_required") {
                await this.resyncFromSnapshot(socket);
                return;
            }
            if (frame.op === "error" && frame.code === "revoked") {
                this.stopped = true;
                socket.close(1000, "device revoked");
                this.callbacks.onRevoked();
                return;
            }
        }
        if (frame.kind === "journal" && socket === this.abandonedSocket) return;
        await this.callbacks.onFrame(frame);
    }

    /**
     * Drop `socket`, re-snapshot, reconnect with the fresh cursor — the server's snapshot_required
     * valve and the client's own replay valve share it. A failed snapshot must not wedge the
     * connection: the socket's close event was swallowed while replacingSnapshot was set, so this
     * method owns the reconnect on both paths. After a failure it backs off (the retry ladder)
     * instead of reconnecting at once, since the same gap would just trip the valve again.
     */
    private async resyncFromSnapshot(socket: WebSocket): Promise<void> {
        this.replacingSnapshot = true;
        socket.close(1000, "replacing snapshot");
        // Detach now rather than waiting for the close event (as forceResync does): the reconnect
        // below must not find this socket still current, and onclose's identity guard then makes
        // the late event a no-op.
        if (this.socket === socket) {
            this.socket = undefined;
            this.welcomed = false;
            this.clearWelcomeTimer();
        }
        let failed = false;
        try {
            await this.callbacks.onSnapshotRequired();
        } catch (error) {
            failed = true;
            console.warn("matron:resync", { event: "snapshot_failed" });
            this.callbacks.onState("connecting", error instanceof Error ? error.message : "Sync failed");
        } finally {
            this.replacingSnapshot = false;
        }
        if (this.stopped) return;
        if (failed) this.scheduleReconnect();
        else this.scheduleReconnect(0);
    }

    private async handleJournalBatch(frames: JournalEvent[], socket: WebSocket): Promise<void> {
        if (socket === this.abandonedSocket) return;
        await this.callbacks.onJournalBatch!(frames);
    }

    private resolveRpc(
        requestId: string,
        pending: typeof this.pendingRpc extends Map<string, infer T> ? T : never,
        reply: RpcReply,
    ): void {
        window.clearTimeout(pending.timeoutTimer);
        if (pending.backoffTimer !== undefined) window.clearTimeout(pending.backoffTimer);
        this.pendingRpc.delete(requestId);
        pending.resolve(reply);
    }

    private isFastPathFrame(frame: unknown): frame is ServerFrame {
        if (typeof frame !== "object" || frame === null || !("kind" in frame)) return false;
        const candidate = frame as Record<string, unknown>;
        return (
            candidate.kind === "rpc" ||
            (candidate.kind === "control" &&
                candidate.op === "error" &&
                typeof candidate.request_id === "string" &&
                this.pendingRpc.has(candidate.request_id))
        );
    }

    private handleProcessingError(error: unknown, socket: WebSocket): void {
        this.callbacks.onState("offline", error instanceof Error ? error.message : "Sync failed");
        socket.close();
    }

    // Parse, runtime-decode, and dispatch one raw text frame (#753). Decoding
    // happens HERE, at the boundary, so a structurally-broken frame is dropped
    // (the caches keep their last good value) and a malformed ephemeral sub-shape
    // is stripped before it reaches the store — both with a diagnostic. A frame
    // that survives decoding takes the same fast-path / serialized-queue split as
    // before.
    private ingestMessage(raw: string, socket: WebSocket): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return;
        }

        const decoded = decodeServerFrame(parsed);
        if (!decoded.ok) {
            this.logFrameDiag(decoded.reason);
            return;
        }
        if (decoded.narrowed) this.logFrameDiag(`narrowed:${decoded.narrowed.join(",")}`);
        const frame = decoded.frame;

        if (frame.kind === "control" && frame.op === "hello_ok" && socket === this.socket) {
            this.helloSocket = socket;
            this.clearWelcomeTimer();
        }

        if (frame.kind === "journal" && this.callbacks.onJournalBatch) {
            const open = this.openJournalBatch;
            if (open && open.socket === socket && open.frames.length < MAX_JOURNAL_BATCH) {
                open.frames.push(frame);
                return;
            }
            const batch = { socket, frames: [frame] };
            this.openJournalBatch = batch;
            this.processing = this.processing
                .then(() => {
                    if (this.openJournalBatch === batch) this.openJournalBatch = undefined;
                    return this.handleJournalBatch(batch.frames, socket);
                })
                .catch((error) => this.handleProcessingError(error, socket));
            return;
        }
        if (this.isFastPathFrame(frame)) {
            void this.handleFrame(frame, socket).catch((error) => this.handleProcessingError(error, socket));
            return;
        }

        this.openJournalBatch = undefined;
        this.processing = this.processing
            .then(() => this.handleFrame(frame, socket))
            .catch((error) => this.handleProcessingError(error, socket));
    }

    private logFrameDiag(reason: string): void {
        console.warn("matron:frame", { reason });
    }

    private logRpcDiag(event: string, requestId?: string): void {
        console.warn("matron:rpc", { event, request_id: requestId });
    }

    private clearWelcomeTimer(): void {
        if (this.welcomeTimer !== undefined) window.clearTimeout(this.welcomeTimer);
        this.welcomeTimer = undefined;
    }

    private scheduleReconnect(delayOverride?: number): void {
        if (this.stopped || this.retryTimer !== undefined || !navigator.onLine) return;
        const baseDelay = delayOverride ?? RETRY_DELAYS_MS[Math.min(this.retryAttempt++, RETRY_DELAYS_MS.length - 1)];
        const delay = delayOverride === undefined ? Math.round(baseDelay * (0.8 + Math.random() * 0.4)) : baseDelay;
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = undefined;
            this.open();
        }, delay);
    }
}
