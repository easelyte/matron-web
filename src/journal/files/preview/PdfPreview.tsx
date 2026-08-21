/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useRef, useState } from "react";

import { JournalApiError } from "../../api";
import type { LoadedPdf } from "../../pdf-render";
import { messageForFileStatus } from "../filesApi";
import { PDF_PAGE_CAP } from "../limits";
import { MediaError, PreviewStatus } from "./PreviewChrome";
import type { RendererProps } from "./types";

// PDF preview via the app's EXISTING pdf.js → <canvas> primitive (F1). pdf.js parses in a worker and
// paints to canvas; the bytes are NEVER handed to a document/plugin context, so no JS-in-PDF, form
// actions, or external fetches execute — the exact hardening `pdf-render.ts` + the media viewer
// rely on. A native `<object>`/`<iframe>` blob embed (which DOES execute the document) is not used.
export function PdfPreview({ api, path, filename, meta }: RendererProps): React.ReactElement {
    const pagesRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [error, setError] = useState<string | undefined>(undefined);
    const [numPages, setNumPages] = useState(0);
    const [reloadTick, setReloadTick] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        let doc: LoadedPdf | null = null;
        setStatus("loading");
        setError(undefined);
        setNumPages(0);
        void (async () => {
            try {
                const bytes = await api.fileBytes(path, { mtime: meta.mtime, signal: controller.signal });
                if (cancelled) return;
                const { loadPdf } = await import("../../pdf-render");
                if (cancelled) return;
                doc = await loadPdf(bytes);
                if (cancelled) {
                    doc.destroy();
                    doc = null;
                    return;
                }
                setNumPages(doc.numPages);
                const container = pagesRef.current;
                if (!container) return;
                container.replaceChildren();
                const pages = Math.min(doc.numPages, PDF_PAGE_CAP);
                for (let page = 1; page <= pages && !cancelled; page += 1) {
                    const canvas = document.createElement("canvas");
                    canvas.className = "mj_FilesPdf_page";
                    container.appendChild(canvas);
                    await doc.renderPage(page, canvas, 1.5);
                }
                if (!cancelled) setStatus("ready");
            } catch (err) {
                if (cancelled) return;
                const code = err instanceof JournalApiError ? err.code : undefined;
                if (code === "aborted" || code === "disposed") return;
                // Transport denials use the uniform copy; a pdf.js parse/render failure gets a fixed
                // friendly message (never leak the engine's internal error text to the operator).
                const httpStatus = err instanceof JournalApiError ? err.status : undefined;
                setError(
                    httpStatus !== undefined
                        ? messageForFileStatus(httpStatus, code)
                        : "This PDF couldn't be displayed here — download it to view.",
                );
                setStatus("error");
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
            doc?.destroy();
        };
    }, [api, path, meta.mtime, reloadTick]);

    if (status === "error")
        return (
            <MediaError
                api={api}
                path={path}
                filename={filename}
                error={error}
                onRetry={() => setReloadTick((value) => value + 1)}
            />
        );

    return (
        <div className="mj_FilesPdf">
            {status === "loading" ? <PreviewStatus variant="loading">Loading PDF…</PreviewStatus> : null}
            <div ref={pagesRef} className="mj_FilesPdf_pages" />
            {numPages > PDF_PAGE_CAP ? (
                <p className="mj_FilesPane_truncated">
                    Showing the first {PDF_PAGE_CAP} of {numPages} pages — download for the rest.
                </p>
            ) : null}
        </div>
    );
}
