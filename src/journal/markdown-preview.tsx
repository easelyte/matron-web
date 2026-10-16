/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Markdown attachment preview.
//
// A markdown file attached to a chat message or a tracker item opens in a side panel on the right
// of the current view (full screen on a phone-width window) instead of downloading. The bytes come
// through the client's authenticated media cache (`client.mediaUrl` → GET /media/:blob_ref with
// Bearer auth), are decoded as UTF-8 (invalid bytes replaced), cached per blob_ref for the session,
// and rendered by the app's own markdown renderer in its "document" variant: images never load and
// only http(s)/mailto links are live.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { copyText } from "./clipboard";
import type { MatronJournalClient } from "./client";
import { CloseIcon, CodeBracketsIcon, DownloadIcon } from "./icons";
import { exceedsMarkdownRenderLimit, MarkdownBody } from "./markdown";

// ---------------------------------------------------------------------------------------
// Which attachments preview.
// ---------------------------------------------------------------------------------------

/** Markdown files above this size keep the plain download behaviour. */
export const MARKDOWN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

const MARKDOWN_MIMES = new Set(["text/markdown", "text/x-markdown"]);
const GENERIC_MIMES = new Set(["", "text/plain", "application/octet-stream"]);
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown)$/i;

export interface MarkdownAttachmentLike {
    /** The attachment's MIME (a tracker attachment's `mime`, a file event's `content_type`). */
    mime?: string;
    name?: string;
    /** Bytes; undefined when unknown — the preview then checks the size after fetching. */
    size?: number;
}

function baseMime(mime: string | undefined): string {
    // Drop parameters (`text/markdown; charset=utf-8`) and normalise case.
    return (mime ?? "").split(";", 1)[0].trim().toLowerCase();
}

/**
 * True when an attachment opens in the markdown preview: a markdown MIME, or a `.md` / `.markdown`
 * / `.mdown` name with an empty, text/plain or octet-stream MIME — and no more than 2 MB. An
 * unknown size counts as previewable; the panel falls back to download if the bytes run past 2 MB.
 */
export function isPreviewableMarkdown(attachment: MarkdownAttachmentLike): boolean {
    const mime = baseMime(attachment.mime);
    const byMime = MARKDOWN_MIMES.has(mime);
    const byName = GENERIC_MIMES.has(mime) && MARKDOWN_EXTENSION.test((attachment.name ?? "").trim());
    if (!byMime && !byName) return false;
    const { size } = attachment;
    if (typeof size === "number" && Number.isFinite(size)) return size >= 0 && size <= MARKDOWN_PREVIEW_MAX_BYTES;
    return true;
}

// ---------------------------------------------------------------------------------------
// Panel state.
// ---------------------------------------------------------------------------------------

export interface MarkdownPreviewTarget {
    blobRef: string;
    name: string;
    size?: number;
}

export interface MarkdownPreviewState {
    target?: MarkdownPreviewTarget;
}

export type MarkdownPreviewAction = { type: "open"; target: MarkdownPreviewTarget } | { type: "close" };

/** Open shows a file (replacing whatever was open); close empties the panel. */
export function markdownPreviewReducer(
    state: MarkdownPreviewState,
    action: MarkdownPreviewAction,
): MarkdownPreviewState {
    switch (action.type) {
        case "open":
            if (state.target?.blobRef === action.target.blobRef && state.target.name === action.target.name) {
                return state;
            }
            return { target: action.target };
        case "close":
            return state.target ? {} : state;
        default:
            return state;
    }
}

export interface MarkdownPreviewContextValue {
    openMarkdownPreview: (target: MarkdownPreviewTarget) => void;
}

export const MarkdownPreviewContext = React.createContext<MarkdownPreviewContextValue | undefined>(undefined);

export function useMarkdownPreview(): MarkdownPreviewContextValue | undefined {
    return React.useContext(MarkdownPreviewContext);
}

/** The panel's state plus the context value that opens it. */
export function useMarkdownPreviewPanel(): {
    target?: MarkdownPreviewTarget;
    context: MarkdownPreviewContextValue;
    close: () => void;
} {
    const [state, dispatch] = useReducer(markdownPreviewReducer, {});
    const openMarkdownPreview = useCallback((target: MarkdownPreviewTarget) => dispatch({ type: "open", target }), []);
    const close = useCallback(() => dispatch({ type: "close" }), []);
    const context = useMemo(() => ({ openMarkdownPreview }), [openMarkdownPreview]);
    return { target: state.target, context, close };
}

// ---------------------------------------------------------------------------------------
// Loading.
// ---------------------------------------------------------------------------------------

export type MarkdownLoadResult = { kind: "text"; text: string } | { kind: "tooLarge"; size: number };

