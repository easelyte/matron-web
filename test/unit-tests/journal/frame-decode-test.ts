/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readFileSync } from "fs";
import { join } from "path";

import { JournalConnection } from "../../../src/journal/connection";
import { decodeServerFrame } from "../../../src/journal/frame-decode";

interface FrameFixtures {
    valid: Array<{ name: string; frame: Record<string, unknown> }>;
    narrowing: Array<{ name: string; frame: Record<string, unknown>; expect: string[] }>;
    invalid: Array<{ name: string; value: unknown; reason: string }>;
}

const fixtures = JSON.parse(
    readFileSync(join(__dirname, "../../fixtures/frames/producer-frames.json"), "utf-8"),
) as FrameFixtures;

describe("decodeServerFrame: conformance fixtures", () => {
    it.each(fixtures.valid.map((f) => [f.name, f] as const))("accepts %s unchanged", (_name, fixture) => {
        const result = decodeServerFrame(fixture.frame);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.narrowed).toBeUndefined();
        expect(result.frame).toEqual(fixture.frame);
    });

    it.each(fixtures.narrowing.map((f) => [f.name, f] as const))(
        "strips the invalid sub-shape of %s",
        (_name, fixture) => {
            const result = decodeServerFrame(fixture.frame);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect([...(result.narrowed ?? [])].sort()).toEqual([...fixture.expect].sort());
        },
    );

    it.each(fixtures.invalid.map((f) => [f.name, f] as const))("rejects %s", (_name, fixture) => {
        const result = decodeServerFrame(fixture.value);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe(fixture.reason);
    });
});

