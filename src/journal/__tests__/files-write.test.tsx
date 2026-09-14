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
import { REPLAY_WINDOW_MS } from "../files/limits";
import { useFileWrites } from "../files/useFileWrites";

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
const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
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
        // The inline editor loads through fileBytes (strict UTF-8 decode), not textContent.
        fileBytes: jest.fn(async () => encode("# notes\n")),
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

/** Select the (only) file row, then open the inline editor on it. */
async function openEditor(pane: HTMLDivElement): Promise<void> {
    await click(pane.querySelector(".mj_FilesRow:not(.mj_FilesRow_dir)"));
    await flush();
    await click(pane.querySelector(".mj_FilesPreview_edit"));
    await flush();
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
        expect(api.move).toHaveBeenCalledWith(`${DIR}/notes.md`, `${DIR}/notes-2026.md`, {
            idempotencyKey: expect.any(String),
        });
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
        expect(api.writeFile).toHaveBeenCalledWith(`${DIR}/notes.md`, "# notes 2\n", {
            overwrite: true,
            idempotencyKey: expect.any(String),
        });
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

// -- Findings from the Codex adversarial review (F1/F2/F3) ---------------------------------------

describe("write lifecycle under the real app shell", () => {
    it("survives StrictMode's setup/cleanup/setup effect replay (no wedged `mutating`)", async () => {
        // The app entry point mounts under React.StrictMode. An `alive` flag that is only set at
        // ref init would be left false by the first cleanup, so every later write would mutate the
        // server and then drop its own outcome, freezing the dialog in `mutating` forever.
        const api = mockApi();
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container as HTMLDivElement);
            root.render(
                <React.StrictMode>
                    <FilesPane client={mockClient(api)} state={STATE} />
                </React.StrictMode>,
            );
        });
        await flush();
        await click(container.querySelector('[aria-label="Delete notes.md"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(api.deleteEntry).toHaveBeenCalledTimes(1);
        expect(dialog()).toBeNull(); // the outcome was applied, not discarded
    });

    it("reuses ONE idempotency key when the outcome was UNCERTAIN (the retry must replay)", async () => {
        const writeFile = jest
            .fn()
            .mockRejectedValueOnce(new JournalApiError("timed out", 0, "timeout"))
            .mockResolvedValue({ path: `${DIR}/notes.md`, bytes: 9, dryRun: false });
        const api = mockApi({ writeFile: writeFile as unknown as FilesApiLike["writeFile"] });
        const pane = await mountPane(api);
        await openEditor(pane);
        await setValue(document.querySelector(".mj_FileWrite_textarea"), "# edited\n");

        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).not.toBeNull(); // failed -> back to confirming, with the error
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();

        expect(writeFile).toHaveBeenCalledTimes(2);
        const first = writeFile.mock.calls[0][2] as { idempotencyKey?: string };
        const second = writeFile.mock.calls[1][2] as { idempotencyKey?: string };
        expect(first.idempotencyKey).toBeTruthy();
        expect(second.idempotencyKey).toBe(first.idempotencyKey);
    });

    it("mints a FRESH key after a definite refusal (the operator is told to change the name)", async () => {
        // The server fingerprints key + payload and rejects a key reused with a different request,
        // so carrying the key into a renamed retry would 409 forever.
        const move = jest
            .fn()
            .mockRejectedValueOnce(new JournalApiError("exists", 409, "dest-exists"))
            .mockResolvedValue({ from: `${DIR}/notes.md`, to: `${DIR}/n3.md`, dryRun: false });
        const api = mockApi({ move: move as unknown as FilesApiLike["move"] });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Rename notes.md"]'));
        await setValue(document.querySelector(".mj_FileWrite_input"), "taken.md");
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(dialog()?.querySelector(".mj_UploadConfirm_error")).not.toBeNull();
        await setValue(document.querySelector(".mj_FileWrite_input"), "n3.md");
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        expect(move).toHaveBeenCalledTimes(2);
        const first = move.mock.calls[0][2] as { idempotencyKey?: string };
        const second = move.mock.calls[1][2] as { idempotencyKey?: string };
        expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    });

    it("refuses to save an edit whose file changed on the server after it was opened", async () => {
        let served = "# notes\n";
        const api = mockApi({ fileBytes: jest.fn(async () => encode(served)) as unknown as FilesApiLike["fileBytes"] });
        const pane = await mountPane(api);
        await openEditor(pane);
        await setValue(document.querySelector(".mj_FileWrite_textarea"), "# my stale edit\n");
        served = "# rewritten by an agent while the editor sat open\n";
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(api.writeFile).not.toHaveBeenCalled();
        expect(dialog()?.querySelector(".mj_UploadConfirm_error")?.textContent).toMatch(/changed on the server/i);
    });
});

