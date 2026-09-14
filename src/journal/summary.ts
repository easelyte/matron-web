/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Type-only import: erased at compile time, so this module stays DOM-free and pulls no
// component code into a unit test that only wants the parser.
import type { ConversationSummary } from "./components";

/**
 * Parse the bridge's rolling digest wire format into display bullets (loop #554).
 *
 * The grammar is the producer's, not ours: matron-bridge `lib/pinned-summary.js` exports
 * `summaryBlocks()` precisely so every consumer agrees on what "a bullet" is in a stored
 * digest. A line starting with `•` opens a block; any following unmarked lines belong to
 * that block (a wrapped bullet, or prose the model emitted without a marker), and leading
 * unmarked lines form a block of their own. Dropping unmarked lines instead would delete
 * exactly the continuation text where "…but it is blocked on X" lands — and would render a
 * prose-only blurb (the column's documented upstream use) as nothing at all.
 *
 * Each block's own `• ` marker is stripped, because the list draws one via
 * `.mj_PinnedSummary_item::before`; leaving it in would double the bullet. Continuation
 * lines are joined with a space: the item is a single inline span, so a newline would
 * collapse to whitespace anyway.
 */
export function parseSummaryBullets(text: string | undefined | null): string[] {
    // typeof, not just truthiness: the snapshot row is cast, not parsed (api.ts), and
    // validateSnapshotRows checks only id/session_outcome, so a server sending a non-string
    // here would otherwise reach .split() and throw INSIDE the app's render — a wedge that
    // survives reload, since the bad value is already in IndexedDB. Degrade to "no digest".
    if (typeof text !== "string" || !text) return [];
    const blocks: string[][] = [];
    for (const line of text.split("\n").map((candidate) => candidate.trim())) {
        if (!line) continue;
        if (line.startsWith("\u2022") || blocks.length === 0) blocks.push([line]);
        else blocks[blocks.length - 1].push(line);
    }
    return blocks
        .map((block) =>
            block
                .join(" ")
                .replace(/^\u2022\s*/, "")
                .trim(),
        )
        .filter(Boolean);
}

/**
 * Build the `<PinnedSummary>` prop for a conversation, or null when there is nothing to show.
 *
 * Returns **null**, never `{ bullets: [] }`. PinnedSummary renders nothing on null but renders
 * a "No summary yet" box on empty bullets, so null is what keeps every undigested conversation
 * — every sub-chat (the bridge's pass is per-session, so children never have one), every fresh
 * session, every conversation owned by a bridge or server without this feature — pixel-identical
 * to before the surface existed.
 *
 * `state` is always "ready": the bridge knows when a pass is in flight but there is no wire field
 * for it, and a shimmer whose whole lifetime is one codex call does not earn one (design §5.4).
 */
export function conversationSummary(
    conversation: { summary?: string; summary_updated_at?: number } | undefined | null,
): ConversationSummary | null {
    const bullets = parseSummaryBullets(conversation?.summary);
    if (!bullets.length) return null;
    // 0 = never written (or an older server that sends no timestamp). Omit the key entirely
    // rather than pass 0, which would render an "updated 56y ago" label off the epoch. Finite
    // and positive, for the same untrusted-row reason as the type check above.
    const updatedAtMs = conversation?.summary_updated_at;
    const hasAge = typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs) && updatedAtMs > 0;
    return {
        bullets,
        state: "ready",
        ...(hasAge ? { updatedAtMs } : {}),
    };
}
