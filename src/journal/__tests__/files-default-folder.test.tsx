/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Files pane default folder + not-found fallback. The pane hardcodes no host path: with nothing
 * remembered it asks the server for its default folder (a path-less listing). A remembered or
 * deep-linked folder that no longer lists (404 gone / 403 outside the read roots / 400 malformed)
 * falls back to that default with a notice instead of a dead-end error; transient failures keep
 * the error + Retry.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../api";
import type { MatronJournalClient } from "../client";
import { FilesPane } from "../files/FilesPane";
import type { FileEntry, FileListing, FilesApiLike } from "../files/filesApi";
import type { ClientState, FilesViewState } from "../types";

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

const HOME = "/srv/box/work";
const GONE = "/old/runtime/workspace";
const ENTRIES: FileEntry[] = [
    { name: "docs", kind: "dir", size: 0, mtime: 1, mime: "" },
    { name: "README.md", kind: "file", size: 12, mtime: 1, mime: "text/markdown" },
];
const defaultListing = (): FileListing => ({
    path: HOME,
    root: HOME,
    parent: null,
    entries: ENTRIES,
    truncated: false,
    writable: false,
});

/** listDir: the default (undefined) answers HOME; anything under GONE answers `failure`. */
function api(failure: JournalApiError, defaultAnswer: () => Promise<FileListing> = async () => defaultListing()) {
    const listDir = jest.fn((path: string | undefined) => {
        if (path === undefined) return defaultAnswer();
        if (path.startsWith(GONE)) return Promise.reject(failure);
        return Promise.resolve({ ...defaultListing(), path, parent: HOME });
    });
    const files = {
        listDir,
        fileMeta: jest.fn(),
        textContent: jest.fn(),
        fileBytes: jest.fn(),
        contentUrl: jest.fn(),
        download: jest.fn(),
        dispose: jest.fn(),
    } as unknown as FilesApiLike;
    const client = {
        filesApi: () => files,
        setFilesPath: jest.fn(),
        closeFilesView: jest.fn(),
    } as unknown as MatronJournalClient;
    return { files, client, listDir };
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
});

async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) {
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    }
}

async function mount(client: MatronJournalClient, filesView: FilesViewState): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    const state = { filesView } as unknown as ClientState;
    await act(async () => {
        root = createRoot(container as HTMLDivElement);
        root.render(<FilesPane client={client} state={state} />);
    });
    await flush();
    return container;
}

const rowNames = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(".mj_FilesRow_name")].map((node) => node.textContent ?? "");
const notice = (el: HTMLElement): string | undefined =>
    el.querySelector(".mj_FilesPane_fallback")?.textContent ?? undefined;
const errorText = (el: HTMLElement): string | undefined =>
    el.querySelector(".mj_FilesPreview_status_error")?.textContent ?? undefined;

describe("FilesPane default folder", () => {
    it("with nothing remembered, asks the server for its default folder (no hardcoded path)", async () => {
        const { client, listDir } = api(new JournalApiError("gone", 404, "not_found"));
        const el = await mount(client, { open: true });
        expect(listDir).toHaveBeenCalledTimes(1);
        expect(listDir.mock.calls[0][0]).toBeUndefined();
        expect(rowNames(el)).toEqual(["docs", "README.md"]);
        expect(el.querySelector(".mj_FilesBreadcrumb")?.textContent).toBe("work");
        // The server-resolved path is what gets remembered for a reopen.
        expect(client.setFilesPath).toHaveBeenCalledWith(HOME);
        expect(notice(el)).toBeUndefined();
    });

    it("browses into a folder of the default listing using the server-resolved path", async () => {
        const { client, listDir } = api(new JournalApiError("gone", 404, "not_found"));
        const el = await mount(client, { open: true });
        const docs = [...el.querySelectorAll<HTMLButtonElement>(".mj_FilesRow")].find((row) =>
            row.textContent?.includes("docs"),
        );
        await act(async () => docs!.click());
        await flush();
        expect(listDir.mock.calls.at(-1)?.[0]).toBe(`${HOME}/docs`);
    });

    it.each([
        [404, "not_found"],
        [403, "denied"],
        [400, "bad_request"],
    ])("a remembered folder answering %i falls back to the default folder with a notice", async (status, code) => {
        const { client, listDir } = api(new JournalApiError("x", status, code));
        const el = await mount(client, { open: true, path: GONE });
        expect(listDir.mock.calls.map(([path]) => path)).toEqual([GONE, undefined]);
        expect(rowNames(el)).toEqual(["docs", "README.md"]);
        expect(errorText(el)).toBeUndefined();
        expect(notice(el)).toContain(`Couldn't open ${GONE}. Showing the default folder instead.`);
        expect(client.setFilesPath).toHaveBeenCalledWith(HOME);
        expect(client.setFilesPath).not.toHaveBeenCalledWith(GONE);

        // Dismissable, and navigating on clears it too.
        await act(async () => el.querySelector<HTMLButtonElement>(".mj_FilesPane_fallback button")!.click());
        expect(notice(el)).toBeUndefined();
    });

    it.each([
        [500, "internal"],
        [401, "unauthorized"],
        [0, "timeout"],
    ])("a transient %i keeps the error and Retry (no fallback)", async (status, code) => {
        const { client, listDir } = api(new JournalApiError("x", status, code));
        const el = await mount(client, { open: true, path: GONE });
        expect(listDir.mock.calls.map(([path]) => path)).toEqual([GONE]);
        expect(errorText(el)).toBeDefined();
        expect(el.querySelector(".mj_FilesRetry")).not.toBeNull();
        expect(notice(el)).toBeUndefined();
    });

    it("a deep link into a folder that no longer lists falls back once, naming the file", async () => {
        const { client, listDir } = api(new JournalApiError("gone", 404, "not_found"));
        const target = `${GONE}/notes/plan.md`;
        const el = await mount(client, {
            open: true,
            path: `${GONE}/notes`,
            targetFile: target,
            targetToken: 1,
        });
        await flush();
        expect(rowNames(el)).toEqual(["docs", "README.md"]);
        expect(notice(el)).toContain(`Couldn't open ${target}.`);
        // The deep link is settled: it does not bounce back to the dead folder.
        const calls = listDir.mock.calls.map(([path]) => path);
        expect(calls.filter((path) => path === undefined)).toHaveLength(1);
        expect(calls.at(-1)).toBeUndefined();
    });

    it("an older journal without a default folder shows a clear message, not a loop", async () => {
        const { client, listDir } = api(new JournalApiError("gone", 404, "not_found"), () =>
            Promise.reject(new JournalApiError("bad", 400, "bad_request")),
        );
        const el = await mount(client, { open: true });
        expect(listDir).toHaveBeenCalledTimes(1);
        expect(errorText(el)).toContain("This server doesn't report a default folder.");
        expect(errorText(el)).not.toContain("no longer exists");
    });

    it("a remembered folder that is gone on an older journal ends on the clear message, once", async () => {
        const { client, listDir } = api(new JournalApiError("gone", 404, "not_found"), () =>
            Promise.reject(new JournalApiError("bad", 400, "bad_request")),
        );
        const el = await mount(client, { open: true, path: GONE });
        expect(listDir.mock.calls.map(([path]) => path)).toEqual([GONE, undefined]);
        expect(errorText(el)).toContain("This server doesn't report a default folder.");
        expect(notice(el)).toContain(`Couldn't open ${GONE}.`);
    });
});
