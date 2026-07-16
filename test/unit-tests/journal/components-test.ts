/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import type { ClientState, JournalEvent, PendingMessage } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const CONVERSATION = {
    id: "c1",
    title: "One",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

interface ClientInternals {
    state: ClientState;
    database?: unknown;
    pendingFiles: Map<string, File>;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInClient(
    options: {
        pendingMessages?: PendingMessage[];
        events?: JournalEvent[];
    } = {},
): MatronJournalClient {
    const client = new MatronJournalClient();
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: options.events ?? [],
        pendingMessages: options.pendingMessages ?? [],
        connection: "online",
    };
    return client;
}

async function renderClient(client: MatronJournalClient): Promise<{
    container: HTMLDivElement;
    root: Root;
}> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(MatronApp, { client }));
    });
    return { container, root };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
}

function fileDragEvent(type: string, file: File): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files: [file] },
    });
    return event;
}

describe("attachment composer", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("opens the picker, dispatches files, and resets it so the same file can be selected again", async () => {
        const client = signedInClient();
        const attachFiles = jest.spyOn(client, "attachFiles").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]');
        if (!input) throw new Error("Missing file input");
        const clickInput = jest.spyOn(input, "click");

        await act(async () => button(rendered!.container, "Attach a file").click());

        expect(clickInput).toHaveBeenCalledTimes(1);
        expect(input.multiple).toBe(true);
        expect(button(rendered.container, "Attach a file").getAttribute("aria-disabled")).toBeNull();
        expect(button(rendered.container, "Voice message").getAttribute("aria-disabled")).toBe("true");

        const file = new File(["same"], "same.txt", { type: "text/plain" });
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        Object.defineProperty(input, "value", { configurable: true, writable: true, value: "selected" });

        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
        expect(input.value).toBe("");
        input.value = "selected";
        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

        expect(attachFiles).toHaveBeenNthCalledWith(1, [file]);
        expect(attachFiles).toHaveBeenNthCalledWith(2, [file]);
        expect(input.value).toBe("");
    });

    it("accepts file drops, prevents browser navigation, and clears the overlay", async () => {
        const client = signedInClient();
        const attachFiles = jest.spyOn(client, "attachFiles").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        const room = rendered.container.querySelector<HTMLElement>(".mx_RoomView");
        if (!room) throw new Error("Missing conversation pane");
        const file = new File(["drop"], "drop.txt", { type: "text/plain" });
        const dragOver = fileDragEvent("dragover", file);

        await act(async () => room.dispatchEvent(dragOver));
        expect(dragOver.defaultPrevented).toBe(true);
        expect(rendered!.container.textContent).toContain("Drop files to attach");

        const drop = fileDragEvent("drop", file);
        await act(async () => room.dispatchEvent(drop));

        expect(drop.defaultPrevented).toBe(true);
        expect(attachFiles).toHaveBeenCalledWith([file]);
        expect(rendered.container.textContent).not.toContain("Drop files to attach");
    });

    it("shows the overlay only for file drags and keeps it active over child elements", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const room = rendered.container.querySelector<HTMLElement>(".mx_RoomView");
        const child = rendered.container.querySelector<HTMLElement>(".mx_RoomView_body");
        if (!room || !child) throw new Error("Missing conversation pane");

        const textDrag = new Event("dragover", { bubbles: true, cancelable: true });
        Object.defineProperty(textDrag, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
        await act(async () => room.dispatchEvent(textDrag));
        expect(textDrag.defaultPrevented).toBe(false);
        expect(rendered!.container.textContent).not.toContain("Drop files to attach");

        const file = new File(["drag"], "drag.txt", { type: "text/plain" });
        await act(async () => room.dispatchEvent(fileDragEvent("dragover", file)));
        const overChild = new MouseEvent("dragleave", { bubbles: true, relatedTarget: child });
        await act(async () => room.dispatchEvent(overChild));
        expect(rendered!.container.textContent).toContain("Drop files to attach");

        await act(async () => room.dispatchEvent(new Event("dragend", { bubbles: true })));
        expect(rendered.container.textContent).not.toContain("Drop files to attach");

        await act(async () => room.dispatchEvent(fileDragEvent("dragover", file)));
        const leavePane = new MouseEvent("dragleave", { bubbles: true, relatedTarget: document.body });
        await act(async () => room.dispatchEvent(leavePane));
        expect(rendered.container.textContent).not.toContain("Drop files to attach");
    });

    it("dispatches pasted clipboard files", async () => {
        const client = signedInClient();
        const attachFiles = jest.spyOn(client, "attachFiles").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        const textarea = rendered.container.querySelector<HTMLTextAreaElement>("textarea");
        if (!textarea) throw new Error("Missing composer textarea");
        const screenshot = new File(["image"], "screenshot.png", { type: "image/png" });
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: { files: [screenshot] } });

        await act(async () => textarea.dispatchEvent(paste));

        expect(attachFiles).toHaveBeenCalledWith([screenshot]);
    });

    it("renders uploading and sending attachments as chips rather than empty text bubbles", async () => {
        const client = signedInClient({
            pendingMessages: [
                {
                    localId: "uploading",
                    convoId: "c1",
                    body: "",
                    createdAt: 1,
                    kind: "image",
                    filename: "photo.png",
                    attachState: "uploading",
                },
                {
                    localId: "sending",
                    convoId: "c1",
                    body: "",
                    createdAt: 2,
                    kind: "file",
                    filename: "notes.txt",
                    attachState: "sending",
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_AttachmentChip_uploading")?.textContent).toContain("Uploading…");
        expect(rendered.container.querySelector(".mj_AttachmentChip_sending")?.textContent).toContain("Sending…");
        expect(rendered.container.querySelector(".mx_EventTile_sending")).toBeNull();
        expect(rendered.container.querySelector(".mj_MessageText")).toBeNull();
    });

    it("renders an echoed file as the inline media tile", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "file",
                    payload: { blob_ref: "media-1", filename: "report.pdf", size: 12 },
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_File")?.textContent).toContain("report.pdf");
        expect(rendered.container.querySelector(".mj_AttachmentChip")).toBeNull();
    });

    it("shows Retry only when canRetry is true and dispatches the retry", async () => {
        const errorMessage: PendingMessage = {
            localId: "failed",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "failed.txt",
            attachState: "error",
            errorKind: "upload_failed",
            canRetry: false,
        };
        const client = signedInClient({ pendingMessages: [errorMessage] });
        const retry = jest.spyOn(client, "retryAttachment").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        expect(rendered.container.querySelector(".mj_AttachmentChip_error")?.textContent).toContain(
            "Couldn't upload attachment.",
        );
        expect([...rendered.container.querySelectorAll("button")].some((item) => item.textContent === "Retry")).toBe(
            false,
        );

        await act(async () => rendered?.root.unmount());
        rendered.container.remove();
        rendered = undefined;

        const retryableClient = signedInClient({ pendingMessages: [{ ...errorMessage, canRetry: true }] });
        const retryable = jest.spyOn(retryableClient, "retryAttachment").mockResolvedValue(undefined);
        rendered = await renderClient(retryableClient);
        const retryButton = [...rendered.container.querySelectorAll("button")].find(
            (item) => item.textContent === "Retry",
        );
        if (!retryButton) throw new Error("Missing Retry button");
        await act(async () => retryButton.click());

        expect(retry).not.toHaveBeenCalled();
        expect(retryable).toHaveBeenCalledWith("failed");
    });

    it("Dismiss durably removes the attachment row and its retained bytes", async () => {
        const message: PendingMessage = {
            localId: "failed",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "failed.txt",
            attachState: "error",
            errorKind: "upload_failed",
            canRetry: true,
        };
        const rows = new Map([[message.localId, message]]);
        const database = {
            deleteOutboxRow: jest.fn(async (localId: string) => {
                rows.delete(localId);
            }),
            events: jest.fn().mockResolvedValue([]),
            outbox: jest.fn(async () => [...rows.values()]),
        };
        const client = signedInClient({ pendingMessages: [message] });
        internals(client).database = database;
        internals(client).pendingFiles.set(message.localId, new File(["retry"], message.filename!));
        rendered = await renderClient(client);
        const dismiss = [...rendered.container.querySelectorAll("button")].find(
            (item) => item.textContent === "Dismiss",
        );
        if (!dismiss) throw new Error("Missing Dismiss button");

        await act(async () => {
            dismiss.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(database.deleteOutboxRow).toHaveBeenCalledWith(message.localId);
        expect(rows.has(message.localId)).toBe(false);
        expect(internals(client).pendingFiles.has(message.localId)).toBe(false);
        expect(rendered.container.querySelector(".mj_AttachmentChip")).toBeNull();
    });
});