describe("uncertain outcomes (Codex round 2)", () => {
    it("resolves an ambiguous edit success instead of deadlocking on the stale-edit guard", async () => {
        // The write committed but its response was lost; the retry finds the file already equal to
        // the draft. That is "already saved", not "someone else changed this".
        let served = "# notes\n";
        const api = mockApi({
            fileBytes: jest.fn(async () => encode(served)) as unknown as FilesApiLike["fileBytes"],
            writeFile: jest
                .fn()
                .mockRejectedValueOnce(
                    new JournalApiError("timed out", 0, "timeout"),
                ) as unknown as FilesApiLike["writeFile"],
        });
        const pane = await mountPane(api);
        await openEditor(pane);
        await setValue(document.querySelector(".mj_FileWrite_textarea"), "# edited\n");
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).not.toBeNull(); // the timeout left the outcome unknown

        served = "# edited\n"; // ...the first attempt had in fact landed
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/already saved/i);
    });

    it("does not offer a blind retry when a DELETE's outcome is unknown", async () => {
        // DELETE carries no idempotency key in the wire contract, so a retry is a fresh mutation:
        // if the first one committed and the path was recreated, the retry hits the replacement.
        const api = mockApi({
            deleteEntry: jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout")),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).toBeNull(); // closed, not left sitting on a "Try again" button
        expect((api.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(1); // listing refreshed
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/couldn't confirm/i);
    });

    it("makes the pane inert and pulls focus into the dialog while a write is pending", async () => {
        // `aria-modal` without this is a lie: focus could reach "Close files" behind the scrim and
        // unmount the pane mid-delete, discarding the outcome, the refresh and the trash path.
        const api = mockApi();
        const pane = await mountPane(api);
        const top = pane.querySelector(".mj_FilesPane_top") as HTMLElement;
        const body = pane.querySelector(".mj_FilesPane_body") as HTMLElement;
        expect(top.hasAttribute("inert")).toBe(false);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        expect(top.hasAttribute("inert")).toBe(true);
        expect(body.hasAttribute("inert")).toBe(true);
        expect(dialog()?.contains(document.activeElement)).toBe(true);
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(top.hasAttribute("inert")).toBe(false); // restored on dismiss
    });

    it("a definite server denial still keeps the delete dialog open for a retry", async () => {
        const api = mockApi({
            deleteEntry: jest.fn().mockRejectedValue(new JournalApiError("nope", 409, "dir-not-empty")),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete src"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).not.toBeNull();
    });

    it("refuses to edit a file whose bytes are not valid UTF-8 (strict decode, not a U+FFFD sniff)", async () => {
        const api = mockApi({
            // Lone continuation bytes: invalid UTF-8, which a FATAL decoder rejects.
            fileBytes: jest.fn(async () => new Uint8Array([0x41, 0xff, 0xfe, 0x42]).buffer),
        });
        const pane = await mountPane(api);
        await openEditor(pane);
        expect(document.querySelector(".mj_FileWrite_textarea")).toBeNull();
        expect(dialog()?.textContent).toMatch(/isn't valid UTF-8/i);
        // The refusal is load-bearing: Save must be disabled, not merely visually discouraged.
        expect((document.querySelector(".mj_FileWrite_danger") as HTMLButtonElement).disabled).toBe(true);
    });
});

// -- Confirming round on the round-3 fix (the fix itself left two blockers) -----------------------

/** A jsdom-usable stand-in for the FileList a real <input type="file"> hands back. */
function fileList(files: File[]): FileList {
    return {
        ...files,
        length: files.length,
        item: (index: number) => files[index] ?? null,
        [Symbol.iterator]: function* () {
            yield* files;
        },
    } as unknown as FileList;
}

async function pickUpload(pane: HTMLDivElement, ...files: File[]): Promise<void> {
    const input = pane.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    Object.defineProperty(input, "files", { value: fileList(files), configurable: true });
    await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
    });
}

/** A promise the test resolves by hand, so a request can be held mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("an UNCERTAIN outcome binds the payload (Codex confirming round, F1)", () => {
    it("locks the upload name while the outcome is unresolved and replays the ORIGINAL payload", async () => {
        // The upload commits but its response is lost. If the operator may now edit "Save as", the
        // retry sends a DIFFERENT payload under the RETAINED key; the server fingerprints key+body,
        // answers 409, the client reads that as definite and mints a fresh key — and the next retry
        // uploads a SECOND copy alongside the one that silently committed.
        const upload = jest
            .fn()
            .mockRejectedValueOnce(new JournalApiError("timed out", 0, "timeout"))
            .mockResolvedValue({ path: `${DIR}/shot.png`, bytes: 3, dryRun: false });
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        expect(dialog()).not.toBeNull();

        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(dialog()).not.toBeNull(); // failed -> back to confirming, with the error

        // The name is no longer the operator's to change: the first attempt may have landed.
        const field = document.querySelector(".mj_FileWrite_input") as HTMLInputElement;
        expect(field.disabled).toBe(true);
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).not.toBeNull();

        // Even if something did change it, the retry re-sends what was actually attempted.
        await setValue(field, "renamed.png");
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        expect(upload).toHaveBeenCalledTimes(2);
        const first = upload.mock.calls[0][1] as { name?: string; idempotencyKey?: string };
        const second = upload.mock.calls[1][1] as { name?: string; idempotencyKey?: string };
        expect(second.name).toBe(first.name);
        expect(second.idempotencyKey).toBe(first.idempotencyKey);
    });

    it("refreshes the listing when an unresolved write is dismissed instead of retried", async () => {
        // Cancel is the escape hatch from the bound payload. It must not drop the operator back
        // into a stale listing, or they re-upload under a fresh key and duplicate anyway.
        const api = mockApi({
            upload: jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout")),
        });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        const listings = (api.listDir as jest.Mock).mock.calls.length;

        await click(dialog()?.querySelector(".mj_UploadConfirm_skip") ?? null);
        await flush();
        expect(dialog()).toBeNull();
        expect((api.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(listings);
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/couldn't confirm/i);
    });

    it("still mints a fresh key after a DEFINITE refusal (round-1 behaviour is not regressed)", async () => {
        const move = jest
            .fn()
            .mockRejectedValueOnce(new JournalApiError("exists", 409, "dest-exists"))
            .mockResolvedValue({ from: `${DIR}/notes.md`, to: `${DIR}/n3.md`, dryRun: false });
        const api = mockApi({ move: move as unknown as FilesApiLike["move"] });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Rename notes.md"]'));
        await setValue(document.querySelector(".mj_FileWrite_input"), "taken.md");
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        // A definite refusal leaves the name editable — nothing happened, so there is nothing to
        // reconcile and the operator is being ASKED to pick another name.
        expect((document.querySelector(".mj_FileWrite_input") as HTMLInputElement).disabled).toBe(false);
        await setValue(document.querySelector(".mj_FileWrite_input"), "n3.md");
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(move.mock.calls[1][1]).toBe(`${DIR}/n3.md`);
    });
});

describe("the modal contains focus while a request is in flight (Codex confirming round, F2)", () => {
    it("holds focus on the card and swallows Tab when every control is disabled", async () => {
        // Mid-delete every control is disabled, so the trap's focusable list is EMPTY. Returning
        // without preventing Tab lets focus walk out to the conversation list behind the scrim,
        // where activating a room closes filesView and unmounts the hook — discarding the outcome,
        // the refresh and the trash location while the delete may still commit.
        const held = deferred<unknown>();
        const api = mockApi({ deleteEntry: jest.fn(() => held.promise) as unknown as FilesApiLike["deleteEntry"] });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));

        const card = dialog() as HTMLElement;
        expect(card.querySelectorAll("button:not([disabled]), input:not([disabled])")).toHaveLength(0);
        expect(card.contains(document.activeElement)).toBe(true);

        const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        await act(async () => {
            document.dispatchEvent(tab);
        });
        expect(tab.defaultPrevented).toBe(true);
        expect(card.contains(document.activeElement)).toBe(true);

        await act(async () => {
            held.resolve({ path: `${DIR}/notes.md`, trashed: null, alreadyMissing: false, dryRun: false });
            await Promise.resolve();
        });
    });

    it("makes every application sibling behind the scrim inert, and restores them on dismiss", async () => {
        // The pane's own `inert` is not enough: the conversation sidebar is a sibling of the pane,
        // not a child of it.
        const sidebar = document.createElement("div");
        sidebar.className = "mx_ConversationList";
        document.body.append(sidebar);
        const preInert = document.createElement("div");
        preInert.setAttribute("inert", "");
        document.body.append(preInert);
        try {
            const api = mockApi();
            const pane = await mountPane(api);
            expect(sidebar.hasAttribute("inert")).toBe(false);

            await click(pane.querySelector('[aria-label="Delete notes.md"]'));
            expect(sidebar.hasAttribute("inert")).toBe(true);

            await act(async () => {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            });
            expect(sidebar.hasAttribute("inert")).toBe(false);
            // Something that was ALREADY inert is left exactly as it was found.
            expect(preInert.hasAttribute("inert")).toBe(true);
        } finally {
            sidebar.remove();
            preInert.remove();
        }
    });
});

describe("a UTF-8 BOM survives an edit (Codex confirming round, F3)", () => {
    it("round-trips the leading U+FEFF instead of silently dropping three valid bytes", async () => {
        const api = mockApi({
            fileBytes: jest.fn(async () => encode("﻿# notes\n")) as unknown as FilesApiLike["fileBytes"],
        });
        const pane = await mountPane(api);
        await openEditor(pane);
        const textarea = document.querySelector(".mj_FileWrite_textarea") as HTMLTextAreaElement;
        expect(textarea.value).toBe("﻿# notes\n");

        await setValue(textarea, "﻿# notes 2\n");
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(api.writeFile).toHaveBeenCalledWith(`${DIR}/notes.md`, "﻿# notes 2\n", {
            overwrite: true,
            idempotencyKey: expect.any(String),
        });
    });
});

// -- Round 1 on the fix above: classify the outcome by ORIGIN, not by HTTP status ----------------

describe("an unreadable SUCCESS is an unresolved outcome, not a refusal", () => {
    it("does not offer a blind retry when a DELETE's 2xx reply could not be parsed", async () => {
        // `filesApi.fetchJson` keeps the RESPONSE status when JSON.parse fails, so a committed
        // delete whose body was truncated arrives as a status-200 error. Read as a definite
        // refusal it bypasses the no-blind-retry path, and the retry deletes whatever now sits at
        // that path — including a replacement another actor just created.
        const api = mockApi({
            deleteEntry: jest.fn().mockRejectedValue(new JournalApiError("The server returned malformed JSON.", 200)),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/couldn't confirm/i);
    });

    it("pins the payload after an upload whose 2xx reply could not be parsed", async () => {
        const upload = jest
            .fn()
            .mockRejectedValueOnce(new JournalApiError("The server returned malformed JSON.", 200))
            .mockResolvedValue({ path: `${DIR}/shot.png`, bytes: 3, dryRun: false });
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        expect((document.querySelector(".mj_FileWrite_input") as HTMLInputElement).disabled).toBe(true);
        expect(dialog()?.querySelector(".mj_UploadConfirm_error")?.textContent).toMatch(/unconfirmed/i);
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect((upload.mock.calls[1][1] as { idempotencyKey?: string }).idempotencyKey).toBe(
            (upload.mock.calls[0][1] as { idempotencyKey?: string }).idempotencyKey,
        );
    });
});

describe("a LOCAL refusal is definite — nothing was sent", () => {
    it("leaves a stale-edit draft editable instead of pinning it as an unresolved write", async () => {
        // The staleness check refuses BEFORE writeFile is called. Classified by status alone it
        // looks exactly like a lost response, which would lock the editor and tell the operator
        // their save may have gone through — of a request that was never issued.
        let served = "# notes\n";
        const api = mockApi({ fileBytes: jest.fn(async () => encode(served)) as unknown as FilesApiLike["fileBytes"] });
        const pane = await mountPane(api);
        await openEditor(pane);
        await setValue(document.querySelector(".mj_FileWrite_textarea"), "# my stale edit\n");
        served = "# rewritten by an agent while the editor sat open\n";
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();

        expect(api.writeFile).not.toHaveBeenCalled();
        expect((document.querySelector(".mj_FileWrite_textarea") as HTMLTextAreaElement).disabled).toBe(false);
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).toBeNull();
    });

    it("leaves the editor usable when the file stopped being UTF-8 text (not-text is local too)", async () => {
        // Same class as the stale-edit guard: the re-read happens HERE, and refuses before any
        // write is issued. Pinning it would lock the editor over a mutation that never existed.
        let served = encode("# notes\n");
        const api = mockApi({ fileBytes: jest.fn(async () => served) as unknown as FilesApiLike["fileBytes"] });
        const pane = await mountPane(api);
        await openEditor(pane);
        await setValue(document.querySelector(".mj_FileWrite_textarea"), "# edited\n");
        served = new Uint8Array([0xff, 0xfe, 0xff]).buffer as ArrayBuffer; // no longer decodable
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();

        expect(api.writeFile).not.toHaveBeenCalled();
        expect((document.querySelector(".mj_FileWrite_textarea") as HTMLTextAreaElement).disabled).toBe(false);
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).toBeNull();
        expect(dialog()?.querySelector(".mj_UploadConfirm_error")?.textContent).toMatch(/valid UTF-8/i);
    });
});

describe("the reconciling re-read is a barrier, not just a message", () => {
    it("offers no way to start a new write while the reconciling listing is still in flight", async () => {
        // Backing out of an unresolved write must not drop the operator into a directory view they
        // can immediately act on: `writable` is derived from the CURRENT listing, so re-reading it
        // takes every write affordance away until the server answers.
        const first = { ...listing(true) };
        let holdSecond: ((value: FileListing) => void) | undefined;
        let call = 0;
        const listDir = jest.fn(() => {
            call += 1;
            if (call === 1) return Promise.resolve(first);
            return new Promise<FileListing>((resolve) => {
                holdSecond = resolve;
            });
        });
        const api = mockApi({
            listDir: listDir as unknown as FilesApiLike["listDir"],
            upload: jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout")),
        });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        await click(dialog()?.querySelector(".mj_UploadConfirm_skip") ?? null);
        await flush();

        // The re-read is out on the wire and has not answered.
        expect(listDir).toHaveBeenCalledTimes(2);
        expect(pane.querySelector(".mj_FilesToolbar")).toBeNull();
        expect(pane.querySelector('input[type="file"]')).toBeNull();
        expect(pane.querySelector(".mj_FilesRow_actions")).toBeNull();
        expect(pane.querySelector(".mj_FilesPreview_edit")).toBeNull();

        await act(async () => {
            holdSecond?.(listing(true));
            await Promise.resolve();
        });
        await flush();
        expect(pane.querySelector(".mj_FilesToolbar")).not.toBeNull(); // ...and back once it lands
    });
});

// -- Round 2: a gateway 5xx is not a verdict, and a pin is only a replay while the key lives -----

describe("a gateway failure is an unresolved outcome (Codex round 2, F1)", () => {
    it("does not offer a blind retry when a DELETE comes back 502", async () => {
        // A proxy that lost an upstream success it never saw is indistinguishable from one that
        // stopped the request — except that the first one committed. Retrying deletes whatever
        // now occupies the path.
        const api = mockApi({
            deleteEntry: jest.fn().mockRejectedValue(new JournalApiError("bad gateway", 502)),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/couldn't confirm/i);
    });

    it("treats 507 as unknown too — a bare status does not authenticate its origin (round 3, F2)", async () => {
        // OUR server raises 507 only from write-ahead gates, so from the journal it would prove
        // non-mutation. But nothing on the wire says the 507 CAME from the journal: any
        // intermediary can emit one, and a proxy that ran out of storage relaying a response has
        // already let the write through. Believing the status means a retried delete removes the
        // replacement. The conservative reading is the only sound one until the origin is provable.
        const api = mockApi({
            deleteEntry: jest.fn().mockRejectedValue(new JournalApiError("no room", 507)),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/couldn't confirm/i);
    });
});

describe("a pinned replay expires before the server forgets the key (Codex round 2, F2)", () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ["queueMicrotask"] }));
    afterEach(() => jest.useRealTimers());

    async function pinAnUncertainUpload(api: FilesApiLike): Promise<HTMLDivElement> {
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).not.toBeNull();
        return pane;
    }

    it("stops offering the retry and reconciles once the replay window lapses", async () => {
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await pinAnUncertainUpload(api);

        await act(async () => {
            jest.advanceTimersByTime(REPLAY_WINDOW_MS + 1);
            await Promise.resolve();
        });
        await flush();

        expect(dialog()).toBeNull(); // the retry is gone, not silently turned into a new mutation
        expect(upload).toHaveBeenCalledTimes(1);
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/no longer be retried safely/i);
        expect((api.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    });

    it("enforces the deadline on the click too, for a tab whose timers were throttled", async () => {
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await pinAnUncertainUpload(api);

        // The clock moves but the timer never runs — exactly what a backgrounded tab does.
        jest.setSystemTime(Date.now() + REPLAY_WINDOW_MS + 1);
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        expect(upload).toHaveBeenCalledTimes(1); // no second request went out
        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/no longer be retried safely/i);
    });

    it("still replays inside the window", async () => {
        const upload = jest
            .fn()
            .mockRejectedValueOnce(new JournalApiError("timed out", 0, "timeout"))
            .mockResolvedValue({ path: `${DIR}/shot.png`, bytes: 3, dryRun: false });
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        await pinAnUncertainUpload(api);

        jest.setSystemTime(Date.now() + REPLAY_WINDOW_MS / 2);
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        expect(upload).toHaveBeenCalledTimes(2);
        expect((upload.mock.calls[1][1] as { idempotencyKey?: string }).idempotencyKey).toBe(
            (upload.mock.calls[0][1] as { idempotencyKey?: string }).idempotencyKey,
        );
    });
});

// -- Round 3: the deadline is only honest if it is anchored to the send, and an expiry must not
//    quietly throw away the rest of the operator's selection ------------------------------------

describe("the replay deadline is anchored to the first send (Codex round 3, F1)", () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ["queueMicrotask"] }));
    afterEach(() => jest.useRealTimers());

    /** A request the test fails by hand, so the clock can move while it is still on the wire. */
    function heldRejection(): { promise: Promise<never>; reject: (error: unknown) => void } {
        let reject!: (error: unknown) => void;
        const promise = new Promise<never>((_resolve, fail) => {
            reject = fail;
        });
        promise.catch(() => {}); // the hook attaches its own handler; keep this one from going unhandled
        return { promise, reject };
    }

    it("is already spent when the failure itself took longer than the window to surface", async () => {
        // The write timeout is 120s and the replay window is 60s, so a request that commits
        // immediately and only rejects at timeout surfaces LONG after the server's record started
        // aging. Measuring the deadline from the failure grants a fresh 60s over a key that may
        // already be gone — and every further ambiguous retry renews it again.
        const held = heldRejection();
        const upload = jest.fn().mockImplementationOnce(() => held.promise);
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(upload).toHaveBeenCalledTimes(1); // in flight, not yet failed

        // The request sits on the wire past the replay window, then fails.
        jest.setSystemTime(Date.now() + REPLAY_WINDOW_MS + 1);
        await act(async () => {
            held.reject(new JournalApiError("timed out", 0, "timeout"));
            await Promise.resolve();
        });
        await flush();
        await act(async () => {
            jest.advanceTimersByTime(1);
            await Promise.resolve();
        });
        await flush();

        // Born expired: the pin is not offered as a retry it can no longer honour.
        expect(dialog()).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/no longer be retried safely/i);
    });

    it("does not renew the deadline on a second ambiguous failure", async () => {
        // Two ambiguous attempts inside one window must still expire on the FIRST send's clock.
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).not.toBeNull();

        // Retry most of the way through the window; the retry fails ambiguously too.
        jest.setSystemTime(Date.now() + REPLAY_WINDOW_MS * 0.6);
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(upload).toHaveBeenCalledTimes(2);

        // Past the ORIGINAL deadline but well inside a renewed one.
        jest.setSystemTime(Date.now() + REPLAY_WINDOW_MS * 0.5);
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        expect(upload).toHaveBeenCalledTimes(2); // no third send
        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/no longer be retried safely/i);
    });
});

