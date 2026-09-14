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
 * The wire carries the raw text the bridge accreted — one `• `-prefixed line per pass,
 * joined with "\n" (matron-bridge lib/pinned-summary.js). The marker is stripped here
 * because the list draws its own via `.mj_PinnedSummary_item::before`; leaving it in
 * would render a double bullet.
 *
 * Lines WITHOUT a marker are dropped when any marked line exists. That is deliberate:
 * the bridge's compaction path accepts codex output whenever any line matches /^•/m, so
 * a preamble ("Here are the 3 bullets:") can reach the column, and it is noise rather
 * than digest. When NO line is marked, every line is kept — a server or bridge that
 * wrote the documented "2-3 sentence" prose blurb into the same column still renders as
 * bullets rather than as nothing.
 */
export function parseSummaryBullets(text: string | undefined | null): string[] {
    // typeof, not just truthiness: the snapshot row is cast, not parsed (api.ts), and
    // validateSnapshotRows checks only id/session_outcome, so a server sending a non-string
    // here would otherwise reach .split() and throw INSIDE the app's render — a wedge that
    // survives reload, since the bad value is already in IndexedDB. Degrade to "no digest".
    if (typeof text !== "string" || !text) return [];
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const marked = lines
        .filter((line) => line.startsWith("•"))
        .map((line) => line.replace(/^•\s*/, "").trim())
        .filter(Boolean);
    return marked.length ? marked : lines;
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