describe("decodeServerFrame: narrowing", () => {
    it("keeps a valid sibling while dropping an invalid sub-shape", () => {
        const result = decodeServerFrame({
            kind: "ephemeral",
            convo_id: "c1",
            status: { model: "m", vitals: { cpu_pct: 250, ram_pct: null, sampled_at_ms: 1 } },
            activity: { state: "thinking" },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const frame = result.frame as { status?: Record<string, unknown>; activity?: unknown };
        expect(frame.status?.model).toBe("m");
        expect(frame.status?.vitals).toBeUndefined();
        expect(frame.activity).toEqual({ state: "thinking" });
        expect(result.narrowed).toEqual(["status.vitals"]);
    });

    it("keeps the valid reading of a vitals object and nulls the bad one", () => {
        const result = decodeServerFrame({
            kind: "ephemeral",
            convo_id: "c1",
            status: { vitals: { cpu_pct: 250, ram_pct: 48, sampled_at_ms: 1 } },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const frame = result.frame as { status?: { vitals?: unknown } };
        expect(frame.status?.vitals).toEqual({ cpu_pct: null, ram_pct: 48, sampled_at_ms: 1 });
        expect(result.narrowed).toEqual(["status.vitals"]);
    });

    it("strips a host_vitals push with an out-of-range percentage and keeps the rest of the frame", () => {
        const result = decodeServerFrame({
            kind: "ephemeral",
            host_vitals: { cpu: 250, ram: 48, sampled_at_ms: 1 },
            activity: { state: "thinking" },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.narrowed).toEqual(["host_vitals"]);
        const frame = result.frame as { host_vitals?: unknown; activity?: unknown };
        expect(frame.host_vitals).toBeUndefined();
        expect(frame.activity).toEqual({ state: "thinking" });
    });

    it("keeps a well-formed host_vitals push", () => {
        const result = decodeServerFrame({ kind: "ephemeral", host_vitals: { cpu: 12, ram: 48, sampled_at_ms: 1 } });
        expect(result.ok && result.narrowed).toBeFalsy();
    });

    it("passes a frame of a kind it does not know, and says so", () => {
        const frame = { kind: "wat", anything: 1 };
        expect(decodeServerFrame(frame)).toEqual({ ok: true, frame, unknownKind: "wat" });
    });

    it("does not mutate the input frame", () => {
        const input = { kind: "ephemeral", convo_id: "c1", activity: { state: "spinning" } };
        decodeServerFrame(input);
        expect(input.activity).toEqual({ state: "spinning" });
    });

    it("passes a journal row through unvalidated, so the cursor logic sees every sequenced row", () => {
        const row = { kind: "journal", seq: "x", convo_id: "c1", ts: 1, sender: "a", type: "text", payload: {} };
        const result = decodeServerFrame(row);
        expect(result).toEqual({ ok: true, frame: row });
    });
});

interface ConnectionInternals {
    ingestMessage(raw: string, socket: WebSocket): void;
    processing: Promise<void>;
}

function harness() {
    const callbacks = {
        cursor: jest.fn().mockResolvedValue(0),
        onFrame: jest.fn().mockResolvedValue(undefined),
        onReady: jest.fn().mockResolvedValue(undefined),
        onSnapshotRequired: jest.fn().mockResolvedValue(undefined),
        onRevoked: jest.fn(),
        onState: jest.fn(),
    };
    const connection = new JournalConnection("https://journal.example", "token", callbacks, () => "request-1");
    const socket = { close: jest.fn() } as unknown as WebSocket;
    return { callbacks, internal: connection as unknown as ConnectionInternals, socket };
}

describe("JournalConnection.ingestMessage", () => {
    afterEach(() => jest.restoreAllMocks());

    it("forwards a valid journal frame to onFrame", async () => {
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(
            JSON.stringify({ kind: "journal", seq: 1, convo_id: "c1", ts: 1, sender: "a", type: "text", payload: {} }),
            socket,
        );
        await internal.processing;
        expect(callbacks.onFrame).toHaveBeenCalledTimes(1);
    });

    it("forwards a notify frame, which notification settings sync relies on", async () => {
        const { callbacks, internal, socket } = harness();
        const notify = { kind: "notify", settings: { mode: "smart", events: { permission: true } } };
        internal.ingestMessage(JSON.stringify(notify), socket);
        await internal.processing;
        expect(callbacks.onFrame).toHaveBeenCalledWith(notify);
    });

    it("forwards a frame of an unrecognised kind to the listeners and logs a diagnostic", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        const frame = { kind: "wat", seq: 1 };
        internal.ingestMessage(JSON.stringify(frame), socket);
        await internal.processing;
        expect(callbacks.onFrame).toHaveBeenCalledWith(frame);
        expect(warn).toHaveBeenCalledWith("matron:frame", { reason: "unknown_kind:wat" });
    });

    it("drops a frame with no kind and logs a diagnostic", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(JSON.stringify({ seq: 1 }), socket);
        await internal.processing;
        expect(callbacks.onFrame).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("matron:frame", { reason: "no_kind" });
    });

    it("forwards a vitals object that has one null reading intact", async () => {
        const { callbacks, internal, socket } = harness();
        const frame = {
            kind: "ephemeral",
            convo_id: "c1",
            status: { vitals: { cpu_pct: null, ram_pct: 40, sampled_at_ms: 5 } },
        };
        internal.ingestMessage(JSON.stringify(frame), socket);
        await internal.processing;
        expect(callbacks.onFrame).toHaveBeenCalledWith(frame);
    });

    it("drops an unparseable frame without throwing", () => {
        const { callbacks, internal, socket } = harness();
        expect(() => internal.ingestMessage("{not json", socket)).not.toThrow();
        expect(callbacks.onFrame).not.toHaveBeenCalled();
    });

    it("forwards an ephemeral frame with the invalid sub-shape stripped", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(
            JSON.stringify({
                kind: "ephemeral",
                convo_id: "c1",
                status: { limits: [null] },
                activity: { state: "thinking" },
            }),
            socket,
        );
        await internal.processing;
        expect(warn).toHaveBeenCalledWith("matron:frame", { reason: "narrowed:status.limits" });
        const forwarded = callbacks.onFrame.mock.calls[0][0] as {
            status?: Record<string, unknown>;
            activity?: unknown;
        };
        expect(forwarded.status?.limits).toBeUndefined();
        expect(forwarded.activity).toEqual({ state: "thinking" });
    });

    it("leaves a malformed rpc frame to the existing rpc handler", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(JSON.stringify({ kind: "rpc", response: "not-an-object" }), socket);
        await internal.processing;
        expect(callbacks.onFrame).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("matron:rpc", { event: "malformed_rpc" });
        expect(warn).not.toHaveBeenCalledWith("matron:frame", expect.anything());
    });
});
