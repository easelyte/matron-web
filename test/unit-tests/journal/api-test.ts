/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError } from "../../../src/journal/api";

const fetchMock = jest.fn();

function jsonResponse(body: unknown, status = 200): Pick<Response, "status" | "headers" | "arrayBuffer"> {
    const encoded = new NodeTextEncoder().encode(JSON.stringify(body));
    return {
        status,
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

    it("sends the bytes and content type verbatim and returns a structurally valid media response", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ media_id: "media-1", size: 3, content_type: "image/png" }));
        const api = new JournalApi("https://journal.example", "token");
        const bytes = new Uint8Array([1, 2, 3]).buffer;

        await expect(api.uploadMedia(bytes, "image/png")).resolves.toEqual({
            media_id: "media-1",
            size: 3,
            content_type: "image/png",
        });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/media");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    Authorization: "Bearer token",
                    "Content-Type": "image/png",
                }),
            }),
        );
        expect(fetchMock.mock.calls[0][1].body).toBe(bytes);
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

    it.each([
        [413, "too_large", "File too large."],
        [400, "empty", "That file is empty."],
    ])("maps HTTP %i code %s to prose", async (status, code, message) => {
        fetchMock.mockResolvedValue(jsonResponse({ error: code }, status));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.uploadMedia(new ArrayBuffer(1), "application/octet-stream")).rejects.toMatchObject({
            message,
            status,
            code,
        });
    });

    it("forwards the abort signal to fetch and rejects when it is aborted", async () => {
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener(
                        "abort",
                        () => reject(new DOMException("The operation was aborted.", "AbortError")),
                        { once: true },
                    );
                }),
        );
        const api = new JournalApi("https://journal.example", "token");
        const controller = new AbortController();

        const upload = api.uploadMedia(new ArrayBuffer(1), "application/octet-stream", controller.signal);
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: controller.signal }));
        controller.abort();

        await expect(upload).rejects.toMatchObject({ name: "Error", message: "The operation was aborted." });
    });

    it("rejects binary requests in Electron before issuing a POST", async () => {
        const journalRequest = jest.fn();
        (window as Window & { electron?: unknown }).electron = {
            initialise: jest.fn(),
            journalRequest,
        };
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.uploadMedia(new ArrayBuffer(1), "application/octet-stream")).rejects.toMatchObject({
            message: "Attachments aren't supported in the desktop build yet.",
            code: "electron_binary_unsupported",
        });
        expect(journalRequest).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
