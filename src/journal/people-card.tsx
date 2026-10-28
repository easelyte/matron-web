/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Person-to-person consent cards: a contact request, a mission share, a session share and a room
 * with another person's agent (a "talk" when the other side picks the session). Each arrives as a
 * `permission_request` with one of those payload kinds, and the journal files a mirror tracker
 * item for the same ask, linked `matron://consent/<kind>/<id>`. That item's buttons are the only
 * way to answer: nothing reads a `prompt_reply` to these cards. So the card here is inert. It says
 * who is asking, which way and about what, and opens the mirror item.
 *
 * A hand-over (`mission_handover`) is the one kind answered on the card itself as well: the owner
 * picks which files cross, which a tap on the mirror's button cannot say, so the card carries the
 * brief, what will be copied, the file list and its own buttons (`POST /grants/:id/answer`).
 */

import React, { useEffect, useState } from "react";

import { JournalApiError } from "./api";
import { MarkdownBody } from "./markdown";
import { asNumber, asString, type EventPayload, type Grant, type GrantAnswer, type JournalEvent } from "./types";

export type PeopleCardKind = "contact_request" | "mission_share" | "mission_handover" | "session_share" | "person_room";

const PEOPLE_CARD_KINDS: ReadonlySet<string> = new Set<PeopleCardKind>([
    "contact_request",
    "mission_share",
    "mission_handover",
    "session_share",
    "person_room",
]);

/** The consent link segment and the payload field carrying its id, per card kind. */
const CONSENT_LINKS: Record<PeopleCardKind, { segment: string; idField: string }> = {
    contact_request: { segment: "contact", idField: "contact_id" },
    mission_share: { segment: "share", idField: "grant_id" },
    mission_handover: { segment: "handover", idField: "grant_id" },
    session_share: { segment: "session", idField: "session_share_id" },
    person_room: { segment: "room", idField: "room_link_id" },
};

export interface PeopleCard {
    kind: PeopleCardKind;
    direction: "in" | "out";
    /** A room the other person's side picks the session for. */
    talk: boolean;
    /** The other person. */
    person: string;
    /** Header label. */
    label: string;
    /** One line: who asks for what. */
    headline: string;
    /** What it is about: the room's topic, the mission's or the session's title; "" when none. */
    topic: string;
    /** The label of the topic row. */
    topicLabel: string;
    /** The asking agent's reason, when the card carries one. */
    why: string;
    /** The mirror item's `matron://consent/...` link; null when the payload lacks a usable id. */
    consentUrl: string | null;
    /** What a mission share lets the other person do ("can read", "can contribute"); "" else. */
    access: string;
    /** The hand-over's own part of the card; null on every other kind. */
    handover: HandoverDetails | null;
}

/** One file a hand-over would copy, as the owner's card lists it. */
export interface HandoverAttachment {
    mediaId: string;
    name: string;
    size: number | null;
    itemNum: number | null;
}

export interface HandoverDetails {
    grantId: string;
    subjectKind: "mission" | "project";
    brief: string;
    /** What will be copied: missions, milestones, items, comments and files. */
    counts: { missions: number; milestones: number; items: number; comments: number; attachments: number };
    /** The owner's card lists every file; the recipient's card carries only the count. */
    attachments: HandoverAttachment[];
    /** What the owner keeps on the copy afterwards: read access, or contributing to it. */
    keepLevel: "read" | "contribute";
}

export function isPeopleCardPayload(payload: EventPayload): boolean {
    return PEOPLE_CARD_KINDS.has(asString(payload.kind));
}

/** A string field of a nested payload object, trimmed; "" when absent. */
function fieldOf(value: unknown, field: string): string {
    return value && typeof value === "object" ? asString((value as EventPayload)[field]).trim() : "";
}

const nameOf = (value: unknown): string => fieldOf(value, "name");

