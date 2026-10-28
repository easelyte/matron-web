/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The item reply box beyond plain text: staged attachments (picker and paste) in a tray above the
 * box, a mic beside send, and one comment per send carrying the typed text, a voice note first
 * when there is one, then the staged files.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient, TrackerCommentOutcome } from "../client";
import type { TrackerAttachment } from "../types";
import { ItemDetail } from "../tracker/ItemDetail";
import { fakeSeen, type FakeSeen, trackerItem } from "./tracker-fixtures";

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

interface FakeClient {
    seen: FakeSeen;
    sessionGeneration: number;
    getSnapshot: jest.Mock;
    postTrackerComment: jest.Mock;
    uploadTrackerAttachment: jest.Mock;
    closeTrackerItem: jest.Mock;
    reopenTrackerItem: jest.Mock;
    closeTrackerView: jest.Mock;
    selectConversation: jest.Mock;
    openTrackerLink: jest.Mock;
}

const uploaded = (file: File): TrackerAttachment => ({
    blob_ref: `ref-${file.name}`,
    mime: file.type,
    name: file.name,
    size: file.size,
});

function fakeClient(): FakeClient {
    return {
        seen: fakeSeen(),
        sessionGeneration: 1,
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
        postTrackerComment: jest.fn().mockResolvedValue({ ok: true }),
        uploadTrackerAttachment: jest.fn(async (file: File) => uploaded(file)),
        closeTrackerItem: jest.fn().mockResolvedValue(true),
        reopenTrackerItem: jest.fn().mockResolvedValue(true),
        closeTrackerView: jest.fn(),
        selectConversation: jest.fn().mockResolvedValue(undefined),
        openTrackerLink: jest.fn(),
    };
}

// ── A minimal MediaRecorder: stop() hands over one chunk, then onstop. ─────────────────────────────

class MockRecorder {
    public static last: MockRecorder | undefined;
    public state: RecordingState = "inactive";
    public mimeType: string;
    public ondataavailable: ((event: BlobEvent) => unknown) | null = null;
    public onerror: ((event: Event) => unknown) | null = null;
    public onstart: ((event: Event) => unknown) | null = null;
    public onstop: ((event: Event) => unknown) | null = null;

    public constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? "audio/webm";
        MockRecorder.last = this;
    }

    public static isTypeSupported(type: string): boolean {
        return type === "audio/webm;codecs=opus" || type === "audio/webm";
    }

    public start(): void {
        this.state = "recording";
    }

    public stop(): void {
        this.state = "inactive";
        setTimeout(() => {
            this.ondataavailable?.({ data: new Blob(["AUDIO"], { type: this.mimeType }) } as BlobEvent);
            this.onstop?.(new Event("stop"));
        }, 0);
    }
}

const track = { stop: jest.fn() };
const stream = { getTracks: () => [track] } as unknown as MediaStream;

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(element);
    });
    return { container, root };
}

async function renderItem(client: FakeClient): Promise<HTMLDivElement> {
    const { container } = await mount(
        <ItemDetail
            item={trackerItem({ num: 12 })}
            comments={[]}
            client={client as unknown as MatronJournalClient}
            onBack={jest.fn()}
        />,
    );
    return container;
}

const input = (container: HTMLElement): HTMLTextAreaElement =>
    container.querySelector<HTMLTextAreaElement>(".mj_TrackerComposer_input")!;

