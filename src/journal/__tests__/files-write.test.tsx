/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Files-pane write UI (Phase 2, T-3.2/T-3.3). The load-bearing assertions here are the two that
 * protect a live deploy: (1) with `writable:false` the pane renders ZERO write affordances, so the
 * dormant backend shows exactly the Phase-1 read-only browser; (2) no destructive call reaches
 * FilesApi without the operator passing through the confirm dialog.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../api";
import { FilesPane } from "../files/FilesPane";
import type { FileEntry, FileListing, FilesApiLike } from "../files/filesApi";
import type { MatronJournalClient } from "../client";
import type { ClientState } from "../types";

// react-window measures its own box; jsdom reports 0 height and would render no rows. Swap it for a
// plain list so the row affordances are actually in the DOM (the virtualization itself is not what
// this suite is testing).
jest.mock("react-window", () => {
    const react = jest.requireActual<typeof import("react")>("react");
    return {
        List: ({
            rowComponent: Row,
            rowCount,
            rowProps,
        }: {
            rowComponent: React.ComponentType<Record<string, unknown>>;
            rowCount: number;
            rowProps: Record<string, unknown>;
        }) =>
            react.createElement(
                "div",
                null,
                Array.from({ length: rowCount }, (_unused, index) =>
                    react.createElement(Row, { key: index, index, style: {}, ...rowProps }),
                ),
            ),
    };
});

const DIR = "/root/.openclaw/workspace";
const ENTRIES: FileEntry[] = [
    { name: "src", kind: "dir", size: 0, mtime: 1, mime: "" },
    { name: "notes.md", kind: "file", size: 120, mtime: 1, mime: "text/markdown" },
];

function listing(writable: boolean): FileListing {
    return { path: DIR, root: DIR, parent: null, entries: ENTRIES, truncated: false, writable };
}

function mockApi(overrides: Partial<FilesApiLike> = {}): FilesApiLike {
    return {
        listDir: jest.fn().mockResolvedValue(listing(true)),
        fileMeta: jest
            .fn()
            .mockResolvedValue({ kind: "file", size: 120, mtime: 1, mime: "text/markdown", isText: true }),
        textContent: jest.fn().mockResolvedValue("# notes\n"),
        fileBytes: jest.fn(),
        contentUrl: jest.fn().mockResolvedValue("blob:mock/1"),
        download: jest.fn(),
        upload: jest.fn().mockResolvedValue({ path: `${DIR}/a.png`, bytes: 3, dryRun: false }),
        mkdir: jest.fn().mockResolvedValue({ path: `${DIR}/new`, dryRun: false }),
        move: jest.fn().mockResolvedValue({ from: `${DIR}/notes.md`, to: `${DIR}/n2.md`, dryRun: false }),
        writeFile: jest.fn().mockResolvedValue({ path: `${DIR}/notes.md`, bytes: 9, dryRun: false }),
        deleteEntry: jest.fn().mockResolvedValue({
            path: `${DIR}/notes.md`,
            trashed: `${DIR}/.matron-trash/x-notes.md`,
            alreadyMissing: false,
            dryRun: false,
        }),
        dispose: jest.fn(),
        ...overrides,
    } as unknown as FilesApiLike;
}

function mockClient(api: FilesApiLike): MatronJournalClient {
    return {
        filesApi: () => api,
        setFilesPath: jest.fn(),
        closeFilesView: jest.fn(),
    } as unknown as MatronJournalClient;
}

const STATE = { filesView: { open: true, path: DIR } } as unknown as ClientState;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// React tracks the previous value on the DOM node, so assigning `.value` directly is invisible to
// it — go through the prototype setter, exactly like the edit-file-sheet tests.
function setValue(element: Element | null, value: string): Promise<void> {
    expect(element).not.toBeNull();
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    return act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
    });
}

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function mountPane(api: FilesApiLike): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
        root = createRoot(container as HTMLDivElement);
        root.render(<FilesPane client={mockClient(api)} state={STATE} />);
    });
    await flush();
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
    });
}

function dialog(): HTMLElement | null {
    return document.querySelector(".mj_FileWrite");
}

describe("write affordances are capability-gated on the server's `writable` flag", () => {
    it("renders NOTHING writable when the server omits/denies the flag (dormant deploy parity)", async () => {
        const api = mockApi({ listDir: jest.fn().mockResolvedValue(listing(false)) });
        const pane = await mountPane(api);
        expect(pane.querySelector(".mj_FilesToolbar")).toBeNull();
        expect(pane.querySelector(".mj_FilesRow_actions")).toBeNull();
        expect(pane.querySelector(".mj_FilesPreview_bar")).toBeNull();
        expect(pane.querySelector('input[type="file"]')).toBeNull();
        // The read-only surface itself is untouched.
        expect(pane.querySelectorAll(".mj_FilesRow")).toHaveLength(ENTRIES.length);
    });

    it("renders the toolbar and per-row actions when the directory is writable", async () => {
        const pane = await mountPane(mockApi());
        expect(pane.querySelector(".mj_FilesToolbar")).not.toBeNull();
        expect(pane.querySelector('[aria-label="Delete notes.md"]')).not.toBeNull();
        expect(pane.querySelector('[aria-label="Rename src"]')).not.toBeNull();
    });
});

