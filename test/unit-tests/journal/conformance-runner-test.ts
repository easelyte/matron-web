/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// The conformance runner's test hook, without a server: frames go through the app's
// decoder, store and notifier, and `expect_model` / `expect_notification` report what
// the app did. (The fixtures themselves replay under the coordinator: `pnpm conformance`.)

import { createClientRunner } from "../../conformance/client-runner";
import { match } from "../../conformance/matcher";

function journalFrame(seq: number, type: string, payload: Record<string, unknown>) {
    return {
        kind: "journal",
        seq,
        convo_id: "c1",
        ts: Date.now(),
        sender: "agent:box-a",
        type,
        payload,
    };
}

describe("conformance matcher", () => {
    it("binds, refs, types and ignores, and rejects an extra key", () => {
        const bindings: Record<string, unknown> = {};
        expect(
            match(
                { a: { $bind: "x" }, b: { $type: "integer" }, c: { $ignore: true } },
                { a: "v", b: 1, c: null },
                bindings,
            ).ok,
        ).toBe(true);
        expect(bindings.x).toBe("v");
        expect(match({ a: { $ref: "x" } }, { a: "v" }, bindings).ok).toBe(true);
        expect(match({ a: 1 }, { a: 1, extra: 2 }, bindings).ok).toBe(false);
    });
});

describe("conformance client runner hook", () => {
    it("reports the model after a journal row and tool stream frames", async () => {
        const runner = createClientRunner({ base: "http://127.0.0.1:1" });
        await runner.deliver(journalFrame(1, "text", { body: "hello" }));
        await runner.deliver({
            kind: "ephemeral",
            convo_id: "c1",
            message_ref: "tu1",
            tool_stream: { event: "append", offset: 0, chunk: "$ make\n" },
        });
        const model = await runner.modelReport();
        expect(model.cursor).toBe(1);
        expect(model.events).toEqual({ c1: [{ seq: 1, type: "text", sender: "agent:box-a" }] });
        const step = {
            kind: "expect_model",
            role: "client",
            expect: {
                cursor: 1,
                app: "foreground",
                muted: false,
                conversations: { $type: "array" },
                events: { c1: [{ seq: 1, type: "text", sender: "agent:box-a" }] },
                tool_streams: { c1: { tu1: { $ignore: true } } },
                activities: {},
            },
        };
        await expect(runner.run(step, {})).resolves.toBeDefined();
        await runner.close();
    });

    it("fails expect_model on an assertion when the model differs", async () => {
        const runner = createClientRunner({ base: "http://127.0.0.1:1" });
        await runner.deliver(journalFrame(1, "text", { body: "hello" }));
        await expect(runner.run({ kind: "expect_model", role: "client", expect: { cursor: 2 } }, {})).rejects.toThrow(
            /model/,
        );
        await runner.close();
    });

    it("reports a notification for a prompt and none for plain agent text", async () => {
        const runner = createClientRunner({ base: "http://127.0.0.1:1" });
        await runner.deliver(journalFrame(1, "prompt", { body: "Proceed?", options: ["yes", "no"] }));
        await expect(
            runner.run(
                {
                    kind: "expect_notification",
                    role: "client",
                    expect: {
                        shown: true,
                        convo_id: "c1",
                        seq: 1,
                        title: { $type: "string" },
                        body: { $type: "string" },
                        silent: { $type: "boolean" },
                    },
                },
                {},
            ),
        ).resolves.toBeDefined();
        await runner.run({ kind: "set_app_state", role: "client", app: "background" }, {});
        await runner.deliver(journalFrame(2, "text", { body: "working" }));
        await expect(
            runner.run(
                { kind: "expect_notification", role: "client", expect: { shown: false, convo_id: "c1", seq: 2 } },
                {},
            ),
        ).resolves.toBeDefined();
        await expect(
            runner.run({ kind: "expect_model", role: "client", expect: { app: { $ref: "none" } } }, {}),
        ).rejects.toThrow();
        await runner.close();
    });

    it("drops a frame the decoder rejects, so the store never sees it", async () => {
        const runner = createClientRunner({ base: "http://127.0.0.1:1" });
        expect(await runner.deliver({ no: "kind" })).toBeUndefined();
        await runner.close();
    });
});
