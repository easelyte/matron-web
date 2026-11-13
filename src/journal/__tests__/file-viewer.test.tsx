/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import { FileViewerPanel, useFileViewerPanel } from "../file-viewer";
import { handleViewerLinkClick } from "../files-link";
import { messageForFileStatus, type FilesApiLike } from "../files/filesApi";
import { JournalApiError } from "../api";

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

const onOpen = jest.fn();
function Harness({
    client,
    path = "/home/report.md",
}: {
    client: MatronJournalClient;
    path?: string;
}): React.ReactElement {
    const viewer = useFileViewerPanel(onOpen);
    return (
        <>
            <a href={`#files=${encodeURIComponent(path)}`} onClick={(event) => handleViewerLinkClick(event, path)}>
                report
            </a>
            {viewer.target && <FileViewerPanel client={client} target={viewer.target} onClose={viewer.close} />}
        </>
    );
}

async function open(
    error?: Error,
    path?: string,
): Promise<{ opener: HTMLAnchorElement; api: FilesApiLike; client: MatronJournalClient }> {
    const api = {
        fileMeta: error
            ? jest.fn().mockRejectedValue(error)
            : jest.fn().mockResolvedValue({ kind: "file", mime: "text/markdown", isText: true, mtime: 1, size: 10 }),
        textContent: jest.fn().mockResolvedValue("# A report"),
        contentUrl: jest.fn().mockRejectedValue(new Error("Unavailable")),
        download: jest.fn(),
    } as unknown as FilesApiLike;
    const client = { filesApi: () => api } as unknown as MatronJournalClient;
    await act(async () => root.render(<Harness client={client} path={path} />));
    const opener = container.querySelector("a")!;
    await act(async () => opener.click());
    return { opener, api, client };
}

it("reads just one file through the Files API, and Escape restores focus to the clicked link", async () => {
    const { opener, api } = await open();
    expect(container.querySelector("aside h1")?.textContent).toBe("A report");
    expect(api.fileMeta).toHaveBeenCalledWith("/home/report.md", expect.any(AbortSignal));
    expect(container.querySelector(".mj_MdPreview_name")?.getAttribute("title")).toBe("/home/report.md");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close preview");
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(container.querySelector("aside")).toBeNull();
    expect(document.activeElement).toBe(opener);
});

it.each([403, 404, 413])("reports preview failure %s without explorer navigation", async (status) => {
    await open(new JournalApiError("File unavailable", status));
    expect(container.querySelector("[role='alert']")?.textContent).toContain(messageForFileStatus(status));
});

it("opens a hash present before the viewer mounts and handles later hash changes", async () => {
    window.history.replaceState(null, "", "/#files=%2Fhome%2Fboot.md");
    await open();
    expect(window.location.hash).toBe("");
    await act(async () => {
        window.history.replaceState(null, "", "/#files=%2Fhome%2Fnext.md");
        window.dispatchEvent(new Event("hashchange"));
    });
    expect(container.querySelector(".mj_MdPreview_name")?.textContent).toBe("next.md");
    expect(window.location.hash).toBe("");
});

it("opens an unsupported hash-linked file's authenticated bytes in a browser tab", async () => {
    const browser = jest.spyOn(window, "open").mockImplementation(() => null);
    const api = {
        fileMeta: jest
            .fn()
            .mockResolvedValue({ kind: "file", mime: "application/zip", isText: false, mtime: 2, size: 10 }),
        contentUrl: jest.fn().mockResolvedValue("blob:file-archive"),
        download: jest.fn(),
    } as unknown as FilesApiLike;
    await act(async () =>
        root.render(
            <Harness client={{ filesApi: () => api } as unknown as MatronJournalClient} path="/home/archive.zip" />,
        ),
    );
    await act(async () => container.querySelector("a")!.click());
    expect(browser).toHaveBeenCalledWith("blob:file-archive", "_blank", "noopener,noreferrer");
    expect(container.querySelector("aside")).toBeNull();
    browser.mockRestore();
});

it("opens the original signed bridge link in a browser tab when metadata is unavailable", async () => {
    const browser = jest.spyOn(window, "open").mockImplementation(() => null);
    const client = {
        filesApi: () => ({ fileMeta: jest.fn().mockRejectedValue(new Error("Unavailable")), download: jest.fn() }),
    } as unknown as MatronJournalClient;
    await act(async () => root.render(<Harness client={client} />));
    const opener = container.querySelector("a")!;
    opener.href = "https://bridge.example/view?token=signed";
    await act(async () => opener.click());
    expect(browser).toHaveBeenCalledWith(opener.href, "_blank", "noopener,noreferrer");
    expect(container.querySelector("aside")).toBeNull();
    browser.mockRestore();
});