describe("an expiry keeps the rest of the upload queue (Codex round 3, F4)", () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ["queueMicrotask"] }));
    afterEach(() => jest.useRealTimers());

    it("carries the unprocessed files forward instead of dropping them silently", async () => {
        // The operator picked three files and cancelled nothing. Reconciling the whole PendingWrite
        // on a TIMER would discard the two they never saw, with a notice naming only the first.
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(
            pane,
            new File(["a"], "one.png", { type: "image/png" }),
            new File(["b"], "two.png", { type: "image/png" }),
            new File(["c"], "three.png", { type: "image/png" }),
        );
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).not.toBeNull();

        await act(async () => {
            jest.advanceTimersByTime(REPLAY_WINDOW_MS + 1);
            await Promise.resolve();
        });
        await flush();

        // The queue survives: the dialog is now confirming the SECOND file, unpinned and editable.
        expect(dialog()).not.toBeNull();
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).toBeNull();
        expect(dialog()?.textContent).toMatch(/two\.png/);
        const notice = pane.querySelector(".mj_FilesPane_notice")?.textContent ?? "";
        expect(notice).toMatch(/one\.png/); // the unconfirmed one is named
        expect(notice).toMatch(/2 more/); // and so is what is still queued
        expect(upload).toHaveBeenCalledTimes(1); // nothing was sent automatically
    });

    it("still closes out when the expired upload was the last in the queue", async () => {
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["a"], "only.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        await act(async () => {
            jest.advanceTimersByTime(REPLAY_WINDOW_MS + 1);
            await Promise.resolve();
        });
        await flush();

        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).not.toMatch(/more file/i);
    });

    it("an explicit cancel still abandons the whole selection — that IS the operator saying stop", async () => {
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(
            pane,
            new File(["a"], "one.png", { type: "image/png" }),
            new File(["b"], "two.png", { type: "image/png" }),
        );
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        await click(dialog()?.querySelector(".mj_UploadConfirm_skip") ?? null);
        await flush();

        expect(dialog()).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
    });
});