async function type(container: HTMLElement, text: string): Promise<void> {
    const textarea = input(container);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
        setValue.call(textarea, text);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

async function pick(container: HTMLElement, files: File[]): Promise<void> {
    const picker = container.querySelector<HTMLInputElement>(".mj_TrackerComposer_file")!;
    Object.defineProperty(picker, "files", { configurable: true, value: files });
    await act(async () => {
        picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

async function click(button: HTMLElement | null): Promise<void> {
    await act(async () => {
        button!.click();
    });
}

const sendButton = (container: HTMLElement): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_send")!;

const chips = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll(".mj_TrackerComposer_chip")).map(
        (chip) => chip.querySelector(".mj_TrackerComposer_chipName")?.textContent ?? "",
    );

/** Records a voice note and stops it with "send"; resolves once the recorder has finalized. */
async function recordVoiceNote(container: HTMLElement): Promise<void> {
    await click(container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_mic"));
    expect(container.querySelector(".mj_VoiceRecording")).not.toBeNull();
    await click(container.querySelector<HTMLButtonElement>(".mj_VoiceRecording_stop"));
    await act(async () => {
        await new Promise((done) => setTimeout(done, 5));
    });
}

describe("ItemDetail reply box", () => {
    const realMediaDevices = navigator.mediaDevices;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia: jest.fn().mockResolvedValue(stream) },
        });
        (window as unknown as { MediaRecorder: unknown }).MediaRecorder = MockRecorder;
    });

    afterEach(() => {
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: realMediaDevices });
        delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
        document.body.innerHTML = "";
    });

    it("has an attach button, and a mic beside send whether or not there is text", async () => {
        const container = await renderItem(fakeClient());
        expect(container.querySelector(".mj_TrackerComposer_attach")).not.toBeNull();
        expect(container.querySelector(".mj_TrackerComposer_mic")).not.toBeNull();
        await type(container, "some words");
        expect(container.querySelector(".mj_TrackerComposer_mic")).not.toBeNull();
        expect(sendButton(container)).not.toBeNull();
    });

    it("stages picked files in a tray above the box, each removable", async () => {
        const container = await renderItem(fakeClient());
        expect(container.querySelector(".mj_TrackerComposer_tray")).toBeNull();

        await pick(container, [new File(["a"], "a.png", { type: "image/png" }), new File(["bb"], "notes.txt")]);
        expect(chips(container)).toEqual(["a.png", "notes.txt"]);

        await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove a.png"]'));
        expect(chips(container)).toEqual(["notes.txt"]);
    });

    it("stages files pasted into the box", async () => {
        const container = await renderItem(fakeClient());
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", {
            value: { files: [new File(["img"], "image.png", { type: "image/png" })] },
        });
        await act(async () => {
            input(container).dispatchEvent(paste);
        });
        expect(chips(container)).toEqual(["image.png"]);
        expect(paste.defaultPrevented).toBe(true);
    });

    it("sends the text and the staged files as one comment, uploading each first", async () => {
        const client = fakeClient();
        const container = await renderItem(client);
        const shot = new File(["a"], "a.png", { type: "image/png" });
        const notes = new File(["bb"], "notes.txt", { type: "text/plain" });
        await pick(container, [shot, notes]);
        await type(container, "here are the files");

        await click(sendButton(container));

        expect(client.uploadTrackerAttachment.mock.calls.map((call) => call[0])).toEqual([shot, notes]);
        expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
        expect(client.postTrackerComment).toHaveBeenCalledWith(
            12,
            { body: "here are the files", attachments: [uploaded(shot), uploaded(notes)] },
            expect.any(String),
        );
        expect(input(container).value).toBe("");
        expect(chips(container)).toEqual([]);
    });

    it("sends staged files with no text, and Cmd/Ctrl+Enter sends too", async () => {
        const client = fakeClient();
        const container = await renderItem(client);
        const shot = new File(["a"], "a.png", { type: "image/png" });
        await pick(container, [shot]);
        expect(sendButton(container).disabled).toBe(false);

        await act(async () => {
            input(container).dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }),
            );
        });

        expect(client.postTrackerComment).toHaveBeenCalledWith(
            12,
            { attachments: [uploaded(shot)] },
            expect.any(String),
        );
    });

    it("keeps the draft and tray when an upload fails, and posts nothing", async () => {
        const client = fakeClient();
        client.uploadTrackerAttachment.mockResolvedValueOnce(null);
        const container = await renderItem(client);
        await pick(container, [new File(["a"], "a.png", { type: "image/png" })]);
        await type(container, "with a picture");

        await click(sendButton(container));

        expect(client.postTrackerComment).not.toHaveBeenCalled();
        expect(input(container).value).toBe("with a picture");
        expect(chips(container)).toEqual(["a.png"]);
    });

    it("a retry after a failed post reuses the uploads and the idempotency key", async () => {
        const client = fakeClient();
        client.postTrackerComment.mockResolvedValueOnce({ ok: false });
        const container = await renderItem(client);
        await pick(container, [new File(["a"], "a.png", { type: "image/png" })]);
        await type(container, "retry me");

        await click(sendButton(container));
        await click(sendButton(container));

        expect(client.uploadTrackerAttachment).toHaveBeenCalledTimes(1);
        expect(client.postTrackerComment).toHaveBeenCalledTimes(2);
        expect(client.postTrackerComment.mock.calls[0][1]).toEqual(client.postTrackerComment.mock.calls[1][1]);
        expect(client.postTrackerComment.mock.calls[0][2]).toBe(client.postTrackerComment.mock.calls[1][2]);
    });

    describe("more files than one comment takes", () => {
        const many = (count: number): File[] =>
            Array.from({ length: count }, (_, i) => new File(["a"], `f${i}.png`, { type: "image/png" }));
        const names = (files: File[]): string[] => files.map((file) => file.name);
        const postedNames = (client: FakeClient, call: number): string[] =>
            client.postTrackerComment.mock.calls[call][1].attachments.map((a: TrackerAttachment) => a.name);
        const failure = (container: HTMLElement): string | null | undefined =>
            container.querySelector(".mj_TrackerComposer_failure")?.textContent;
        const refusal = "The journal takes at most 20 attachments on one comment.";

        it("keeps every picked file, and says how the reply will be split", async () => {
            const container = await renderItem(fakeClient());
            const files = many(42);

            await pick(container, files);

            expect(chips(container)).toEqual(names(files));
            expect(container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_attach")!.disabled).toBe(false);
            expect(sendButton(container).disabled).toBe(false);
            expect(container.querySelector(".mj_TrackerComposer_limit")?.textContent).toBe(
                "42 files will go as 3 replies of up to 20.",
            );
        });

        it("says nothing about splitting while the files fit on one comment", async () => {
            const container = await renderItem(fakeClient());
            await pick(container, many(20));
            expect(container.querySelector(".mj_TrackerComposer_limit")).toBeNull();
        });

        it("sends them as comments of at most 20 files, in order, the text on the first only", async () => {
            const client = fakeClient();
            const container = await renderItem(client);
            const files = many(42);
            await pick(container, files);
            await type(container, "the whole set");

            await click(sendButton(container));

            expect(client.postTrackerComment).toHaveBeenCalledTimes(3);
            const writes = client.postTrackerComment.mock.calls.map((call) => call[1]);
            expect(writes.map((write) => write.body)).toEqual(["the whole set", undefined, undefined]);
            expect(postedNames(client, 0)).toEqual(names(files.slice(0, 20)));
            expect(postedNames(client, 1)).toEqual(names(files.slice(20, 40)));
            expect(postedNames(client, 2)).toEqual(names(files.slice(40)));
            const keys = client.postTrackerComment.mock.calls.map((call) => call[2]);
            expect(new Set(keys).size).toBe(3);
            expect(input(container).value).toBe("");
            expect(chips(container)).toEqual([]);
            expect(failure(container)).toBeUndefined();
        });

        it("a refused comment stops the send, says which files did not go and why, and keeps them", async () => {
            const client = fakeClient();
            client.postTrackerComment
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce({ ok: false, reason: refusal });
            const container = await renderItem(client);
            const files = many(42);
            await pick(container, files);
            await type(container, "the whole set");

            await click(sendButton(container));

            // The first comment went (with the text); the second was refused, so the third never went.
            expect(client.postTrackerComment).toHaveBeenCalledTimes(2);
            expect(input(container).value).toBe("");
            expect(chips(container)).toEqual(names(files.slice(20)));
            expect(failure(container)).toContain(`20 of 42 files sent; 22 not sent. ${refusal}`);
            expect(container.querySelector('[role="alert"].mj_TrackerComposer_failure')).not.toBeNull();

            // Retry sends exactly what is left: the refused comment again under its key, then the rest.
            const refusedKey = client.postTrackerComment.mock.calls[1][2];
            const uploads = client.uploadTrackerAttachment.mock.calls.length;
            await click(container.querySelector<HTMLButtonElement>('[aria-label="Retry the reply"]'));

            expect(client.postTrackerComment).toHaveBeenCalledTimes(4);
            expect(client.postTrackerComment.mock.calls[2][1]).toEqual(client.postTrackerComment.mock.calls[1][1]);
            expect(client.postTrackerComment.mock.calls[2][2]).toBe(refusedKey);
            expect(postedNames(client, 3)).toEqual(names(files.slice(40)));
            // The refused comment's files were uploaded once; only the last two are new.
            expect(client.uploadTrackerAttachment.mock.calls.length).toBe(uploads + 2);
            expect(chips(container)).toEqual([]);
            expect(failure(container)).toBeUndefined();
        });

        it("a refused first comment keeps the text and every file, and Discard drops them", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValueOnce({ ok: false, reason: "The server refused it (HTTP 400)." });
            const container = await renderItem(client);
            const files = many(25);
            await pick(container, files);
            await type(container, "do not lose me");

            await click(sendButton(container));

            expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
            expect(input(container).value).toBe("do not lose me");
            expect(chips(container)).toEqual(names(files));
            expect(failure(container)).toContain("Reply not sent. The server refused it (HTTP 400).");

            await click(container.querySelector<HTMLButtonElement>('[aria-label="Discard the reply"]'));

            expect(input(container).value).toBe("");
            expect(chips(container)).toEqual([]);
            expect(failure(container)).toBeUndefined();
            expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
        });

        it("locks the tray while a reply goes, so a file can't be removed after its comment is planned", async () => {
            const client = fakeClient();
            const first = deferred<TrackerCommentOutcome>();
            client.postTrackerComment.mockImplementationOnce(() => first.promise);
            const container = await renderItem(client);
            const files = many(25);
            await pick(container, files);

            await click(sendButton(container));
            const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove f22.png"]')!;
            expect(remove.disabled).toBe(true);
            await click(remove);
            await act(async () => {
                first.resolve({ ok: true });
            });

            expect(client.postTrackerComment).toHaveBeenCalledTimes(2);
            expect(postedNames(client, 1)).toEqual(names(files.slice(20)));
            expect(chips(container)).toEqual([]);
            // Unlocked again once the reply has gone.
            await pick(container, many(1));
            expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove f0.png"]')!.disabled).toBe(false);
        });

        it("a failure notice goes when the text is edited", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValueOnce({ ok: false, reason: "Item is closed." });
            const container = await renderItem(client);
            await type(container, "first try");
            await click(sendButton(container));
            expect(failure(container)).toContain("Item is closed.");

            await type(container, "first try, reworded");

            expect(failure(container)).toBeUndefined();
        });

        it("a failure notice goes when a leftover file is removed, and does not come back", async () => {
            const client = fakeClient();
            client.postTrackerComment
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce({ ok: false, reason: refusal });
            const container = await renderItem(client);
            await pick(container, many(22));
            await click(sendButton(container));
            expect(failure(container)).toContain("20 of 22 files sent; 2 not sent.");

            await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove f20.png"]'));
            expect(failure(container)).toBeUndefined();
            await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove f21.png"]'));
            await type(container, "a new reply");

            expect(failure(container)).toBeUndefined();
        });

        it("a failed comment goes again with its original text when the text was edited", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValueOnce({ ok: false, reason: "The server refused it (HTTP 400)." });
            const container = await renderItem(client);
            const files = many(22);
            await pick(container, files);
            await type(container, "version one");
            await click(sendButton(container));

            await type(container, "version two");
            await click(sendButton(container));

            // The first comment may have landed, so it is replayed exactly: same text, files and key.
            expect(client.postTrackerComment).toHaveBeenCalledTimes(3);
            const [first, retry, rest] = client.postTrackerComment.mock.calls;
            expect(retry[1]).toEqual(first[1]);
            expect(retry[1].body).toBe("version one");
            expect(retry[2]).toBe(first[2]);
            // The new wording goes with the files that follow.
            expect(rest[1].body).toBe("version two");
            expect(postedNames(client, 2)).toEqual(names(files.slice(20)));
            expect(input(container).value).toBe("");
            expect(chips(container)).toEqual([]);
        });

        it("a refused text-only reply keeps the text and says why", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValueOnce({ ok: false, reason: "Item is closed." });
            const container = await renderItem(client);
            await type(container, "one more thing");

            await click(sendButton(container));

            expect(input(container).value).toBe("one more thing");
            expect(failure(container)).toContain("Reply not sent. Item is closed.");
        });
    });

    describe("voice note", () => {
        it("sends one comment: the typed text as body, the voice note first, then the staged files", async () => {
            const client = fakeClient();
            const container = await renderItem(client);
            const shot = new File(["a"], "a.png", { type: "image/png" });
            await pick(container, [shot]);
            await type(container, "listen to this");
            const upload = deferred<TrackerAttachment | null>();
            client.uploadTrackerAttachment.mockImplementationOnce(() => upload.promise);

            await recordVoiceNote(container);

            // The draft and the tray clear as the send starts, before the upload settles.
            expect(input(container).value).toBe("");
            expect(chips(container)).toEqual([]);

            const voice = client.uploadTrackerAttachment.mock.calls[0][0] as File;
            expect(voice.name).toBe("voice-note.webm");
            expect(voice.type).toBe("audio/webm;codecs=opus");
            expect(client.uploadTrackerAttachment.mock.calls[1][0]).toBe(shot);

            const voiceAttachment = { blob_ref: "ref-voice", mime: voice.type, name: voice.name, size: voice.size };
            await act(async () => {
                upload.resolve(voiceAttachment);
            });

            expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
            expect(client.postTrackerComment).toHaveBeenCalledWith(
                12,
                { body: "listen to this", attachments: [voiceAttachment, uploaded(shot)] },
                expect.any(String),
            );
            expect(container.querySelector(".mj_VoiceRecording")).toBeNull();
        });

        it("has one send while recording: the box's own send gives way to the recording bar", async () => {
            const container = await renderItem(fakeClient());
            await type(container, "listen to this");

            await click(container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_mic"));

            expect(container.querySelector(".mj_VoiceRecording_stop")).not.toBeNull();
            expect(container.querySelector(".mj_TrackerComposer_send")).toBeNull();
            expect(container.querySelector(".mj_TrackerComposer_mic")).toBeNull();
            expect(container.querySelector(".mj_TrackerComposer_input")).toBeNull();
        });

        it("holds the typed send while the microphone starts, then sends the text with the note", async () => {
            const request = deferred<MediaStream>();
            (navigator.mediaDevices.getUserMedia as jest.Mock).mockReturnValueOnce(request.promise);
            const client = fakeClient();
            const container = await renderItem(client);
            await type(container, "listen to this");

            await click(container.querySelector<HTMLButtonElement>(".mj_TrackerComposer_mic"));

            expect(sendButton(container).disabled).toBe(true);
            await act(async () => {
                input(container).dispatchEvent(
                    new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
                );
            });
            expect(client.postTrackerComment).not.toHaveBeenCalled();
            expect(input(container).value).toBe("listen to this");

            await act(async () => request.resolve(stream));
            await click(container.querySelector<HTMLButtonElement>(".mj_VoiceRecording_stop"));
            await act(async () => {
                await new Promise((done) => setTimeout(done, 5));
            });

            expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
            expect(client.postTrackerComment).toHaveBeenCalledWith(
                12,
                { body: "listen to this", attachments: [expect.objectContaining({ name: "voice-note.webm" })] },
                expect.any(String),
            );
        });

        it("with an empty draft is a voice-only comment", async () => {
            const client = fakeClient();
            const container = await renderItem(client);

            await recordVoiceNote(container);

            expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
            const [num, write] = client.postTrackerComment.mock.calls[0];
            expect(num).toBe(12);
            expect(write).toEqual({ attachments: [expect.objectContaining({ name: "voice-note.webm" })] });
        });

        it("restores the draft and tray when the send fails, and says so", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValue({ ok: false });
            const container = await renderItem(client);
            await pick(container, [new File(["a"], "a.png", { type: "image/png" })]);
            await type(container, "do not lose me");

            await recordVoiceNote(container);

            expect(input(container).value).toBe("do not lose me");
            // The recording comes back too, first in the tray, so it can be sent again.
            expect(chips(container)).toEqual(["voice-note.webm", "a.png"]);
            expect(container.querySelector(".mj_VoiceError")?.textContent).toContain("Couldn't send the voice note");
        });

        it("does not overwrite text typed while the failed send was in flight", async () => {
            const client = fakeClient();
            const post = deferred<TrackerCommentOutcome>();
            client.postTrackerComment.mockImplementationOnce(() => post.promise);
            const container = await renderItem(client);
            await type(container, "first thought");

            await recordVoiceNote(container);
            expect(input(container).value).toBe("");
            await type(container, "second thought");
            await act(async () => {
                post.resolve({ ok: false });
            });

            expect(input(container).value).toBe("second thought");
            expect(container.querySelector(".mj_VoiceError")).not.toBeNull();
        });

        it("goes alone, keeping the draft and tray, when the tray is already full", async () => {
            const client = fakeClient();
            const container = await renderItem(client);
            const files = Array.from({ length: 20 }, (_, i) => new File(["a"], `f${i}.png`, { type: "image/png" }));
            await pick(container, files);
            await type(container, "still here");

            await recordVoiceNote(container);

            expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
            expect(client.postTrackerComment.mock.calls[0][1]).toEqual({
                attachments: [expect.objectContaining({ name: "voice-note.webm" })],
            });
            expect(input(container).value).toBe("still here");
            expect(chips(container)).toHaveLength(20);
        });

        it("a full tray that fails to take the note keeps every staged file and holds the note to retry", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValueOnce({ ok: false });
            const container = await renderItem(client);
            const files = Array.from({ length: 20 }, (_, i) => new File(["a"], `f${i}.png`, { type: "image/png" }));
            await pick(container, files);

            await recordVoiceNote(container);

            // No staged file is dropped to make room: the tray is exactly as it was.
            expect(chips(container)).toEqual(files.map((file) => file.name));
            const held = container.querySelector(".mj_TrackerComposer_heldVoice");
            expect(held?.textContent).toContain("Voice note not sent");
            expect(container.querySelector(".mj_VoiceError")?.textContent).toContain("Couldn't send the voice note");

            const uploads = client.uploadTrackerAttachment.mock.calls.length;
            await click(container.querySelector<HTMLButtonElement>('[aria-label="Retry the voice note"]'));

            // The retry is the same comment: same payload, same key, the recording not uploaded again.
            expect(client.postTrackerComment).toHaveBeenCalledTimes(2);
            expect(client.postTrackerComment.mock.calls[1][1]).toEqual(client.postTrackerComment.mock.calls[0][1]);
            expect(client.postTrackerComment.mock.calls[1][2]).toBe(client.postTrackerComment.mock.calls[0][2]);
            expect(client.uploadTrackerAttachment.mock.calls.length).toBe(uploads);
            expect(container.querySelector(".mj_TrackerComposer_heldVoice")).toBeNull();
            expect(chips(container)).toHaveLength(20);
        });

        it("a held voice note can be discarded", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValueOnce({ ok: false });
            const container = await renderItem(client);
            await pick(
                container,
                Array.from({ length: 20 }, (_, i) => new File(["a"], `f${i}.png`, { type: "image/png" })),
            );

            await recordVoiceNote(container);
            await click(container.querySelector<HTMLButtonElement>('[aria-label="Discard the voice note"]'));

            expect(container.querySelector(".mj_TrackerComposer_heldVoice")).toBeNull();
            expect(client.postTrackerComment).toHaveBeenCalledTimes(1);
        });

        it("restoring a failed note never drops files, and Send then splits the over-full tray", async () => {
            const client = fakeClient();
            const post = deferred<TrackerCommentOutcome>();
            client.postTrackerComment.mockImplementationOnce(() => post.promise);
            const container = await renderItem(client);
            const first = Array.from({ length: 19 }, (_, i) => new File(["a"], `a${i}.png`, { type: "image/png" }));
            await pick(container, first);

            await recordVoiceNote(container);
            // While the note is in flight the cleared tray fills up again.
            const later = Array.from({ length: 20 }, (_, i) => new File(["b"], `b${i}.png`, { type: "image/png" }));
            await pick(container, later);
            await act(async () => {
                post.resolve({ ok: false });
            });

            expect(chips(container)).toEqual([
                "voice-note.webm",
                ...first.map((file) => file.name),
                ...later.map((file) => file.name),
            ]);
            expect(sendButton(container).disabled).toBe(false);
            expect(container.querySelector(".mj_TrackerComposer_limit")?.textContent).toBe(
                "40 files will go as 2 replies of up to 20.",
            );

            await click(sendButton(container));

            // Two comments, in tray order: the recording and 19 files, then the other 20.
            const posted = client.postTrackerComment.mock.calls.slice(1).map((call) => call[1].attachments.length);
            expect(posted).toEqual([20, 20]);
            expect(client.postTrackerComment.mock.calls[1][1].attachments[0].name).toBe("voice-note.webm");
            expect(chips(container)).toEqual([]);
        });

        it("Send retries a failed note as the same comment, then the files staged meanwhile", async () => {
            const client = fakeClient();
            const post = deferred<TrackerCommentOutcome>();
            client.postTrackerComment.mockImplementationOnce(() => post.promise);
            const container = await renderItem(client);
            const first = Array.from({ length: 5 }, (_, i) => new File(["a"], `a${i}.png`, { type: "image/png" }));
            await pick(container, first);

            await recordVoiceNote(container);
            // While the note is in flight more files are staged; with the note's six they would fit
            // on one comment, but that would be a different comment from the one that may have landed.
            const later = Array.from({ length: 3 }, (_, i) => new File(["b"], `b${i}.png`, { type: "image/png" }));
            await pick(container, later);
            await act(async () => {
                post.resolve({ ok: false });
            });
            expect(chips(container)).toHaveLength(9);
            const uploads = client.uploadTrackerAttachment.mock.calls.length;

            await click(sendButton(container));

            expect(client.postTrackerComment).toHaveBeenCalledTimes(3);
            const [note, retry, rest] = client.postTrackerComment.mock.calls;
            expect(retry[1]).toEqual(note[1]);
            expect(retry[2]).toBe(note[2]);
            expect(rest[1].attachments.map((a: TrackerAttachment) => a.name)).toEqual(later.map((file) => file.name));
            expect(rest[2]).not.toBe(note[2]);
            // Only the files staged meanwhile were uploaded; the note's were remembered.
            expect(client.uploadTrackerAttachment.mock.calls.length).toBe(uploads + 3);
            expect(chips(container)).toEqual([]);
        });

        it("a failed note goes again with its own text; text typed meanwhile goes on a new comment", async () => {
            const client = fakeClient();
            const post = deferred<TrackerCommentOutcome>();
            client.postTrackerComment.mockImplementationOnce(() => post.promise);
            const container = await renderItem(client);
            await pick(container, [new File(["a"], "a0.png", { type: "image/png" })]);
            await type(container, "first thought");

            await recordVoiceNote(container);
            await type(container, "second thought");
            const later = new File(["b"], "b0.png", { type: "image/png" });
            await pick(container, [later]);
            await act(async () => {
                post.resolve({ ok: false });
            });
            expect(input(container).value).toBe("second thought");

            await click(sendButton(container));

            expect(client.postTrackerComment).toHaveBeenCalledTimes(3);
            const [note, retry, fresh] = client.postTrackerComment.mock.calls;
            expect(note[1].body).toBe("first thought");
            expect(retry[1]).toEqual(note[1]);
            expect(retry[2]).toBe(note[2]);
            expect(fresh[1]).toEqual({ body: "second thought", attachments: [uploaded(later)] });
            expect(input(container).value).toBe("");
            expect(chips(container)).toEqual([]);
        });

        it("text typed while a failed note was in flight gets a comment of its own when no file is left", async () => {
            const client = fakeClient();
            const post = deferred<TrackerCommentOutcome>();
            client.postTrackerComment.mockImplementationOnce(() => post.promise);
            const container = await renderItem(client);
            await type(container, "first thought");

            await recordVoiceNote(container);
            await type(container, "second thought");
            await act(async () => {
                post.resolve({ ok: false });
            });

            await click(sendButton(container));

            expect(client.postTrackerComment).toHaveBeenCalledTimes(3);
            const [note, retry, fresh] = client.postTrackerComment.mock.calls;
            expect(retry[1]).toEqual(note[1]);
            expect(retry[2]).toBe(note[2]);
            expect(fresh[1]).toEqual({ body: "second thought" });
            expect(input(container).value).toBe("");
        });

        it("a retry with Send after a failed note reuses its upload and its idempotency key", async () => {
            const client = fakeClient();
            client.postTrackerComment.mockResolvedValueOnce({ ok: false });
            const container = await renderItem(client);
            await pick(container, [new File(["a"], "a.png", { type: "image/png" })]);
            await type(container, "say it again");

            await recordVoiceNote(container);
            expect(client.uploadTrackerAttachment).toHaveBeenCalledTimes(2);

            await click(sendButton(container));

            expect(client.uploadTrackerAttachment).toHaveBeenCalledTimes(2);
            expect(client.postTrackerComment).toHaveBeenCalledTimes(2);
            expect(client.postTrackerComment.mock.calls[1][1]).toEqual(client.postTrackerComment.mock.calls[0][1]);
            expect(client.postTrackerComment.mock.calls[1][2]).toBe(client.postTrackerComment.mock.calls[0][2]);
            expect(chips(container)).toEqual([]);
        });
    });

    describe("thumbnails", () => {
        const realCreate = URL.createObjectURL;
        const realRevoke = URL.revokeObjectURL;
        afterEach(() => {
            URL.createObjectURL = realCreate;
            URL.revokeObjectURL = realRevoke;
        });

        it("shows an image's blob: preview", async () => {
            URL.createObjectURL = jest.fn(() => "blob:https://matron.test/1234");
            URL.revokeObjectURL = jest.fn();
            const container = await renderItem(fakeClient());
            await pick(container, [new File(["a"], "a.png", { type: "image/png" })]);
            expect(container.querySelector<HTMLImageElement>(".mj_TrackerComposer_thumb")?.src).toBe(
                "blob:https://matron.test/1234",
            );
        });

        it("draws no thumbnail for a preview that is not a blob: URL", async () => {
            URL.createObjectURL = jest.fn(() => "javascript:alert(1)");
            URL.revokeObjectURL = jest.fn();
            const container = await renderItem(fakeClient());
            await pick(container, [new File(["a"], "a.png", { type: "image/png" })]);
            expect(chips(container)).toEqual(["a.png"]);
            expect(container.querySelector(".mj_TrackerComposer_thumb")).toBeNull();
        });
    });
});
