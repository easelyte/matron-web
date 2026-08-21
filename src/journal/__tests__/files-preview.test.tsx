/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { FileMeta, FilesApiLike } from "../files/filesApi";
import { FilePreview } from "../files/preview/FilePreview";
import { pickPreviewKind } from "../files/previewKind";

// ── Pure dispatch (the security-relevant "right renderer per mime/is_text" gate) ────────────────
describe("pickPreviewKind", () => {
    const cases: Array<[{ mime: string; isText: boolean; filename: string }, string]> = [
        [{ mime: "text/markdown", isText: true, filename: "README.md" }, "markdown"],
        [{ mime: "text/plain", isText: true, filename: "notes.md" }, "markdown"], // extension wins
        [{ mime: "text/plain", isText: true, filename: "client.ts" }, "code"],
        [{ mime: "application/json", isText: true, filename: "tsconfig.json" }, "code"], // isText overrides generic MIME
        [{ mime: "image/png", isText: false, filename: "diagram.png" }, "image"],
        [{ mime: "application/pdf", isText: false, filename: "report.pdf" }, "pdf"],
        [{ mime: "audio/mpeg", isText: false, filename: "song.mp3" }, "audio"],
        [{ mime: "video/mp4", isText: false, filename: "clip.mp4" }, "video"],
        [{ mime: "application/zip", isText: false, filename: "archive.zip" }, "generic"],
        [{ mime: "application/octet-stream", isText: false, filename: "blob.bin" }, "generic"],
        // A binary with a code-ish extension must NOT preview as code when the server says not-text.
        [{ mime: "application/octet-stream", isText: false, filename: "weird.ts" }, "generic"],
    ];
    it.each(cases)("dispatches %o → %s", (args, expected) => {
        expect(pickPreviewKind(args)).toBe(expected);
    });
});

// ── End-to-end: FilePreview renders the matching component for each meta ─────────────────────────
function mockApi(meta: FileMeta): FilesApiLike {
    return {
        listDir: jest.fn(),
        fileMeta: jest.fn().mockResolvedValue(meta),
        textContent: jest.fn().mockResolvedValue("# Title\n\ncode: `x`"),
        contentUrl: jest.fn().mockResolvedValue("blob:https://journal.example/xyz"),
        download: jest.fn().mockResolvedValue(undefined),
        revokeAll: jest.fn(),
    } as unknown as FilesApiLike;
}

async function renderPreview(meta: FileMeta, filename: string): Promise<HTMLDivElement> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(<FilePreview api={mockApi(meta)} path={`/root/${filename}`} filename={filename} />);
    });
    // Flush meta load → dispatch → content load (two setState hops).
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
    return container;
}

const meta = (over: Partial<FileMeta>): FileMeta => ({
    kind: "file",
    size: 1024,
    mtime: Date.now(),
    mime: "application/octet-stream",
    isText: false,
    ...over,
});

describe("FilePreview dispatch (DOM)", () => {
    it("renders markdown for a .md text file", async () => {
        const c = await renderPreview(meta({ mime: "text/markdown", isText: true }), "README.md");
        expect(c.querySelector(".mj_FilesMarkdown")).not.toBeNull();
    });
    it("renders the code viewer for a .ts text file", async () => {
        const c = await renderPreview(meta({ mime: "text/plain", isText: true }), "client.ts");
        expect(c.querySelector(".mj_FilesCode_pre")).not.toBeNull();
    });
    it("renders an <img> for an image", async () => {
        const c = await renderPreview(meta({ mime: "image/png" }), "diagram.png");
        expect(c.querySelector(".mj_FilesImage img")).not.toBeNull();
    });
    it("renders a native PDF <object> for a pdf", async () => {
        const c = await renderPreview(meta({ mime: "application/pdf" }), "report.pdf");
        expect(c.querySelector('.mj_FilesPdf object[type="application/pdf"]')).not.toBeNull();
    });
    it("renders an <audio> element for audio", async () => {
        const c = await renderPreview(meta({ mime: "audio/mpeg" }), "song.mp3");
        expect(c.querySelector(".mj_FilesMedia audio")).not.toBeNull();
    });
    it("renders a <video> element for video", async () => {
        const c = await renderPreview(meta({ mime: "video/mp4" }), "clip.mp4");
        expect(c.querySelector(".mj_FilesMedia video")).not.toBeNull();
    });
    it("renders the generic card with a download button for a binary", async () => {
        const c = await renderPreview(meta({ mime: "application/zip" }), "archive.zip");
        expect(c.querySelector(".mj_FilesGeneric")).not.toBeNull();
        expect(c.querySelector(".mj_FilesDownload")).not.toBeNull();
    });
});
