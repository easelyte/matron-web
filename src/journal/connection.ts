/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type ConnectionState, type RpcReply, type ServerFrame, websocketUrl } from "./types";

interface JournalConnectionCallbacks {
    cursor(): Promise<number>;
    onFrame(frame: ServerFrame): Promise<void>;
    onReady(): Promise<void>;
    onSnapshotRequired(): Promise<void>;
    onRevoked(): void;
    onState(state: ConnectionState, error?: string): void;
}

const RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export class JournalConnection {
    private socket?: WebSocket;
    private retryTimer?: number;
    private retryAttempt = 0;
    private stopped = true;
    private welcomed = false;
    private replacingSnapshot = false;
    private processing = Promise.resolve();
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

    public async agentRequest(
        agentDeviceId: number,
        method: string,
        params: unknown,
        timeoutMs = 30_000,
        makeId = (): string => crypto.randomUUID(),
    ): Promise<RpcReply> {
        const requestId = makeId();
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

        socket.onopen = () => {
            void this.callbacks
                .cursor()
                .then((cursor) => {
                    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
                    socket.send(JSON.stringify({ op: "hello", token: this.token, cursor }));
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
            this.processing = this.processing
                .then(async () => {
                    let frame: ServerFrame;
                    try {
                        frame = JSON.parse(message.data) as ServerFrame;
                    } catch {
                        return;
                    }
                    await this.handleFrame(frame, socket);
                })
                .catch((error) => {
                    this.callbacks.onState("offline", error instanceof Error ? error.message : "Sync failed");
                    socket.close();
                });
        };

        socket.onerror = () => {
            // The close event owns retry scheduling and carries a more useful state transition.
        };

        socket.onclose = (event) => {
            if (this.socket === socket) this.socket = undefined;
            this.welcomed = false;
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
                this.welcomed = true;
                this.retryAttempt = 0;
                this.callbacks.onState("online");
                await this.callbacks.onReady();
                return;
            }
            if (frame.op === "snapshot_required") {
                this.replacingSnapshot = true;
                socket.close(1000, "replacing snapshot");
                try {
                    await this.callbacks.onSnapshotRequired();
                } finally {
                    this.replacingSnapshot = false;
                }
                this.scheduleReconnect(0);
                return;
            }
            if (frame.op === "error" && frame.code === "revoked") {
                this.stopped = true;
                socket.close(1000, "device revoked");
                this.callbacks.onRevoked();
                return;
            }
        }
        await this.callbacks.onFrame(frame);
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

    private logRpcDiag(event: string, requestId?: string): void {
        console.warn("matron:rpc", { event, request_id: requestId });
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