// -- Round 4: the carried queue must not punch through the reconciliation barrier, and a wall
//    clock is not a trustworthy deadline on its own ----------------------------------------------

describe("a carried upload queue stays behind the reconciliation barrier (Codex round 4, F1)", () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ["queueMicrotask"] }));
    afterEach(() => jest.useRealTimers());

    /** Mount with a listing whose SECOND read (the reconciling one) is under the test's control. */
    async function paneWithHeldReload(second: {
        resolve?: FileListing;
        reject?: Error;
    }): Promise<{ pane: HTMLDivElement; release: () => void; upload: jest.Mock }> {
        let release!: () => void;
        let call = 0;
        const listDir = jest.fn(() => {
            call += 1;
            if (call === 1) return Promise.resolve(listing(true));
            return new Promise<FileListing>((resolve, reject) => {
                release = () => (second.reject ? reject(second.reject) : resolve(second.resolve ?? listing(true)));
            });
        });
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({
            listDir: listDir as unknown as FilesApiLike["listDir"],
            upload: upload as unknown as FilesApiLike["upload"],
        });
        const pane = await mountPane(api);
        await pickUpload(
            pane,
            new File(["a"], "one.png", { type: "image/png" }),
            new File(["b"], "two.png", { type: "image/png" }),
        );
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        await act(async () => {
            jest.advanceTimersByTime(REPLAY_WINDOW_MS + 1);
            await Promise.resolve();
        });
        await flush();
        return { pane, release, upload };
    }

    it("offers nothing while the reconciling listing is still in flight", async () => {
        const { pane, release, upload } = await paneWithHeldReload({ resolve: listing(true) });

        // The barrier is up: no dialog for the next file, and no write affordance anywhere.
        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesToolbar")).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);

        // ...and the queue is not lost — it is released when the listing lands.
        await act(async () => {
            release();
            await Promise.resolve();
        });
        await flush();
        expect(dialog()).not.toBeNull();
        expect(dialog()?.textContent).toMatch(/two\.png/);
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).toBeNull();
    });

    it("never re-offers it when the refreshed directory comes back read-only", async () => {
        // The capability can be revoked underneath an operator mid-selection. Re-offering the
        // queue would present a confirm button for a write the server will now refuse.
        const { pane, release, upload } = await paneWithHeldReload({ resolve: listing(false) });
        await act(async () => {
            release();
            await Promise.resolve();
        });
        await flush();

        expect(dialog()).toBeNull();
        expect(pane.querySelector(".mj_FilesToolbar")).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
    });

    it("never re-offers it when the reconciling re-read fails outright", async () => {
        const { pane, release, upload } = await paneWithHeldReload({ reject: new Error("network down") });
        await act(async () => {
            release();
            await Promise.resolve();
        });
        await flush();

        expect(dialog()).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(pane.querySelector(".mj_FilesPreview_status_error")).not.toBeNull();
    });
});

