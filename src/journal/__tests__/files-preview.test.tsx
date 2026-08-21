/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../api";
import type { FileMeta, FilesApiLike } from "../files/filesApi";
import { FilePreview } from "../files/preview/FilePreview";
import { GenericPreview } from "../files/preview/GenericPreview";
import { pickPreviewKind } from "../files/previewKind";

// PdfPreview lazily imports this; stub it so a PDF mounts in jsdom without real pdf.js — mirrors the
// media-viewer test. numPages:1 → one canvas painted.
jest.mock("../pdf-render", () => ({
    loadPdf: jest.fn().mockResolvedValue({
        numPages: 1,
        renderPage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
    }),
}));

// ── Pure dispatch (the security-relevant "right renderer per mime/is_text" gate) ────────────────
describe("pickPreviewKind", () => {
    const cases: Array<[{ mime: string; isText: boolean; filename: string }, string]> = [
        [{ mime: "text/markdown", isText: true, filename: "README.md" }, "markdown"],
        [{ mime: "text/plain", isText: true, filename: "notes.md" }, "markdown"],
        [{ mime: "text/plain", isText: true, filename: "client.ts" }, "code"],
        [{ mime: "application/json", isText: true, filename: "tsconfig.json" }, "code"],
        [{ mime: "image/png", isText: false, filename: "diagram.png" }, "image"],
        [{ mime: "application/pdf", isText: false, filename: "report.pdf" }, "pdf"],
        [{ mime: "audio/mpeg", isText: false, filename: "song.mp3" }, "audio"],
        [{ mime: "video/mp4", isText: false, filename: "clip.mp4" }, "video"],
        [{ mime: "application/zip", isText: false, filename: "archive.zip" }, "generic"],
        [{ mime: "application/octet-stream", isText: false, filename: "weird.ts" }, "generic"],
    ];
    it.each(cases)("dispatches %o → %s", (args, expected) => {
        expect(pickPreviewKind(args)).toBe(expected);
    });
});

// ── End-to-end: FilePreview renders the matching component for each meta ─────────────────────────
function mockApi(meta: FileMeta, overrides: Partial<FilesApiLike> = {}): FilesApiLike {
    return {
        listDir: jest.fn(),
        fileMeta: jest.fn().mockResolvedValue(meta),
        textContent: jest.fn().mockResolvedValue("# Title\n\ncode: `x`"),
        fileBytes: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
        contentUrl: jest.fn().mockResolvedValue("blob:mock/xyz"),
        download: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn(),
        ...overrides,
    } as unknown as FilesApiLike;
}

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(element);
    });
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
    return { container, root };
}

const meta = (over: Partial<FileMeta>): FileMeta => ({
    kind: "file",
    size: 1024,
    mtime: 123,
    mime: "application/octet-stream",
    isText: false,
    ...over,
});

describe("FilePreview dispatch (DOM)", () => {
    it("renders markdown for a .md text file", async () => {
        const { container } = await mount(
            <FilePreview
                api={mockApi(meta({ mime: "text/markdown", isText: true }))}
                path="/r/README.md"
                filename="README.md"
            />,
        );
        expect(container.querySelector(".mj_FilesMarkdown")).not.toBeNull();
    });
    it("renders the code viewer for a .ts text file", async () => {
        const { container } = await mount(
            <FilePreview
                api={mockApi(meta({ mime: "text/plain", isText: true }))}
                path="/r/client.ts"
                filename="client.ts"
            />,
        );
        expect(container.querySelector(".mj_FilesCode_pre")).not.toBeNull();
    });
    it("renders an <img> for an image", async () => {
        const { container } = await mount(
            <FilePreview api={mockApi(meta({ mime: "image/png" }))} path="/r/diagram.png" filename="diagram.png" />,
        );
        expect(container.querySelector(".mj_FilesImage img")).not.toBeNull();
    });
    it("renders a pdf.js CANVAS (not a native <object>) for a pdf", async () => {
        const { container } = await mount(
            <FilePreview api={mockApi(meta({ mime: "application/pdf" }))} path="/r/report.pdf" filename="report.pdf" />,
        );
        expect(container.querySelector("canvas.mj_FilesPdf_page")).not.toBeNull();
        expect(container.querySelector("object")).toBeNull(); // no active-document embed (F1)
    });
    it("renders an <audio> element for audio", async () => {
        const { container } = await mount(
            <FilePreview api={mockApi(meta({ mime: "audio/mpeg" }))} path="/r/song.mp3" filename="song.mp3" />,
        );
        expect(container.querySelector(".mj_FilesMedia audio")).not.toBeNull();
    });
    it("renders the generic card with a download button for a binary", async () => {
        const { container } = await mount(
            <FilePreview
                api={mockApi(meta({ mime: "application/zip" }))}
                path="/r/archive.zip"
                filename="archive.zip"
            />,
        );
        expect(container.querySelector(".mj_FilesGeneric")).not.toBeNull();
        expect(container.querySelector(".mj_FilesDownload")).not.toBeNull();
    });
});

// F5: a failed download surfaces a visible error instead of a silent reset / unhandled rejection.
describe("download error visibility", () => {
    it("shows the uniform status message when download rejects", async () => {
        const api = mockApi(meta({ mime: "application/zip" }), {
            download: jest.fn().mockRejectedValue(new JournalApiError("denied", 403, "forbidden")),
        });
        const { container } = await mount(
            <GenericPreview
                api={api}
                path="/r/archive.zip"
                filename="archive.zip"
                meta={meta({ mime: "application/zip" })}
            />,
        );
        const button = container.querySelector<HTMLButtonElement>(".mj_FilesDownload");
        expect(button).not.toBeNull();
        await act(async () => {
            button!.click();
            await Promise.resolve();
            await Promise.resolve();
        });
        const error = container.querySelector(".mj_FilesDownload_error");
        expect(error?.textContent).toBe("This file or folder can't be accessed.");
    });
});
