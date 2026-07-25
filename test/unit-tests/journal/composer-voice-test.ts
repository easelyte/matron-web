/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp } from "../../../src/journal/components";
import type { ClientState, Conversation, PendingMessage, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

const CONVERSATIONS: Conversation[] = [
    {
        id: "A",
        title: "A",
        session_state: "running",
        last_seq: 1,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        read_up_to_seq: 0,
    },
    {
        id: "B",
        title: "B",
        session_state: "running",
        last_seq: 1,
        unread_count: 0,
        snippet: "",
        created_at: 2,
        read_up_to_seq: 0,
    },
];

interface ClientInternals {
    state: ClientState;
    sessionGen: number;
    database?: {
        events: (conversationId: string) => Promise<[]>;
        outbox: (conversationId?: string) => Promise<PendingMessage[]>;
    };
}

interface RecorderConfig {
    autoStart?: boolean;
    autoStopEvents?: boolean;
    finalChunk?: string;
    finalMime?: string;
    initialMime?: string;
    startDelay?: number;
    startMime?: string;
}

interface Deferred<T> {
    promise: Promise<T>;
    reject: (reason: unknown) => void;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

class MockTrack {
    public readonly stop = jest.fn();
}

class MockStream {
    public readonly track = new MockTrack();

    public getTracks(): MediaStreamTrack[] {
        return [this.track as unknown as MediaStreamTrack];
    }
}

class MockRecorder {
    public static harness: MediaHarness;

    public readonly id: number;
    public readonly start = jest.fn((timeslice?: number) => {
        this.startTimeslice = timeslice;
        this.state = "recording";
        if (this.config.autoStart !== false) {
            setTimeout(() => {
                this.mimeType = this.config.startMime ?? this.mimeType;
                this.onstart?.call(this as unknown as MediaRecorder, new Event("start"));
            }, this.config.startDelay ?? 0);
        }
    });
    public readonly stop = jest.fn(() => {
        if (this.state === "inactive") throw new DOMException("Already inactive", "InvalidStateError");
        this.state = "inactive";
        if (this.config.autoStopEvents !== false) setTimeout(() => this.dispatchFinalEvents(), 0);
    });

    public state: RecordingState = "inactive";
    public mimeType: string;
    public startTimeslice: number | undefined;
    public ondataavailable: ((this: MediaRecorder, event: BlobEvent) => unknown) | null = null;
    public onerror: ((this: MediaRecorder, event: Event) => unknown) | null = null;
    public onstart: ((this: MediaRecorder, event: Event) => unknown) | null = null;
    public onstop: ((this: MediaRecorder, event: Event) => unknown) | null = null;

    private readonly config: RecorderConfig;
    private finalEventsDispatched = false;

    public constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        const harness = MockRecorder.harness;
        this.id = harness.instances.length + 1;
        this.config = harness.configs.shift() ?? {};
        this.mimeType = this.config.initialMime ?? options?.mimeType ?? "";
        harness.instances.push(this);
    }

    public dispatchFinalEvents(): void {
        if (this.finalEventsDispatched) return;
        this.finalEventsDispatched = true;
        const finalChunk = this.config.finalChunk ?? `FINAL-${this.id}`;
        if (finalChunk.length > 0) this.emitData(finalChunk, this.config.finalMime ?? this.mimeType);
        this.onstop?.call(this as unknown as MediaRecorder, new Event("stop"));
    }

    public emitData(contents: string, type = this.mimeType): void {
        const data = new Blob([contents], { type });
        this.ondataavailable?.call(this as unknown as MediaRecorder, { data } as BlobEvent);
    }

    public emitError(): void {
        this.onerror?.call(this as unknown as MediaRecorder, new Event("error"));
    }
}

class MockAudioContext {
    public state: AudioContextState = "running";
    public readonly analyser = {
        fftSize: 0,
        frequencyBinCount: 8,
        getByteTimeDomainData: jest.fn(),
    };
    public readonly close = jest.fn(async () => {
        this.state = "closed";
    });
    public readonly createAnalyser = jest.fn(() => this.analyser as unknown as AnalyserNode);
    public readonly createMediaStreamSource = jest.fn(
        () => ({ connect: jest.fn() }) as unknown as MediaStreamAudioSourceNode,
    );
}

class MediaHarness {
    public readonly configs: RecorderConfig[] = [];
    public readonly instances: MockRecorder[] = [];
    public readonly streams: MockStream[] = [];
    public readonly getUserMedia = jest.fn<Promise<MediaStream>, [MediaStreamConstraints]>(() =>
        Promise.resolve(this.stream()),
    );
    public readonly isTypeSupported = jest.fn((type: string) => this.supportedMimes.has(type));
    public supportedMimes = new Set(["audio/webm;codecs=opus", "audio/webm"]);

    public stream(): MediaStream {
        const stream = new MockStream();
        this.streams.push(stream);
        return stream as unknown as MediaStream;
    }

    public queue(config: RecorderConfig): void {
        this.configs.push(config);
    }

    public get latest(): MockRecorder {
        const recorder = this.instances.at(-1);
        if (!recorder) throw new Error("No MediaRecorder instance");
        return recorder;
    }
}

interface Rendered {
    client: MatronJournalClient;
    container: HTMLDivElement;
    root: Root;
}

let harness: MediaHarness;
let rendered: Rendered | undefined;
let mediaDevicesDescriptor: PropertyDescriptor | undefined;
let mediaRecorderDescriptor: PropertyDescriptor | undefined;
let audioContextDescriptor: PropertyDescriptor | undefined;
let requestAnimationFrameDescriptor: PropertyDescriptor | undefined;
let cancelAnimationFrameDescriptor: PropertyDescriptor | undefined;

function makeClient(): MatronJournalClient {
    const client = new MatronJournalClient();
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: CONVERSATIONS,
        selectedConversationId: "A",
        events: [],
        pendingMessages: [],
        connection: "online",
    };
    internals(client).database = {
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
    };
    return client;
}

