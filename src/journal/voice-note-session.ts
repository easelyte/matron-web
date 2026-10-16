/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The app's one voice-note recording, owned above every page. Each composer used to own its own
 * MediaRecorder and stop it when it unmounted or switched conversation, so a note died the moment
 * the user looked elsewhere. Now a surface (the chat composer, an item's reply box) starts a note
 * here with the place it belongs to, and from then on the microphone, the MediaRecorder and their
 * timers live here: a conversation's note keeps recording across any navigation, and Stop from
 * anywhere (the composer's own bar, the app-wide indicator) sends it to that conversation, never to
 * whatever is on screen.
 *
 * One note at a time: a start for another place while one is recording is refused, naming where the
 * live note is going. An item reply's note is not persistent: its surface ends it when it leaves, as
 * before. Sign-out, the app unmounting and the page going away all release the microphone.
 *
 * Holds the MediaRecorder lifecycle the hook had: microphone acquisition with its timeout and
 * session binding, a 5-minute cap, an onstop watchdog and late-error guards.
 */

export type VoiceState = "idle" | "requesting" | "recording" | "error";

/** Where a finished recording was made: the caller's context at mic time, and the session then. */
export interface VoiceRecordingContext {
    contextKey: string;
    sessionGen: number;
}

/**
 * Sends a finished recording. A surface's own sender reports its failures itself (void); the
 * fallback for a note finished while its surface is gone resolves to a message when it didn't go.
 */
export type VoiceNoteDeliver = (blob: Blob, context: VoiceRecordingContext) => Promise<string | null> | void;

export interface VoiceNoteTarget {
    /** Namespaced by kind, so a conversation and an item can never share one: "conversation:A". */
    key: string;
    kind: string;
    /** The caller's own id for the place, handed back with the recording. */
    contextKey: string;
    /** What the indicator and a refusal call the place. */
    title: string;
    /** Keeps recording when its surface leaves the screen. Otherwise the surface ends it. */
    persistent: boolean;
}

export interface VoiceNoteStart extends VoiceNoteTarget {
    /** Used for a persistent note when no surface of its kind is mounted to send it. */
    deliverAway?: VoiceNoteDeliver;
    /** The starting surface's sender: used for a note that isn't persistent. */
    deliver: VoiceNoteDeliver;
}

/** A note finished away from its surface that didn't send; kept for Retry until discarded. */
export interface VoiceNoteFailure {
    id: number;
    target: VoiceNoteTarget;
    message: string;
}

export interface VoiceNoteSnapshot {
    /** The state of `target`'s note. Idle means no note: `target` is null. */
    state: VoiceState;
    target: VoiceNoteTarget | null;
    errorMessage: string | null;
    elapsedMs: number;
    waveformActive: boolean;
    /** A stop was committed and the recorder has not finalized yet. */
    stopInFlight: boolean;
    /** A persistent note is recording and no surface showing its own bar is on screen. */
    showsIndicator: boolean;
    /** A note finished away from its surface is being sent. */
    sending: VoiceNoteTarget | null;
    failures: readonly VoiceNoteFailure[];
}

export interface VoiceSessionClient {
    readonly sessionGeneration: number;
    subscribe?: (listener: () => void) => () => void;
}

interface Surface {
    kind: string;
    key: string | undefined;
    deliver: VoiceNoteDeliver;
}

const MAX_RECORDING_MS = 5 * 60 * 1000;

export class VoiceNoteSession {
    private readonly listeners = new Set<() => void>();
    private snapshot: VoiceNoteSnapshot = {
        state: "idle",
        target: null,
        errorMessage: null,
        elapsedMs: 0,
        waveformActive: false,
        stopInFlight: false,
        showsIndicator: false,
        sending: null,
        failures: [],
    };

    private voiceState: VoiceState = "idle";
    private target: VoiceNoteStart | null = null;
    private errorMessage: string | null = null;
    private elapsedMs = 0;
    private waveformActive = false;
    private sending: VoiceNoteTarget | null = null;
    private sendsInFlight = 0;
    private failures: VoiceNoteFailure[] = [];
    private readonly failedNotes = new Map<number, { blob: Blob; start: VoiceNoteStart; sessionGen: number }>();
    private nextFailureId = 1;
    private readonly surfaces = new Map<object, Surface>();

    private gen = 0;
    private resetGen = 0;
    private knownSessionGen: number;
    private mediaRecorder: MediaRecorder | null = null;
    private mediaStream: MediaStream | null = null;
    private audioContext: AudioContext | null = null;
    private currentAnalyser: AnalyserNode | null = null;
    private chunks: Blob[] = [];
    private recMime: string | undefined;
    private recordingStartMs = 0;
    private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    private acquireTimer: ReturnType<typeof setTimeout> | null = null;
    private disposition: "send" | "discard" = "discard";
    private sendInFlight = false;
    private stoppedAway = false;
    private stopInFlight = false;
    private finalized = false;
    private recordingId = 0;
    private recordingSessionGen = 0;
    private visibilityHandler: (() => void) | null = null;

    public constructor(private readonly client: VoiceSessionClient) {
        this.knownSessionGen = client.sessionGeneration;
        // Sign-out or a replaced session: nothing of the old account keeps recording or sending.
        client.subscribe?.(() => {
            if (client.sessionGeneration === this.knownSessionGen) return;
            this.knownSessionGen = client.sessionGeneration;
            this.reset();
        });
        // The page going away (or into the back-forward cache) gives the microphone back.
        window.addEventListener("pagehide", () => this.cancel());
    }

    public readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    public readonly getSnapshot = (): VoiceNoteSnapshot => this.snapshot;

    /** The live analyser for a waveform, while one could be built. */
    public get analyser(): AnalyserNode | null {
        return this.currentAnalyser;
    }

    public get supported(): boolean {
        return Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder !== "undefined";
    }

    /**
     * Starts a note for `start`. Returns a message when refused because another place's note is
     * starting or recording; a second start for the same place is ignored.
     */
    public start(start: VoiceNoteStart): string | null {
        if (!this.supported) return null;
        if (this.target && (this.voiceState === "requesting" || this.voiceState === "recording")) {
            if (this.target.key === start.key) return null;
            return `Already recording a voice note for “${this.target.title}”. Send or cancel it first.`;
        }
        const gen = ++this.gen;
        // Bind mic acquisition to the session generation at REQUEST time (finalize/send are already
        // session-bound via recordingSessionGen). A getUserMedia pending across a logout / session
        // replacement must not be adopted by the replacement session.
        const acquireSessionGen = this.client.sessionGeneration;
        this.target = start;
        this.errorMessage = null;
        this.voiceState = "requesting";
        this.emit();
        const localTimer = setTimeout(() => {
            if (gen === this.gen && this.voiceState === "requesting") {
                if (this.acquireTimer === localTimer) this.acquireTimer = null;
                ++this.gen;
                this.fail("Microphone request timed out — try again.");
            }
        }, 20_000);
        this.acquireTimer = localTimer;
        void navigator.mediaDevices.getUserMedia({ audio: true }).then(
            (stream) => {
                clearTimeout(localTimer);
                if (this.acquireTimer === localTimer) this.acquireTimer = null;
                if (gen !== this.gen || this.client.sessionGeneration !== acquireSessionGen) {
                    stream.getTracks().forEach((track) => track.stop());
                    // A session-replaced request is cancelled, not hung: the 20 s timeout was just
                    // cleared, so without this the button would stay locked in "requesting".
                    if (gen === this.gen) this.setIdle();
                    return;
                }
                this.startRecording(stream);
            },
            (error: unknown) => {
                clearTimeout(localTimer);
                if (this.acquireTimer === localTimer) this.acquireTimer = null;
                if (gen !== this.gen) return;
                const name =
                    typeof error === "object" && error !== null && "name" in error
                        ? String((error as { name: unknown }).name)
                        : "";
                this.fail(
                    name === "NotAllowedError" || name === "SecurityError"
                        ? "Microphone access denied."
                        : name === "NotFoundError"
                          ? "No microphone found."
                          : "Couldn't access the microphone.",
                );
            },
        );
        return null;
    }

    /** Stops the live note: "send" sends it to the place it was started for. */
    public stop(disposition: "send" | "discard"): void {
        const recorder = this.mediaRecorder;
        if (!recorder || recorder.state === "inactive") return;
        if (disposition === "send") {
            this.disposition = "send";
            this.sendInFlight = true;
            // Sent while no surface shows the note's place (the app-wide bar, the duration cap):
            // it goes out on its own, never taking a draft from a composer that opens meanwhile.
            this.stoppedAway = this.snapshot.showsIndicator;
        } else if (!this.sendInFlight) {
            this.disposition = "discard";
        }
        this.stopInFlight = true;
        const rid = this.recordingId;
        const localChunks = this.chunks;
        this.watchdogTimer = setTimeout(() => {
            if (rid !== this.recordingId || this.finalized) return;
            console.warn("voice: onstop absent — watchdog finalizing", {
                rid,
                chunks: localChunks.length,
                elapsedMs: Date.now() - this.recordingStartMs,
            });
            this.finalize(rid, localChunks);
        }, 3000);
        recorder.stop();
        this.emit();
    }

    /** Aborts the live note or microphone request, whatever it is for, and releases the microphone. */
    public cancel(): void {
        ++this.gen;
        if (this.acquireTimer !== null) {
            clearTimeout(this.acquireTimer);
            this.acquireTimer = null;
        }
        if (this.voiceState === "requesting") {
            this.setIdle();
            return;
        }
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") this.stop("discard");
        this.releaseMedia();
    }

    /** Aborts the live note or request only if it is for `key`. */
    public cancelIfTargeting(key: string): void {
        if (this.target?.key !== key) return;
        if (this.voiceState !== "requesting" && this.voiceState !== "recording") return;
        this.cancel();
    }

    /** Clears the error shown for `key`. */
    public dismissError(key: string): void {
        if (this.voiceState !== "error" || this.target?.key !== key) return;
        this.setIdle();
    }

    /** Sends a failed note again, to the same place. */
    public retry(id: number): void {
        const note = this.failedNotes.get(id);
        if (!note) return;
        this.forget(id);
        this.deliver(note.blob, note.start, note.sessionGen, true);
    }

    /** Gives up on a failed note. */
    public discard(id: number): void {
        this.forget(id);
    }

    /** Sign-out: nothing of the old account may keep recording or sending. */
    public reset(): void {
        this.cancel();
        if (this.voiceState === "error") this.setIdle();
        this.resetGen += 1;
        this.failures = [];
        this.failedNotes.clear();
        this.sending = null;
        this.sendsInFlight = 0;
        this.emit();
    }

    /**
     * A surface that can show and send notes of `kind` is mounted, showing `key`. While one shows
     * the live note's own place the app-wide indicator hides rather than doubling the controls, and
     * a persistent note goes through a mounted surface of its kind when it finishes.
     */
    public registerSurface(id: object, surface: Surface): void {
        this.surfaces.set(id, surface);
        this.emit();
    }

    public unregisterSurface(id: object): void {
        if (this.surfaces.delete(id)) this.emit();
    }

    private emit(): void {
        const target = this.target;
        const live = target && this.voiceState !== "idle" ? target : null;
        const showsIndicator = Boolean(
            live?.persistent &&
            this.voiceState === "recording" &&
            ![...this.surfaces.values()].some((surface) => surface.key === live.key),
        );
        this.snapshot = {
            state: this.voiceState,
            target: live && {
                key: live.key,
                kind: live.kind,
                contextKey: live.contextKey,
                title: live.title,
                persistent: live.persistent,
            },
            errorMessage: this.voiceState === "error" ? this.errorMessage : null,
            elapsedMs: this.elapsedMs,
            waveformActive: this.waveformActive,
            stopInFlight: this.stopInFlight,
            showsIndicator,
            sending: this.sending,
            failures: this.failures,
        };
        for (const listener of this.listeners) listener();
    }

    private setIdle(): void {
        this.voiceState = "idle";
        this.errorMessage = null;
        this.elapsedMs = 0;
        this.target = null;
        this.emit();
    }

    private fail(message: string): void {
        this.errorMessage = message;
        this.voiceState = "error";
        this.emit();
    }

    private addFailure(blob: Blob, start: VoiceNoteStart, sessionGen: number, message: string): void {
        const id = this.nextFailureId++;
        this.failedNotes.set(id, { blob, start, sessionGen });
        this.failures = [...this.failures, { id, target: start, message }];
    }

    private forget(id: number): void {
        this.failedNotes.delete(id);
        this.failures = this.failures.filter((failure) => failure.id !== id);
        this.emit();
    }

    private releaseMedia(): void {
        if (this.deadlineTimer !== null) {
            clearTimeout(this.deadlineTimer);
            this.deadlineTimer = null;
        }
        if (this.tickTimer !== null) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
        this.mediaStream?.getTracks().forEach((track) => track.stop());
        this.mediaStream = null;
        const context = this.audioContext;
        this.audioContext = null;
        this.currentAnalyser = null;
        if (context && context.state !== "closed") void context.close().catch(() => undefined);
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
    }

    private releaseResources(): void {
        this.releaseMedia();
        if (this.watchdogTimer !== null) {
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        // Detach handlers on final release: after finalize the recorder object can still emit a late
        // onerror (e.g. during track teardown), which would otherwise flip a finalized/sent note to a
        // false error state. `finalized` guards the onerror body too; detaching is
        // belt-and-suspenders and also drops the reference for GC.
        const recorder = this.mediaRecorder;
        if (recorder) {
            recorder.ondataavailable = null;
            recorder.onstop = null;
            recorder.onerror = null;
        }
        this.mediaRecorder = null;
    }

    private finalize(rid: number, localChunks: Blob[]): void {
        if (rid !== this.recordingId) return;
        if (this.finalized) return;
        this.finalized = true;

        const mime = this.recMime || "audio/webm";
        const blob = localChunks.length ? new Blob(localChunks, { type: mime }) : null;
        const wantSend = this.disposition === "send";
        const start = this.target;
        const capturedSessionGen = this.recordingSessionGen;
        // Nobody asked it to stop: the browser ended it (the microphone was unplugged or its
        // permission withdrawn). What was captured is kept for Retry / Discard, never sent unasked.
        const interrupted = !this.stopInFlight && this.voiceState === "recording";
        this.releaseResources();
        this.waveformActive = false;

        if (interrupted) {
            this.sendInFlight = false;
            if (!blob || !start || this.client.sessionGeneration !== capturedSessionGen) {
                this.fail("The microphone stopped.");
                return;
            }
            this.setIdle();
            this.addFailure(blob, start, capturedSessionGen, "The microphone stopped before it was sent.");
            this.emit();
            return;
        }

        if (wantSend && !blob) {
            this.errorMessage = "Recording failed to save.";
            this.voiceState = "error";
            console.warn("voice: committed recording contained no audio", {
                rid,
                disposition: this.disposition,
                chunks: localChunks.length,
                elapsedMs: Date.now() - this.recordingStartMs,
            });
            this.sendInFlight = false;
            this.stopInFlight = false;
            this.emit();
            return;
        }

        this.sendInFlight = false;
        this.stopInFlight = false;
        if (this.voiceState !== "error") this.setIdle();
        else this.emit();

        if (wantSend && blob && start && this.client.sessionGeneration !== capturedSessionGen) {
            console.warn("voice: session changed before finalize — recording not sent", { rid });
        }
        if (wantSend && blob && start && this.client.sessionGeneration === capturedSessionGen) {
            this.deliver(blob, start, capturedSessionGen, this.stoppedAway);
        }
    }

    /**
     * A persistent note sent away from its place (or retried from the bar) goes out through its
     * fallback, and a failure there is kept for Retry. One sent from its own place goes through the
     * surface still showing that place, which reports its own failures, or the fallback when it has
     * moved on (switched place between Stop and the recorder finalizing, or unmounted).
     * Any other note goes through the surface that started it.
     */
    private deliver(blob: Blob, start: VoiceNoteStart, sessionGen: number, away: boolean): void {
        const context = { contextKey: start.contextKey, sessionGen };
        let deliver = start.deliver;
        if (start.persistent) {
            const surface = [...this.surfaces.values()].find((candidate) => candidate.key === start.key);
            deliver = (away ? undefined : surface?.deliver) ?? start.deliverAway ?? start.deliver;
        }
        const outcome = deliver(blob, context);
        if (!outcome) return;
        const resetGen = this.resetGen;
        this.sendsInFlight += 1;
        this.sending = start;
        this.emit();
        const settle = (message: string | null): void => {
            if (resetGen !== this.resetGen) return;
            this.sendsInFlight -= 1;
            if (this.sendsInFlight === 0) this.sending = null;
            if (message) this.addFailure(blob, start, sessionGen, message);
            this.emit();
        };
        outcome.then(settle, () => settle("Couldn't save the recording."));
    }

    private startRecording(stream: MediaStream): void {
        const rid = ++this.recordingId;
        const localChunks: Blob[] = [];
        this.chunks = localChunks;
        this.recMime = undefined;
        this.mediaStream = stream;
        this.recordingSessionGen = this.client.sessionGeneration;
        this.waveformActive = false;
        try {
            const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((candidate) =>
                window.MediaRecorder.isTypeSupported(candidate),
            );
            const recorder = mimeType
                ? new window.MediaRecorder(stream, { mimeType })
                : new window.MediaRecorder(stream);
            this.mediaRecorder = recorder;
            recorder.onstart = () => {
                if (rid !== this.recordingId || localChunks !== this.chunks) return;
                this.recMime ||= recorder.mimeType || undefined;
            };
            recorder.ondataavailable = (event) => {
                if (rid !== this.recordingId || localChunks !== this.chunks) return;
                this.recMime ||= event.data.type || undefined;
                if (event.data.size) localChunks.push(event.data);
            };
            recorder.onstop = () => {
                if (rid !== this.recordingId || localChunks !== this.chunks) return;
                this.finalize(rid, localChunks);
            };
            recorder.onerror = () => {
                // `finalized`: a late error after the note was already finalized+sent (notably via
                // the onstop-absent watchdog) must not overwrite the sent/idle state with a false error.
                if (rid !== this.recordingId || localChunks !== this.chunks || this.finalized) return;
                this.releaseMedia();
                this.fail("Recording stopped unexpectedly.");
                this.stop("discard");
            };

            try {
                const context = new window.AudioContext();
                this.audioContext = context;
                const analyser = context.createAnalyser();
                analyser.fftSize = 256;
                this.currentAnalyser = analyser;
                context.createMediaStreamSource(stream).connect(analyser);
                this.waveformActive = true;
            } catch {
                const context = this.audioContext;
                this.audioContext = null;
                this.currentAnalyser = null;
                if (context && context.state !== "closed") void context.close().catch(() => undefined);
            }

            this.disposition = "discard";
            this.sendInFlight = false;
            this.stoppedAway = false;
            this.stopInFlight = false;
            this.finalized = false;
            this.recordingStartMs = Date.now();
            this.elapsedMs = 0;
            this.tickTimer = setInterval(() => {
                this.elapsedMs = Date.now() - this.recordingStartMs;
                this.emit();
            }, 500);
            this.deadlineTimer = setTimeout(() => {
                if (Date.now() - this.recordingStartMs >= MAX_RECORDING_MS) this.stop("send");
            }, MAX_RECORDING_MS);
            const reconcileDurationCap = (): void => {
                if (document.visibilityState === "visible" && Date.now() - this.recordingStartMs >= MAX_RECORDING_MS) {
                    this.stop("send");
                }
            };
            this.visibilityHandler = reconcileDurationCap;
            document.addEventListener("visibilitychange", reconcileDurationCap);

            // A track that ends (device unplugged, permission withdrawn) ends the recording; most
            // browsers stop the recorder themselves, this covers those that leave it hanging.
            for (const track of stream.getTracks()) {
                track.addEventListener?.("ended", () => {
                    if (rid !== this.recordingId || this.finalized || recorder.state === "inactive") return;
                    this.watchdogTimer = setTimeout(() => this.finalize(rid, localChunks), 3000);
                    try {
                        recorder.stop();
                    } catch {
                        this.finalize(rid, localChunks);
                    }
                });
            }

            recorder.start(1000);
            this.voiceState = "recording";
            this.emit();
        } catch {
            stream.getTracks().forEach((track) => track.stop());
            this.releaseResources();
            this.fail("Couldn't start recording.");
        }
    }
}

const sessions = new WeakMap<object, VoiceNoteSession>();

/** The one voice-note session for `client`, made on first use. */
export function voiceNoteSessionFor(client: VoiceSessionClient): VoiceNoteSession {
    let session = sessions.get(client);
    if (!session) {
        session = new VoiceNoteSession(client);
        sessions.set(client, session);
    }
    return session;
}