describe("the replay deadline survives a wall-clock rollback (Codex round 4, F2)", () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ["queueMicrotask"] }));
    afterEach(() => jest.useRealTimers());

    it("expires on elapsed time even when the system clock is set backwards", async () => {
        // NTP correction, a laptop waking up, or an operator fixing their clock. Measured on the
        // wall alone, the client would sit inside an apparent window the server had already left,
        // and the next retry would be a fresh mutation wearing a replayed key.
        const upload = jest.fn().mockRejectedValue(new JournalApiError("timed out", 0, "timeout"));
        const api = mockApi({ upload: upload as unknown as FilesApiLike["upload"] });
        const pane = await mountPane(api);
        await pickUpload(pane, new File(["abc"], "shot.png", { type: "image/png" }));
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).not.toBeNull();

        // The wall clock jumps an hour into the past; `setSystemTime` deliberately leaves the
        // monotonic clock alone, exactly as a real adjustment does.
        jest.setSystemTime(Date.now() - 60 * REPLAY_WINDOW_MS);
        await act(async () => {
            jest.advanceTimersByTime(REPLAY_WINDOW_MS + 1);
            await Promise.resolve();
        });
        await flush();

        expect(dialog()).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(pane.querySelector(".mj_FilesPane_notice")?.textContent).toMatch(/no longer be retried safely/i);
    });
});

