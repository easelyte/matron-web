/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Timeline cards for the tracker markers (`item` / `milestone` / `mission` journal events). They
 * join the mj_PromptCard visual family so an inline tracker card reads as the same card species as
 * a permission / spawn card. Every field is parsed defensively — titles can be absent across a
 * privacy boundary, so each falls back to `#num`. Tapping a card opens the corresponding tracker
 * surface via the client.
 */

import React from "react";

import type { MatronJournalClient } from "../client";
import { ChevronRightIcon } from "../icons";
import { MarkdownBody } from "../markdown";
import {
    asNumber,
    asString,
    isObject,
    type EventPayload,
    type JournalEvent,
    type TrackerItemKind,
    type TrackerMilestoneKind,
    type TrackerResolution,
} from "../types";
import { itemStatusText, kindLabel, milestoneKindLabel, oneLine } from "./format";
import { MilestoneGlyph, TrackerGlyph } from "./glyphs";

const ITEM_KINDS: readonly TrackerItemKind[] = ["task", "question", "decision"];
const RESOLUTIONS: readonly TrackerResolution[] = ["done", "answered", "decided", "reversed", "cancelled"];

function itemKind(payload: EventPayload): TrackerItemKind {
    const kind = asString(payload.kind);
    return (ITEM_KINDS as readonly string[]).includes(kind) ? (kind as TrackerItemKind) : "task";
}

function resolution(payload: EventPayload): TrackerResolution | null {
    const value = asString(payload.resolution);
    return (RESOLUTIONS as readonly string[]).includes(value) ? (value as TrackerResolution) : null;
}

function actorLabel(payload: EventPayload): string {
    return asString(payload.by) === "user" ? "You" : "Agent";
}

interface MarkerComment {
    body: string;
    attachmentNames: string[];
}

function parseComment(value: unknown): MarkerComment | null {
    if (!isObject(value)) return null;
    const body = asString(value.body);
    const attachmentNames = Array.isArray(value.attachments)
        ? value.attachments.flatMap((attachment) =>
              isObject(attachment) && typeof attachment.name === "string" ? [attachment.name] : [],
          )
        : [];
    if (!body && attachmentNames.length === 0) return null;
    return { body, attachmentNames };
}

/** `item` marker with action created|closed — a full card with the status pill. */
export function ItemCard({ client, event }: { client: MatronJournalClient; event: JournalEvent }): React.ReactElement {
    const payload = event.payload;
    const num = asNumber(payload.num);
    const kind = itemKind(payload);
    const title = asString(payload.title).trim();
    const action = asString(payload.action);
    const closed = action === "closed";
    const awaiting = asString(payload.awaiting);
    const needsYou = awaiting === "user" && !closed;
    const status = itemStatusText({
        state: closed ? "closed" : "open",
        awaiting: awaiting === "user" ? "user" : awaiting === "agent" ? "agent" : null,
        resolution: closed ? resolution(payload) : null,
    });
    const comment = closed ? parseComment(payload.comment) : null;

    return (
        <button
            type="button"
            className={`mj_PromptCard mj_TrackerCard${needsYou ? " mj_TrackerCard_needsyou" : ""}`}
            onClick={() => client.openTrackerItem(num)}
        >
            <div className="mj_TrackerCard_row">
                <span className="mj_TrackerCard_glyph" aria-hidden="true">
                    <TrackerGlyph kind={kind} />
                </span>
                <span className="mj_TrackerCard_num">#{num}</span>
                <span className="mj_TrackerCard_title">{title || kindLabel(kind)}</span>
                <span
                    className={`mj_TrackerStatusPill ${
                        needsYou ? "mj_TrackerStatusPill_needsyou" : "mj_TrackerStatusPill_muted"
                    }`}
                >
                    {status}
                </span>
            </div>
            {comment ? (
                <div className="mj_TrackerCard_comment">
                    {comment.body ? (
                        <div className="mj_TrackerProse">
                            <MarkdownBody
                                text={comment.body}
                                label={`item-card-${num}`}
                                onTrackerLink={(kind, target) => client.openTrackerLink(kind, target)}
                            />
                        </div>
                    ) : null}
                    {comment.attachmentNames.map((name, index) => (
                        <p key={`${name}-${index}`} className="mj_TrackerCard_attachment">
                            {name}
                        </p>
                    ))}
                </div>
            ) : null}
        </button>
    );
}

