/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Not a unit test: the stdio side of the conformance runner, run under jest
// (jest.conformance.config.cjs) so the app's code loads exactly as it does in its tests.
// The replay coordinator speaks newline-delimited JSON on stdin and stdout:
//   in  {"op":"init","base":...}  out {"op":"ready","capabilities":[...]}
//   in  {"op":"step","id","step","bindings"}  out {"id","ok","bindings"|"error"}
//   in  {"op":"close"}
// stdout is written with fs.writeSync so jest's console capture cannot touch it.

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { CLIENT_CAPABILITIES, createClientRunner, type FixtureStep } from "./client-runner";

interface Message {
    op: string;
    id?: number;
    base?: string;
    step?: FixtureStep;
    bindings?: Record<string, unknown>;
}

function send(message: unknown): void {
    writeSync(1, JSON.stringify(message) + "\n");
}

it("runs as a conformance runner until the coordinator closes it", async () => {
    let runner: ReturnType<typeof createClientRunner> | undefined;
    // Steps run one at a time, in the order the coordinator sent them.
    let queue: Promise<void> = Promise.resolve();
    await new Promise<void>((finished) => {
        const lines = createInterface({ input: process.stdin });
        lines.on("line", (line) => {
            const message = JSON.parse(line) as Message;
            queue = queue.then(async () => {
                if (message.op === "init") {
                    runner = createClientRunner({ base: message.base as string });
                    send({ op: "ready", capabilities: CLIENT_CAPABILITIES });
                } else if (message.op === "step" && runner) {
                    try {
                        const result = await runner.run(message.step as FixtureStep, message.bindings ?? {});
                        send({ id: message.id, ok: true, bindings: result.bindings, observed: result.observed });
                    } catch (error) {
                        send({
                            id: message.id,
                            ok: false,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                } else if (message.op === "close") {
                    await runner?.close();
                    lines.close();
                    finished();
                }
            });
        });
        lines.on("close", () => finished());
    });
});
