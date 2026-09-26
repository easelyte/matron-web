/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * A full-width inbox row for one tracker item. Leading kind glyph, the title on its own line, then
 * a meta line that LEADS with the #number (monospaced-digit) and carries one status token. The
 * whole row is a button → onOpen(num). Presentational: it derives everything from the item plus a
 * caller-resolved origin title; no data fetching.
 */

import React from "react";

import type { TrackerItem } from "../types";
import { isFromViewedConvo, itemStatusText, kindLabel, needsUser, oneLine, resolutionLabel } from "./format";
import { CommentBubbleGlyph, ImagePlaceholderGlyph, TrackerGlyph } from "./glyphs";

export function ItemRow({
    item,
    scope = "chat",
    originTitle,
    currentConvoId,
    onOpen,
}: {
    item: TrackerItem;
    scope?: "chat" | "all";
    originTitle?: string;
    /** The conversation being viewed. A row filed from it carries no origin note (it is "this
     *  session"); a row from any other conversation reads "from <title>". */
    currentConvoId?: string | null;
    onOpen: (num: number) => void;
}): React.ReactElement {
    const urgent = needsUser(item);
    const origin = scope === "all" && originTitle && !isFromViewedConvo(item, currentConvoId) ? originTitle : null;
    const body = oneLine(item.body);
    // ONE status token: needs-you (orange) → closed-with-resolution → with-the-agent. An open item
    // awaiting nobody-in-particular shows no token (the row itself is the "open" signal).
    const statusToken = urgent ? (
        <span className="mj_TrackerItemRow_status mj_TrackerItemRow_status_needsyou">Needs you</span>
    ) : item.state === "closed" ? (
        <span className="mj_TrackerItemRow_status mj_TrackerItemRow_status_muted">
            {item.resolution ? resolutionLabel(item.resolution) : "Closed"}
        </span>
    ) : item.awaiting === "agent" ? (
        <span className="mj_TrackerItemRow_status mj_TrackerItemRow_status_muted">With the agent</span>
    ) : null;

    const label = [
        kindLabel(item.kind),
        `number ${item.num}`,
        item.title,
        origin ? `from ${origin}` : "",
        itemStatusText(item),
    ]
        .filter(Boolean)
        .join(", ");

    return (
        <button
            type="button"
            className={`mj_TrackerItemRow${urgent ? " mj_TrackerItemRow_needsyou" : ""}`}
            aria-label={label}
            onClick={() => onOpen(item.num)}
        >
            <span className="mj_TrackerItemRow_glyph" aria-hidden="true">
                <TrackerGlyph kind={item.kind} />
            </span>
            <span className="mj_TrackerItemRow_main">
                <span className="mj_TrackerItemRow_title">
                    <span className="mj_TrackerItemRow_num">#{item.num}</span>
                    {item.title}
                </span>
                {body ? <span className="mj_TrackerItemRow_body">{body}</span> : null}
                <span className="mj_TrackerItemRow_meta">
                    {origin ? <span className="mj_TrackerItemRow_origin">from {origin}</span> : null}
                    {statusToken}
                    {item.comment_count > 0 ? (
                        <span className="mj_TrackerItemRow_comments">
                            <CommentBubbleGlyph aria-hidden="true" />
                            {item.comment_count}
                        </span>
                    ) : null}
                </span>
            </span>
            {item.has_image ? (
                <span className="mj_TrackerItemRow_thumb" aria-hidden="true">
                    <ImagePlaceholderGlyph />
                </span>
            ) : null}
        </button>
    );
}