type PreviewClient = Pick<MatronJournalClient, "mediaUrl" | "sessionGeneration">;

// Decoded text per blob_ref for the session. The client instance survives a sign-out, so the cache
// is tied to its session generation as well: a new session starts with an empty cache and never
// sees the previous user's text.
const textCache = new WeakMap<object, { generation: number; texts: Map<string, string> }>();

function cacheFor(client: PreviewClient): Map<string, string> {
    const entry = textCache.get(client);
    if (entry && entry.generation === client.sessionGeneration) return entry.texts;
    const texts = new Map<string, string>();
    textCache.set(client, { generation: client.sessionGeneration, texts });
    return texts;
}

/** Decode bytes as UTF-8, replacing invalid sequences (a leading BOM is dropped). */
export function decodeMarkdownBytes(bytes: ArrayBuffer | Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Fetch an attachment's bytes through the authenticated media cache and decode them. Bytes past
 * the 2 MB cap are not decoded: the caller offers the download instead.
 */
export async function loadMarkdownText(client: PreviewClient, blobRef: string): Promise<MarkdownLoadResult> {
    const generation = client.sessionGeneration;
    const cached = cacheFor(client).get(blobRef);
    if (cached !== undefined) return { kind: "text", text: cached };
    const url = await client.mediaUrl(blobRef);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Couldn't load the file (${response.status})`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MARKDOWN_PREVIEW_MAX_BYTES) return { kind: "tooLarge", size: bytes.byteLength };
    const text = decodeMarkdownBytes(bytes);
    // Signed out mid-fetch: don't seed the next session's cache.
    if (client.sessionGeneration !== generation) throw new Error("Not signed in");
    cacheFor(client).set(blobRef, text);
    return { kind: "text", text };
}

type LoadState =
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "tooLarge" }
    | { phase: "ready"; text: string };

function useMarkdownText(client: MatronJournalClient, blobRef: string): LoadState & { retry: () => void } {
    const [state, setState] = useState<{ ref: string; load: LoadState }>({ ref: blobRef, load: { phase: "loading" } });
    const [nonce, setNonce] = useState(0);
    useEffect(() => {
        let live = true;
        setState({ ref: blobRef, load: { phase: "loading" } });
        loadMarkdownText(client, blobRef).then(
            (result) => {
                if (!live) return;
                setState({
                    ref: blobRef,
                    load: result.kind === "text" ? { phase: "ready", text: result.text } : { phase: "tooLarge" },
                });
            },
            (error: unknown) => {
                if (!live) return;
                const message = error instanceof Error && error.message ? error.message : "Couldn't load the file";
                setState({ ref: blobRef, load: { phase: "error", message } });
            },
        );
        return () => {
            live = false;
        };
    }, [client, blobRef, nonce]);
    const retry = useCallback(() => setNonce((value) => value + 1), []);
    // Never show the previous file's text while a new one loads.
    const load: LoadState = state.ref === blobRef ? state.load : { phase: "loading" };
    return { ...load, retry };
}

// ---------------------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------------------

// Overlays that own Escape while they are open; the panel defers to them.
const ESCAPE_OWNERS =
    ".mj_MediaViewer_scrim, .mj_MediaBrowser_scrim, .mj_SubChatPane_covering, .mj_EventSource_scrim, .mj_UploadConfirm_scrim, .mj_NewSessionSheet, .mj_SettingsScrim, .mj_EventRowMenu, .mj_ConversationMenu, .mj_HeaderMenu, [role='menu']";

function DownloadButton({
    client,
    target,
    primary = false,
}: {
    client: MatronJournalClient;
    target: MarkdownPreviewTarget;
    primary?: boolean;
}): React.ReactElement {
    const [busy, setBusy] = useState(false);
    const download = async (): Promise<void> => {
        setBusy(true);
        try {
            // Always the cached blob: URL from the authenticated media path, never /media/:id.
            const url = await client.mediaUrl(target.blobRef);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = target.name || "attachment.md";
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
        } catch {
            /* The body shows load errors; a failed download just leaves the button as it was. */
        } finally {
            setBusy(false);
        }
    };
    return (
        <button
            type="button"
            className={primary ? "mj_MdPreview_primary" : "mj_MdPreview_action"}
            onClick={() => void download()}
            disabled={busy}
            aria-label={`Download ${target.name}`}
            title="Download"
        >
            <DownloadIcon aria-hidden />
            <span>Download</span>
        </button>
    );
}

