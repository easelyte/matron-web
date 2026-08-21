/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Shared numeric ceilings for the Files pane, in one place so markdown and code enforce the SAME
// inline-render limit (F6) and the transport limits are not scattered.

/**
 * Single inline-render ceiling for ALL text previews (markdown AND code). Beyond this the pane
 * refuses to render inline and offers download instead — a multi-MB text file (up to the server's
 * 5 MB inline cap) would otherwise stall a phone even when markdown skips PARSING but still injects
 * the raw payload as DOM text. Both MarkdownPreview and CodePreview gate on this constant.
 */
export const INLINE_TEXT_MAX = 512_000;

/** Max PDF pages rendered inline (via pdf.js → canvas); beyond this, download for the rest. */
export const PDF_PAGE_CAP = 30;

/** Per-request fetch timeout — a stalled read surfaces a retryable error instead of hanging. */
export const FETCH_TIMEOUT_MS = 30_000;

/** How long a one-shot download object URL lives before it is revoked (never session-cached). */
export const DOWNLOAD_URL_TTL_MS = 60_000;
