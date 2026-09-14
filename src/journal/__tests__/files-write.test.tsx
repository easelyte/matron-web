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

async function pickUpload(pane: HTMLDivElement, file: File): Promise<void> {
    const input = pane.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    Object.defineProperty(input, "files", { value: fileList([file]), configurable: true });
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

    it("keeps 507 definite — the journal raises it from write-ahead gates, before anything lands", async () => {
        // audit-fail-closed / trash-write-failed / metadata-preserve-failed all refuse BEFORE the
        // irreversible call, so 507 proves non-mutation and the dialog stays retryable.
        const api = mockApi({
            deleteEntry: jest.fn().mockRejectedValue(new JournalApiError("no room", 507)),
        });
        const pane = await mountPane(api);
        await click(pane.querySelector('[aria-label="Delete notes.md"]'));
        await click(document.querySelector(".mj_FileWrite_danger"));
        await flush();
        expect(dialog()).not.toBeNull();
        expect(dialog()?.querySelector(".mj_FileWrite_bound")).toBeNull();
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
