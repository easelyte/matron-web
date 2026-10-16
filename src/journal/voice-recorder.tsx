/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The voice-note controls shared by the chat composer and the tracker item reply box: the hook
 * that binds a surface to the app's one recording (`VoiceNoteSession`), the live waveform, the
 * controls drawn while recording, and the app-wide indicator for a note recording off screen.
 * The recording itself lives in the session, so it outlives the surface that started it; what a
 * finished recording is FOR belongs to the caller's `onRecorded`.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ArrowUpCircleIcon, CloseIcon, MicOnIcon, StopIcon, TrashIcon, WarningTriangleIcon } from "./icons";
import {
    type VoiceNoteDeliver,
    type VoiceNoteSnapshot,
    type VoiceRecordingContext,
    type VoiceSessionClient,
    type VoiceState,
    voiceNoteSessionFor,
} from "./voice-note-session";

export type { VoiceRecordingContext, VoiceState } from "./voice-note-session";

export interface VoiceRecorder {
    voiceState: VoiceState;
    voiceSupported: boolean;
    elapsedLabel: string;
    /** The elapsed time for the live region: whole minutes, empty in the first minute. */
    spokenElapsed: string;
    waveformActive: boolean;
    /** The error to show while `voiceState` is "error". */
    errorMessage: string | null;
    /** A stop was committed and the recorder has not finalized yet: the bar's buttons are inert. */
    stopInFlight: boolean;
    acquireVoice: () => void;
    commitVoiceStop: (disposition: "send" | "discard") => void;
    dismissError: () => void;
    /** A send of a finished recording failed: show `message` unless a new recording is under way. */
    reportSendFailure: (message: string) => void;
    containerRef: React.RefObject<HTMLDivElement | null>;
    micButtonRef: React.RefObject<HTMLButtonElement | null>;
    stopButtonRef: React.RefObject<HTMLButtonElement | null>;
    waveformCanvasRef: React.RefObject<HTMLCanvasElement | null>;
}

