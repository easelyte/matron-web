/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Media viewer / lightbox.
//
// A first-class overlay opened from an inline image or a renderable file chip. It composes a
// modal scrim + dialog card + bottom ThumbStrip + a per-type body. The body is chosen by a
// SECURITY-LOAD-BEARING decision table (harden the serve boundary — untrusted media must
// never execute as a document on the app origin):
//   - raster  → zoom/pan <img>
//   - svg     → inert <img> ONLY (never <iframe>/<object>/<embed>/innerHTML/inline-<svg>)
//   - pdf     → pdf.js → <canvas>, lazily imported (./pdf-render) only when a PDF opens
//   - video   → <video controls>
//   - download→ metadata + Download card; HTML and unknown types are NEVER rendered inline
//
// All rendering reuses the cached `blob:` object URL from `client.mediaUrl` — no re-fetch, no
// same-origin navigation to /media/:id, and downloads go through `<a href={blob:} download>`.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "./client";
import {
    ChevronLeftIcon,
    ChevronRightIcon,
    CloseIcon,
    DownloadIcon,
    FileIcon,
    FitIcon,
    PdfFileIcon,
    ResetIcon,
    VideoFileIcon,
    ZoomInIcon,
    ZoomOutIcon,
} from "./icons";
import type { LoadedPdf } from "./pdf-render";
import { asString, type FileKind, fileKindFromMime, type JournalEvent, type MediaDims, parseMediaDims } from "./types";

// ---------------------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no React, no DOM).
// ---------------------------------------------------------------------------------------

export type MediaRenderKind = "raster" | "svg" | "pdf" | "video" | "download";

export interface MediaItem {
    mediaId: string;
    kind: MediaRenderKind;
    fileKind: FileKind;
    isImageEvent: boolean;
    contentType?: string;
    filename?: string;
    caption?: string;
    dims?: MediaDims;
    size?: number;
}

const RASTER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

function extensionOf(filename?: string): string {
    if (!filename) return "";
    const dot = filename.lastIndexOf(".");
    return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

// Decide how a media item renders. SVG is checked BEFORE the generic image/* branch so an
// `image/svg+xml` MIME never falls through to the raster path — it must always take the inert
// <img> body. Bridge `image` events are raster-only (the bridge omits .svg from its MIME map),
// so an image event is unconditionally raster. Everything unrecognised is download-only.
export function mediaRenderKind(isImageEvent: boolean, contentType?: string, filename?: string): MediaRenderKind {
    if (isImageEvent) return "raster";
    const mime = (contentType ?? "").trim().toLowerCase();
    const ext = extensionOf(filename);
    // The bridge/journal serve every non-raster file as application/octet-stream (svg is
    // deliberately un-typed; other types simply aren't mapped), so a generic/absent MIME must
    // fall back to the filename extension — otherwise svg/pdf/video would all be misclassified
    // as plain downloads and never reach their render bodies.
    const generic = mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream";
    if (mime === "image/svg+xml" || (generic && ext === "svg")) return "svg";
    if (mime === "application/pdf" || (generic && ext === "pdf")) return "pdf";
    if (mime.startsWith("video/") || (generic && VIDEO_EXTENSIONS.has(ext))) return "video";
    if (mime.startsWith("image/") || (generic && RASTER_EXTENSIONS.has(ext))) return "raster";
    return "download";
}

// True when a file chip should open the viewer inline rather than plain-download on click.
export function isRenderableInViewer(contentType?: string, filename?: string): boolean {
    return mediaRenderKind(false, contentType, filename) !== "download";
}

// The gallery corpus = every image/file event with a blob_ref, in timeline order.
export function buildMediaCorpus(events: readonly JournalEvent[]): MediaItem[] {
    const items: MediaItem[] = [];
    for (const event of events) {
        if (event.type !== "image" && event.type !== "file") continue;
        const mediaId = asString(event.payload.blob_ref);
        if (!mediaId) continue;
        const isImageEvent = event.type === "image";
        const contentType = asString(event.payload.content_type) || undefined;
        const filename = asString(event.payload.filename) || undefined;
        const size =
            typeof event.payload.size === "number" && Number.isFinite(event.payload.size)
                ? event.payload.size
                : undefined;
        items.push({
            mediaId,
            isImageEvent,
            contentType,
            filename,
            caption: asString(event.payload.caption) || undefined,
            dims: parseMediaDims(event.payload.dims),
            size,
            kind: mediaRenderKind(isImageEvent, contentType, filename),
            fileKind: fileKindFromMime(contentType),
        });
    }
    return items;
}

// Machine size string ("1.4 MB") — mirrors components.tsx `formatBytes`; shown in Fira Code.
export function formatMediaSize(value?: number): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function mediaTypeLabel(item: MediaItem): string {
    if (item.contentType) return item.contentType;
    const ext = extensionOf(item.filename);
    return ext ? ext.toUpperCase() : item.isImageEvent ? "image" : "file";
}

function errorText(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error) return error;
    return "Media failed to load";
}

