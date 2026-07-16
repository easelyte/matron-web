/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError } from "../../../src/journal/api";

const fetchMock = jest.fn();

function jsonResponse(body: unknown): Pick<Response, "status" | "headers" | "arrayBuffer"> {
    const encoded = new NodeTextEncoder().encode(JSON.stringify(body));
    return {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        arrayBuffer: async () => encoded.buffer,
    };
}

describe("JournalApi uploadMedia", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("returns a structurally valid media response", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ media_id: "media-1", size: 3, content_type: "image/png" }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.uploadMedia(new ArrayBuffer(3), "image/png")).resolves.toEqual({
            media_id: "media-1",
            size: 3,
            content_type: "image/png",
        });
    });

    it.each([
        ["an object with no fields", {}],
        ["a null media id", { media_id: null, size: 3, content_type: "image/png" }],
        ["a blank media id", { media_id: "  ", size: 3, content_type: "image/png" }],
        ["a missing size", { media_id: "media-1", content_type: "image/png" }],
        ["a non-number size", { media_id: "media-1", size: "3", content_type: "image/png" }],
        ["a missing content type", { media_id: "media-1", size: 3 }],
        ["a non-string content type", { media_id: "media-1", size: 3, content_type: null }],
    ])("rejects a successful response containing %s", async (_description, body) => {
        fetchMock.mockResolvedValue(jsonResponse(body));
        const api = new JournalApi("https://journal.example", "token");

        const upload = api.uploadMedia(new ArrayBuffer(3), "image/png");

        await expect(upload).rejects.toBeInstanceOf(JournalApiError);
        await expect(upload).rejects.toMatchObject({ status: 200 });
    });
});
