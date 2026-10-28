/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Timeline cards for the tracker markers (`item` / `milestone` / `mission` journal events). They
 * join the mj_PromptCard visual family so an inline tracker card reads as the same card species as
 * a permission / spawn card. Every field is parsed defensively — titles can be absent across a
 * privacy boundary, so each falls back to `#num`. Tapping a card's header opens the corresponding
 * tracker surface via the client.
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
    type TrackerContributor,
    type TrackerItemKind,
    type TrackerMilestoneKind,
    type TrackerResolution,
} from "../types";
import { contributorWords, itemStatusText, kindLabel, milestoneKindLabel, oneLine } from "./format";
import { MilestoneGlyph, TrackerGlyph } from "./glyphs";
import { inlineRefsToText } from "./inline-attachments";

const ITEM_KINDS: readonly TrackerItemKind[] = ["task", "question", "decision", "notice"];
const RESOLUTIONS: readonly TrackerResolution[] = ["done", "answered", "decided", "reversed", "cancelled"];

function itemKind(payload: EventPayload): TrackerItemKind {
    const kind = asString(payload.kind);
    return (ITEM_KINDS as readonly string[]).includes(kind) ? (kind as TrackerItemKind) : "task";
}

function resolution(payload: EventPayload): TrackerResolution | null {
    const value = asString(payload.resolution);
    return (RESOLUTIONS as readonly string[]).includes(value) ? (value as TrackerResolution) : null;
}

function parseContributor(value: unknown): TrackerContributor | null {
    if (!isObject(value)) return null;
    const name = asString(value.name).trim();
    return name ? { name, via: asString(value.via) === "agent" ? "agent" : "user" } : null;
}

function actorLabel(payload: EventPayload): string {
    // Another person's write (a contributor's reply, or the owner's on a contributor's item).
    const person = contributorWords(parseContributor(payload.person));
    if (person) return person;
    return asString(payload.by) === "user" ? "You" : "Agent";
}

interface MarkerComment {
    body: string;
    attachmentNames: string[];
}

