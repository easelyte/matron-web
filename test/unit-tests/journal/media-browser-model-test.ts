/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { buildMediaBrowserEntries, extractLinks } from "../../../src/journal/media-browser-model";
import type { JournalEvent } from "../../../src/journal/types";

const event = (seq: number, type: string, payload: Record<string, unknown>, sender = "agent:claude"): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: 1_000 * seq,
    sender,
    type,
    payload,
});

describe("extractLinks", () => {
    it("finds http and https links only", () => {
        expect(extractLinks("see https://example.com/a and http://example.com/b, not ftp://example.com")).toEqual([
            "https://example.com/a",
            "http://example.com/b",
        ]);
        expect(extractLinks("mailto:alice@example.com file:///tmp/x ssh://box-a")).toEqual([]);
    });

    it("leaves out the punctuation and markdown around a link", () => {
        expect(extractLinks("Done: https://example.com/report.")).toEqual(["https://example.com/report"]);
        expect(extractLinks("[the docs](https://example.com/docs)")).toEqual(["https://example.com/docs"]);
        expect(extractLinks("(see https://example.com/x)")).toEqual(["https://example.com/x"]);
        expect(extractLinks("**https://example.com/bold**")).toEqual(["https://example.com/bold"]);
        expect(extractLinks("<https://example.com/angle>")).toEqual(["https://example.com/angle"]);
    });

    it("keeps brackets that belong to the link", () => {
        expect(extractLinks("https://example.com/wiki/Thing_(disambiguation)")).toEqual([
            "https://example.com/wiki/Thing_(disambiguation)",
        ]);
    });

    it("ignores a scheme with no host", () => {
        expect(extractLinks("https:// nothing")).toEqual([]);
    });
});

describe("buildMediaBrowserEntries", () => {
    it("lists images as media and other attachments as files, newest first", () => {
        const entries = buildMediaBrowserEntries([
            event(1, "image", { blob_ref: "img-1" }),
            event(2, "file", { blob_ref: "file-1", name: "report.pdf", size: 2048, content_type: "application/pdf" }),
            event(3, "image", { blob_ref: "img-2", caption: "chart" }),
            event(4, "image", { blob_ref: "img-3", expired: true }),
            event(5, "file", { name: "no-blob.txt" }),
        ]);
        expect(entries.media.map((item) => item.mediaId)).toEqual(["img-3", "img-2", "img-1"]);
        expect(entries.media[0].expired).toBe(true);
        expect(entries.files.map((item) => [item.mediaId, item.filename, item.size])).toEqual([
            ["file-1", "report.pdf", 2048],
        ]);
    });

    it("lists each link once, at its newest sighting, with that message's first line", () => {
        const long = "x".repeat(250);
        const entries = buildMediaBrowserEntries([
            event(1, "text", { body: "first look https://example.com/a" }),
            event(2, "text", { body: `${long}\nhttps://example.com/b` }),
            event(3, "text", { body: "Again: https://example.com/a\nsecond line" }, "user:alice"),
            event(4, "tool_output", { snippet: "https://example.com/not-prose" }),
            event(5, "text", { body: "mirror https://example.com/c", fallback_for: "it_1" }),
        ]);
        expect(entries.links).toEqual([
            { url: "https://example.com/a", context: "Again: https://example.com/a", ts: 3_000 },
            { url: "https://example.com/b", context: "x".repeat(200), ts: 2_000 },
        ]);
    });

    it("is empty for a chat with nothing to browse", () => {
        expect(buildMediaBrowserEntries([event(1, "text", { body: "hello" })])).toEqual({
            media: [],
            files: [],
            links: [],
        });
    });
});
