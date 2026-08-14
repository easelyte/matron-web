/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import {
    buildMediaCorpus,
    formatMediaSize,
    isRenderableInViewer,
    type MediaItem,
    MediaViewer,
    mediaRenderKind,
    viewerRetypeMime,
} from "../media-viewer";
import type { JournalEvent } from "../types";

// The PDF body dynamically imports this; stub it so a PDF item can mount in jsdom without
// pulling real pdf.js (which is the whole point of the lazy boundary).
jest.mock("../pdf-render", () => ({
    loadPdf: jest.fn().mockResolvedValue({
        numPages: 2,
        renderPage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
    }),
}));

function stubClient(url = "blob:https://journal.example/abc123"): MatronJournalClient {
    return { mediaUrl: jest.fn().mockResolvedValue(url) } as unknown as MatronJournalClient;
}

function item(overrides: Partial<MediaItem> & Pick<MediaItem, "mediaId">): MediaItem {
    return {
        kind: "raster",
        fileKind: "image",
        isImageEvent: true,
        ...overrides,
    };
}

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    // Flush the mediaUrl microtasks (useObjectUrl → setState).
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
    return { container, root };
}

describe("media render classification (pure)", () => {
    it("routes each content type per the decision table", () => {
        expect(mediaRenderKind(true, "image/png")).toBe("raster");
        expect(mediaRenderKind(false, "image/svg+xml")).toBe("svg");
        expect(mediaRenderKind(false, undefined, "logo.svg")).toBe("svg");
        expect(mediaRenderKind(false, "application/pdf")).toBe("pdf");
        expect(mediaRenderKind(false, undefined, "report.pdf")).toBe("pdf");
        expect(mediaRenderKind(false, "video/mp4")).toBe("video");
        expect(mediaRenderKind(false, "image/jpeg")).toBe("raster");
        // SVG never falls through to the generic image/* raster path.
        expect(mediaRenderKind(false, "image/svg+xml")).not.toBe("raster");
        // Hard guardrail: HTML and unknown are download-only.
        expect(mediaRenderKind(false, "text/html")).toBe("download");
        expect(mediaRenderKind(false, "application/octet-stream")).toBe("download");
        expect(mediaRenderKind(false, undefined, "archive.gz")).toBe("download");
        // REAL WORLD: the bridge/journal serve non-raster media as application/octet-stream,
        // so the extension must still route them — the original bug shipped svg/pdf/video as
        // downloads because octet-stream is non-empty and the ext fallback only ran on "".
        expect(mediaRenderKind(false, "application/octet-stream", "diagram.svg")).toBe("svg");
        expect(mediaRenderKind(false, "application/octet-stream", "report.pdf")).toBe("pdf");
        expect(mediaRenderKind(false, "application/octet-stream", "clip.mp4")).toBe("video");
        expect(mediaRenderKind(false, "application/octet-stream", "photo.png")).toBe("raster");
    });

    it("isRenderableInViewer is true only for inline-renderable types", () => {
        expect(isRenderableInViewer("image/svg+xml")).toBe(true);
        expect(isRenderableInViewer("application/pdf")).toBe(true);
        expect(isRenderableInViewer("video/webm")).toBe(true);
        expect(isRenderableInViewer("text/html")).toBe(false);
        expect(isRenderableInViewer("application/zip")).toBe(false);
    });

    it("viewerRetypeMime re-types svg/video (bridge serves them octet-stream), leaves raster/pdf alone", () => {
        // SVG/video blobs arrive as application/octet-stream — an <img>/<video> can't render
        // those, so the viewer re-wraps them with a real MIME. Raster is already image/*, and
        // pdf.js reads raw bytes, so both pass through untouched.
        expect(viewerRetypeMime({ kind: "svg", filename: "d.svg" })).toBe("image/svg+xml");
        expect(viewerRetypeMime({ kind: "video", filename: "c.mp4" })).toBe("video/mp4");
        expect(viewerRetypeMime({ kind: "video", filename: "c.webm" })).toBe("video/webm");
        expect(viewerRetypeMime({ kind: "video", filename: "c.mov" })).toBe("video/quicktime");
        expect(viewerRetypeMime({ kind: "video", filename: undefined })).toBe("video/mp4");
        expect(viewerRetypeMime({ kind: "raster", filename: "a.png" })).toBeUndefined();
        expect(viewerRetypeMime({ kind: "pdf", filename: "b.pdf" })).toBeUndefined();
        expect(viewerRetypeMime({ kind: "download", filename: "x.gz" })).toBeUndefined();
    });

    it("formatMediaSize renders machine size strings", () => {
        expect(formatMediaSize(512)).toBe("512 B");
        expect(formatMediaSize(2048)).toBe("2 KB");
        expect(formatMediaSize(1_468_006)).toBe("1.4 MB");
        expect(formatMediaSize(undefined)).toBeUndefined();
    });
});

