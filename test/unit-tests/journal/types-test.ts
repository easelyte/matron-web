/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    endpointUrl,
    enforceToolLogTtl,
    eventSnippet,
    normalizeServerUrl,
    websocketUrl,
} from "../../../src/journal/types";

describe("matron-journal wire helpers", () => {
    it("normalizes secure and loopback server URLs", () => {
        expect(normalizeServerUrl("chat.example.com/")).toBe("https://chat.example.com");
        expect(normalizeServerUrl("http://127.0.0.1:9810/")).toBe("http://127.0.0.1:9810");
        expect(normalizeServerUrl("/journal")).toBe("http://localhost/journal");
        expect(() => normalizeServerUrl("http://chat.example.com")).toThrow("Use HTTPS");
        expect(() => normalizeServerUrl("https://user:secret@chat.example.com")).toThrow("cannot contain credentials");
    });

    it("preserves a reverse-proxy path for HTTP and WebSocket endpoints", () => {
        expect(endpointUrl("https://example.com/journal", "/snapshot").href).toBe(
            "https://example.com/journal/snapshot",
        );
        expect(endpointUrl("https://example.com/journal", "/convo/c1/messages?limit=80").href).toBe(
            "https://example.com/journal/convo/c1/messages?limit=80",
        );
        expect(websocketUrl("https://example.com/journal")).toBe("wss://example.com/journal/ws");
    });

    it("drops locally cached live output after the binding 24 hour TTL", () => {
        const event = {
            kind: "journal" as const,
            seq: 1,
            convo_id: "c1",
            ts: 1_000,
            sender: "agent:dev",
            type: "tool_output",
            payload: { live_log: true, snippet: "secret output", blob_ref: "blob-1", command: "make" },
        };
        const expired = enforceToolLogTtl(event, event.ts + 24 * 60 * 60 * 1000);
        expect(expired.payload).toMatchObject({ expired: true, blob_ref: null, command: "make" });
        expect(expired.payload).not.toHaveProperty("snippet");
    });
});

describe("eventSnippet captions", () => {
    it("prefers the caption over the filename for image and file snippets", () => {
        expect(eventSnippet("image", { filename: "shot.png", caption: "what is wrong here?" })).toBe(
            "🖼 what is wrong here?",
        );
        expect(eventSnippet("file", { filename: "notes.txt", caption: "read this first" })).toBe("📎 read this first");
    });

    it("falls back to the filename when no caption is present", () => {
        expect(eventSnippet("image", { filename: "shot.png" })).toBe("🖼 shot.png");
        expect(eventSnippet("file", { filename: "notes.txt", caption: "" })).toBe("📎 notes.txt");
    });
});
