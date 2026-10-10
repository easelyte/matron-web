/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    endpointUrl,
    enforceToolLogTtl,
    eventSnippet,
    fileKindFromMime,
    IMAGE_FRAME_MAX_HEIGHT_PX,
    imageFrameStyle,
    MESSAGE_EVENT_TYPES,
    normalizeServerUrl,
    parseMediaDims,
    websocketUrl,
} from "../../../src/journal/types";

describe("matron-journal media payload helpers (§6)", () => {
    it("parses positive dims and rejects absent / non-positive / malformed", () => {
        expect(parseMediaDims({ width: 1200, height: 800 })).toEqual({ width: 1200, height: 800 });
        expect(parseMediaDims(undefined)).toBeUndefined();
        expect(parseMediaDims(null)).toBeUndefined();
        expect(parseMediaDims({})).toBeUndefined();
        expect(parseMediaDims({ width: 0, height: 800 })).toBeUndefined();
        expect(parseMediaDims({ width: 100, height: -1 })).toBeUndefined();
        expect(parseMediaDims({ width: "1200", height: "800" })).toBeUndefined();
        expect(parseMediaDims({ width: Number.NaN, height: 10 })).toBeUndefined();
    });

    it("pre-shrinks the reserved image frame width so the height cap preserves aspect ratio", () => {
        const cap = IMAGE_FRAME_MAX_HEIGHT_PX;
        // Short: natural height at intrinsic width is under the cap (400 < 520) → width unchanged.
        expect(imageFrameStyle({ width: 1200, height: 400 })).toEqual({
            aspectRatio: "1200 / 400",
            width: 1200,
        });
        // Landscape but tall enough to exceed the cap (800 > 520) → width shrinks to keep the ratio.
        expect(imageFrameStyle({ width: 1200, height: 800 })).toEqual({
            aspectRatio: "1200 / 800",
            width: 1200 * (cap / 800), // 780 at cap=520 → 780×520 (ratio 1.5 preserved)
        });
        // Portrait: height would blow past the cap → width shrinks so the capped height keeps ratio
        // (a non-replaced <div> won't back-shrink on its own — this is the bug the reserve box hit).
        expect(imageFrameStyle({ width: 1000, height: 2000 })).toEqual({
            aspectRatio: "1000 / 2000",
            width: 1000 * (cap / 2000), // 260 at cap=520 → 260×520, not 1000×520
        });
        // Square past the cap also shrinks (1:1 at column width still exceeds max-height).
        expect(imageFrameStyle({ width: 1000, height: 1000 })).toEqual({
            aspectRatio: "1000 / 1000",
            width: cap, // 520×520
        });
        // The shrunk width, times the aspect ratio, never exceeds the height cap.
        const p = imageFrameStyle({ width: 300, height: 1800 });
        expect(p.width * (1800 / 300)).toBeLessThanOrEqual(cap + 1e-9);
    });

    it("buckets MIME types into file kinds, falling back to generic", () => {
        expect(fileKindFromMime("image/png")).toBe("image");
        expect(fileKindFromMime("application/pdf")).toBe("pdf");
        expect(fileKindFromMime("text/plain")).toBe("text");
        expect(fileKindFromMime("audio/mpeg")).toBe("audio");
        expect(fileKindFromMime("video/mp4")).toBe("video");
        expect(fileKindFromMime("application/zip")).toBe("archive");
        expect(fileKindFromMime("application/x-tar")).toBe("archive");
        expect(fileKindFromMime("APPLICATION/PDF")).toBe("pdf");
        expect(fileKindFromMime("application/octet-stream")).toBe("generic");
        expect(fileKindFromMime("")).toBe("generic");
        expect(fileKindFromMime(undefined)).toBe("generic");
        expect(fileKindFromMime(42)).toBe("generic");
    });
});

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
    it("uses the peer message body instead of a type placeholder", () => {
        expect(eventSnippet("peer_message", { body: "Coordinate the deploy window" })).toBe(
            "Coordinate the deploy window",
        );
    });

    it("removes control and bidi format characters from peer message snippets", () => {
        const snippet = eventSnippet("peer_message", { body: "safe\ntext\u202elive\u202cend\u2067now\u2069" });
        expect(snippet).toBe("safe text live end now");
        expect(snippet).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    });

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

    it("labels a generic permission_request with its description", () => {
        expect(eventSnippet("permission_request", { description: "Restart nginx on prod?" })).toBe(
            "Permission: Restart nginx on prod?",
        );
    });

    it("labels an agent_spawn permission_request with a fixed sidebar snippet, byte-exact with the server's own copy", () => {
        // Not derived from topic/task — the server mints this same literal string into the
        // snapshot snippet, and a locally-derived variant would flip-flop the sidebar row
        // across a resume.
        expect(
            eventSnippet("permission_request", {
                kind: "agent_spawn",
                topic: "Flake hunt",
                task: "Run the suite and fix flakes",
            }),
        ).toBe("🤝 Agent spawn request");
        expect(eventSnippet("permission_request", { kind: "agent_spawn", task: "Line one\nLine two" })).toBe(
            "🤝 Agent spawn request",
        );
    });
});

describe("MESSAGE_EVENT_TYPES", () => {
    it("counts spawn_outcome as a message event, so it bumps unread and drives the snippet", () => {
        expect(MESSAGE_EVENT_TYPES.has("spawn_outcome")).toBe(true);
    });
});
