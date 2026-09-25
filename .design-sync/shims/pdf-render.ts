// design-sync shim for src/journal/pdf-render.ts (bundle + previews only; the app is untouched).
// The real module lazy-loads pdf.js (several MB plus a worker the canvas cannot fetch). This
// stand-in keeps the same LoadedPdf contract and paints each page as a plain document: white
// sheet, a title bar and grey text lines, so PDF previews and the media viewer render a
// page-shaped canvas instead of an error. It never parses the bytes it is given.
export interface LoadedPdf {
    numPages: number;
    renderPage(pageNumber: number, canvas: HTMLCanvasElement, scale: number): Promise<void>;
    destroy(): void;
}

export async function loadPdf(_data: ArrayBuffer): Promise<LoadedPdf> {
    return {
        numPages: 3,
        async renderPage(pageNumber, canvas, scale): Promise<void> {
            const width = Math.floor(420 * scale);
            const height = Math.floor(560 * scale);
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas 2D context unavailable");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, width, height);
            const unit = width / 420;
            context.fillStyle = "#1b1815";
            context.fillRect(36 * unit, 40 * unit, 220 * unit, 14 * unit);
            context.fillStyle = "#c9c3b8";
            for (let line = 0; line < 22; line += 1) {
                const lineWidth = (line % 5 === 4 ? 180 : 348) * unit;
                context.fillRect(36 * unit, (84 + line * 20) * unit, lineWidth, 7 * unit);
            }
            context.fillStyle = "#9a938a";
            context.font = `${11 * unit}px sans-serif`;
            context.fillText(`${pageNumber}`, 205 * unit, 540 * unit);
        },
        destroy(): void {},
    };
}
