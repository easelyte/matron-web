/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { FilesApi, messageForFileStatus } from "../files/filesApi";
import { JournalApiError } from "../api";

/**
 * A minimal stand-in for `Response`: jsdom does not provide the global, and the client only ever
 * reads `status`, `clone().text()` on the error path, and `arrayBuffer()` on the success path.
 */
function reply(status: number, body: unknown): unknown {
    const text = JSON.stringify(body);
    return {
        status,
        clone: () => ({ text: async () => text }),
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
}

/**
 * 507 means two opposite things, and the client used to say the same sentence for both.
 *
 * The journal raises a bare 507 from its write-ahead gates, where the operation provably did not
 * happen. It raises `{"error":"indeterminate"}` when it reserved an operation durably, lost the
 * process executing it, and cannot prove from the filesystem whether the mutation landed. Telling
 * an operator "Nothing was changed" in the second case is not a vague message, it is a false one —
 * and the thing they would reasonably do next, having been told that, is exactly the thing that
 * makes a delete happen twice.
 */
describe("an indeterminate outcome does not claim nothing changed", () => {
    it("names the doubt and points at the listing", () => {
        const copy = messageForFileStatus(507, "indeterminate");
        expect(copy).not.toMatch(/nothing was changed/i);
        expect(copy).toMatch(/can't tell whether it was applied/i);
        expect(copy).toMatch(/refresh/i);
    });

    it("leaves the write-ahead 507 saying exactly what it said before", () => {
        // A bare 507 from the gate really does prove non-mutation, and that copy is correct.
        expect(messageForFileStatus(507)).toMatch(/nothing was changed/i);
        expect(messageForFileStatus(507, "storage")).toMatch(/nothing was changed/i);
    });

    it("carries the honest copy on the thrown error, not just at the render site", () => {
        // The discriminator was parsed off the body and then dropped when the message was built, so
        // anything reading `error.message` directly got the wrong sentence.
        const fetchMock = jest
            .fn()
            .mockResolvedValue(reply(507, { error: "indeterminate", outcome: "unknown", retryable: false }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const api = new FilesApi("https://journal.example", "tok");
        return api.deleteEntry("/w/notes.md", { confirm: true, idempotencyKey: "k1" }).then(
            () => {
                throw new Error("expected the delete to reject");
            },
            (error: unknown) => {
                expect(error).toBeInstanceOf(JournalApiError);
                const api_error = error as JournalApiError;
                expect(api_error.status).toBe(507);
                expect(api_error.code).toBe("indeterminate");
                expect(api_error.message).not.toMatch(/nothing was changed/i);
            },
        );
    });
});

describe("DELETE carries an Idempotency-Key", () => {
    it("puts the key on the wire, so a lost response replays instead of deleting again", async () => {
        // The journal's delete route has run under `withIdempotency` since Phase 2. This was the one
        // write not sending a key, which made every retry a fresh execution — and if another actor
        // had recreated the path in the gap, it deleted the REPLACEMENT.
        const fetchMock = jest
            .fn()
            .mockResolvedValue(
                reply(200, { path: "/w/notes.md", trashed: ".matron-trash/notes.md", already_missing: false }),
            );
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const api = new FilesApi("https://journal.example", "tok");
        await api.deleteEntry("/w/notes.md", { confirm: true, idempotencyKey: "delete-key-1" });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(String(url)).toContain("/files?");
        expect(init.method).toBe("DELETE");
        expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("delete-key-1");
    });
});