function parseComment(value: unknown): MarkerComment | null {
    if (!isObject(value)) return null;
    // The card lists attachments by name, so an inline ref reads as its caption here.
    const body = inlineRefsToText(asString(value.body));
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
        // The card is a plain container and only its header row is the open-item button: the comment
        // body renders markdown (links, code-block copy buttons), and interactive content may not
        // nest inside a <button>. As a sibling, a link click opens its own target, not this item.
        <div className={`mj_PromptCard mj_TrackerCard${needsYou ? " mj_TrackerCard_needsyou" : ""}`}>
            <button type="button" className="mj_TrackerCard_row" onClick={() => client.openTrackerItem(num)}>
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
            </button>
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
        </div>
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
        // Same split as ItemCard: the lead line is the button, the markdown body is its sibling.
        <div className="mj_TrackerInlineNote">
            <button type="button" className="mj_TrackerInlineNote_line" onClick={() => client.openTrackerItem(num)}>
                <span className="mj_TrackerInlineNote_glyph" aria-hidden="true">
                    <TrackerGlyph kind={kind} />
                </span>
                {lead}
            </button>
            {comment?.body ? (
                <div className="mj_TrackerProse mj_TrackerInlineNote_body">
                    <MarkdownBody
                        text={comment.body}
                        label={`item-note-${num}`}
                        onTrackerLink={(kind, target) => client.openTrackerLink(kind, target)}
                    />
                </div>
            ) : null}
        </div>
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

/**
 * What a conversation's item markers say about its item cards, read in one walk before the timeline
 * builds its rows. Every `created` and `closed` marker used to draw its own card from its frozen
 * payload, so a decided item showed twice: a "Needs you" card that never cleared, and a "Done" card
 * under it. An item now shows once — at its most recent `created`/`closed` marker, in the state of
 * its most recent renderable marker of any kind. The one-line `commented`/`reopened` notes are events,
 * not copies of the item, and stay. A marker without an `item_id` cannot be matched and is left as is.
 */
export interface ItemCardFold {
    /** Seqs of card markers superseded by a later card for the same item. */
    hidden: ReadonlySet<number>;
    /** The surviving card per item, re-stated where a later marker changed what it shows. By seq. */
    restated: ReadonlyMap<number, EventPayload>;
}

export const EMPTY_ITEM_CARD_FOLD: ItemCardFold = { hidden: new Set(), restated: new Map() };

export function foldItemCards(events: readonly JournalEvent[]): ItemCardFold {
    const hidden = new Set<number>();
    const restated = new Map<number, EventPayload>();
    const lastCard = new Map<string, JournalEvent>();
    const latestMarker = new Map<string, JournalEvent>();
    for (const event of events) {
        if (!isRenderableItemMarker(event)) continue;
        const itemId = asString(event.payload.item_id);
        if (!itemId) continue;
        latestMarker.set(itemId, event);
        const action = asString(event.payload.action);
        if (action !== "created" && action !== "closed") continue;
        const previous = lastCard.get(itemId);
        if (previous) hidden.add(previous.seq);
        lastCard.set(itemId, event);
    }
    for (const [itemId, card] of lastCard) {
        const latest = latestMarker.get(itemId);
        if (!latest || latest === card) continue;
        const payload = restateItemCard(card.payload, latest.payload);
        if (payload !== card.payload) restated.set(card.seq, payload);
    }
    return hidden.size || restated.size ? { hidden, restated } : EMPTY_ITEM_CARD_FOLD;
}

/** Whether the item is closed as of this marker: a `closed` marker says so by its action; any later
 *  marker carries the item's resolution, which a reopen clears. */
function leavesItemClosed(payload: EventPayload): boolean {
    const action = asString(payload.action);
    return action === "closed" || (action !== "reopened" && resolution(payload) !== null);
}

/**
 * A card-shaped marker (`created`/`closed`) re-stated in the item's state as of `latest`, a later
 * marker for the same item. Returns `card` itself when nothing the card draws changed. A closed card
 * keeps its closing comment; a card whose item has been reopened since drops it, with the "Done" pill.
 */
export function restateItemCard(card: EventPayload, latest: EventPayload): EventPayload {
    const closed = leavesItemClosed(latest);
    const wasClosed = asString(card.action) === "closed";
    const title = typeof latest.title === "string" ? latest.title : card.title;
    const awaiting = latest.awaiting;
    const nextResolution = closed ? (resolution(latest) ?? resolution(card)) : null;
    const keepComment = closed === wasClosed;
    const unchanged =
        title === card.title &&
        closed === wasClosed &&
        awaiting === card.awaiting &&
        nextResolution === (closed ? resolution(card) : null) &&
        (keepComment || card.comment === undefined);
    if (unchanged) return card;
    const next: EventPayload = { ...card, title, action: closed ? "closed" : "created", awaiting };
    if (awaiting === undefined) delete next.awaiting;
    if (nextResolution) next.resolution = nextResolution;
    else delete next.resolution;
    if (!keepComment) delete next.comment;
    return next;
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
    // Another person's milestone in one of the user's missions: the row carries `contributor`,
    // the marker `person`.
    const by = contributorWords(parseContributor(payload.contributor) ?? parseContributor(payload.person));

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
                {by ? <span className="mj_TrackerContributor"> · by {by}</span> : null}
            </p>
        </button>
    );
}

/** `mission` marker — a one-line notice. */
// A `memory` marker (spec 2026-09-27 memories): a quiet one-line notice, the MissionNotice
// species. The journal may append the same change to two conversations; each renders its own
// line. Across a privacy boundary the payload carries no name — the notice then has no target
// and opens the Memories list instead of one memory.
export function MemoryNotice({
    client,
    event,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
}): React.ReactElement {
    const payload = event.payload;
    const name = asString(payload.name).trim();
    const description = oneLine(asString(payload.description));
    const action = asString(payload.action);
    const verb = action === "deleted" ? "deleted" : payload.created === true ? "saved" : "updated";
    const who = asString(payload.by) === "user" ? "You" : "Agent";
    const what = name ? ` · ${name}${description && action !== "deleted" ? ` — ${description}` : ""}` : "";
    const text = `${who} ${verb} a memory${what}`;
    const open = (): void => {
        if (name && action !== "deleted") client.openTrackerMemory(name);
        else client.openTrackerView({ view: "memories", itemId: null, missionId: null, memoryName: null });
    };
    return (
        <button type="button" className="mj_TrackerMissionNotice mj_TrackerMemoryNotice" onClick={open}>
            <span className="mj_TrackerMissionNotice_flag" aria-hidden="true">
                🧠
            </span>
            {text}
        </button>
    );
}

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
    // A mission handed over to another person: its `closed` marker and each `left` marker say who.
    const handedTo = isObject(payload.handed_over) ? asString(payload.handed_over.to).trim() : "";

    let text: string;
    if (handedTo && (action === "closed" || action === "left")) {
        text = `Mission #${num} handed to ${handedTo}${title ? ` · ${title}` : ""}`;
    } else if (action === "created") {
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
