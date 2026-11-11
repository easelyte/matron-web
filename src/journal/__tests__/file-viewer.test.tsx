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
        listDir: jest.fn(),
        fileMeta: error
            ? jest.fn().mockRejectedValue(error)
            : jest.fn().mockResolvedValue({ kind: "file", mime: "text/markdown", isText: true, mtime: 1, size: 10 }),
        textContent: jest.fn().mockResolvedValue("# A report"),
        download: jest.fn(),
    } as unknown as FilesApiLike;
    const client = { filesApi: () => api, openFilesView: jest.fn() } as unknown as MatronJournalClient;
    await act(async () => root.render(<Harness client={client} path={path} />));
    const opener = container.querySelector("a")!;
    await act(async () => opener.click());
    return { opener, api, client };
}

it("reads just one file through the Files API, and Escape restores focus to the clicked link", async () => {
    const { opener, api } = await open();
    expect(container.querySelector("aside h1")?.textContent).toBe("A report");
    expect(api.fileMeta).toHaveBeenCalledWith("/home/report.md", expect.any(AbortSignal));
    expect(api.listDir).not.toHaveBeenCalled();
    expect(container.querySelector(".mj_MdPreview_name")?.getAttribute("title")).toBe("/home/report.md");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close preview");
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(container.querySelector("aside")).toBeNull();
    expect(document.activeElement).toBe(opener);
});

it.each(["/home/report.md", "/report.md"])(
    "Show in Files closes the panel and selects %s in its directory",
    async (path) => {
        const { client } = await open(undefined, path);
        const show = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Show in Files",
        )!;
        await act(async () => show.click());
        expect(container.querySelector("aside")).toBeNull();
        expect(client.openFilesView).toHaveBeenCalledWith(path === "/report.md" ? "/" : "/home", path);
    },
);

it.each([403, 404, 413])("retains Show in Files when the normal preview reports %s", async (status) => {
    await open(new JournalApiError("File unavailable", status));
    expect(container.querySelector("[role='alert']")?.textContent).toContain(messageForFileStatus(status));
    expect(container.textContent).toContain("Show in Files");
});

it("shows an offline error with Show in Files still available", async () => {
    await open(new Error("Offline"));
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Offline");
    expect(container.textContent).toContain("Show in Files");
});