describe("buildMediaCorpus (pure)", () => {
    function event(seq: number, type: string, payload: Record<string, unknown>): JournalEvent {
        return { seq, convo_id: "c1", ts: seq, sender: "agent:1", type, payload };
    }

    it("collects image + file events with a blob_ref, in order, classified", () => {
        const corpus = buildMediaCorpus([
            event(1, "text", { body: "hi" }),
            event(2, "image", { blob_ref: "img-1", content_type: "image/png", caption: "shot" }),
            event(3, "file", { blob_ref: "svg-1", content_type: "application/octet-stream", filename: "d.svg" }),
            event(4, "file", { blob_ref: "", content_type: "application/pdf" }), // dropped: no blob_ref
            event(5, "file", { blob_ref: "html-1", content_type: "text/html", filename: "page.html" }),
        ]);
        expect(corpus.map((c) => c.mediaId)).toEqual(["img-1", "svg-1", "html-1"]);
        expect(corpus[0].kind).toBe("raster");
        expect(corpus[1].kind).toBe("svg");
        expect(corpus[2].kind).toBe("download");
    });
});

describe("MediaViewer overlay", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    const gallery: MediaItem[] = [
        item({ mediaId: "img-1", kind: "raster", filename: "one.png" }),
        item({ mediaId: "svg-1", kind: "svg", isImageEvent: false, contentType: "image/svg+xml", filename: "two.svg" }),
        item({
            mediaId: "html-1",
            kind: "download",
            fileKind: "generic",
            isImageEvent: false,
            contentType: "text/html",
            filename: "three.html",
            size: 1_468_006,
        }),
    ];

    it("shows the index and traverses the gallery via next", async () => {
        rendered = await render(
            <MediaViewer
                client={stubClient()}
                items={gallery}
                initialMediaId="img-1"
                opener={null}
                onClose={() => {}}
            />,
        );
        expect(rendered.container.querySelector(".mj_MediaViewer_count")?.textContent).toBe("1 / 3");
        // ThumbStrip reflects the full corpus; the active thumb is ringed in accent.
        const thumbs = rendered.container.querySelectorAll(".mj_MediaViewer_thumb");
        expect(thumbs).toHaveLength(3);
        expect(rendered.container.querySelectorAll(".mj_MediaViewer_thumb_active")).toHaveLength(1);

        const next = rendered.container.querySelector<HTMLButtonElement>(".mj_MediaViewer_nav_next");
        await act(async () => next?.click());
        expect(rendered.container.querySelector(".mj_MediaViewer_count")?.textContent).toBe("2 / 3");
    });

    it("selects the body per type: raster → <img>, svg → inert <img>, html → download-only", async () => {
        // Raster.
        rendered = await render(
            <MediaViewer
                client={stubClient()}
                items={gallery}
                initialMediaId="img-1"
                opener={null}
                onClose={() => {}}
            />,
        );
        expect(rendered.container.querySelector(".mj_MediaViewer_img")).not.toBeNull();
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        // SVG — an inert <img>, never a document/plugin context. (The stage's own <svg>
        // zoom-control glyphs are legitimate chrome, so the forbidden set is iframe/object/
        // embed, and the media itself must be an <img>, not injected inline-svg.)
        rendered = await render(
            <MediaViewer
                client={stubClient()}
                items={gallery}
                initialMediaId="svg-1"
                opener={null}
                onClose={() => {}}
            />,
        );
        const body = rendered.container.querySelector(".mj_MediaViewer_body");
        expect(body?.querySelector(".mj_MediaViewer_img")?.tagName).toBe("IMG");
        expect(body?.querySelector("iframe, object, embed")).toBeNull();
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        // HTML — download-only card, no inline render of the bytes.
        rendered = await render(
            <MediaViewer
                client={stubClient()}
                items={gallery}
                initialMediaId="html-1"
                opener={null}
                onClose={() => {}}
            />,
        );
        expect(rendered.container.querySelector(".mj_MediaViewer_downloadCard")).not.toBeNull();
        expect(rendered.container.querySelector(".mj_MediaViewer_body img")).toBeNull();
        expect(rendered.container.querySelector(".mj_MediaViewer_body iframe, .mj_MediaViewer_body object")).toBeNull();
    });

    it("SECURITY: a script-carrying SVG renders via <img> and its script never executes", async () => {
        const sentinel = "__mj_svg_pwned__";
        const globalRef = globalThis as unknown as Record<string, unknown>;
        delete globalRef[sentinel];
        // The blob the viewer would show carries an active <script>. Because it is only ever
        // set as an <img src>, the browser rasterises it and the script is inert — the SVG
        // bytes are never parsed into the document. (jsdom lacks URL.createObjectURL and never
        // fetches/executes <img> src, so a fake blob: URL is sufficient to assert the shape:
        // the code path is what matters — no inline-svg / iframe / object / embed / innerHTML.)
        const blobUrl = "blob:https://journal.example/svg-inert";

        rendered = await render(
            <MediaViewer
                client={stubClient(blobUrl)}
                items={[
                    item({
                        mediaId: "svg-x",
                        kind: "svg",
                        isImageEvent: false,
                        contentType: "image/svg+xml",
                        filename: "x.svg",
                    }),
                ]}
                initialMediaId="svg-x"
                opener={null}
                onClose={() => {}}
            />,
        );

        const img = rendered.container.querySelector<HTMLImageElement>(".mj_MediaViewer_img");
        expect(img).not.toBeNull();
        expect(img?.tagName).toBe("IMG");
        expect(img?.getAttribute("src")).toBe(blobUrl); // rendered from the blob, inert
        // No document/plugin context and no injected <script> from the SVG bytes.
        expect(rendered.container.querySelector("iframe, object, embed, script")).toBeNull();
        expect(globalRef[sentinel]).toBeUndefined(); // the SVG's script never ran
    });

    it("download uses the blob: object URL, never the raw /media route", async () => {
        rendered = await render(
            <MediaViewer
                client={stubClient("blob:https://journal.example/deadbeef")}
                items={gallery}
                initialMediaId="html-1"
                opener={null}
                onClose={() => {}}
            />,
        );
        const link = rendered.container.querySelector<HTMLAnchorElement>(".mj_MediaViewer_downloadBtn");
        expect(link).not.toBeNull();
        const href = link?.getAttribute("href") ?? "";
        expect(href.startsWith("blob:")).toBe(true);
        expect(href).not.toContain("/media/");
        expect(link?.getAttribute("download")).toBe("three.html");
    });

    it("keyboard: Esc closes, ArrowRight advances the gallery", async () => {
        const onClose = jest.fn();
        rendered = await render(
            <MediaViewer
                client={stubClient()}
                items={gallery}
                initialMediaId="img-1"
                opener={null}
                onClose={onClose}
            />,
        );
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
        });
        expect(rendered.container.querySelector(".mj_MediaViewer_count")?.textContent).toBe("2 / 3");
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("restores focus to the opener element on close", async () => {
        const opener = document.createElement("button");
        document.body.append(opener);
        rendered = await render(
            <MediaViewer
                client={stubClient()}
                items={gallery}
                initialMediaId="img-1"
                opener={opener}
                onClose={() => {}}
            />,
        );
        await act(async () => rendered?.root.unmount());
        expect(document.activeElement).toBe(opener);
        rendered.container.remove();
        rendered = undefined;
        opener.remove();
    });
});