async function renderComposer(strict = false, client = makeClient()): Promise<Rendered> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const app = React.createElement(MatronApp, { client });
    await act(async () => {
        root.render(strict ? React.createElement(StrictMode, null, app) : app);
    });
    rendered = { client, container, root };
    return rendered;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
}

function voiceError(container: HTMLElement): string | null {
    return container.querySelector('.mj_VoiceError [role="status"]')?.textContent ?? null;
}

async function click(container: HTMLElement, label: string): Promise<void> {
    await act(async () => button(container, label).click());
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
    });
}

async function startRecording(container: HTMLElement): Promise<MockRecorder> {
    await click(container, "Record voice message");
    expect(button(container, "Stop and send voice message")).toBe(document.activeElement);
    return harness.latest;
}

async function unmount(): Promise<void> {
    if (!rendered) return;
    const current = rendered;
    rendered = undefined;
    await act(async () => current.root.unmount());
    current.container.remove();
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    harness = new MediaHarness();
    MockRecorder.harness = harness;

    mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    mediaRecorderDescriptor = Object.getOwnPropertyDescriptor(window, "MediaRecorder");
    audioContextDescriptor = Object.getOwnPropertyDescriptor(window, "AudioContext");
    requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
    cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");

    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: harness.getUserMedia },
    });
    Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: Object.assign(MockRecorder, { isTypeSupported: harness.isTypeSupported }),
    });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: MockAudioContext });
    Object.defineProperty(window, "requestAnimationFrame", {
        configurable: true,
        value: jest.fn(() => 1),
    });
    Object.defineProperty(window, "cancelAnimationFrame", { configurable: true, value: jest.fn() });
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        beginPath: jest.fn(),
        clearRect: jest.fn(),
        lineTo: jest.fn(),
        moveTo: jest.fn(),
        stroke: jest.fn(),
        strokeStyle: "",
        lineWidth: 1,
    } as unknown as CanvasRenderingContext2D);
});

