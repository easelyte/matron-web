/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type ConnectionState, type ServerFrame, websocketUrl } from "./types";

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
        this.callbacks.onState("offline");
    }

    public send(operation: Record<string, unknown>): boolean {
        if (!this.welcomed || this.socket?.readyState !== WebSocket.OPEN) return false;
        this.socket.send(JSON.stringify(operation));
        return true;
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
