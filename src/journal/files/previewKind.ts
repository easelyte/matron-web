/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Pure preview-renderer dispatch. Separated from the React components so it is unit-testable in
// isolation (the visual dispatch is the security-relevant "right renderer per mime/is_text" gate).

import { fileKindFromMime } from "../types";
import { extensionOf } from "./format";

export type PreviewKind = "markdown" | "code" | "image" | "pdf" | "audio" | "video" | "generic";

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);

function isMarkdown(mime: string, filename: string): boolean {
    return mime.trim().toLowerCase() === "text/markdown" || MARKDOWN_EXT.has(extensionOf(filename));
}

/**
 * Choose the preview renderer for a file. Media kinds (image/pdf/audio/video) are driven off the
 * coarse MIME bucket; the text/binary split is driven by the server's `isText` sniff (authoritative
 * — a JSON file with an `application/json` MIME still previews as code because the server saw text).
 * Markdown is detected by MIME or extension before the generic code path.
 */
export function pickPreviewKind(args: { mime: string; isText: boolean; filename: string }): PreviewKind {
    const kind = fileKindFromMime(args.mime);
    if (kind === "image") return "image";
    if (kind === "pdf") return "pdf";
    if (kind === "audio") return "audio";
    if (kind === "video") return "video";
    if (args.isText) return isMarkdown(args.mime, args.filename) ? "markdown" : "code";
    return "generic";
}