afterEach(async () => {
    await unmount();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();

    if (mediaDevicesDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    if (mediaRecorderDescriptor) Object.defineProperty(window, "MediaRecorder", mediaRecorderDescriptor);
    else Reflect.deleteProperty(window, "MediaRecorder");
    if (audioContextDescriptor) Object.defineProperty(window, "AudioContext", audioContextDescriptor);
    else Reflect.deleteProperty(window, "AudioContext");
    if (requestAnimationFrameDescriptor) {
        Object.defineProperty(window, "requestAnimationFrame", requestAnimationFrameDescriptor);
    } else {
        Reflect.deleteProperty(window, "requestAnimationFrame");
    }
    if (cancelAnimationFrameDescriptor) {
        Object.defineProperty(window, "cancelAnimationFrame", cancelAnimationFrameDescriptor);
    } else {
        Reflect.deleteProperty(window, "cancelAnimationFrame");
    }
});

describe("Composer voice recording", () => {
    it("disables voice capture with a browser-unsupported tooltip when capability is missing", async () => {
        Object.defineProperty(window, "MediaRecorder", { configurable: true, value: undefined });
        const { container } = await renderComposer();

        const mic = button(container, "Record voice message");
        expect(mic.disabled).toBe(true);
        expect(mic.title).toBe("Voice recording isn't supported in this browser.");
        expect(mic.getAttribute("aria-disabled")).toBe("true");
    });

    it("starts under StrictMode, requests audio, and records with a 1000 ms timeslice", async () => {
        const { container } = await renderComposer(true);

        const recorder = await startRecording(container);

        expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true });
        expect(recorder.start).toHaveBeenCalledWith(1000);
        expect(recorder.startTimeslice).toBe(1000);
    });

    it("continues recording with a static indicator when AudioContext initialization fails", async () => {
        Object.defineProperty(window, "AudioContext", {
            configurable: true,
            value: class {
                public constructor() {
                    throw new Error("Web Audio unavailable");
                }
            },
        });
        const { container } = await renderComposer();

        const recorder = await startRecording(container);

        expect(recorder.state).toBe("recording");
        expect(harness.streams[0].track.stop).not.toHaveBeenCalled();
        expect(voiceError(container)).toBeNull();
        expect(container.querySelector(".mj_VoiceRecording_waveformFallback")).not.toBeNull();
        expect(container.querySelector(".mj_VoiceRecording_waveform")).toBeNull();
    });

    it("maps microphone permission denial to an inline error", async () => {
        harness.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
        const { container } = await renderComposer();

        await click(container, "Record voice message");

        expect(voiceError(container)).toBe("Microphone access denied.");
    });

    it("discards without sending and commits a stop exactly once", async () => {
        const sendVoiceNote = jest.spyOn(MatronJournalClient.prototype, "sendVoiceNote").mockResolvedValue("sent");
        const { container } = await renderComposer();
        const recorder = await startRecording(container);

        await click(container, "Discard recording");
        button(container, "Discard recording").click();
        expect(recorder.state).toBe("inactive");
        expect(recorder.stop).toHaveBeenCalledTimes(1);
        await advance(0);

        expect(sendVoiceNote).not.toHaveBeenCalled();
        expect(container.querySelector(".mj_VoiceRecording")).toBeNull();
    });

    it("restores focus to the mic after send completion", async () => {
        jest.spyOn(MatronJournalClient.prototype, "sendVoiceNote").mockResolvedValue("sent");
        const { container } = await renderComposer();

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);

        expect(button(container, "Record voice message")).toBe(document.activeElement);
    });

    it("restores focus to the mic after discard completion", async () => {
        const { container } = await renderComposer();
        await startRecording(container);
        button(container, "Discard recording").focus();

        await click(container, "Discard recording");
        await advance(0);

        expect(button(container, "Record voice message")).toBe(document.activeElement);
    });

    it("keeps the async stop gap across a conversation switch and sends every queued chunk to the captured convo", async () => {
        harness.queue({ finalChunk: "FINAL-A", finalMime: "audio/webm" });
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockResolvedValue("sent");
        const { container } = await renderComposer(false, client);
        const recorder = await startRecording(container);
        recorder.emitData("HEAD", "audio/webm");

        await click(container, "Stop and send voice message");
        expect(recorder.state).toBe("inactive");
        expect(sendVoiceNote).not.toHaveBeenCalled();
        await act(async () => {
            await client.selectConversation("B");
        });
        expect(recorder.state).toBe("inactive");

        await advance(0);

        expect(sendVoiceNote).toHaveBeenCalledTimes(1);
        const [blob, convoId] = sendVoiceNote.mock.calls[0];
        expect(convoId).toBe("A");
        expect(blob.size).toBe("HEAD".length + "FINAL-A".length);
        expect(blob.type).toBe("audio/webm");
    });

    it("uses the watchdog to send partial audio exactly once when onstop is absent", async () => {
        harness.queue({ autoStopEvents: false, finalChunk: "UNUSED" });
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockResolvedValue("sent");
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { container } = await renderComposer(false, client);
        const recorder = await startRecording(container);
        recorder.emitData("PARTIAL", "audio/webm");

        await click(container, "Stop and send voice message");
        await advance(3000);

        expect(sendVoiceNote).toHaveBeenCalledTimes(1);
        expect(sendVoiceNote.mock.calls[0][0].size).toBe("PARTIAL".length);
        expect(sendVoiceNote.mock.calls[0][1]).toBe("A");
        expect(voiceError(container)).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            "voice: onstop absent — watchdog finalizing",
            expect.objectContaining({ rid: 1, chunks: 1 }),
        );
        await act(async () => recorder.dispatchFinalEvents());
        expect(sendVoiceNote).toHaveBeenCalledTimes(1);
    });

    it("drops a completed recording if the client session changed before onstop", async () => {
        harness.queue({ autoStopEvents: false, finalChunk: "FINAL-A" });
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockResolvedValue("sent");
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { container } = await renderComposer(false, client);
        const recorder = await startRecording(container);

        await click(container, "Stop and send voice message");
        internals(client).sessionGen += 1;
        await act(async () => recorder.dispatchFinalEvents());

        expect(sendVoiceNote).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("voice: session changed before finalize — recording not sent", { rid: 1 });
        expect(harness.streams[0].track.stop).toHaveBeenCalledTimes(1);
    });

    it("keeps recorder errors visible after discard finalization", async () => {
        const { container } = await renderComposer();
        const recorder = await startRecording(container);

        await act(async () => recorder.emitError());
        expect(harness.streams[0].track.stop).toHaveBeenCalledTimes(1);
        expect(voiceError(container)).toBe("Recording stopped unexpectedly.");
        await advance(0);

        expect(voiceError(container)).toBe("Recording stopped unexpectedly.");
    });

    it("shows an error when a committed recording finalizes without audio", async () => {
        harness.queue({ finalChunk: "" });
        const sendVoiceNote = jest.spyOn(MatronJournalClient.prototype, "sendVoiceNote").mockResolvedValue("sent");
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { container } = await renderComposer();

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);

        expect(sendVoiceNote).not.toHaveBeenCalled();
        expect(voiceError(container)).toBe("Recording failed to save.");
        expect(warn).toHaveBeenCalledWith(
            "voice: committed recording contained no audio",
            expect.objectContaining({ disposition: "send", chunks: 0 }),
        );
    });

    it("surfaces a fast artifact-less send outcome using the synchronous voice-state mirror", async () => {
        const client = makeClient();
        jest.spyOn(client, "sendVoiceNote").mockResolvedValue("persist-failed");
        const { container } = await renderComposer(false, client);

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);

        expect(voiceError(container)).toBe("Couldn't save the recording — try again.");
    });

    it("surfaces a rejected send after switching conversations when the composer is idle", async () => {
        const pendingSend = deferred<"sent">();
        const client = makeClient();
        jest.spyOn(client, "sendVoiceNote").mockReturnValue(pendingSend.promise);
        const { container } = await renderComposer(false, client);

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);
        await act(async () => {
            await client.selectConversation("B");
        });
        await act(async () => pendingSend.reject(new Error("failed")));

        expect(voiceError(container)).toBe("Couldn't save the recording — try again.");
    });

    it("surfaces a rejected send without a conversation switch", async () => {
        const client = makeClient();
        jest.spyOn(client, "sendVoiceNote").mockRejectedValue(new Error("failed"));
        const { container } = await renderComposer(false, client);

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);

        expect(voiceError(container)).toBe("Couldn't save the recording — try again.");
    });

    it("allows a committed send promise to settle after unmount", async () => {
        const pendingSend = deferred<"sent">();
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockReturnValue(pendingSend.promise);
        const { container } = await renderComposer(false, client);

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);
        await unmount();
        await act(async () => pendingSend.resolve("sent"));

        expect(sendVoiceNote).toHaveBeenCalledTimes(1);
        expect(sendVoiceNote.mock.calls[0][1]).toBe("A");
    });

    it("does not let an older send rejection clobber a new recording", async () => {
        const pendingSend = deferred<"sent">();
        const client = makeClient();
        jest.spyOn(client, "sendVoiceNote").mockReturnValueOnce(pendingSend.promise).mockResolvedValue("sent");
        const { container } = await renderComposer(false, client);

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);
        await startRecording(container);
        await act(async () => pendingSend.reject(new Error("failed")));

        expect(container.querySelector(".mj_VoiceRecording")).not.toBeNull();
        expect(voiceError(container)).toBeNull();
    });

    it("does not let an older send rejection clobber a newer microphone request", async () => {
        const pendingSend = deferred<"sent">();
        const pendingPermission = deferred<MediaStream>();
        const client = makeClient();
        jest.spyOn(client, "sendVoiceNote").mockReturnValue(pendingSend.promise);
        const { container } = await renderComposer(false, client);

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);
        harness.getUserMedia.mockReturnValueOnce(pendingPermission.promise);
        await click(container, "Record voice message");
        await act(async () => pendingSend.reject(new Error("failed")));

        expect(button(container, "Requesting microphone access").getAttribute("aria-busy")).toBe("true");
        expect(voiceError(container)).toBeNull();
    });

    it("exits requesting on conversation switch and stops a stale late permission stream", async () => {
        const request = deferred<MediaStream>();
        const staleStream = harness.stream() as unknown as MockStream;
        harness.getUserMedia.mockReturnValueOnce(request.promise);
        const client = makeClient();
        const { container } = await renderComposer(false, client);

        await click(container, "Record voice message");
        expect(button(container, "Requesting microphone access").disabled).toBe(true);
        await act(async () => {
            await client.selectConversation("B");
        });
        expect(button(container, "Record voice message").disabled).toBe(false);
        await act(async () => request.resolve(staleStream as unknown as MediaStream));

        expect(staleStream.track.stop).toHaveBeenCalledTimes(1);
        expect(harness.instances).toHaveLength(0);
        expect(button(container, "Record voice message").disabled).toBe(false);
    });

    it("times out acquisition, stops a stale resolve, and does not let it clear the next request timer", async () => {
        const requestA = deferred<MediaStream>();
        const requestB = deferred<MediaStream>();
        const staleStream = harness.stream() as unknown as MockStream;
        harness.getUserMedia.mockReturnValueOnce(requestA.promise).mockReturnValueOnce(requestB.promise);
        const { container } = await renderComposer();

        await click(container, "Record voice message");
        await advance(20_000);
        expect(voiceError(container)).toBe("Microphone request timed out — try again.");
        await click(container, "Record voice message");
        await act(async () => requestA.resolve(staleStream as unknown as MediaStream));
        expect(staleStream.track.stop).toHaveBeenCalledTimes(1);
        expect(button(container, "Requesting microphone access").disabled).toBe(true);
        await advance(20_000);

        expect(voiceError(container)).toBe("Microphone request timed out — try again.");
    });

    it("updates elapsed time and auto-stops once through the guarded send path", async () => {
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockResolvedValue("sent");
        const { container } = await renderComposer(false, client);
        const recorder = await startRecording(container);

        await advance(1500);
        expect(container.querySelector(".mj_VoiceRecording_time")?.textContent).toBe("0:01");
        await advance(5 * 60 * 1000 - 1500);
        expect(recorder.state).toBe("inactive");
        document.dispatchEvent(new Event("visibilitychange"));
        expect(recorder.stop).toHaveBeenCalledTimes(1);
        await advance(1);

        expect(sendVoiceNote).toHaveBeenCalledTimes(1);
    });

    it("does not resend on late recording-A callbacks and keeps recording-B chunks isolated", async () => {
        harness.queue({ autoStopEvents: false, finalChunk: "AAAA-FINAL" });
        harness.queue({ autoStopEvents: false, finalChunk: "BB", finalMime: "audio/webm" });
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockResolvedValue("sent");
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const { container } = await renderComposer(false, client);
        const recorderA = await startRecording(container);
        recorderA.emitData("AAAA", "audio/webm");
        await click(container, "Stop and send voice message");
        await advance(3000);
        expect(sendVoiceNote).toHaveBeenCalledTimes(1);
        expect(sendVoiceNote.mock.calls[0][0].size).toBe("AAAA".length);
        expect(voiceError(container)).toBeNull();

        const recorderB = await startRecording(container);
        recorderB.emitData("B", "audio/webm");
        await act(async () => recorderA.dispatchFinalEvents());
        expect(sendVoiceNote).toHaveBeenCalledTimes(1);
        await click(container, "Stop and send voice message");
        await act(async () => recorderB.dispatchFinalEvents());

        expect(sendVoiceNote).toHaveBeenCalledTimes(2);
        expect(sendVoiceNote.mock.calls[1][0].size).toBe("B".length + "BB".length);
        expect(sendVoiceNote.mock.calls[1][0].type).toBe("audio/webm");
        expect(warn).toHaveBeenCalledWith(
            "voice: onstop absent — watchdog finalizing",
            expect.objectContaining({ rid: 1 }),
        );
    });

    it("captures a fallback MIME from onstart after start initially reports no type", async () => {
        harness.supportedMimes.clear();
        harness.queue({ initialMime: "", startMime: "audio/mp4", finalMime: "audio/mp4" });
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockResolvedValue("sent");
        const { container } = await renderComposer(false, client);

        const recorder = await startRecording(container);
        expect(recorder.mimeType).toBe("");
        await advance(0);
        expect(recorder.mimeType).toBe("audio/mp4");
        await click(container, "Stop and send voice message");
        await advance(0);

        expect(sendVoiceNote.mock.calls[0][0].type).toBe("audio/mp4");
    });

    it("uses a chunk MIME when stopped before onstart and defaults only when no real MIME arrives", async () => {
        harness.supportedMimes.clear();
        harness.queue({
            initialMime: "",
            startDelay: 100,
            startMime: "audio/mp4",
            finalChunk: "",
            finalMime: "",
        });
        harness.queue({ autoStart: false, initialMime: "", finalChunk: "UNTYPED", finalMime: "" });
        const client = makeClient();
        const sendVoiceNote = jest.spyOn(client, "sendVoiceNote").mockResolvedValue("sent");
        const { container } = await renderComposer(false, client);

        const fastRecorder = await startRecording(container);
        fastRecorder.emitData("MP4", "audio/mp4");
        await click(container, "Stop and send voice message");
        await advance(0);
        expect(sendVoiceNote.mock.calls[0][0].type).toBe("audio/mp4");

        await startRecording(container);
        await click(container, "Stop and send voice message");
        await advance(0);
        expect(sendVoiceNote.mock.calls[1][0].type).toBe("audio/webm");
    });

    it("stops a permission stream that resolves after unmount without starting a recorder", async () => {
        const request = deferred<MediaStream>();
        const lateStream = harness.stream() as unknown as MockStream;
        harness.getUserMedia.mockReturnValueOnce(request.promise);
        const { container } = await renderComposer();

        await click(container, "Record voice message");
        await unmount();
        await act(async () => request.resolve(lateStream as unknown as MediaStream));

        expect(lateStream.track.stop).toHaveBeenCalledTimes(1);
        expect(harness.instances).toHaveLength(0);
    });
});
