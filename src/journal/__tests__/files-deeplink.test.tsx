/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Files deep link (#files=<abs>). Two halves, matching the two code paths:
 *   1. client.applyFilesDeepLink parses the hash into filesView {path=dir, targetFile=abs} and
 *      clears the fragment (so refresh/back never re-fires), and no-ops on a foreign/malformed hash
 *      or before sign-in.
 *   2. FilesPane auto-opens the target's preview once its directory listing lands, and quietly does
 *      nothing when the target file is absent from the listing.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../client";
import { FilesPane } from "../files/FilesPane";
import type { FileEntry, FileListing, FilesApiLike } from "../files/filesApi";
import type { MatronJournalClient as ClientType } from "../client";
import type { ClientState, FilesViewState } from "../types";

// jsdom reports 0 height for react-window's own box; swap it for a plain list so the rows land in
// the DOM (same shim the files-write suite uses — virtualization is not what this tests).
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
const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const ENTRIES: FileEntry[] = [
    { name: "src", kind: "dir", size: 0, mtime: 1, mime: "" },
    { name: "dan-offer.md", kind: "file", size: 120, mtime: 1, mime: "text/markdown" },
];

function listing(): FileListing {
    return { path: DIR, root: DIR, parent: null, entries: ENTRIES, truncated: false, writable: false };
}

function mockApi(overrides: Partial<FilesApiLike> = {}): FilesApiLike {
    return {
        listDir: jest.fn().mockResolvedValue(listing()),
        fileMeta: jest
            .fn()
            .mockResolvedValue({ kind: "file", size: 120, mtime: 1, mime: "text/markdown", isText: true }),
        textContent: jest.fn().mockResolvedValue("# offer\n"),
        fileBytes: jest.fn(async () => encode("# offer\n")),
        contentUrl: jest.fn().mockResolvedValue("blob:mock/1"),
        download: jest.fn(),
        dispose: jest.fn(),
        ...overrides,
    } as unknown as FilesApiLike;
}

function mockClient(api: FilesApiLike): ClientType {
    return {
        filesApi: () => api,
        setFilesPath: jest.fn(),
        closeFilesView: jest.fn(),
    } as unknown as ClientType;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    // Reset the hash between cases so the next test starts clean.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
});

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function mountPane(api: FilesApiLike, filesView: FilesViewState): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    const state = { filesView } as unknown as ClientState;
    await act(async () => {
        root = createRoot(container as HTMLDivElement);
        root.render(<FilesPane client={mockClient(api)} state={state} />);
    });
    await flush();
    return container;
}

// Force a signed-in phase without standing up a session — applyFilesDeepLink gates on it.
function signedInClient(): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
    };
    return client;
}

describe("client.applyFilesDeepLink", () => {
    it("parses #files=<abs> into { path=dir, targetFile=abs } and clears the hash", () => {
        const abs = `${DIR}/dan-offer.md`;
        window.location.hash = `#files=${encodeURIComponent(abs)}`;
        const client = signedInClient();
        client.applyFilesDeepLink();
        expect(client.getSnapshot().filesView).toEqual({ open: true, path: DIR, targetFile: abs });
        // Fragment cleared so a refresh / back-button does not re-trigger.
        expect(window.location.hash).toBe("");
    });

    it("handles a root-level file (dirname collapses to '/')", () => {
        window.location.hash = `#files=${encodeURIComponent("/etc-note.txt")}`;
        const client = signedInClient();
        client.applyFilesDeepLink();
        expect(client.getSnapshot().filesView).toEqual({ open: true, path: "/", targetFile: "/etc-note.txt" });
    });

    it("ignores a foreign hash and leaves it intact", () => {
        window.location.hash = "#msg=42";
        const client = signedInClient();
        client.applyFilesDeepLink();
        expect(client.getSnapshot().filesView).toBeUndefined();
        expect(window.location.hash).toBe("#msg=42");
    });

    it("ignores a non-absolute target", () => {
        window.location.hash = "#files=relative/path.md";
        const client = signedInClient();
        client.applyFilesDeepLink();
        expect(client.getSnapshot().filesView).toBeUndefined();
    });

    it("no-ops before sign-in and preserves the hash for a later hashchange", () => {
        const abs = `${DIR}/dan-offer.md`;
        window.location.hash = `#files=${encodeURIComponent(abs)}`;
        const client = new MatronJournalClient(); // phase: "loading"
        client.applyFilesDeepLink();
        expect(client.getSnapshot().filesView).toBeUndefined();
        expect(window.location.hash).toBe(`#files=${encodeURIComponent(abs)}`);
    });
});

describe("FilesPane deep-link auto-preview", () => {
    it("auto-selects the target file once its directory listing lands", async () => {
        const pane = await mountPane(mockApi(), { open: true, path: DIR, targetFile: `${DIR}/dan-offer.md` });
        const selectedRow = pane.querySelector(".mj_FilesRow_selected");
        expect(selectedRow).not.toBeNull();
        expect(selectedRow?.textContent).toContain("dan-offer.md");
        expect(selectedRow?.getAttribute("aria-current")).toBe("true");
    });

    it("selects nothing when the target file is absent from the listing", async () => {
        const pane = await mountPane(mockApi(), { open: true, path: DIR, targetFile: `${DIR}/missing.md` });
        expect(pane.querySelector(".mj_FilesRow_selected")).toBeNull();
        // The read-only listing itself is untouched.
        expect(pane.querySelectorAll(".mj_FilesRow")).toHaveLength(ENTRIES.length);
    });

    it("does not auto-select when no targetFile is set (plain open)", async () => {
        const pane = await mountPane(mockApi(), { open: true, path: DIR });
        expect(pane.querySelector(".mj_FilesRow_selected")).toBeNull();
    });
});