function canShareFiles(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export function MarkdownPreviewPanel({
    client,
    target,
    onClose,
}: {
    client: MatronJournalClient;
    target: MarkdownPreviewTarget;
    onClose: () => void;
}): React.ReactElement {
    const load = useMarkdownText(client, target.blobRef);
    const [source, setSource] = useState(false);
    const [copyLabel, setCopyLabel] = useState("Copy");
    const closeRef = useRef<HTMLButtonElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    // A new file starts rendered, scrolled to the top.
    useEffect(() => {
        setSource(false);
        setCopyLabel("Copy");
        bodyRef.current?.scrollTo?.({ top: 0 });
    }, [target.blobRef]);

    // Focus moves to the panel when a file opens and back to whatever last opened one when it closes.
    const openerRef = useRef<HTMLElement | null>(null);
    const panelRef = useRef<HTMLElement>(null);
    useEffect(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && !panelRef.current?.contains(active)) {
            openerRef.current = active;
        }
        closeRef.current?.focus({ preventScroll: true });
    }, [target.blobRef]);
    useEffect(
        () => () => {
            const opener = openerRef.current;
            if (opener?.isConnected) opener.focus({ preventScroll: true });
        },
        [],
    );

    useEffect(() => () => clearTimeout(copyTimer.current), []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (document.querySelector(ESCAPE_OWNERS)) return;
            event.preventDefault();
            onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const text = load.phase === "ready" ? load.text : undefined;

    const copy = async (): Promise<void> => {
        if (text === undefined) return;
        const copied = await copyText(text);
        setCopyLabel(copied ? "Copied" : "Copy failed");
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopyLabel("Copy"), 1_500);
    };

    const share = async (): Promise<void> => {
        if (text === undefined) return;
        const file = new File([text], target.name || "attachment.md", { type: "text/markdown" });
        const data: ShareData = { files: [file], title: target.name };
        try {
            if (navigator.canShare && !navigator.canShare(data)) {
                await navigator.share({ title: target.name, text });
            } else {
                await navigator.share(data);
            }
        } catch {
            /* Cancelled, or the platform refused — nothing to do. */
        }
    };

    let body: React.ReactNode;
    if (load.phase === "loading") {
        body = <div className="mj_MdPreview_note">Loading…</div>;
    } else if (load.phase === "error") {
        body = (
            <div className="mj_MdPreview_state" role="alert">
                <span className="mj_MdPreview_error">{load.message}</span>
                <div className="mj_MdPreview_stateActions">
                    <button type="button" className="mj_MdPreview_primary" onClick={load.retry}>
                        Retry
                    </button>
                    <DownloadButton client={client} target={target} />
                </div>
            </div>
        );
    } else if (load.phase === "tooLarge") {
        body = (
            <div className="mj_MdPreview_state">
                <span className="mj_MdPreview_note">This file is too large to preview.</span>
                <DownloadButton client={client} target={target} primary />
            </div>
        );
    } else if (source) {
        body = <pre className="mj_MdPreview_source">{load.text}</pre>;
    } else {
        body = (
            <>
                {exceedsMarkdownRenderLimit(load.text) ? (
                    <div className="mj_MdPreview_note">This file is too long to format, so it is shown as text.</div>
                ) : null}
                <div className="mj_Markdown mj_MdPreview_doc">
                    <MarkdownBody text={load.text} label={`md-preview-${target.blobRef}`} variant="document" />
                </div>
            </>
        );
    }

    return (
        <aside ref={panelRef} className="mj_MdPreview" aria-label={`Preview of ${target.name}`}>
            <header className="mj_MdPreview_header">
                <span className="mj_MdPreview_name" title={target.name}>
                    {target.name}
                </span>
                <div className="mj_MdPreview_actions">
                    <button
                        type="button"
                        className="mj_MdPreview_action"
                        aria-pressed={source}
                        disabled={text === undefined}
                        onClick={() => setSource((value) => !value)}
                        title={source ? "Show formatted" : "Show source"}
                    >
                        <CodeBracketsIcon aria-hidden />
                        <span>Source</span>
                    </button>
                    <button
                        type="button"
                        className="mj_MdPreview_action"
                        disabled={text === undefined}
                        onClick={() => void copy()}
                        title="Copy markdown"
                    >
                        <span aria-live="polite">{copyLabel}</span>
                    </button>
                    {canShareFiles() ? (
                        <button
                            type="button"
                            className="mj_MdPreview_action"
                            disabled={text === undefined}
                            onClick={() => void share()}
                        >
                            <span>Share</span>
                        </button>
                    ) : null}
                    <DownloadButton client={client} target={target} />
                    <button
                        ref={closeRef}
                        type="button"
                        className="mj_MdPreview_close"
                        aria-label="Close preview"
                        title="Close"
                        onClick={onClose}
                    >
                        <CloseIcon aria-hidden />
                    </button>
                </div>
            </header>
            <div ref={bodyRef} className="mj_MdPreview_body">
                {body}
            </div>
        </aside>
    );
}