/** `item` marker with action commented|reopened — a one-line note (with the reply body if any). */
export function ItemInlineNote({
    client,
    event,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
}): React.ReactElement {
    const payload = event.payload;
    const num = asNumber(payload.num);
    const kind = itemKind(payload);
    const title = asString(payload.title).trim() || `#${num}`;
    const who = actorLabel(payload);
    const reopened = asString(payload.action) === "reopened";
    const lead = reopened ? `${who} reopened #${num} · ${title}` : `${who} replied on #${num} · ${title}`;
    const comment = reopened ? null : parseComment(payload.comment);

    return (
        <button type="button" className="mj_TrackerInlineNote" onClick={() => client.openTrackerItem(num)}>
            <span className="mj_TrackerInlineNote_line">
                <span className="mj_TrackerInlineNote_glyph" aria-hidden="true">
                    <TrackerGlyph kind={kind} />
                </span>
                {lead}
            </span>
            {comment?.body ? (
                <div className="mj_TrackerProse mj_TrackerInlineNote_body">
                    <MarkdownBody
                        text={comment.body}
                        label={`item-note-${num}`}
                        onTrackerLink={(kind, target) => client.openTrackerLink(kind, target)}
                    />
                </div>
            ) : null}
        </button>
    );
}

// The item-marker actions that render visible timeline content. Any action NOT in this set — the
// quiet invalidation-only `reordered`/`updated`, plus any unknown action under server/client version
// skew — renders null and MUST also be suppressed from the timeline, or it leaves a ghost row (an
// empty avatar/bubble shell). This is the SINGLE classifier shared by renderItemMarker (below) and
// the timeline suppressor (isSuppressedTrackerEvent, components.tsx) so the two can never diverge (F5).
const RENDERABLE_ITEM_ACTIONS: ReadonlySet<string> = new Set(["created", "closed", "commented", "reopened"]);

/** True when this `item` marker renders a visible card/note (and so must occupy a timeline row). */
export function isRenderableItemMarker(event: JournalEvent): boolean {
    return event.type === "item" && RENDERABLE_ITEM_ACTIONS.has(asString(event.payload.action));
}

/**
 * Dispatch an `item` marker to its card. `created`/`closed` → ItemCard; `commented`/`reopened` →
 * ItemInlineNote. Anything else (quiet invalidation-only `reordered`/`updated`, or an unknown future
 * action) is non-renderable per the shared classifier and returns null, so a future action can't
 * crash the timeline — and, being suppressed in lock-step, can't leave a ghost row either.
 */
export function renderItemMarker(event: JournalEvent, client: MatronJournalClient): React.ReactElement | null {
    if (!isRenderableItemMarker(event)) return null;
    switch (asString(event.payload.action)) {
        case "created":
        case "closed":
            return <ItemCard client={client} event={event} />;
        case "commented":
        case "reopened":
            return <ItemInlineNote client={client} event={event} />;
        default:
            return null;
    }
}

/** `milestone` marker — a card that jumps to its parent mission. */
export function MilestoneCard({
    client,
    event,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
}): React.ReactElement {
    const payload = event.payload;
    const num = asNumber(payload.num);
    const missionNum = asNumber(payload.mission_num);
    const kind: TrackerMilestoneKind = asString(payload.kind) === "user_input" ? "user_input" : "progress";
    const title = asString(payload.title).trim() || `#${num}`;
    const body = oneLine(asString(payload.body));
    const missionLabelText = asString(payload.mission_title).trim() || `#${missionNum}`;
    const userInput = kind === "user_input";

    return (
        <button
            type="button"
            className={`mj_PromptCard mj_TrackerCard${userInput ? " mj_TrackerCard_needsyou" : ""}`}
            onClick={() => client.openTrackerMission(missionNum)}
        >
            <div className="mj_TrackerCard_row">
                <span className="mj_TrackerCard_glyph" aria-hidden="true">
                    <MilestoneGlyph kind={kind} />
                </span>
                <span className="mj_TrackerCard_num">#{num}</span>
                <span className="mj_TrackerCard_title">{title}</span>
                <ChevronRightIcon className="mj_TrackerCard_chevron" aria-hidden="true" />
            </div>
            {body ? <p className="mj_TrackerCard_milestoneBody">{body}</p> : null}
            <p className="mj_TrackerCard_subtitle">
                {milestoneKindLabel(kind)} · {missionLabelText}
            </p>
        </button>
    );
}

/** `mission` marker — a one-line notice. */
export function MissionNotice({
    client,
    event,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
}): React.ReactElement {
    const payload = event.payload;
    const num = asNumber(payload.num);
    const title = asString(payload.title).trim();
    const action = asString(payload.action);

    let text: string;
    if (action === "created") {
        text = `Mission #${num} started${title ? ` · ${title}` : ""}`;
    } else if (action === "joined") {
        text = `Joined mission #${num}`;
    } else if (action === "updated") {
        text = `Mission #${num} renamed`;
    } else if (action === "closed") {
        const nums = Array.isArray(payload.open_item_nums)
            ? payload.open_item_nums.filter((value): value is number => typeof value === "number")
            : [];
        text = nums.length
            ? `Mission #${num} closed over ${nums.map((value) => `#${value}`).join(", ")}`
            : `Mission #${num} closed`;
    } else {
        text = `Mission #${num}`;
    }

    return (
        <button type="button" className="mj_TrackerMissionNotice" onClick={() => client.openTrackerMission(num)}>
            <span className="mj_TrackerMissionNotice_flag" aria-hidden="true">
                🏁
            </span>
            {text}
        </button>
    );
}