// ---------------------------------------------------------------------------------------
// Context — Timeline provides `openViewer`, AuthenticatedMedia consumes it.
// ---------------------------------------------------------------------------------------

export interface MediaViewerContextValue {
    openViewer: (mediaId: string, opener: HTMLElement | null) => void;
}

export const MediaViewerContext = React.createContext<MediaViewerContextValue | undefined>(undefined);

export function useMediaViewer(): MediaViewerContextValue | undefined {
    return React.useContext(MediaViewerContext);
}

// ---------------------------------------------------------------------------------------
// Object-URL loader — reuses the client's cached blob URL, with retry.
// ---------------------------------------------------------------------------------------

interface ObjectUrlState {
    url?: string;
    loading: boolean;
    error?: string;
}

function useObjectUrl(client: MatronJournalClient, mediaId: string): ObjectUrlState & { retry: () => void } {
    const [state, setState] = useState<ObjectUrlState>({ loading: true });
    const [nonce, setNonce] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true });
        client
            .mediaUrl(mediaId)
            .then((url) => {
                if (!cancelled) setState({ url, loading: false });
            })
            .catch((error: unknown) => {
                if (!cancelled) setState({ loading: false, error: errorText(error) });
            });
        return () => {
            cancelled = true;
        };
    }, [client, mediaId, nonce]);
    const retry = useCallback(() => setNonce((value) => value + 1), []);
    return { ...state, retry };
}

// The bridge serves non-raster media as application/octet-stream (SVG is deliberately never
// given image/svg+xml — iOS UIImage can't decode it and inline SVG is script-capable; other
// types simply aren't in its MIME map). An <img>/<video> cannot render an octet-stream blob,
// so for the types the viewer paints natively we must re-wrap the cached bytes in a correctly
// typed Blob. pdf.js reads raw bytes and never needs this; raster arrives as image/* already.
export function viewerRetypeMime(item: Pick<MediaItem, "kind" | "filename">): string | undefined {
    if (item.kind === "svg") return "image/svg+xml";
    if (item.kind === "video") {
        const ext = item.filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
        if (ext === "webm") return "video/webm";
        if (ext === "ogv" || ext === "ogg") return "video/ogg";
        if (ext === "mov") return "video/quicktime";
        return "video/mp4";
    }
    return undefined;
}