// -- Round 5: a SUCCESSFUL queue step goes behind the same barrier, and the capability is
//    re-checked at the moment of acting, not only where the affordance was drawn ----------------

describe("a successful upload releases the next file through the barrier (Codex round 5, F1)", () => {
    it("offers nothing until the post-write re-read lands, then offers the next file", async () => {
        // The success path had the same hole the expiry path did: it opened the successor the
        // instant the first upload returned, while the re-read that authorizes it was still out.
        let release!: (value: FileListing) => void;
        let call = 0;
        const listDir = jest.fn(() => {
            call += 1;
            if (call === 1) return Promise.resolve(listing(true));
            return new Promise<FileListing>((resolve) => {
                release = resolve;
            });
        });
        const upload = jest.fn().mockResolvedValue({ path: `${DIR}/one.png`, bytes: 1, dryRun: false });
        const api = mockApi({
            listDir: listDir as unknown as FilesApiLike["listDir"],
            upload: upload as unknown as FilesApiLike["upload"],
        });
        const pane = await mountPane(api);
        await pickUpload(
            pane,
            new File(["a"], "one.png", { type: "image/png" }),
            new File(["b"], "two.png", { type: "image/png" }),
        );
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();

        expect(upload).toHaveBeenCalledTimes(1);
        expect(dialog()).toBeNull(); // the barrier is up; two.png is parked, not offered
        expect(pane.querySelector(".mj_FilesToolbar")).toBeNull();

        await act(async () => {
            release(listing(true));
            await Promise.resolve();
        });
        await flush();

        expect(dialog()).not.toBeNull();
        expect(dialog()?.textContent).toMatch(/two\.png/);
    });

    it("drops the rest of the selection when the re-read says the folder is no longer writable", async () => {
        let release!: (value: FileListing) => void;
        let call = 0;
        const listDir = jest.fn(() => {
            call += 1;
            if (call === 1) return Promise.resolve(listing(true));
            return new Promise<FileListing>((resolve) => {
                release = resolve;
            });
        });
        const upload = jest.fn().mockResolvedValue({ path: `${DIR}/one.png`, bytes: 1, dryRun: false });
        const api = mockApi({
            listDir: listDir as unknown as FilesApiLike["listDir"],
            upload: upload as unknown as FilesApiLike["upload"],
        });
        const pane = await mountPane(api);
        await pickUpload(
            pane,
            new File(["a"], "one.png", { type: "image/png" }),
            new File(["b"], "two.png", { type: "image/png" }),
        );
        await click(document.querySelector(".mj_FileWrite_confirm"));
        await flush();
        await act(async () => {
            release(listing(false));
            await Promise.resolve();
        });
        await flush();

        expect(dialog()).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
    });
});

