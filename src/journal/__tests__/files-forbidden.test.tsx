/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * An account the journal refuses the file routes to (403 `forbidden`) degrades to the hidden state:
 * the pane closes and the entry point / deep links stay off until sign-out. A per-path refusal
 * (`denied`) is an ordinary error inside the pane and does not hide anything.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../api";
import { MatronJournalClient } from "../client";
import { FilesPane } from "../files/FilesPane";
import { type FilesApiLike, isFilesForbidden } from "../files/filesApi";
import type { MatronJournalClient as ClientType } from "../client";
import type { ClientState } from "../types";

const DIR = "/home/user/project";

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
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
});

async function mountWithListError(error: JournalApiError): Promise<jest.Mock> {
    const api = {
        listDir: jest.fn().mockRejectedValue(error),
        dispose: jest.fn(),
    } as unknown as FilesApiLike;
    const markFilesUnavailable = jest.fn();
    const client = {
        filesApi: () => api,
        setFilesPath: jest.fn(),
        closeFilesView: jest.fn(),
        markFilesUnavailable,
    } as unknown as ClientType;
    const state = { filesView: { open: true, path: DIR } } as unknown as ClientState;
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
        root = createRoot(container as HTMLDivElement);
        root.render(<FilesPane client={client} state={state} />);
    });
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
    return markFilesUnavailable;
}

describe("isFilesForbidden", () => {
    it("is true only for a 403 carrying the account-level `forbidden` code", () => {
        expect(isFilesForbidden(403, "forbidden")).toBe(true);
        expect(isFilesForbidden(403, "denied")).toBe(false);
        expect(isFilesForbidden(403, undefined)).toBe(false);
        expect(isFilesForbidden(404, "forbidden")).toBe(false);
        expect(isFilesForbidden(undefined, undefined)).toBe(false);
    });
});

describe("FilesPane on a refused listing", () => {
    it("hides Files for the session on 403 forbidden", async () => {
        const mark = await mountWithListError(new JournalApiError("nope", 403, "forbidden"));
        expect(mark).toHaveBeenCalledTimes(1);
    });

    it("keeps the pane (with its error) on a per-path 403 denied", async () => {
        const mark = await mountWithListError(new JournalApiError("nope", 403, "denied"));
        expect(mark).not.toHaveBeenCalled();
        expect(container?.textContent).toContain("can't be accessed");
    });
});

describe("client.markFilesUnavailable", () => {
    function signedInClient(): MatronJournalClient {
        const client = new MatronJournalClient();
        (client as unknown as { state: ClientState }).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            config: { files_root: DIR },
            filesView: { open: true, path: DIR },
        };
        return client;
    }

    it("closes the pane and makes later deep links no-ops", () => {
        const client = signedInClient();
        client.markFilesUnavailable();
        expect(client.getSnapshot().filesUnavailable).toBe(true);
        expect(client.getSnapshot().filesView).toBeUndefined();

        window.location.hash = `#files=${encodeURIComponent(`${DIR}/notes.md`)}`;
        client.applyFilesDeepLink();
        expect(client.getSnapshot().filesView).toBeUndefined();
    });
});
