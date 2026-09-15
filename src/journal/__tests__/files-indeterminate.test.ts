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
        expect(copy).toMatch(/couldn't confirm whether this change was applied/i);
        expect(copy).toMatch(/refresh and check/i);
    });

    it("keeps the definite copy only where the server earned it", () => {
        // The journal's storage-side refusals (trash-write-failed / audit-fail-closed /
        // metadata-preserve-failed) all answer `denied`, and they really did refuse before touching
        // anything. That is the ONLY 507 allowed to claim nothing changed.
        expect(messageForFileStatus(507, "denied")).toMatch(/nothing was changed/i);
    });

    it("falls to ambiguity when the body is unreadable or the code is unknown", () => {
        // The failure this inverts: a truncated or non-JSON error body leaves `code` undefined, and
        // defaulting THAT to "nothing was changed" recreates the exact false certainty the branch
        // exists to remove — a 507 from an intermediary may already have let the write through.
        for (const code of [undefined, "", "some-future-reason", "indeterminate"]) {
            expect(messageForFileStatus(507, code)).not.toMatch(/nothing was changed/i);
            expect(messageForFileStatus(507, code)).toMatch(/refresh and check/i);
        }
    });

    it("does not let a response body rename its own status", () => {
        // `timeout` is minted locally and always with status 0. Once server-supplied `error` strings
        // reach this helper, honouring the code first would let a 401 carrying {"error":"timeout"}
        // read as a slow load rather than an expired session, and invite a futile retry.
        expect(messageForFileStatus(0, "timeout")).toMatch(/took too long/i);
        expect(messageForFileStatus(401, "timeout")).toMatch(/session expired/i);
        expect(messageForFileStatus(403, "timeout")).toMatch(/can't be accessed/i);
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
                expect(api_error.message).toMatch(/refresh and check/i);
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

describe("no delete reaches the wire unkeyed", () => {
    it("mints a key when the caller supplies none", async () => {
        // The UI hook always passes one, but `FilesApi` is exported: a future consumer omitting the
        // option should not silently get the old unprotected behaviour back.
        const fetchMock = jest
            .fn()
            .mockResolvedValue(reply(200, { path: "/w/notes.md", trashed: null, already_missing: true }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const api = new FilesApi("https://journal.example", "tok");
        await api.deleteEntry("/w/notes.md", { confirm: true });

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const key = (init.headers as Record<string, string>)["Idempotency-Key"];
        expect(typeof key).toBe("string");
        expect(key).not.toBe("");
    });
});