describe("the write capability is re-checked where the write is SENT (Codex round 5, F1 backstop)", () => {
    let writes: ReturnType<typeof useFileWrites> | undefined;

    function Harness({ api, ready }: { api: FilesApiLike; ready: boolean }): null {
        writes = useFileWrites(api, () => {}, { status: "loaded", writable: ready, path: DIR });
        return null;
    }

    async function render(api: FilesApiLike, ready: boolean): Promise<void> {
        await act(async () => {
            root?.render(<Harness api={api} ready={ready} />);
        });
        await flush();
    }

    afterEach(() => {
        writes = undefined;
    });

    it("refuses to send when the directory stopped being writable while the dialog sat open", async () => {
        // The dialog outlives the listing that opened it. A gate that only decides whether the
        // affordance RENDERS does not gate the action (P19) — this is the check at the send.
        const api = mockApi();
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container as HTMLDivElement);
        });
        await render(api, true);

        await act(async () => {
            writes?.begin({ kind: "delete", path: `${DIR}/notes.md`, name: "notes.md", isDir: false });
        });
        expect(writes?.state?.phase).toBe("confirming");

        // The capability goes away underneath the open dialog.
        await render(api, false);
        await act(async () => {
            writes?.submit({});
        });
        await flush();

        expect(api.deleteEntry).not.toHaveBeenCalled();
        expect(writes?.state).toBeUndefined();
        expect(writes?.notice).toMatch(/isn't available in this folder/i);
    });

    it("still sends normally while the directory is writable", async () => {
        const api = mockApi();
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container as HTMLDivElement);
        });
        await render(api, true);

        await act(async () => {
            writes?.begin({ kind: "delete", path: `${DIR}/notes.md`, name: "notes.md", isDir: false });
        });
        await act(async () => {
            writes?.submit({});
        });
        await flush();

        expect(api.deleteEntry).toHaveBeenCalledTimes(1);
    });
});

describe("navigating away drops a parked upload queue (Codex round 5, F3)", () => {
    let writes: ReturnType<typeof useFileWrites> | undefined;

    function Harness({ api, ready, path }: { api: FilesApiLike; ready: boolean; path: string }): null {
        writes = useFileWrites(api, () => {}, { status: "loaded", writable: ready, path });
        return null;
    }

    it("clears it on navigation even when the destination never becomes ready", async () => {
        // A read-only or failing destination leaves `ready` false forever. Checking navigation only
        // after readiness meant the selection survived the trip and reappeared on the way back.
        const api = mockApi({ upload: jest.fn().mockResolvedValue({ path: `${DIR}/a`, bytes: 1, dryRun: false }) });
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container as HTMLDivElement);
        });
        const show = async (ready: boolean, path: string): Promise<void> => {
            await act(async () => {
                root?.render(<Harness api={api} ready={ready} path={path} />);
            });
            await flush();
        };
        await show(true, DIR);

        // Upload the first of two; the second is parked behind the barrier.
        await act(async () => {
            writes?.begin({
                kind: "upload",
                dir: DIR,
                files: [new File(["a"], "one.png"), new File(["b"], "two.png")],
                index: 0,
            });
        });
        await act(async () => {
            writes?.submit({});
        });
        await flush();
        expect(writes?.state).toBeUndefined(); // parked, not offered

        // Off to a folder that never loads, and back again.
        await show(false, "/root/elsewhere");
        await show(true, DIR);

        expect(writes?.state).toBeUndefined(); // the abandoned selection does not come back
    });
});