// Like useObjectUrl, but re-wraps the cached bytes in a correctly-typed Blob for svg/video
// (whose source blob is octet-stream) so the <img>/<video> can render them. Transparent
// pass-through for types that already carry a usable content-type (raster).
function useRenderableObjectUrl(client: MatronJournalClient, item: MediaItem): ObjectUrlState & { retry: () => void } {
    const base = useObjectUrl(client, item.mediaId);
    const targetMime = viewerRetypeMime(item);
    const [typed, setTyped] = useState<ObjectUrlState>({ loading: true });
    useEffect(() => {
        if (!targetMime) return; // raster: `base` is used directly below.
        if (base.error) {
            setTyped({ loading: false, error: base.error });
            return;
        }
        if (!base.url) {
            setTyped({ loading: true });
            return;
        }
        // Environments without blob fetch / object URLs (e.g. jsdom in tests) can't re-wrap —
        // fall through to the base URL rather than hanging on a fetch that can't resolve.
        if (typeof fetch !== "function" || typeof URL.createObjectURL !== "function") {
            setTyped({ url: base.url, loading: false });
            return;
        }
        let cancelled = false;
        let created: string | undefined;
        setTyped({ loading: true });
        fetch(base.url)
            .then((response) => response.blob())
            .then((blob) => {
                if (cancelled) return;
                const retyped = blob.type === targetMime ? blob : new Blob([blob], { type: targetMime });
                created = URL.createObjectURL(retyped);
                setTyped({ url: created, loading: false });
            })
            .catch((error: unknown) => {
                if (!cancelled) setTyped({ loading: false, error: errorText(error) });
            });
        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [base.url, base.error, targetMime]);
    return targetMime ? { ...typed, retry: base.retry } : base;
}

// ---------------------------------------------------------------------------------------
// Zoom / pan — shared by raster, svg, and pdf bodies.
// ---------------------------------------------------------------------------------------

export interface ZoomApi {
    zoomIn: () => void;
    zoomOut: () => void;
    toggleFit: () => void;
    reset: () => void;
}

const ZOOM_STEP = 1.25;

interface ZoomState {
    scale: number; // 1 = fit-to-stage
    x: number;
    y: number;
}

function useZoomPan(registerZoom: (api: ZoomApi | null) => void): {
    api: ZoomApi;
    percent: number;
    zoomed: boolean;
    transform: string;
    stageRef: React.RefObject<HTMLDivElement | null>;
    onWheel: (event: React.WheelEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onDoubleClick: () => void;
    onContentMeasured: (naturalWidth: number, renderedWidth: number) => void;
} {
    const [state, setState] = useState<ZoomState>({ scale: 1, x: 0, y: 0 });
    const stageRef = useRef<HTMLDivElement | null>(null);
    // natural px / fitted-on-screen px — used to place the "100%" anchor and the % readout.
    const geometry = useRef<{ actualScale: number; min: number; max: number }>({ actualScale: 2, min: 1, max: 8 });

    const clamp = useCallback((scale: number): number => {
        const { min, max } = geometry.current;
        return Math.min(max, Math.max(min, scale));
    }, []);

    const onContentMeasured = useCallback((naturalWidth: number, renderedWidth: number): void => {
        if (naturalWidth > 0 && renderedWidth > 0) {
            const actualScale = naturalWidth / renderedWidth;
            geometry.current = {
                actualScale,
                min: Math.min(1, actualScale),
                max: Math.max(1, actualScale) * 4,
            };
        }
    }, []);

    const zoomIn = useCallback(() => setState((s) => ({ ...s, scale: clamp(s.scale * ZOOM_STEP) })), [clamp]);
    const zoomOut = useCallback(() => setState((s) => ({ ...s, scale: clamp(s.scale / ZOOM_STEP) })), [clamp]);
    const reset = useCallback(() => setState({ scale: 1, x: 0, y: 0 }), []);
    const toggleFit = useCallback(() => {
        setState((s) => {
            const atFit = Math.abs(s.scale - 1) < 0.01;
            return atFit ? { scale: clamp(geometry.current.actualScale), x: 0, y: 0 } : { scale: 1, x: 0, y: 0 };
        });
    }, [clamp]);

    const api = useMemo<ZoomApi>(() => ({ zoomIn, zoomOut, toggleFit, reset }), [zoomIn, zoomOut, toggleFit, reset]);
    useEffect(() => {
        registerZoom(api);
        return () => registerZoom(null);
    }, [registerZoom, api]);

    const onWheel = useCallback(
        (event: React.WheelEvent): void => {
            event.preventDefault();
            const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
            setState((s) => {
                const nextScale = clamp(s.scale * factor);
                const rect = stageRef.current?.getBoundingClientRect();
                if (!rect || rect.width === 0) return { ...s, scale: nextScale };
                const cx = event.clientX - rect.left - rect.width / 2;
                const cy = event.clientY - rect.top - rect.height / 2;
                const ratio = nextScale / s.scale;
                return { scale: nextScale, x: cx - (cx - s.x) * ratio, y: cy - (cy - s.y) * ratio };
            });
        },
        [clamp],
    );

    const onPointerDown = useCallback((event: React.PointerEvent): void => {
        if (event.button !== 0) return;
        const start = { x: event.clientX, y: event.clientY };
        const origin = { x: 0, y: 0 };
        let dragging = false;
        setState((s) => {
            origin.x = s.x;
            origin.y = s.y;
            dragging = s.scale > 1.001;
            return s;
        });
        if (!dragging) return;
        event.preventDefault();
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        const move = (moveEvent: PointerEvent): void => {
            setState((s) => ({
                ...s,
                x: origin.x + (moveEvent.clientX - start.x),
                y: origin.y + (moveEvent.clientY - start.y),
            }));
        };
        const up = (): void => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }, []);

    const percent = useMemo(() => {
        const { actualScale } = geometry.current;
        const fitPercent = actualScale > 0 ? 1 / actualScale : 1;
        return Math.round(state.scale * fitPercent * 100) || Math.round(state.scale * 100);
    }, [state.scale]);

    return {
        api,
        percent,
        zoomed: state.scale > 1.001,
        transform: `translate(${state.x}px, ${state.y}px) scale(${state.scale})`,
        stageRef,
        onWheel,
        onPointerDown,
        onDoubleClick: toggleFit,
        onContentMeasured,
    };
}

function ZoomControls({ api, percent }: { api: ZoomApi; percent: number }): React.ReactElement {
    return (
        <div className="mj_MediaViewer_zoom" role="group" aria-label="Zoom controls">
            <button type="button" className="mj_MediaViewer_zoomBtn" aria-label="Zoom out" onClick={api.zoomOut}>
                <ZoomOutIcon aria-hidden />
            </button>
            <span className="mj_MediaViewer_zoomPct" aria-live="off">
                {percent}%
            </span>
            <button type="button" className="mj_MediaViewer_zoomBtn" aria-label="Zoom in" onClick={api.zoomIn}>
                <ZoomInIcon aria-hidden />
            </button>
            <span className="mj_MediaViewer_zoomSep" aria-hidden />
            <button
                type="button"
                className="mj_MediaViewer_zoomBtn"
                aria-label="Toggle fit and 100%"
                onClick={api.toggleFit}
            >
                <FitIcon aria-hidden />
            </button>
            <button type="button" className="mj_MediaViewer_zoomBtn" aria-label="Reset zoom" onClick={api.reset}>
                <ResetIcon aria-hidden />
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------------------
// Per-type bodies.
// ---------------------------------------------------------------------------------------

interface BodyProps {
    client: MatronJournalClient;
    item: MediaItem;
    registerZoom: (api: ZoomApi | null) => void;
    registerPage: (api: PageApi | null) => void;
    announce: (message: string) => void;
}

interface PageApi {
    nextPage: () => boolean;
    prevPage: () => boolean;
}

// Raster + SVG share this body. An SVG is rendered through the SAME inert <img> as a raster
// image — the browser rasterises it and its scripts / external fetches stay inert. There is
// deliberately no <iframe>/<object>/<embed>/innerHTML path here (guardrail).
function ImageBody({ client, item, registerZoom, announce }: BodyProps): React.ReactElement {
    const { url, loading, error, retry } = useRenderableObjectUrl(client, item);
    const [imgError, setImgError] = useState(false);
    const zoom = useZoomPan(registerZoom);
    const imgRef = useRef<HTMLImageElement>(null);

    if (error || imgError) {
        return (
            <div className="mj_MediaViewer_body mj_MediaViewer_center">
                <div className="mj_MediaViewer_errorGroup">
                    <span className="mj_MediaViewer_error">{error ?? "Media failed to load"}</span>
                    <button
                        type="button"
                        className="mj_MediaViewer_retry"
                        onClick={() => {
                            setImgError(false);
                            retry();
                        }}
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            className="mj_MediaViewer_body mj_MediaViewer_stage"
            ref={zoom.stageRef}
            onWheel={zoom.onWheel}
            onPointerDown={zoom.onPointerDown}
            onDoubleClick={zoom.onDoubleClick}
            data-zoomed={zoom.zoomed ? "true" : undefined}
        >
            {!url || loading ? (
                <div className="mj_MediaViewer_center mj_MediaViewer_note">Loading image…</div>
            ) : (
                <img
                    ref={imgRef}
                    className="mj_MediaViewer_img"
                    src={url}
                    alt={item.caption || item.filename || "Shared image"}
                    draggable={false}
                    style={{ transform: zoom.transform }}
                    onLoad={(event) => {
                        const image = event.currentTarget;
                        zoom.onContentMeasured(image.naturalWidth, image.clientWidth || image.naturalWidth);
                        announce(
                            `${item.kind === "svg" ? "Vector image" : "Image"} loaded${item.filename ? `, ${item.filename}` : ""}`,
                        );
                    }}
                    onError={() => setImgError(true)}
                />
            )}
            <ZoomControls api={zoom.api} percent={zoom.percent} />
        </div>
    );
}

function VideoBody({ client, item }: BodyProps): React.ReactElement {
    const { url, loading, error, retry } = useRenderableObjectUrl(client, item);
    if (error) {
        return (
            <div className="mj_MediaViewer_body mj_MediaViewer_center">
                <div className="mj_MediaViewer_errorGroup">
                    <span className="mj_MediaViewer_error">{error}</span>
                    <button type="button" className="mj_MediaViewer_retry" onClick={retry}>
                        Retry
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className="mj_MediaViewer_body mj_MediaViewer_center">
            {!url || loading ? (
                <div className="mj_MediaViewer_note">Loading video…</div>
            ) : (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video className="mj_MediaViewer_video" src={url} controls />
            )}
        </div>
    );
}

function DownloadBody({ client, item }: BodyProps): React.ReactElement {
    const { url, loading, error } = useObjectUrl(client, item.mediaId);
    const KindIcon = item.fileKind === "pdf" ? PdfFileIcon : item.fileKind === "video" ? VideoFileIcon : FileIcon;
    const size = formatMediaSize(item.size);
    return (
        <div className="mj_MediaViewer_body mj_MediaViewer_center">
            <div className="mj_MediaViewer_downloadCard">
                <KindIcon className="mj_MediaViewer_downloadGlyph" aria-hidden />
                <span className="mj_MediaViewer_downloadName" title={item.filename}>
                    {item.filename || "Attachment"}
                </span>
                <span className="mj_MediaViewer_downloadMeta">
                    {[mediaTypeLabel(item), size].filter(Boolean).join(" · ")}
                </span>
                <span className="mj_MediaViewer_downloadNote">No preview available for this type.</span>
                {error ? (
                    <span className="mj_MediaViewer_error">{error}</span>
                ) : url ? (
                    <a className="mj_MediaViewer_downloadBtn" href={url} download={item.filename || "attachment"}>
                        <DownloadIcon aria-hidden />
                        Download
                    </a>
                ) : (
                    <span className="mj_MediaViewer_note">{loading ? "Preparing download…" : ""}</span>
                )}
            </div>
        </div>
    );
}

function PdfBody({ client, item, registerZoom, registerPage, announce }: BodyProps): React.ReactElement {
    const { url, loading: urlLoading, error: urlError, retry } = useObjectUrl(client, item.mediaId);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const docRef = useRef<LoadedPdf | null>(null);
    const [numPages, setNumPages] = useState(0);
    const [page, setPage] = useState(1);
    const [renderError, setRenderError] = useState<string>();
    const zoom = useZoomPan(registerZoom);

    // Register page navigation so ←/→ walk PDF pages before moving between gallery items.
    useEffect(() => {
        const api: PageApi = {
            nextPage: () => {
                let advanced = false;
                setPage((current) => {
                    if (current < numPages) {
                        advanced = true;
                        return current + 1;
                    }
                    return current;
                });
                return advanced;
            },
            prevPage: () => {
                let advanced = false;
                setPage((current) => {
                    if (current > 1) {
                        advanced = true;
                        return current - 1;
                    }
                    return current;
                });
                return advanced;
            },
        };
        registerPage(api);
        return () => registerPage(null);
    }, [registerPage, numPages]);

    // Load the document once the blob URL is ready (lazy pdf.js import lives here).
    useEffect(() => {
        if (!url) return undefined;
        let cancelled = false;
        setRenderError(undefined);
        (async () => {
            try {
                const [{ loadPdf }, response] = await Promise.all([import("./pdf-render"), fetch(url)]);
                const bytes = await response.arrayBuffer();
                if (cancelled) return;
                const loaded = await loadPdf(bytes);
                if (cancelled) {
                    loaded.destroy();
                    return;
                }
                docRef.current = loaded;
                setNumPages(loaded.numPages);
                setPage(1);
            } catch (error) {
                if (!cancelled) setRenderError(errorText(error));
            }
        })();
        return () => {
            cancelled = true;
            docRef.current?.destroy();
            docRef.current = null;
        };
    }, [url]);

    // Paint the current page whenever it changes. Two hazards guarded here:
    //  - deps name zoom.onContentMeasured (stable useCallback), NOT the `zoom` object, which is
    //    rebuilt every render — depending on it re-ran this effect on every wheel/pan and started
    //    a second render on a canvas pdf.js still owns ("Cannot use the same canvas during
    //    multiple render() operations").
    //  - renders are chained through renderChainRef for the same reason: a fast page flip fires
    //    a new effect run while the previous renderPage is still mid-flight on the same canvas.
    const { onContentMeasured } = zoom;
    const renderChainRef = useRef<Promise<void>>(Promise.resolve());
    useEffect(() => {
        const doc = docRef.current;
        const canvas = canvasRef.current;
        if (!doc || !canvas || numPages === 0) return;
        let cancelled = false;
        const render = renderChainRef.current.then(async () => {
            if (cancelled) return; // superseded before it started — don't paint a stale page
            await doc.renderPage(page, canvas, 1.5);
        });
        renderChainRef.current = render.catch(() => undefined);
        render
            .then(() => {
                if (cancelled) return;
                onContentMeasured(canvas.width, canvas.clientWidth || canvas.width);
                announce(`Page ${page} of ${numPages}${item.filename ? `, ${item.filename}` : ""}`);
            })
            .catch((error: unknown) => {
                if (!cancelled) setRenderError(errorText(error));
            });
        return () => {
            cancelled = true;
        };
    }, [page, numPages, item.filename, onContentMeasured, announce]);

    if (urlError || renderError) {
        return (
            <div className="mj_MediaViewer_body mj_MediaViewer_center">
                <div className="mj_MediaViewer_errorGroup">
                    <span className="mj_MediaViewer_error">{urlError ?? renderError}</span>
                    <button type="button" className="mj_MediaViewer_retry" onClick={retry}>
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="mj_MediaViewer_body mj_MediaViewer_pdf">
            {numPages > 1 && (
                <div className="mj_MediaViewer_pageRail" role="group" aria-label="PDF pages">
                    {Array.from({ length: numPages }, (_unused, index) => index + 1).map((pageNumber) => (
                        <button
                            key={pageNumber}
                            type="button"
                            className="mj_MediaViewer_pageThumb"
                            aria-label={`Page ${pageNumber}`}
                            aria-current={pageNumber === page ? "true" : undefined}
                            onClick={() => setPage(pageNumber)}
                        >
                            {pageNumber}
                        </button>
                    ))}
                </div>
            )}
            <div
                className="mj_MediaViewer_stage"
                ref={zoom.stageRef}
                onWheel={zoom.onWheel}
                onPointerDown={zoom.onPointerDown}
                onDoubleClick={zoom.onDoubleClick}
                data-zoomed={zoom.zoomed ? "true" : undefined}
            >
                {numPages === 0 && !urlLoading ? (
                    <div className="mj_MediaViewer_center mj_MediaViewer_note">Loading PDF…</div>
                ) : null}
                {urlLoading ? <div className="mj_MediaViewer_center mj_MediaViewer_note">Loading PDF…</div> : null}
                <canvas ref={canvasRef} className="mj_MediaViewer_canvas" style={{ transform: zoom.transform }} />
                <ZoomControls api={zoom.api} percent={zoom.percent} />
            </div>
        </div>
    );
}

function MediaBody(props: BodyProps): React.ReactElement {
    switch (props.item.kind) {
        case "raster":
        case "svg":
            return <ImageBody {...props} />;
        case "pdf":
            return <PdfBody {...props} />;
        case "video":
            return <VideoBody {...props} />;
        default:
            return <DownloadBody {...props} />;
    }
}

// ---------------------------------------------------------------------------------------
// ThumbStrip — the corpus, current item ringed in accent. Scrolls, never wraps.
// ---------------------------------------------------------------------------------------

function ThumbGlyph({ item }: { item: MediaItem }): React.ReactElement {
    if (item.kind === "pdf") return <PdfFileIcon aria-hidden />;
    if (item.kind === "video") return <VideoFileIcon aria-hidden />;
    return <FileIcon aria-hidden />;
}

function LoadedThumbImage({ client, mediaId }: { client: MatronJournalClient; mediaId: string }): React.ReactElement {
    const { url } = useObjectUrl(client, mediaId);
    return url ? <img className="mj_MediaViewer_thumbImg" src={url} alt="" /> : <FileIcon aria-hidden />;
}

// The journal serves no thumbnail variant — a thumb paints the full-resolution blob. Fetch it
// only once the tile has actually scrolled into view, or opening the viewer in an image-heavy
// conversation downloads every blob in the strip up front just to draw 38px tiles.
function ThumbImage({ client, mediaId }: { client: MatronJournalClient; mediaId: string }): React.ReactElement {
    const holderRef = useRef<HTMLSpanElement>(null);
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const holder = holderRef.current;
        if (!holder) return undefined;
        if (typeof IntersectionObserver === "undefined") {
            setVisible(true); // jsdom / ancient engines — degrade to eager
            return undefined;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setVisible(true);
                observer.disconnect();
            }
        });
        observer.observe(holder);
        return () => observer.disconnect();
    }, []);
    return (
        <span ref={holderRef} className="mj_MediaViewer_thumbHolder">
            {visible ? <LoadedThumbImage client={client} mediaId={mediaId} /> : <FileIcon aria-hidden />}
        </span>
    );
}

function ThumbStrip({
    client,
    items,
    activeIndex,
    onSelect,
}: {
    client: MatronJournalClient;
    items: MediaItem[];
    activeIndex: number;
    onSelect: (index: number) => void;
}): React.ReactElement {
    const stripRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        stripRef.current
            ?.querySelector<HTMLElement>(`[data-thumb-index="${activeIndex}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "center" });
    }, [activeIndex]);
    return (
        <div className="mj_MediaViewer_thumbs" ref={stripRef} role="tablist" aria-label="Media in this conversation">
            {items.map((item, index) => {
                const active = index === activeIndex;
                const showImage = item.kind === "raster" || item.kind === "svg";
                return (
                    <button
                        key={item.mediaId}
                        type="button"
                        role="tab"
                        data-thumb-index={index}
                        className={`mj_MediaViewer_thumb${active ? " mj_MediaViewer_thumb_active" : ""}`}
                        aria-selected={active}
                        aria-label={item.filename || item.caption || `Item ${index + 1}`}
                        onClick={() => onSelect(index)}
                    >
                        {showImage ? <ThumbImage client={client} mediaId={item.mediaId} /> : <ThumbGlyph item={item} />}
                    </button>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------------------
// The viewer overlay.
// ---------------------------------------------------------------------------------------

export function MediaViewer({
    client,
    items,
    initialMediaId,
    opener,
    onClose,
}: {
    client: MatronJournalClient;
    items: MediaItem[];
    initialMediaId: string;
    opener: HTMLElement | null;
    onClose: () => void;
}): React.ReactElement | null {
    const [index, setIndex] = useState(() => {
        const found = items.findIndex((item) => item.mediaId === initialMediaId);
        return found === -1 ? 0 : found;
    });
    const cardRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const liveRef = useRef<HTMLDivElement>(null);
    const zoomApiRef = useRef<ZoomApi | null>(null);
    const pageApiRef = useRef<PageApi | null>(null);

    const safeIndex = Math.min(index, Math.max(0, items.length - 1));
    const item = items[safeIndex];

    const announce = useCallback((message: string): void => {
        if (liveRef.current) liveRef.current.textContent = message;
    }, []);

    const registerZoom = useCallback((api: ZoomApi | null): void => {
        zoomApiRef.current = api;
    }, []);
    const registerPage = useCallback((api: PageApi | null): void => {
        pageApiRef.current = api;
    }, []);

    const goTo = useCallback(
        (next: number): void => {
            setIndex(() => Math.min(items.length - 1, Math.max(0, next)));
        },
        [items.length],
    );

    // Focus the close button on open; restore focus to the opener on close.
    useEffect(() => {
        closeRef.current?.focus();
        return () => {
            if (opener?.isConnected) opener.focus();
        };
    }, [opener]);

    // Announce item changes for screen readers.
    useEffect(() => {
        if (item) announce(`${item.filename || item.caption || "Media"}, ${safeIndex + 1} of ${items.length}`);
    }, [safeIndex, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keyboard: Esc close, ←/→ (PDF pages first, then items), +/- zoom, f fit, focus trap.
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                onClose();
                return;
            }
            if (event.key === "Tab") {
                const focusable = [
                    ...(cardRef.current?.querySelectorAll<HTMLElement>(
                        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
                    ) ?? []),
                ];
                if (focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (
                    event.shiftKey &&
                    (document.activeElement === first || !cardRef.current?.contains(document.activeElement))
                ) {
                    event.preventDefault();
                    last.focus();
                } else if (
                    !event.shiftKey &&
                    (document.activeElement === last || !cardRef.current?.contains(document.activeElement))
                ) {
                    event.preventDefault();
                    first.focus();
                }
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                if (pageApiRef.current?.nextPage()) return;
                goTo(safeIndex + 1);
            } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (pageApiRef.current?.prevPage()) return;
                goTo(safeIndex - 1);
            } else if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                zoomApiRef.current?.zoomIn();
            } else if (event.key === "-" || event.key === "_") {
                event.preventDefault();
                zoomApiRef.current?.zoomOut();
            } else if (event.key === "f" || event.key === "F") {
                event.preventDefault();
                zoomApiRef.current?.toggleFit();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [goTo, safeIndex, onClose]);

    if (!item) return null;

    const label = item.caption || item.filename || "Media viewer";
    const size = formatMediaSize(item.size);
    const meta = [mediaTypeLabel(item), size].filter(Boolean).join(" · ");

    return (
        <div className="mj_MediaViewer_scrim" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
            <div ref={cardRef} className="mj_MediaViewer" onClick={(event) => event.stopPropagation()}>
                <header className="mj_MediaViewer_header">
                    <span className="mj_MediaViewer_count">
                        {safeIndex + 1} / {items.length}
                    </span>
                    <span className="mj_MediaViewer_name" title={item.filename}>
                        {item.filename || item.caption || "Media"}
                    </span>
                    {meta && <span className="mj_MediaViewer_meta">{meta}</span>}
                    <span className="mj_MediaViewer_headerSpacer" />
                    <DownloadLink client={client} item={item} />
                    <button
                        ref={closeRef}
                        type="button"
                        className="mj_MediaViewer_close"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        <CloseIcon aria-hidden />
                    </button>
                </header>

                <div className="mj_MediaViewer_main">
                    {items.length > 1 && (
                        <button
                            type="button"
                            className="mj_MediaViewer_nav mj_MediaViewer_nav_prev"
                            aria-label="Previous item"
                            disabled={safeIndex === 0}
                            onClick={() => goTo(safeIndex - 1)}
                        >
                            <ChevronLeftIcon aria-hidden />
                        </button>
                    )}
                    <MediaBody
                        key={item.mediaId}
                        client={client}
                        item={item}
                        registerZoom={registerZoom}
                        registerPage={registerPage}
                        announce={announce}
                    />
                    {items.length > 1 && (
                        <button
                            type="button"
                            className="mj_MediaViewer_nav mj_MediaViewer_nav_next"
                            aria-label="Next item"
                            disabled={safeIndex === items.length - 1}
                            onClick={() => goTo(safeIndex + 1)}
                        >
                            <ChevronRightIcon aria-hidden />
                        </button>
                    )}
                </div>

                {item.caption && <div className="mj_MediaViewer_caption">{item.caption}</div>}

                {items.length > 1 && (
                    <ThumbStrip client={client} items={items} activeIndex={safeIndex} onSelect={goTo} />
                )}

                <div ref={liveRef} className="mj_MediaViewer_live" aria-live="polite" aria-atomic="true" />
            </div>
        </div>
    );
}

// Download always goes through the cached blob: URL, never a same-origin /media/:id href
// (guardrail). Rendered in the header so every type — including download-only — can save.
function DownloadLink({ client, item }: { client: MatronJournalClient; item: MediaItem }): React.ReactElement {
    const { url, loading } = useObjectUrl(client, item.mediaId);
    if (!url) {
        return (
            <button
                type="button"
                className="mj_MediaViewer_download"
                disabled
                aria-label="Preparing download"
                title="Download"
            >
                <DownloadIcon aria-hidden />
                <span>{loading ? "Preparing…" : "Download"}</span>
            </button>
        );
    }
    return (
        <a
            className="mj_MediaViewer_download"
            href={url}
            download={item.filename || "attachment"}
            aria-label={`Download ${item.filename || "attachment"}`}
            title="Download"
        >
            <DownloadIcon aria-hidden />
            <span>Download</span>
        </a>
    );
}