function elapsedLabelOf(elapsedMs: number): string {
    const minutes = Math.floor(elapsedMs / 60_000);
    const seconds = Math.floor((elapsedMs % 60_000) / 1000);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The recording time as a screen reader hears it: whole minutes only, so a live region speaks once
 * a minute rather than every second.
 */
function spokenElapsedOf(elapsedMs: number): string {
    const minutes = Math.floor(elapsedMs / 60_000);
    return minutes === 0 ? "" : `, ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** What `snapshot` means for the surface showing `key`: its own note's state, or its own error. */
function stateFor(snapshot: VoiceNoteSnapshot, key: string | undefined, localError: string | null): VoiceState {
    if (key !== undefined && snapshot.target?.key === key) return snapshot.state;
    return localError ? "error" : "idle";
}

export function useVoiceRecorder({
    contextKey,
    client,
    onRecorded,
    kind,
    title,
    deliverAway,
}: {
    /** The place the mic serves (a conversation id, an item number). */
    contextKey: string | undefined;
    /** The session generation binds a recording to the session it began in. */
    client: VoiceSessionClient;
    /** A recording committed with "send" that holds audio, made in the still-current session. */
    onRecorded: (blob: Blob, context: VoiceRecordingContext) => void;
    /** What the place is: "conversation" or "item". Names the surface to the session. */
    kind: string;
    /** What the place is called, for the app-wide indicator and a refused second note. */
    title: string;
    /**
     * Makes the note outlive this surface: it keeps recording when the surface switches place or
     * unmounts, and goes out through this when no surface of its kind is mounted to send it.
     * Without it, leaving the place ends its note, as before.
     */
    deliverAway?: VoiceNoteDeliver;
}): VoiceRecorder {
    const session = voiceNoteSessionFor(client);
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const key = contextKey === undefined ? undefined : `${kind}:${contextKey}`;
    const keyRef = useRef(key);
    keyRef.current = key;
    const onRecordedRef = useRef(onRecorded);
    onRecordedRef.current = onRecorded;
    const deliverAwayRef = useRef(deliverAway);
    deliverAwayRef.current = deliverAway;
    const persistent = deliverAway !== undefined;
    const [surfaceId] = useState(() => ({}));
    const [localError, reactSetLocalError] = useState<string | null>(null);
    const localErrorRef = useRef<string | null>(null);
    const setLocalError = useCallback((message: string | null): void => {
        localErrorRef.current = message;
        reactSetLocalError(message);
    }, []);
    const containerRef = useRef<HTMLDivElement>(null);
    const micButtonRef = useRef<HTMLButtonElement>(null);
    const stopButtonRef = useRef<HTMLButtonElement>(null);
    const restoreVoiceFocusRef = useRef(false);
    const focusStopRef = useRef(false);
    const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
    const mine = key !== undefined && snapshot.target?.key === key;
    const voiceState = stateFor(snapshot, key, localError);
    const waveformActive = mine && snapshot.waveformActive;

    // Register as a surface for this place: the app-wide indicator hides while it is on screen, and
    // a persistent note of this kind is sent through it. Leaving a place ends its note unless the
    // note is persistent.
    useLayoutEffect(() => {
        session.registerSurface(surfaceId, {
            kind,
            key,
            deliver: (blob, context) => onRecordedRef.current(blob, context),
        });
        return () => {
            session.unregisterSurface(surfaceId);
            if (!persistent && key !== undefined) session.cancelIfTargeting(key);
        };
    }, [session, surfaceId, kind, key, persistent]);

    // Focus goes back to the mic after this surface's own note finishes, if it was in the bar. The
    // check runs as the session changes, before the bar unmounts and takes the focus with it.
    useEffect(() => {
        let recordingKey: string | undefined;
        const check = (): void => {
            const next = session.getSnapshot();
            const recording = next.target?.key === keyRef.current && next.state === "recording";
            if (recordingKey !== undefined && recordingKey === keyRef.current && !recording && next.state !== "error") {
                restoreVoiceFocusRef.current = Boolean(containerRef.current?.contains(document.activeElement));
            }
            recordingKey = recording ? keyRef.current : undefined;
        };
        check();
        return session.subscribe(check);
    }, [session]);

    // The live waveform, drawn from the session's analyser while this surface shows its note.
    useEffect(() => {
        if (voiceState !== "recording" || !waveformActive) return;
        const values = new Uint8Array(session.analyser?.frequencyBinCount ?? 0);
        const reducedMotion =
            typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let rafId: number | null = null;
        const draw = (): void => {
            const canvas = waveformCanvasRef.current;
            const currentAnalyser = session.analyser;
            if (canvas && currentAnalyser) {
                const context = canvas.getContext("2d");
                if (context) {
                    const width = Math.max(1, Math.floor(canvas.clientWidth * window.devicePixelRatio));
                    const height = Math.max(1, Math.floor(canvas.clientHeight * window.devicePixelRatio));
                    if (canvas.width !== width) canvas.width = width;
                    if (canvas.height !== height) canvas.height = height;
                    if (!reducedMotion) currentAnalyser.getByteTimeDomainData(values);
                    context.clearRect(0, 0, width, height);
                    const computed = getComputedStyle(canvas);
                    context.strokeStyle =
                        computed.getPropertyValue("--mj-color-icon-accent-primary").trim() || computed.color;
                    context.lineWidth = Math.max(1, window.devicePixelRatio);
                    context.beginPath();
                    for (let index = 0; index < values.length; index += 1) {
                        const x = (index / Math.max(1, values.length - 1)) * width;
                        const y = reducedMotion ? height / 2 : (values[index] / 255) * height;
                        if (index === 0) context.moveTo(x, y);
                        else context.lineTo(x, y);
                    }
                    context.stroke();
                }
            }
            rafId = requestAnimationFrame(draw);
        };
        draw();
        return () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [session, voiceState, waveformActive]);

    const acquireVoice = useCallback((): void => {
        const currentKey = keyRef.current;
        if (currentKey === undefined || contextKey === undefined) return;
        setLocalError(null);
        focusStopRef.current = true;
        const refused = session.start({
            key: currentKey,
            kind,
            contextKey,
            title,
            persistent,
            deliver: (blob, context) => onRecordedRef.current(blob, context),
            deliverAway: persistent
                ? (blob, context) => deliverAwayRef.current?.(blob, context) ?? Promise.resolve(null)
                : undefined,
        });
        if (refused) {
            focusStopRef.current = false;
            setLocalError(refused);
        }
    }, [session, kind, contextKey, title, persistent, setLocalError]);

    const commitVoiceStop = useCallback(
        (disposition: "send" | "discard"): void => {
            session.stop(disposition);
            const inert = session.getSnapshot().stopInFlight;
            containerRef.current?.querySelectorAll<HTMLButtonElement>(".mj_VoiceRecording_action").forEach((button) => {
                button.disabled = inert;
            });
        },
        [session],
    );

    const dismissError = useCallback((): void => {
        setLocalError(null);
        if (keyRef.current !== undefined) session.dismissError(keyRef.current);
    }, [session, setLocalError]);

    const reportSendFailure = useCallback(
        (message: string): void => {
            if (stateFor(session.getSnapshot(), keyRef.current, localErrorRef.current) === "idle") {
                setLocalError(message);
            }
        },
        [session, setLocalError],
    );

    // The stop button takes focus as a note this surface asked for starts; coming back to a place
    // whose note is already recording leaves focus where the user put it.
    useLayoutEffect(() => {
        if (voiceState === "recording") {
            if (focusStopRef.current) stopButtonRef.current?.focus();
            focusStopRef.current = false;
        } else if (voiceState === "idle") {
            const shouldRestoreFocus = restoreVoiceFocusRef.current;
            restoreVoiceFocusRef.current = false;
            if (shouldRestoreFocus) micButtonRef.current?.focus();
        }
    }, [voiceState]);

    return {
        voiceState,
        voiceSupported: session.supported,
        elapsedLabel: elapsedLabelOf(mine ? snapshot.elapsedMs : 0),
        spokenElapsed: spokenElapsedOf(mine ? snapshot.elapsedMs : 0),
        waveformActive,
        errorMessage: mine ? snapshot.errorMessage : localError,
        stopInFlight: mine && snapshot.stopInFlight,
        acquireVoice,
        commitVoiceStop,
        dismissError,
        reportSendFailure,
        containerRef,
        micButtonRef,
        stopButtonRef,
        waveformCanvasRef,
    };
}

/** The recording row: live dot, waveform, elapsed time, discard and stop-and-send. */
export function VoiceRecordingBar({
    recorder,
    sendLabel = "Stop and send voice message",
}: {
    recorder: VoiceRecorder;
    sendLabel?: string;
}): React.ReactElement {
    return (
        <div className="mj_VoiceRecording">
            <span className="mj_VoiceRecording_dot" aria-hidden="true" />
            {recorder.waveformActive ? (
                <canvas className="mj_VoiceRecording_waveform" ref={recorder.waveformCanvasRef} aria-hidden="true" />
            ) : (
                <span className="mj_VoiceRecording_waveformFallback" aria-hidden="true" />
            )}
            <span className="mj_VoiceRecording_time" aria-hidden="true">
                {recorder.elapsedLabel}
            </span>
            <span className="mj_ScreenReaderOnly" aria-live="polite">
                Recording{recorder.spokenElapsed}
            </span>
            <button
                className="mj_VoiceRecording_action"
                type="button"
                aria-label="Discard recording"
                title="Discard recording"
                disabled={recorder.stopInFlight}
                onClick={() => recorder.commitVoiceStop("discard")}
            >
                <TrashIcon />
            </button>
            <button
                ref={recorder.stopButtonRef}
                className="mj_VoiceRecording_action mj_VoiceRecording_stop"
                type="button"
                aria-label={sendLabel}
                title={sendLabel}
                disabled={recorder.stopInFlight}
                onClick={() => recorder.commitVoiceStop("send")}
            >
                <StopIcon />
            </button>
        </div>
    );
}

/** The mic button: records on tap, a spinner while the browser asks for the microphone. */
export function VoiceMicButton({
    recorder,
    className,
    label = "Record voice message",
    disabled = false,
}: {
    recorder: VoiceRecorder;
    className: string;
    label?: string;
    disabled?: boolean;
}): React.ReactElement {
    const { voiceState, voiceSupported } = recorder;
    const inert = !voiceSupported || voiceState === "requesting" || disabled;
    return (
        <button
            ref={recorder.micButtonRef}
            type="button"
            className={className}
            title={
                voiceSupported
                    ? voiceState === "requesting"
                        ? "Requesting microphone access…"
                        : label
                    : "Voice recording isn't supported in this browser."
            }
            aria-label={voiceState === "requesting" ? "Requesting microphone access" : label}
            aria-busy={voiceState === "requesting"}
            aria-disabled={inert}
            disabled={inert}
            onClick={recorder.acquireVoice}
        >
            {voiceState === "requesting" ? <span className="mj_Spinner" aria-hidden="true" /> : <MicOnIcon />}
        </button>
    );
}

/** The recorder's error, dismissable. Nothing unless the recorder is in its error state. */
export function VoiceErrorBanner({ recorder }: { recorder: VoiceRecorder }): React.ReactElement | null {
    if (recorder.voiceState !== "error" || !recorder.errorMessage) return null;
    return (
        <div className="mj_ConnectionError mj_VoiceError">
            <span role="status">{recorder.errorMessage}</span>
            <button
                className="mj_ConnectionError_dismiss"
                type="button"
                aria-label="Dismiss recording error"
                title="Dismiss recording error"
                onClick={recorder.dismissError}
            >
                <CloseIcon />
            </button>
        </div>
    );
}

/** Whether the app-wide voice-note bar has anything to show, for the layout that makes room for it. */
export function useVoiceNoteBarVisible(client: VoiceSessionClient): boolean {
    const session = voiceNoteSessionFor(client);
    return useSyncExternalStore(session.subscribe, () => {
        const snapshot = session.getSnapshot();
        return snapshot.showsIndicator || snapshot.sending !== null || snapshot.failures.length > 0;
    });
}

/**
 * The app-wide voice-note bar, along the bottom of the main column: while a conversation's note
 * records and its composer isn't on screen, a pill says where the note is going with the running
 * time, Cancel and Send, and the rest of it goes back there. A note finished from here that didn't
 * send becomes a Retry / Discard row, so a note for a conversation that has since gone away is never
 * silently lost.
 */
export function VoiceNoteBar({
    client,
    onOpen,
}: {
    client: VoiceSessionClient;
    /** Goes back to the place a note is for: its target's kind and the caller's own id. */
    onOpen: (kind: string, contextKey: string) => void;
}): React.ReactElement | null {
    const session = voiceNoteSessionFor(client);
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const live = snapshot.showsIndicator ? snapshot.target : null;
    const sending = live ? null : snapshot.sending;
    if (!live && !sending && snapshot.failures.length === 0) return null;
    return (
        <div className="mj_VoiceNoteBar" role="region" aria-label="Voice note">
            {live && (
                <div className="mj_VoiceNoteIndicator">
                    <button
                        className="mj_VoiceNoteIndicator_open"
                        type="button"
                        title="Open the conversation this voice note is for"
                        onClick={() => onOpen(live.kind, live.contextKey)}
                    >
                        <span className="mj_VoiceRecording_dot" aria-hidden="true" />
                        <span className="mj_VoiceNoteIndicator_text">
                            <span className="mj_VoiceNoteIndicator_headline">
                                Recording{" "}
                                <span className="mj_VoiceNoteIndicator_time">{elapsedLabelOf(snapshot.elapsedMs)}</span>
                            </span>
                            <span className="mj_VoiceNoteIndicator_subtitle">For {live.title}</span>
                        </span>
                    </button>
                    <span className="mj_ScreenReaderOnly" aria-live="polite">
                        Voice note recording for {live.title}
                        {spokenElapsedOf(snapshot.elapsedMs)}
                    </span>
                    <button
                        className="mj_VoiceNoteIndicator_action"
                        type="button"
                        aria-label="Cancel voice note"
                        title="Cancel voice note"
                        disabled={snapshot.stopInFlight}
                        onClick={() => session.stop("discard")}
                    >
                        <CloseIcon />
                    </button>
                    <button
                        className="mj_VoiceNoteIndicator_action mj_VoiceNoteIndicator_send"
                        type="button"
                        aria-label="Send voice note"
                        title="Send voice note"
                        disabled={snapshot.stopInFlight}
                        onClick={() => session.stop("send")}
                    >
                        <ArrowUpCircleIcon />
                    </button>
                </div>
            )}
            {sending && (
                <div className="mj_VoiceNoteIndicator" role="status">
                    <button
                        className="mj_VoiceNoteIndicator_open"
                        type="button"
                        title="Open the conversation this voice note is for"
                        onClick={() => onOpen(sending.kind, sending.contextKey)}
                    >
                        <span className="mj_Spinner" aria-hidden="true" />
                        <span className="mj_VoiceNoteIndicator_text">
                            <span className="mj_VoiceNoteIndicator_headline">Sending voice note…</span>
                            <span className="mj_VoiceNoteIndicator_subtitle">For {sending.title}</span>
                        </span>
                    </button>
                </div>
            )}
            {snapshot.failures.map((failure) => (
                <div key={failure.id} className="mj_VoiceNoteIndicator mj_VoiceNoteIndicator_failed">
                    <button
                        className="mj_VoiceNoteIndicator_open"
                        type="button"
                        title="Open the conversation this voice note is for"
                        onClick={() => onOpen(failure.target.kind, failure.target.contextKey)}
                    >
                        <WarningTriangleIcon className="mj_VoiceNoteIndicator_warning" aria-hidden="true" />
                        <span className="mj_VoiceNoteIndicator_text">
                            <span className="mj_VoiceNoteIndicator_headline" role="status">
                                Voice note didn't send
                            </span>
                            <span className="mj_VoiceNoteIndicator_subtitle">
                                {failure.target.title}: {failure.message}
                            </span>
                        </span>
                    </button>
                    <button
                        className="mj_VoiceNoteIndicator_textAction"
                        type="button"
                        onClick={() => session.discard(failure.id)}
                    >
                        Discard
                    </button>
                    <button
                        className="mj_VoiceNoteIndicator_textAction mj_VoiceNoteIndicator_retry"
                        type="button"
                        onClick={() => session.retry(failure.id)}
                    >
                        Retry
                    </button>
                </div>
            ))}
        </div>
    );
}
