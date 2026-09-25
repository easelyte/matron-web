// design-sync shim for src/journal/connection.ts (bundle + previews only; the app is untouched).
// build-pkg.mjs swaps it into the package copy so nothing rendered in the claude.ai/design
// canvas can open the journal WebSocket. Same exported names as the real module; every method
// is an inert no-op and agent RPCs resolve to a relay failure. Keep in step with the real
// module's public surface (start / stop / send / forceResync / reconnectNow / agentRequest).
import type { ConnectionState, RpcReply, ServerFrame } from "./types";

interface JournalConnectionCallbacks {
    cursor(): Promise<number>;
    onFrame(frame: ServerFrame): Promise<void>;
    onReady(): Promise<void>;
    onSnapshotRequired(): Promise<void>;
    onRevoked(): void;
    onState(state: ConnectionState, error?: string): void;
}

export const WELCOME_TIMEOUT_MS = 20_000;

export class JournalConnection {
    public constructor(
        _serverUrl: string,
        _token: string,
        _callbacks: JournalConnectionCallbacks,
        _makeId: () => string = () => "",
    ) {}

    public start(): void {}

    public stop(): void {}

    public send(_operation: Record<string, unknown>): boolean {
        return false;
    }

    public async forceResync(): Promise<void> {}

    public reconnectNow(): void {}

    public async agentRequest(
        _agentDeviceId: number,
        _method: string,
        _params: unknown,
        _timeoutMs = 30_000,
    ): Promise<RpcReply> {
        return { ok: false, origin: "relay", code: "offline", detail: "design canvas: no journal connection" };
    }
}
