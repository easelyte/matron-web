/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * File preview header: the Copy action. Pins that Copy is offered only for text-like previews,
 * copies the FULL raw source (markdown source, not rendered HTML; past the inline-render ceiling
 * too) from the same single read the preview renders, shows "copied" feedback for a bounded time,
 * announces it, and surfaces a failure instead of swallowing it.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../api";
import type { FileMeta, FilesApiLike } from "../files/filesApi";
import { INLINE_TEXT_MAX } from "../files/limits";
import { FilePreview } from "../files/preview/FilePreview";
import { COPIED_FEEDBACK_MS } from "../files/preview/PreviewToolbar";

jest.mock("../pdf-render", () => ({
    loadPdf: jest.fn().mockResolvedValue({
        numPages: 1,
        renderPage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
    }),
}));

const MD = "# Title\n\n**bold** body\n";

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
        textContent: jest.fn().mockResolvedValue(MD),
        fileBytes: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
        contentUrl: jest.fn().mockResolvedValue("blob:mock/xyz"),
        download: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn(),
        ...overrides,
    } as unknown as FilesApiLike;
}

let writeText: jest.Mock;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
    writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function flush(): Promise<void> {
    await act(async () => {
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
}

async function mount(api: FilesApiLike, path: string, filename: string): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
        root = createRoot(container as HTMLDivElement);
        root.render(<FilePreview api={api} path={path} filename={filename} />);
    });
    await flush();
    return container;
}

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    jest.useRealTimers();
});

const copyButton = (c: HTMLElement): HTMLButtonElement | null =>
    c.querySelector<HTMLButtonElement>(".mj_FilesAction_copy");

async function click(element: Element | null): Promise<void> {
    expect(element).not.toBeNull();
    await act(async () => {
        (element as HTMLElement).click();
    });
    await flush();
}

describe("Copy is offered only for text-like previews", () => {
    it.each([
        ["README.md", meta({ mime: "text/markdown", isText: true })],
        ["client.ts", meta({ mime: "text/plain", isText: true })],
        ["notes.txt", meta({ mime: "text/plain", isText: true })],
        ["data.json", meta({ mime: "application/json", isText: true })],
    ])("shows Copy for %s", async (name, fileMeta) => {
        const c = await mount(mockApi(fileMeta), `/r/${name}`, name);
        expect(copyButton(c)).not.toBeNull();
        expect(copyButton(c)?.getAttribute("aria-label")).toBe("Copy contents");
    });

    it.each([
        ["diagram.png", meta({ mime: "image/png" })],
        ["report.pdf", meta({ mime: "application/pdf" })],
        ["song.mp3", meta({ mime: "audio/mpeg" })],
        ["clip.mp4", meta({ mime: "video/mp4" })],
        ["archive.zip", meta({ mime: "application/zip" })],
    ])("hides Copy for %s", async (name, fileMeta) => {
        const c = await mount(mockApi(fileMeta), `/r/${name}`, name);
        expect(copyButton(c)).toBeNull();
        // The rest of the cluster is still there.
        expect(c.querySelector(".mj_FilesAction_download")).not.toBeNull();
    });

    it("reads a text file ONCE for both the view and Copy", async () => {
        const api = mockApi(meta({ mime: "text/markdown", isText: true }));
        await mount(api, "/r/README.md", "README.md");
        expect(api.textContent).toHaveBeenCalledTimes(1);
    });
});

describe("copying", () => {
    it("writes the raw markdown source (not rendered text) to the clipboard", async () => {
        const c = await mount(mockApi(meta({ mime: "text/markdown", isText: true })), "/r/README.md", "README.md");
        await click(copyButton(c));
        expect(writeText).toHaveBeenCalledWith(MD);
    });

    it("copies the full text even past the inline-render ceiling (too-large card shown)", async () => {
        const big = "x".repeat(INLINE_TEXT_MAX + 10);
        const api = mockApi(meta({ mime: "text/plain", isText: true }), {
            textContent: jest.fn().mockResolvedValue(big),
        });
        const c = await mount(api, "/r/big.log", "big.log");
        expect(c.textContent).toContain("too large to preview inline");
        await click(copyButton(c));
        expect(writeText).toHaveBeenCalledWith(big);
    });

    it("swaps to a check + announces, then reverts after the feedback window", async () => {
        jest.useFakeTimers();
        const c = await mount(mockApi(meta({ mime: "text/plain", isText: true })), "/r/notes.txt", "notes.txt");
        await click(copyButton(c));
        expect(copyButton(c)?.classList.contains("mj_FilesAction_done")).toBe(true);
        expect(copyButton(c)?.getAttribute("aria-label")).toBe("Copied");
        const live = c.querySelector(".mj_FilesPreview_live");
        expect(live?.getAttribute("aria-live")).toBe("polite");
        expect(live?.textContent).toBe("Copied to clipboard");

        await act(async () => {
            jest.advanceTimersByTime(COPIED_FEEDBACK_MS);
        });
        expect(copyButton(c)?.classList.contains("mj_FilesAction_done")).toBe(false);
        expect(copyButton(c)?.getAttribute("aria-label")).toBe("Copy contents");
        expect(live?.textContent).toBe("");
    });

    it("falls back to execCommand when the async clipboard API is unavailable (insecure context)", async () => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
        const execCommand = jest.fn().mockReturnValue(true);
        Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
        const c = await mount(mockApi(meta({ mime: "text/plain", isText: true })), "/r/notes.txt", "notes.txt");
        await click(copyButton(c));
        expect(execCommand).toHaveBeenCalledWith("copy");
        expect(copyButton(c)?.classList.contains("mj_FilesAction_done")).toBe(true);
    });

    it("shows an inline error when copying fails", async () => {
        writeText.mockRejectedValue(new Error("NotAllowedError"));
        Object.defineProperty(document, "execCommand", { configurable: true, value: jest.fn().mockReturnValue(false) });
        const c = await mount(mockApi(meta({ mime: "text/plain", isText: true })), "/r/notes.txt", "notes.txt");
        await click(copyButton(c));
        const error = c.querySelector(".mj_FilesPreview_copyError");
        expect(error?.getAttribute("role")).toBe("alert");
        expect(error?.textContent).toMatch(/Couldn't copy/);
        expect(copyButton(c)?.classList.contains("mj_FilesAction_done")).toBe(false);
    });
});

describe("Copy is unavailable (with a reason) until the full text is readable", () => {
    it("is aria-disabled while the text is loading", async () => {
        const api = mockApi(meta({ mime: "text/plain", isText: true }), {
            textContent: jest.fn(() => new Promise<string>(() => {})),
        });
        const c = await mount(api, "/r/notes.txt", "notes.txt");
        const button = copyButton(c);
        expect(button?.getAttribute("aria-disabled")).toBe("true");
        expect(button?.title).toMatch(/Loading/);
        await click(button);
        expect(writeText).not.toHaveBeenCalled();
    });

    it("explains a too-large read (413) and never copies partial text", async () => {
        const api = mockApi(meta({ mime: "text/plain", isText: true }), {
            textContent: jest.fn().mockRejectedValue(new JournalApiError("too big", 413, "too_large")),
        });
        const c = await mount(api, "/r/huge.log", "huge.log");
        const button = copyButton(c);
        expect(button?.getAttribute("aria-disabled")).toBe("true");
        expect(button?.title).toBe("Too large to copy. Download it instead.");
        await click(button);
        expect(writeText).not.toHaveBeenCalled();
    });
});
