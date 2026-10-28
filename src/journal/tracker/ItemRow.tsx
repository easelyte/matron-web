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
 *
 * A notice (something to read, not to decide) is drawn lighter than a question: regular-weight
 * secondary title, a muted "To read" token instead of the orange "Needs you", no orange edge. Given
 * `onSeen`, an open notice carries a one-tap Seen button beside the row (a sibling, not nested in
 * the row's button). Given `onAnswer`, an open consent request waiting on the user carries its own
 * Approve and Decline on a line under the row (rowConsentAnswers), so it is answered in place.
 */

import React from "react";

import type { TrackerItem } from "../types";
import {
    awaitsSeen,
    closedStatusLabel,
    contributorWords,
    isAffirmativeAnswer,
    itemProvenance,
    itemStatusText,
    kindLabel,
    needsUser,
    oneLine,
    rowConsentAnswers,
} from "./format";
import { CommentBubbleGlyph, ImagePlaceholderGlyph, MissionGlyph, TrackerGlyph } from "./glyphs";
import { inlineRefsToText } from "./inline-attachments";

export const ItemRow = React.memo(function ItemRow({
    item,
    scope = "chat",
    originTitle,
    currentConvoId,
    onOpen,
    onSeen,
    seenBusy = false,
    onAnswer,
    answerBusy = false,
    describedBy,
}: {
    item: TrackerItem;
    scope?: "chat" | "all";
    originTitle?: string;
    /** Journal convo id of the session viewing this row. Drives the provenance chip: same origin →
     *  no chip; different origin → "from «title»"; route-elsewhere label → "↪ Handle elsewhere". */
    currentConvoId?: string | null;
    onOpen: (num: number) => void;
    /** Marks an open notice seen; without it no Seen button is drawn. */
    onSeen?: (num: number) => void;
    /** The Seen tap is in flight: the button is disabled. */
    seenBusy?: boolean;
    /** Answers a consent request with one of its labels; without it no answer buttons are drawn. */
    onAnswer?: (num: number, label: string) => void;
    /** An answer tap is in flight: the buttons are disabled. */
    answerBusy?: boolean;
    /** Id of an extra description for the row button (e.g. a keyboard hint). */
    describedBy?: string;
}): React.ReactElement {
    const notice = item.kind === "notice";
    // A notice awaiting the user is still in "Needs you", but it is not the urgent orange state.
    const urgent = needsUser(item) && !notice;
    const showSeen = !!onSeen && awaitsSeen(item);
    const answers = onAnswer ? rowConsentAnswers(item) : [];
    // Filed by another person (or their agent) into one of the user's missions.
    const by = contributorWords(item.contributor);
    // The preview shows no attachments, so an inline image ref reads as its caption.
    const body = oneLine(inlineRefsToText(item.body));
    // Provenance relative to the viewing session. The caller-resolved originTitle (the live
    // conversation list, which tracks renames) wins; the title carried on the item
    // (origin_convo_title) covers origins the caller could not resolve.
    const provenance = itemProvenance(item, currentConvoId);
    const provTitle = originTitle ?? (provenance.kind !== "here" ? provenance.title : null) ?? null;
    // The informational "from another session" chip stays gated to the all-conversations scope (a
    // chat-scoped list is all one origin); the actionable route-elsewhere chip shows in any scope.
    const showOtherChip = provenance.kind === "other" && scope === "all";
    const showRouteChip = provenance.kind === "elsewhere";
    // ONE status token: needs-you (orange) → closed-with-resolution → with-the-agent. An open item
    // awaiting nobody-in-particular shows no token (the row itself is the "open" signal).
    const statusToken = urgent ? (
        <span className="mj_TrackerItemRow_status mj_TrackerItemRow_status_needsyou">Needs you</span>
    ) : notice && needsUser(item) ? (
        <span className="mj_TrackerItemRow_status mj_TrackerItemRow_status_muted">To read</span>
    ) : item.state === "closed" ? (
        <span className="mj_TrackerItemRow_status mj_TrackerItemRow_status_muted">{closedStatusLabel(item)}</span>
    ) : item.awaiting === "agent" ? (
        <span className="mj_TrackerItemRow_status mj_TrackerItemRow_status_muted">With the agent</span>
    ) : null;

    const label = [
        kindLabel(item.kind),
        `number ${item.num}`,
        item.title,
        showRouteChip
            ? `handle elsewhere${provTitle ? `, from ${provTitle}` : ""}`
            : showOtherChip
              ? `from ${provTitle ?? "another chat"}`
              : "",
        by ? `by ${by}` : "",
        itemStatusText(item),
    ]
        .filter(Boolean)
        .join(", ");

    const row = (
        <button
            type="button"
            className={`mj_TrackerItemRow${urgent ? " mj_TrackerItemRow_needsyou" : ""}${
                notice ? " mj_TrackerItemRow_notice" : ""
            }${showSeen ? " mj_TrackerItemRow_withSeen" : ""}${answers.length > 0 ? " mj_TrackerItemRow_withAnswers" : ""}`}
            aria-label={label}
            aria-describedby={describedBy}
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
                    {showRouteChip ? (
                        <span className="mj_TrackerItemRow_origin mj_TrackerItemRow_routeElsewhere">
                            ↪ Handle elsewhere{provTitle ? ` · ${provTitle}` : ""}
                        </span>
                    ) : showOtherChip ? (
                        <span className="mj_TrackerItemRow_origin">from {provTitle ?? "another chat"}</span>
                    ) : null}
                    {by ? <span className="mj_TrackerItemRow_origin mj_TrackerContributor">by {by}</span> : null}
                    {item.mission_num ? (
                        <span className="mj_TrackerItemRow_missionChip">
                            <MissionGlyph state="open" aria-hidden="true" />#{item.mission_num}
                        </span>
                    ) : null}
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
    if (answers.length > 0) {
        return (
            <div className="mj_TrackerItemRow_wrap mj_TrackerItemRow_answerWrap">
                {row}
                <div className="mj_TrackerItemRow_answers" role="group" aria-label={`Answer number ${item.num}`}>
                    {answers.map((label) => (
                        <button
                            key={label}
                            type="button"
                            className={`mj_TrackerAction${isAffirmativeAnswer(label) ? " mj_TrackerAction_affirmative" : ""}`}
                            aria-label={`${label}, number ${item.num}`}
                            disabled={answerBusy}
                            onClick={() => onAnswer?.(item.num, label)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>
        );
    }
    if (!showSeen) return row;
    return (
        <div className="mj_TrackerItemRow_wrap">
            {row}
            <button
                type="button"
                className="mj_TrackerAction mj_TrackerItemRow_seen"
                aria-label={`Seen, number ${item.num}`}
                disabled={seenBusy}
                onClick={() => onSeen(item.num)}
            >
                Seen
            </button>
        </div>
    );
});