describe("a read-only answer ENDS a parked queue (Codex round 6, F1)", () => {
    let writes: ReturnType<typeof useFileWrites> | undefined;

    function Harness({
        api,
        status,
        writable,
    }: {
        api: FilesApiLike;
        status: "loading" | "loaded" | "error";
        writable: boolean;
    }): null {
        writes = useFileWrites(api, () => {}, { status, writable, path: DIR });
        return null;
    }

    it("does not resurrect it when the same directory becomes writable again later", async () => {
        // The read-only branch used to just return, leaving the queue parked. Any later listing of
        // the same directory that came back writable — a retry, toggling hidden files — walked
        // straight into the release and re-offered a selection the operator was told was dropped.
        const api = mockApi({ upload: jest.fn().mockResolvedValue({ path: `${DIR}/a`, bytes: 1, dryRun: false }) });
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container as HTMLDivElement);
        });
        const show = async (status: "loading" | "loaded" | "error", writable: boolean): Promise<void> => {
            await act(async () => {
                root?.render(<Harness api={api} status={status} writable={writable} />);
            });
            await flush();
        };
        await show("loaded", true);

        await act(async () => {
            writes?.begin({
                kind: "upload",
                dir: DIR,
                files: [new File(["a"], "one.png"), new File(["b"], "two.png")],
                index: 0,
            });
        });
        await act(async () => {
            writes?.submit({});
        });
        await flush();
        expect(writes?.state).toBeUndefined(); // two.png is parked behind the barrier

        await show("loading", false); // the re-read goes out
        await show("loaded", false); // ...and answers: read-only. The queue is over.
        expect(writes?.state).toBeUndefined();

        await show("loaded", true); // capability comes back later
        expect(writes?.state).toBeUndefined(); // ...and the abandoned selection stays abandoned
    });

    it("still releases the queue when the re-read answers writable", async () => {
        const api = mockApi({ upload: jest.fn().mockResolvedValue({ path: `${DIR}/a`, bytes: 1, dryRun: false }) });
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container as HTMLDivElement);
        });
        const show = async (status: "loading" | "loaded" | "error", writable: boolean): Promise<void> => {
            await act(async () => {
                root?.render(<Harness api={api} status={status} writable={writable} />);
            });
            await flush();
        };
        await show("loaded", true);
        await act(async () => {
            writes?.begin({
                kind: "upload",
                dir: DIR,
                files: [new File(["a"], "one.png"), new File(["b"], "two.png")],
                index: 0,
            });
        });
        await act(async () => {
            writes?.submit({});
        });
        await flush();

        await show("loading", false);
        expect(writes?.state).toBeUndefined(); // still in flight — nothing offered
        await show("loaded", true);
        expect(writes?.state?.phase).toBe("confirming"); // ...and released once it answers
    });
});

describe("a failed re-read is not an answer (Codex round 7)", () => {
    let writes: ReturnType<typeof useFileWrites> | undefined;

    function Harness({
        api,
        status,
        writable,
    }: {
        api: FilesApiLike;
        status: "loading" | "loaded" | "error";
        writable: boolean;
    }): null {
        writes = useFileWrites(api, () => {}, { status, writable, path: DIR });
        return null;
    }

    it("keeps a parked queue across a transient listing failure and releases it on the retry", async () => {
        // Collapsing "errored" into "answered" made a dropped socket discard the rest of the
        // operator's selection — the one outcome the expiry notice explicitly promises against,
        // and one they cannot undo except by picking the files again.
        const api = mockApi({ upload: jest.fn().mockResolvedValue({ path: `${DIR}/a`, bytes: 1, dryRun: false }) });
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container as HTMLDivElement);
        });
        const show = async (status: "loading" | "loaded" | "error", writable: boolean): Promise<void> => {
            await act(async () => {
                root?.render(<Harness api={api} status={status} writable={writable} />);
            });
            await flush();
        };
        await show("loaded", true);
        await act(async () => {
            writes?.begin({
                kind: "upload",
                dir: DIR,
                files: [new File(["a"], "one.png"), new File(["b"], "two.png")],
                index: 0,
            });
        });
        await act(async () => {
            writes?.submit({});
        });
        await flush();
        expect(writes?.state).toBeUndefined(); // two.png parked

        await show("loading", false);
        await show("error", false); // the network dropped; the pane shows its Retry
        expect(writes?.state).toBeUndefined(); // nothing offered — but nothing thrown away either

        await show("loading", false);
        await show("loaded", true); // the retry lands
        expect(writes?.state?.phase).toBe("confirming");
        expect(writes?.state?.pending.kind).toBe("upload");
    });
});
