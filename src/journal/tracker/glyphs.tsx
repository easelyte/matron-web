/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Single source-of-truth glyph map for the tracker. Every tracker surface (rows, cards, detail
 * headers) draws its kind glyph from here so the visual vocabulary is defined once. Colour is
 * carried by a class, not a fill — the semantic tokens (orange "needs you", teal accent, purple
 * decision, secondary) live in journal.pcss so both themes stay in lock-step.
 *
 * Orange is the ONE urgent colour and appears ONLY where it means "needs you": the question glyph,
 * the user_input milestone glyph, and the NeedsYou badge.
 */

import React from "react";

import type { TrackerItemKind } from "../types";

type GlyphProps = React.SVGProps<SVGSVGElement> & { className?: string };

function Glyph({ children, className, ...props }: GlyphProps & { children: React.ReactNode }): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={className}
            {...props}
        >
            {children}
        </svg>
    );
}

/** Question item — orange (needs-you semantic). A speech bubble carrying a question mark. */
export function QuestionGlyph(props: GlyphProps): React.ReactElement {
    return (
        <Glyph {...props} className={`mj_TrackerGlyph mj_TrackerGlyph_question ${props.className ?? ""}`.trim()}>
            <path d="M4 5h16v11H9l-4 3v-3H4z" />
            <path d="M9.6 9.2a2.4 2.4 0 0 1 4.4 1.3c0 1.6-2 1.7-2 3" />
            <path d="M12 15.2h.01" />
        </Glyph>
    );
}

/** Task item — teal accent. A checkable square. */
export function TaskGlyph(props: GlyphProps): React.ReactElement {
    return (
        <Glyph {...props} className={`mj_TrackerGlyph mj_TrackerGlyph_task ${props.className ?? ""}`.trim()}>
            <rect x="4" y="4" width="16" height="16" rx="3" />
            <path d="m8.5 12 2.5 2.5 4.5-5" />
        </Glyph>
    );
}

/** Decision item — purple. A fork / branch. */
export function DecisionGlyph(props: GlyphProps): React.ReactElement {
    return (
        <Glyph {...props} className={`mj_TrackerGlyph mj_TrackerGlyph_decision ${props.className ?? ""}`.trim()}>
            <circle cx="6" cy="5" r="2" />
            <circle cx="6" cy="19" r="2" />
            <circle cx="18" cy="9" r="2" />
            <path d="M6 7v10M6 12h6a4 4 0 0 0 4-4V11" />
        </Glyph>
    );
}

/** A comment-count bubble glyph (secondary). */
export function CommentBubbleGlyph(props: GlyphProps): React.ReactElement {
    return (
        <Glyph {...props} className={`mj_TrackerGlyph mj_TrackerGlyph_bubble ${props.className ?? ""}`.trim()}>
            <path d="M4 5h16v11H9l-4 3v-3H4z" />
        </Glyph>
    );
}

/** Jump-to-conversation glyph (used on milestone rows). */
export function JumpGlyph(props: GlyphProps): React.ReactElement {
    return (
        <Glyph {...props} className={`mj_TrackerGlyph mj_TrackerGlyph_jump ${props.className ?? ""}`.trim()}>
            <path d="M7 17 17 7" />
            <path d="M9 7h8v8" />
        </Glyph>
    );
}

/** A photo placeholder for a row whose item carries an image (read-only, no blob fetch in v1). */
export function ImagePlaceholderGlyph(props: GlyphProps): React.ReactElement {
    return (
        <Glyph {...props} className={`mj_TrackerGlyph mj_TrackerGlyph_photo ${props.className ?? ""}`.trim()}>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="8.5" cy="10" r="1.5" />
            <path d="m4 17 5-5 4 4 3-3 4 4" />
        </Glyph>
    );
}

/**
 * Unified dispatcher — draw the glyph for an item kind. The discrete components above stay
 * available for call sites that already know which they want; this is the single-prop convenience
 * the rows use.
 */
export function TrackerGlyph({
    kind,
    ...props
}: GlyphProps & {
    kind?: TrackerItemKind;
}): React.ReactElement | null {
    if (kind === "question") return <QuestionGlyph {...props} />;
    if (kind === "task") return <TaskGlyph {...props} />;
    if (kind === "decision") return <DecisionGlyph {...props} />;
    return null;
}

/**
 * The "needs you" count badge — orange capsule, white text, question-mark glyph. Renders nothing
 * when the count is zero or negative, so a caller can drop it in unconditionally.
 */
export function NeedsYouBadge({ count }: { count: number }): React.ReactElement | null {
    if (!(count > 0)) return null;
    const shown = count > 99 ? "99+" : String(count);
    return (
        <span className="mj_TrackerNeedsYouBadge" aria-label={`${count} item${count === 1 ? "" : "s"} need you`}>
            <svg
                viewBox="0 0 24 24"
                width="1em"
                height="1em"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
            >
                <path d="M9.4 9.2a2.6 2.6 0 0 1 4.8 1.3c0 1.7-2.2 1.8-2.2 3.2" strokeLinecap="round" />
                <path d="M12 17h.01" strokeLinecap="round" />
            </svg>
            <span className="mj_TrackerNeedsYouBadge_count">{shown}</span>
        </span>
    );
}
