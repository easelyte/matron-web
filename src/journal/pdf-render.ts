/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Lazy pdf.js boundary (safe PDF rendering).
//
// This module is reached ONLY via `await import("./pdf-render")` from the media viewer's
// PDF body, so pdf.js + its worker land in a lazy webpack chunk that never touches the main
// entry. It is also the single place that references `import.meta.url` (worker asset URL),
// which keeps that ESM-only token out of the jsdom/jest parse path — tests mock this module.
//
// Security posture (harden the serve boundary): pdf.js parses the PDF in a worker and
// paints pages to <canvas>. The bytes are NEVER handed to a document/plugin context, so no
// JS-in-PDF, form actions, or external fetches execute. We additionally pin:
//   - enableScripting is left at its default (false) → PDF-embedded JS never runs
//   - disableAutoFetch / disableStream → no speculative network fetches
// (pdf.js v5+ removed the `isEvalSupported` option — the eval-based fast paths it guarded no
// longer exist in the engine, so there is nothing left to opt out of.)
import * as pdfjs from "pdfjs-dist";

// Point at the worker that CopyWebpackPlugin copies VERBATIM to assets/ (see
// webpack.config.mjs). Do NOT use `new URL("…/pdf.worker.min.mjs", import.meta.url)`:
// that makes webpack re-run its Terser over pdfjs-dist's already-minified worker, and the
// double-minified result throws `Setting up fake worker failed: "Private field '#T' must be
// declared in an enclosing class"` in pdf.js's in-thread fake-worker eval (reproduced in
// headless Chromium 2026-09-20; pristine worker renders fine). The copied asset is marked
// `{ info: { minimized: true } }` so Terser leaves it exactly as pdfjs-dist ships it.
// document.baseURI keeps the URL correct regardless of the app's base path.
try {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("assets/pdf.worker.min.mjs", document.baseURI).toString();
} catch {
    // Non-browser runtime (jsdom/jest mock this module) — leave workerSrc unset so pdf.js
    // uses its in-thread fallback rather than throwing at module-eval time.
}

export interface LoadedPdf {
    numPages: number;
    renderPage(pageNumber: number, canvas: HTMLCanvasElement, scale: number): Promise<void>;
    destroy(): void;
}

// Parse a PDF from raw bytes. `data` is a *copy* of the blob bytes; pdf.js takes ownership of
// the ArrayBuffer, so callers must hand it a transferable copy they no longer read.
export async function loadPdf(data: ArrayBuffer): Promise<LoadedPdf> {
    const task = pdfjs.getDocument({
        data: new Uint8Array(data),
        disableAutoFetch: true,
        disableStream: true,
    });
    const doc = await task.promise;

    return {
        numPages: doc.numPages,
        async renderPage(pageNumber, canvas, scale): Promise<void> {
            const page = await doc.getPage(pageNumber);
            const viewport = page.getViewport({ scale });
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas 2D context unavailable");
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            await page.render({ canvas, canvasContext: context, viewport }).promise;
        },
        destroy(): void {
            void task.destroy();
        },
    };
}
