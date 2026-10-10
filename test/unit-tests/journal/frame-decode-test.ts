/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readFileSync } from "fs";
import { join } from "path";

import { JournalConnection } from "../../../src/journal/connection";
import { decodeServerFrame } from "../../../src/journal/frame-decode";

interface ProducerFixtures {
    valid: Array<{ name: string; source: string; frame: Record<string, unknown> }>;
    narrowing: Array<{ name: string; frame: Record<string, unknown>; expect: string[] }>;
    invalid: Array<{ name: string; value: unknown; reason: string }>;
}

const fixtures = JSON.parse(
    readFileSync(join(__dirname, "../../fixtures/frames/producer-frames.json"), "utf-8"),
) as ProducerFixtures;

describe("decodeServerFrame — producer conformance", () => {
    // Every real producer shape must decode cleanly with NO narrowing. A failure
    // here means either the decoder is wrong or a producer drifted — see
    // test/fixtures/frames/README.md.
    it.each(fixtures.valid.map((f) => [f.name, f] as const))("accepts %s unchanged", (_name, fixture) => {
        const result = decodeServerFrame(fixture.frame);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.narrowed).toBeUndefined();
        expect(result.frame).toEqual(fixture.frame);
    });
});

describe("decodeServerFrame — narrowing", () => {
    it.each(fixtures.narrowing.map((f) => [f.name, f] as const))(
        "strips the invalid sub-shape of %s",
        (_name, fixture) => {
            const result = decodeServerFrame(fixture.frame);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect([...(result.narrowed ?? [])].sort()).toEqual([...fixture.expect].sort());
        },
    );

    it("retains a valid sub-shape while dropping an invalid sibling", () => {
        const result = decodeServerFrame({
            kind: "ephemeral",
            convo_id: "c1",
            host_vitals: { cpu: 250, ram: 48, sampled_at_ms: 1 },
            activity: { state: "thinking" },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const frame = result.frame as { host_vitals?: unknown; activity?: unknown };
        expect(frame.host_vitals).toBeUndefined();
        expect(frame.activity).toEqual({ state: "thinking" });
    });

    it("keeps the rest of status when only vitals is malformed", () => {
        const result = decodeServerFrame({
            kind: "ephemeral",
            convo_id: "c1",
            status: { model: "claude-opus-4-8", vitals: { cpu_pct: "nope", ram_pct: 47, sampled_at_ms: 1 } },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const status = (result.frame as { status?: Record<string, unknown> }).status;
        expect(status?.model).toBe("claude-opus-4-8");
        expect(status?.vitals).toBeUndefined();
        expect(result.narrowed).toEqual(["status.vitals"]);
    });

    it("does not mutate the input frame", () => {
        const input = { kind: "ephemeral", convo_id: "c1", activity: { state: "spinning" } };
        decodeServerFrame(input);
        expect(input.activity).toEqual({ state: "spinning" });
    });
});

describe("decodeServerFrame — rejection", () => {
    it.each(fixtures.invalid.map((f) => [f.name, f] as const))("rejects %s", (_name, fixture) => {
        const result = decodeServerFrame(fixture.value);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe(fixture.reason);
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
    const internal = connection as unknown as ConnectionInternals;
    return { callbacks, connection, internal, socket };
}

describe("JournalConnection.ingestMessage — frame boundary", () => {
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

    it("drops a frame with an unrecognised discriminant and emits a diagnostic (cache keeps last good)", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(JSON.stringify({ kind: "wat", seq: 1 }), socket);
        await internal.processing;
        expect(callbacks.onFrame).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("matron:frame", { reason: "unknown_kind" });
    });

    it("does not reject a journal frame at the boundary — regression guard against re-adding the cursor-gap bug", async () => {
        // Regression guard: the decoder must NOT reject/drop journal frames.
        // Dropping a sequenced frame and continuing would advance the durable
        // cursor past it and lose the row permanently (applyJournal has no gap
        // detection). This asserts ONLY the boundary contract (frame forwarded,
        // no matron:frame diagnostic) — it does NOT claim malformed sequenced
        // frames are handled safely downstream. A malformed seq still poisons
        // last_seq/cursor exactly as on origin/main (pre-existing; robust handling
        // needs resync-based recovery, tracked separately). A well-formed seq is
        // used here so the test asserts the guard, not the latent issue.
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(
            JSON.stringify({
                kind: "journal",
                seq: 7,
                convo_id: "c1",
                ts: 1,
                sender: "a",
                type: "custom_type",
                payload: {},
            }),
            socket,
        );
        await internal.processing;
        expect(callbacks.onFrame).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalledWith("matron:frame", expect.anything());
    });

    it("drops an unparseable frame without throwing", () => {
        const { callbacks, internal, socket } = harness();
        expect(() => internal.ingestMessage("{not json", socket)).not.toThrow();
        expect(callbacks.onFrame).not.toHaveBeenCalled();
    });

    it("forwards a narrowed ephemeral frame with an invalid sub-shape stripped", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(
            JSON.stringify({
                kind: "ephemeral",
                convo_id: "c1",
                host_vitals: { cpu: 250, ram: 48, sampled_at_ms: 1 },
                activity: { state: "thinking" },
            }),
            socket,
        );
        await internal.processing;
        expect(warn).toHaveBeenCalledWith("matron:frame", { reason: "narrowed:host_vitals" });
        const forwarded = callbacks.onFrame.mock.calls[0][0] as { host_vitals?: unknown; activity?: unknown };
        expect(forwarded.host_vitals).toBeUndefined();
        expect(forwarded.activity).toEqual({ state: "thinking" });
    });

    it("passes a malformed rpc frame through to the existing rpc handler (no boundary rejection)", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { callbacks, internal, socket } = harness();
        internal.ingestMessage(JSON.stringify({ kind: "rpc", response: "not-an-object" }), socket);
        await internal.processing;
        // handleFrame owns rpc validation and logs its own diagnostic; the boundary
        // must NOT reject the frame (that would strand the pending request).
        expect(callbacks.onFrame).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("matron:rpc", { event: "malformed_rpc" });
        expect(warn).not.toHaveBeenCalledWith("matron:frame", expect.anything());
    });
});
