/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * File-explorer download-to-local (loop #773). The gap #773 closes: previewable files (text, image,
 * pdf, media) had NO download affordance — only unpreviewable / too-large / load-error states did,
 * via a per-renderer DownloadControl. This suite pins the fix: FilePreview renders exactly ONE
 * download control for EVERY file type, it goes through the existing api.download attachment path
 * (no new read surface), it is NOT gated on any write capability, and a rejection surfaces uniformly
 * without leaking the server's reason and without crashing the preview.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../api";
import type { FileMeta, FilesApiLike } from "../files/filesApi";
import { FilePreview } from "../files/preview/FilePreview";

// PdfPreview lazily imports this; stub so a PDF mounts in jsdom without real pdf.js.
jest.mock("../pdf-render", () => ({
    loadPdf: jest.fn().mockResolvedValue({
        numPages: 1,
        renderPage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
    }),
}));

const meta = (over: Partial<FileMeta>): FileMeta => ({
    kind: "file",
    size: 1024,
    mtime: 123,
    mime: "application/octet-stream",
    isText: false,
    ...over,
});

function mockApi(fileMeta: FileMeta, overrides: Partial<FilesApiLike> = {}): FilesApiLike {
    return {
        listDir: jest.fn(),
        fileMeta: jest.fn().mockResolvedValue(fileMeta),
        textContent: jest.fn().mockResolvedValue("# Title\n\nbody"),
        fileBytes: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
        contentUrl: jest.fn().mockResolvedValue("blob:mock/xyz"),
        download: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn(),
        ...overrides,
    } as unknown as FilesApiLike;
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
        root = createRoot(container as HTMLDivElement);
        root.render(element);
    });
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
    return container;
}

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
});

function click(element: Element | null): Promise<void> {
    expect(element).not.toBeNull();
    return act(async () => {
        (element as HTMLElement).click();
        await Promise.resolve();
        await Promise.resolve();
    });
}

const preview = (path: string, filename: string, api: FilesApiLike): React.ReactElement => (
    <FilePreview api={api} path={path} filename={filename} />
);

describe("every previewable file type now offers download (loop #773)", () => {
    // These are the types that previously rendered inline with NO download button at all.
    it("offers download for a markdown/text file", async () => {
        const c = await mount(
            preview("/r/README.md", "README.md", mockApi(meta({ mime: "text/markdown", isText: true }))),
        );
        expect(c.querySelector(".mj_FilesMarkdown")).not.toBeNull();
        expect(c.querySelector(".mj_FilesAction_download")).not.toBeNull();
    });

    it("offers download for an image", async () => {
        const c = await mount(preview("/r/diagram.png", "diagram.png", mockApi(meta({ mime: "image/png" }))));
        expect(c.querySelector(".mj_FilesImage img")).not.toBeNull();
        expect(c.querySelector(".mj_FilesAction_download")).not.toBeNull();
    });

    it("offers download for a pdf", async () => {
        const c = await mount(preview("/r/report.pdf", "report.pdf", mockApi(meta({ mime: "application/pdf" }))));
        expect(c.querySelector(".mj_FilesAction_download")).not.toBeNull();
    });

    it("offers download for audio", async () => {
        const c = await mount(preview("/r/song.mp3", "song.mp3", mockApi(meta({ mime: "audio/mpeg" }))));
        expect(c.querySelector(".mj_FilesMedia audio")).not.toBeNull();
        expect(c.querySelector(".mj_FilesAction_download")).not.toBeNull();
    });
});

describe("exactly one download control per file (no duplicate — Codex F1)", () => {
    it("renders a SINGLE download control for a binary/unpreviewable file", async () => {
        const c = await mount(preview("/r/archive.zip", "archive.zip", mockApi(meta({ mime: "application/zip" }))));
        expect(c.querySelector(".mj_FilesGeneric")).not.toBeNull(); // the info card still renders
        expect(c.querySelectorAll(".mj_FilesAction_download")).toHaveLength(1); // ...with no second button
    });
});

describe("download goes through the existing attachment path", () => {
    it("calls api.download with the file's path and name", async () => {
        const api = mockApi(meta({ mime: "text/markdown", isText: true }));
        const c = await mount(preview("/r/README.md", "README.md", api));
        await click(c.querySelector(".mj_FilesAction_download"));
        expect(api.download).toHaveBeenCalledTimes(1);
        expect(api.download).toHaveBeenCalledWith("/r/README.md", "README.md");
    });
});

describe("a rejected download surfaces a uniform error without leaking the reason", () => {
    it("shows the uniform status copy and keeps the preview mounted", async () => {
        const api = mockApi(meta({ mime: "text/markdown", isText: true }), {
            download: jest.fn().mockRejectedValue(new JournalApiError("secret-path denied", 403, "forbidden")),
        });
        const c = await mount(preview("/r/README.md", "README.md", api));
        await click(c.querySelector(".mj_FilesAction_download"));
        const error = c.querySelector(".mj_FilesPreview_downloadError");
        expect(error).not.toBeNull();
        // Uniform copy — the server's raw reason must not reach the operator.
        expect(error?.textContent).toBe("This file or folder can't be accessed.");
        expect(error?.textContent).not.toMatch(/denied|403|secret-path/);
        // The preview itself did not crash on the rejection.
        expect(c.querySelector(".mj_FilesMarkdown")).not.toBeNull();
    });

    it("disables the button while the download is in flight, then re-enables it", async () => {
        let release!: () => void;
        const download = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const api = mockApi(meta({ mime: "text/markdown", isText: true }), {
            download: download as unknown as FilesApiLike["download"],
        });
        const c = await mount(preview("/r/README.md", "README.md", api));
        const button = c.querySelector<HTMLButtonElement>(".mj_FilesAction_download");
        await click(button);
        expect(button?.disabled).toBe(true);
        await act(async () => {
            release();
            await Promise.resolve();
        });
        expect(button?.disabled).toBe(false);
    });
});