describe("destructive writes require the confirm dialog", () => {
    it("clicking Delete opens the confirm dialog and calls NOTHING until it is confirmed", async () => {
        const api = mockApi();
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        expect(dialog()).not.toBeNull();
        expect(api.deleteEntry).not.toHaveBeenCalled();
        // The dialog names the act and discloses the recovery path.
        expect(dialog()?.textContent).toContain("Delete file");
        expect(dialog()?.textContent).toContain(".matron-trash/");

        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(api.deleteEntry).toHaveBeenCalledWith(`${DIR}/notes.md`, { confirm: true, recursive: false });
        expect(dialog()).toBeNull();
        // The listing is re-read from the server and the trash destination is reported.
        expect((api.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(1);
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toContain(".matron-trash/");
    });

    it("a directory delete sends recursive:true", async () => {
        const api = mockApi();
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete src"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(api.deleteEntry).toHaveBeenCalledWith(`${DIR}/src`, { confirm: true, recursive: true });
    });

    it("Escape cancels while confirming, and issues no request", async () => {
        const api = mockApi();
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(dialog()).toBeNull();
        expect(api.deleteEntry).not.toHaveBeenCalled();
    });

    it("a second click cannot fire a second destructive request (double-submit guard)", async () => {
        let release: (() => void) | undefined;
        const deleteEntry = jest.fn(
            () =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({ path: `${DIR}/notes.md`, trashed: null, alreadyMissing: false, dryRun: false });
                }),
        );
        const api = mockApi({ deleteEntry: deleteEntry as unknown as FilesApiLike["deleteEntry"] });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        const confirm = document.querySelector(".mj_FileWrite_danger");
        await click(confirm);
        await click(confirm);
        expect(deleteEntry).toHaveBeenCalledTimes(1);
        // Mid-flight the dialog stays up and refuses to be dismissed.
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(dialog()).not.toBeNull();
        await act(async () => {
            release?.();
            await Promise.resolve();
        });
    });

    it("a denial keeps the dialog open with the uniform copy (no silent close)", async () => {
        const api = mockApi({
            deleteEntry: jest.fn().mockRejectedValue(new JournalApiError("nope", 409, "dir-not-empty")),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete src"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).not.toBeNull();
        expect(dialog()?.querySelector(".mj_UploadConfirm_error")?.textContent).toMatch(/conflicts/i);
    });
});

describe("non-destructive writes", () => {
    it("New folder posts the sanitized child path under the current directory", async () => {
        const api = mockApi();
        const pane = await mountPane(api);
        await click(pane.querySelector(".mj_FilesToolbar_button"));
        await setValue(document.querySelector(".mj_FileWrite_input"), "designs");
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(api.mkdir).toHaveBeenCalledWith(`${DIR}/designs`);
        expect(dialog()).toBeNull();
    });

    it("rename moves within the current directory and cannot submit an unchanged name", async () => {
        const api = mockApi();
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Rename notes.md"]'));
        const confirm = document.querySelector(".mj_FileWrite_confirm") as HTMLButtonElement;
        expect(confirm.disabled).toBe(true); // prefilled with the current name: nothing to do
        await setValue(document.querySelector(".mj_FileWrite_input"), "notes-2026.md");
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(api.move).toHaveBeenCalledWith(`${DIR}/notes.md`, `${DIR}/notes-2026.md`);
    });

    it("editing a text file saves with overwrite:true (the server trashes the prior version)", async () => {
        const api = mockApi();
        const pane = await mountPane(api);
        await click(pane.querySelector(".mj_FilesRow:not(.mj_FilesRow_dir)"));
        await flush();
        const edit = pane.querySelector(".mj_FilesPreview_edit");
        expect(edit).not.toBeNull();
        await click(edit);
        await flush();
        const textarea = document.querySelector(".mj_FileWrite_textarea") as HTMLTextAreaElement;
        expect(textarea.value).toBe("# notes\n"); // seeded from the CURRENT bytes on disk
        await setValue(textarea, "# notes 2\n");
        expect(dialog()?.textContent).toContain(".matron-trash/");
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(api.writeFile).toHaveBeenCalledWith(`${DIR}/notes.md`, "# notes 2\n", { overwrite: true });
    });

    it("does not offer inline editing for a binary file", async () => {
        const api = mockApi({
            listDir: jest.fn().mockResolvedValue({
                ...listing(true),
                entries: [{ name: "a.png", kind: "file", size: 10, mtime: 1, mime: "image/png" }],
            }),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector(".mj_FilesRow"));
        await flush();
        expect(pane.querySelector(".mj_FilesPreview_bar")).toBeNull();
    });
});