const count = (value: unknown): number => {
    const n = asNumber(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** The share level as words; "" for a level the apps do not know. */
export function accessWords(level: unknown): string {
    if (level === "contribute") return "can contribute";
    if (level === "read") return "can read";
    return "";
}

function parseHandover(payload: EventPayload, direction: "in" | "out"): HandoverDetails {
    const subject = payload.subject && typeof payload.subject === "object" ? (payload.subject as EventPayload) : {};
    const preview = payload.preview && typeof payload.preview === "object" ? (payload.preview as EventPayload) : {};
    const listed = direction === "out" && Array.isArray(preview.attachments) ? preview.attachments : [];
    const attachments: HandoverAttachment[] = [];
    const seen = new Set<string>();
    for (const raw of listed) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as EventPayload;
        const mediaId = asString(entry.media_id);
        if (!mediaId || seen.has(mediaId)) continue;
        seen.add(mediaId);
        const size = asNumber(entry.size, -1);
        const itemNum = asNumber(entry.item_num);
        attachments.push({
            mediaId,
            name: asString(entry.name).trim() || "Untitled file",
            size: size >= 0 ? size : null,
            itemNum: Number.isInteger(itemNum) && itemNum > 0 ? itemNum : null,
        });
    }
    const files = Array.isArray(preview.attachments) ? attachments.length : count(preview.attachments);
    return {
        grantId: asString(payload.grant_id),
        subjectKind: asString(subject.kind) === "project" ? "project" : "mission",
        brief: asString(payload.brief).trim(),
        counts: {
            missions: count(preview.missions) || (asString(subject.kind) === "project" ? 0 : 1),
            milestones: count(preview.milestones),
            items: count(preview.items),
            comments: count(preview.comments),
            attachments: files,
        },
        attachments,
        keepLevel: asString(payload.keep_level) === "contribute" ? "contribute" : "read",
    };
}

/** The line under the owner's "keep contributing" switch, and the recipient's line about it. */
export function keepLevelText(keepLevel: "read" | "contribute", direction: "in" | "out", owner: string): string {
    if (direction === "out") {
        return keepLevel === "contribute"
            ? "You can keep adding milestones, items and comments to their copy."
            : "You keep read access to their copy.";
    }
    return keepLevel === "contribute"
        ? `${owner} stays on as a contributor; you can end that any time.`
        : `${owner} keeps read access.`;
}

function consentUrlOf(kind: PeopleCardKind, payload: EventPayload): string | null {
    const { segment, idField } = CONSENT_LINKS[kind];
    const id = asString(payload[idField]);
    // The journal's ids are plain tokens; anything that could change the link's shape is not one.
    return id && /^[^/?#\s]+$/.test(id) ? `matron://consent/${segment}/${id}` : null;
}

/** Reads a person-to-person card payload, or null when `payload` is not one. */
export function parsePeopleCard(payload: EventPayload): PeopleCard | null {
    const kind = asString(payload.kind);
    if (!PEOPLE_CARD_KINDS.has(kind)) return null;
    const k = kind as PeopleCardKind;
    const direction = asString(payload.direction) === "in" ? "in" : "out";
    const talk = k === "person_room" && payload.talk === true;
    let person = "";
    if (k === "contact_request") person = nameOf(payload.peer);
    else if (k === "mission_share" || k === "mission_handover")
        person = nameOf(direction === "out" ? payload.grantee : payload.owner);
    else person = nameOf(payload.person);
    const who = person || "Someone";
    const whose = person ? `${person}'s` : "another person's";
    const Whose = person ? `${person}'s` : "Another person's";
    const out = direction === "out";

    let label: string;
    let headline: string;
    let topic = "";
    let topicLabel = "About";
    let access = "";
    let handover: HandoverDetails | null = null;
    switch (k) {
        case "contact_request":
            label = "Contact request";
            headline = out
                ? `Your agent asks to add ${person || "someone"} as a contact`
                : `${who} wants to add you as a contact`;
            break;
        case "mission_share":
            label = "Mission share";
            headline = out
                ? `Your agent asks to share a mission with ${person || "someone"}`
                : `${who} wants to share a mission with you`;
            topic = fieldOf(payload.mission, "title");
            topicLabel = "Mission";
            access = accessWords(payload.level);
            break;
        case "mission_handover": {
            handover = parseHandover(payload, direction);
            const what = handover.subjectKind === "project" ? "a project" : "a mission";
            label = "Hand-over";
            headline = out
                ? `Your agent asks to hand ${what} over to ${person || "someone"}`
                : `${who} wants to hand ${what} over to you`;
            topic = fieldOf(payload.subject, "title");
            topicLabel = handover.subjectKind === "project" ? "Project" : "Mission";
            break;
        }
        case "session_share":
            label = "Session share";
            headline = `Your agent asks to let ${whose} agents reach this session`;
            topic = asString(payload.session_title).trim();
            topicLabel = "Session";
            break;
        default:
            label = talk ? "Talk request" : "Room with another person";
            if (talk) {
                headline = out ? `Your agent asks to talk with ${person || "someone"}` : `${Whose} agent wants to talk`;
            } else {
                headline = out
                    ? `Your agent asks to talk with ${whose} agent`
                    : `${Whose} agent wants to talk with your session`;
            }
            topic = asString(payload.topic).trim();
            break;
    }
    return {
        kind: k,
        direction,
        talk,
        person,
        label,
        headline,
        topic,
        topicLabel,
        why: asString(payload.justification).trim(),
        consentUrl: consentUrlOf(k, payload),
        access,
        handover,
    };
}

export function PromptPeopleGlyph(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="9" cy="8" r="3" />
            <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
            <path d="M16 5.5a3 3 0 0 1 0 5" />
            <path d="M17.5 14a5.5 5.5 0 0 1 3 5" />
        </svg>
    );
}

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

export const PEOPLE_CARD_HINT = "Answer in your tracker (For you)";

type MirrorLookup = { kind: "looking" } | { kind: "found"; num: number } | { kind: "missing" };

/** Where a hand-over stands, as this side's card says it. */
export type HandoverPhase = "open" | "sent" | "handed" | "declined" | "expired" | "withdrawn" | "ended";

/**
 * The phase of a hand-over grant from either side. A raise of an active share carries the ask in
 * `pending_level` / `pending_state`, and the row keeps its old level and state meanwhile.
 */
export function handoverPhase(grant: Grant): HandoverPhase {
    const raising = grant.pending_level === "owner";
    const state = raising ? grant.pending_state : grant.level === "owner" ? grant.state : null;
    // A raise that ended (declined, withdrawn, expired) clears its fields and leaves the old share.
    if (!state) return "ended";
    const out = grant.direction === "out";
    switch (state) {
        case "awaiting_owner":
            return out ? "open" : "ended";
        case "pending":
            return out ? "sent" : "open";
        case "active":
            return "handed";
        case "declined":
            return "declined";
        case "expired":
            return "expired";
        default:
            return "withdrawn";
    }
}

/** The outcome line for a phase; null while the card still waits for this side's answer. */
export function handoverOutcomeText(phase: HandoverPhase, direction: "in" | "out", person: string): string | null {
    const them = person || "them";
    switch (phase) {
        case "open":
            return null;
        case "sent":
            return `Approved — waiting for ${them} to accept`;
        case "handed":
            return direction === "out" ? `Handed over to ${them}` : "Accepted — it is now yours";
        case "declined":
            return "Declined";
        case "expired":
            return "Expired — nobody answered within 24 hours";
        case "withdrawn":
            return "Withdrawn";
        default:
            return "No longer open";
    }
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** "1 mission · 4 milestones · 6 items · 12 comments · 3 files", leaving out what is zero. */
export function handoverCountsText(details: HandoverDetails): string {
    const { missions, milestones, items, comments, attachments } = details.counts;
    const parts: string[] = [];
    if (missions > 0) parts.push(plural(missions, "mission"));
    if (milestones > 0) parts.push(plural(milestones, "milestone"));
    if (items > 0) parts.push(plural(items, "item"));
    if (comments > 0) parts.push(plural(comments, "comment"));
    if (attachments > 0) parts.push(plural(attachments, "file"));
    return parts.length ? parts.join(" · ") : "Nothing but the brief";
}

function formatSize(bytes: number | null): string {
    if (bytes === null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const HANDOVER_REPLY_HINT =
    "To say why, or to ask for changes, reply on the item: your reply goes to the agent.";

type AnswerState =
    { kind: "idle" } | { kind: "sending"; decision: GrantAnswer["decision"] } | { kind: "failed"; message: string };

/**
 * A hand-over's own part of the card: the brief, what will cross, the files (ticked boxes on the
 * owner's side, all ticked to start) and the answer buttons, or how it was answered.
 */
function HandoverSection({
    card,
    details,
    loadGrant,
    answerGrant,
}: {
    card: PeopleCard;
    details: HandoverDetails;
    loadGrant?: (grantId: string) => Promise<Grant>;
    answerGrant?: (grantId: string, answer: GrantAnswer) => Promise<Grant>;
}): React.ReactElement {
    const out = card.direction === "out";
    const { grantId } = details;
    // Until the journal says otherwise the card is open; a card with nothing to read it from stays so.
    const [phase, setPhase] = useState<HandoverPhase | null>(() => (grantId && loadGrant ? null : "open"));
    const [answer, setAnswer] = useState<AnswerState>({ kind: "idle" });
    const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
    // The owner's say on what they keep: the asking agent's choice to start, theirs to change.
    const [keepContributing, setKeepContributing] = useState(() => details.keepLevel === "contribute");
    // A newer payload for the same card starts the switch again from what it asks.
    useEffect(() => {
        setKeepContributing(details.keepLevel === "contribute");
    }, [details.keepLevel]);

    // The card may have been answered on another device, or on the mirror item: ask the journal.
    useEffect(() => {
        if (!grantId || !loadGrant) return;
        let live = true;
        loadGrant(grantId).then(
            (grant) => {
                if (live) setPhase(handoverPhase(grant));
            },
            (error: unknown) => {
                // A grant the journal no longer shows is over; an unreachable journal leaves the
                // buttons up, and the answer itself says if the card was already answered.
                if (live) setPhase(error instanceof JournalApiError && error.status === 404 ? "ended" : "open");
            },
        );
        return () => {
            live = false;
        };
        // loadGrant is a fresh closure each render; the lookup depends only on the grant.
    }, [grantId]);

    const toggle = (mediaId: string): void => {
        setExcluded((previous) => {
            const next = new Set(previous);
            if (next.has(mediaId)) next.delete(mediaId);
            else next.add(mediaId);
            return next;
        });
    };

    const send = async (decision: GrantAnswer["decision"]): Promise<void> => {
        if (!answerGrant || !grantId || answer.kind === "sending") return;
        setAnswer({ kind: "sending", decision });
        const body: GrantAnswer =
            decision === "approve" && out
                ? {
                      decision,
                      exclude_media: details.attachments
                          .filter((file) => excluded.has(file.mediaId))
                          .map((file) => file.mediaId),
                      keep_level: keepContributing ? "contribute" : "read",
                  }
                : { decision };
        try {
            const grant = await answerGrant(grantId, body);
            setPhase(handoverPhase(grant));
            setAnswer({ kind: "idle" });
        } catch (error) {
            if (error instanceof JournalApiError && (error.status === 409 || error.status === 404)) {
                const blockedBy = asString(error.body?.blocked_by);
                setAnswer({
                    kind: "failed",
                    message:
                        error.status === 404
                            ? "This hand-over is no longer open."
                            : blockedBy === "expired"
                              ? "This hand-over expired."
                              : blockedBy && blockedBy !== "pending"
                                ? `It can no longer be handed over (${blockedBy.replace(/_/g, " ")}).`
                                : "Already answered.",
                });
                if (error.status === 404) {
                    setPhase("ended");
                } else if (loadGrant) {
                    // Answered elsewhere: no buttons until the journal says where it stands, so
                    // nothing can post a second answer meanwhile. Only a 404 ends the card; an
                    // unreachable journal leaves it open, as on mount.
                    setPhase(null);
                    loadGrant(grantId).then(
                        (grant) => setPhase(handoverPhase(grant)),
                        (reloadError: unknown) =>
                            setPhase(
                                reloadError instanceof JournalApiError && reloadError.status === 404 ? "ended" : "open",
                            ),
                    );
                } else {
                    setPhase("ended");
                }
            } else {
                setAnswer({ kind: "failed", message: "Not sent — check the connection and try again." });
            }
        }
    };

    const outcome = phase ? handoverOutcomeText(phase, card.direction, card.person) : null;
    const answerable = !!answerGrant && !!grantId && phase !== null && phase === "open";
    const sending = answer.kind === "sending";
    const listFiles = out && details.attachments.length > 0;
    const approveLabel = out ? "Approve" : "Accept";

    return (
        <>
            {details.brief ? (
                <div className="mj_HandoverBrief">
                    <span className="mj_SpawnDetail_label">Brief</span>
                    <div className="mj_HandoverBrief_body">
                        <MarkdownBody text={details.brief} label={`handover-${grantId}`} />
                    </div>
                </div>
            ) : null}
            <div className="mj_SpawnDetails">
                <div className="mj_SpawnDetail mj_HandoverCounts">
                    <span className="mj_SpawnDetail_label">{out ? "Copies" : "Arrives"}</span>
                    <span className="mj_SpawnDetail_value">{handoverCountsText(details)}</span>
                </div>
            </div>
            {listFiles ? (
                <fieldset className="mj_HandoverFiles" disabled={!answerable || sending}>
                    <legend className="mj_SpawnDetail_label">Files to send</legend>
                    {details.attachments.map((file) => (
                        <label key={file.mediaId} className="mj_HandoverFile">
                            <input
                                type="checkbox"
                                checked={!excluded.has(file.mediaId)}
                                onChange={() => toggle(file.mediaId)}
                            />
                            <span className="mj_HandoverFile_name">{file.name}</span>
                            <span className="mj_HandoverFile_meta">
                                {[file.itemNum !== null ? `#${file.itemNum}` : "", formatSize(file.size)]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                        </label>
                    ))}
                </fieldset>
            ) : null}
            {out ? (
                <div className="mj_HandoverKeep">
                    <label className="mj_HandoverKeep_toggle">
                        <input
                            type="checkbox"
                            role="switch"
                            checked={keepContributing}
                            disabled={!answerable || sending}
                            onChange={() => setKeepContributing((on) => !on)}
                        />
                        <span>Keep contributing after the hand-over</span>
                    </label>
                    <p className="mj_HandoverKeep_hint">
                        {keepLevelText(keepContributing ? "contribute" : "read", "out", card.person)}
                    </p>
                </div>
            ) : (
                <p className="mj_HandoverKeep_hint">{keepLevelText(details.keepLevel, "in", card.person)}</p>
            )}
            {answerable ? (
                <div className="mj_PromptOptions mj_HandoverOptions">
                    <button type="button" disabled={sending} onClick={() => void send("decline")}>
                        Decline
                    </button>
                    <button
                        type="button"
                        className="mj_PromptOption_affirmative"
                        disabled={sending}
                        onClick={() => void send("approve")}
                    >
                        {approveLabel}
                    </button>
                </div>
            ) : null}
            {sending ? (
                <div className="mj_PromptResolved mj_PromptResolved_pending">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Muted">Sending…</span>
                </div>
            ) : null}
            {answer.kind === "failed" ? (
                <div className="mj_PromptResolved mj_PromptResolved_expired" role="status">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">{answer.message}</span>
                </div>
            ) : null}
            {outcome ? (
                <div
                    className={`mj_PromptResolved mj_HandoverOutcome ${
                        phase === "sent" || phase === "handed"
                            ? "mj_PromptResolved_approved"
                            : "mj_PromptResolved_declined"
                    }`}
                >
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">{outcome}</span>
                </div>
            ) : null}
            {out && (answerable || phase === "sent") ? <p className="mj_HandoverHint">{HANDOVER_REPLY_HINT}</p> : null}
        </>
    );
}

/**
 * The inert card. `findItem` resolves the mirror item's number (null when it can't be found);
 * `onOpenItem` opens it. Without a mirror the card says where to answer instead. A hand-over card
 * also reads its grant (`loadGrant`) and answers it (`answerGrant`).
 */
export function PeopleCardView({
    event,
    card,
    findItem,
    onOpenItem,
    loadGrant,
    answerGrant,
}: {
    event: JournalEvent;
    card: PeopleCard;
    findItem: (convoId: string, consentUrl: string) => Promise<number | null>;
    onOpenItem: (num: number) => void;
    loadGrant?: (grantId: string) => Promise<Grant>;
    answerGrant?: (grantId: string, answer: GrantAnswer) => Promise<Grant>;
}): React.ReactElement {
    const { consentUrl } = card;
    const [mirror, setMirror] = useState<MirrorLookup>(() => (consentUrl ? { kind: "looking" } : { kind: "missing" }));
    useEffect(() => {
        if (!consentUrl) {
            setMirror({ kind: "missing" });
            return;
        }
        let live = true;
        setMirror({ kind: "looking" });
        findItem(event.convo_id, consentUrl).then(
            (num) => {
                if (live) setMirror(num === null ? { kind: "missing" } : { kind: "found", num });
            },
            () => {
                if (live) setMirror({ kind: "missing" });
            },
        );
        return () => {
            live = false;
        };
        // findItem is a fresh closure each render; the lookup depends only on what it looks up.
    }, [event.convo_id, consentUrl]);

    const fields: Array<[string, string, string]> = [];
    if (card.topic) fields.push(["topic", card.topicLabel, card.topic]);
    if (card.access) fields.push(["access", "Access", card.access]);
    if (card.why) fields.push(["why", "Why", card.why]);

    return (
        <div className={`mj_PromptCard mj_PeopleCard mj_PeopleCard_${card.direction}`}>
            <div className="mj_PromptHeader">
                <span className="mj_PromptLabel">{card.label}</span>
                <time className="mj_PromptTime" dateTime={new Date(event.ts).toISOString()}>
                    {formatTime(event.ts)}
                </time>
            </div>
            <div className="mj_PromptBody">
                <span className="mj_PromptGlyph" aria-hidden="true">
                    <PromptPeopleGlyph />
                </span>
                <span className="mj_PromptQuestion">{card.headline}</span>
            </div>
            {fields.length > 0 && (
                <div className="mj_SpawnDetails">
                    {fields.map(([key, label, value]) => (
                        <div key={key} className={`mj_SpawnDetail mj_PeopleDetail_${key}`}>
                            <span className="mj_SpawnDetail_label">{label}</span>
                            <span className="mj_SpawnDetail_value">{value}</span>
                        </div>
                    ))}
                </div>
            )}
            {card.handover ? (
                <HandoverSection card={card} details={card.handover} loadGrant={loadGrant} answerGrant={answerGrant} />
            ) : null}
            {card.handover && mirror.kind !== "found" ? null : (
                <div className="mj_PromptOptions mj_PeopleCard_footer">
                    {mirror.kind === "found" ? (
                        <button type="button" className="mj_PeopleCard_open" onClick={() => onOpenItem(mirror.num)}>
                            {card.handover ? "Open the item" : "Answer in the tracker"}
                        </button>
                    ) : (
                        <span className="mj_PeopleCard_hint">{PEOPLE_CARD_HINT}</span>
                    )}
                </div>
            )}
        </div>
    );
}
