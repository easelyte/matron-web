/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// One-line preview text from markdown source. Shared by the Work view (loop summaries) and the
// sidebar (conversation previews). Deliberately a small regex pass, not the remark renderer: a
// preview is one ellipsised line, and a server snippet is already flattened and cut at 120
// characters, so it is often not well-formed markdown at all.

/**
 * Strip inline markdown so a preview line reads as prose: `**bold**` → bold, `` `code` `` → code,
 * `[text](url)` → text. Block syntax (bullets, headings, quotes) is dropped at the line start.
 */
export function plainText(markdown: string): string {
    return markdown
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1");
}

/**
 * A sidebar preview from a conversation snippet. On top of plainText: the snippet's newlines are
 * already collapsed server-side, so a heading can sit mid-line ("Session closed. ## Summary"), and
 * the 120-character cut can leave an unclosed `**` or backtick behind ("**Do…"). Both are dropped.
 * `#785` keeps its hash: a heading marker needs a space after it.
 */
export function snippetText(snippet: string): string {
    return plainText(snippet)
        .replace(/(^|\s)#{1,6}\s+/g, "$1")
        .replace(/\*\*|`/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
