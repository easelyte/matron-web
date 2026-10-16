/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Item detail — header (kind glyph, #num · kind, status pill), the context block (the item's
 * mission and the conversation that owns it — the one that filed it — each a jump), the item body,
 * its comment thread (status rows rendered as centered muted lines from the structured
 * transition, with any closing/reopening note beneath as an ordinary comment card; a comment that
 * asks a follow-up question carries its own one-tap answer buttons; an open item carries its own
 * item-level buttons under the body, such as a notice's Seen), a pinned reply
 * composer, and a resolve/reopen menu. All mutations go through the client; the store refetch keeps
 * the thread live.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentSpawnCard, type AgentSpawnDecision, isAnswerableAgentSpawn } from "../agent-spawn-card";
import { JOURNAL_ATTACHMENTS_MAX } from "../api";
import { type MatronJournalClient, type TrackerCommentOutcome, voiceNoteFile } from "../client";
import { stopSpawnedSession } from "../coordinator-consent";
import { filesDeepLinkHash, handleFilesLinkClick } from "../files-link";
import { ChevronLeftIcon, CloseIcon, KebabIcon, PlusCircleIcon, SendIcon } from "../icons";
import { parseOwnTrackerUrl } from "../link-path";
import { parseTrackerHref } from "../markdown";
import { MediaViewer, MediaViewerContext, type MediaViewerContextValue } from "../media-viewer";
import {
    asString,
    type SpawnConsentRows,
    spawnOutcomeKind,
    spawnOutcomeSnippet,
    type TrackerAttachment,
    type TrackerComment,
    type TrackerCommentWrite,
    type TrackerItem,
    type TrackerLink,
    type TrackerLinkHandler,
    type TrackerResolution,
} from "../types";
import { useVoiceRecorder, VoiceErrorBanner, VoiceMicButton, VoiceRecordingBar } from "../voice-recorder";
import {
    availableResolutions,
    formatRelativeTime,
    humanizeSize,
    isConsentItem,
    isRouteElsewhere,
    itemStatusText,
    kindLabel,
    needsUser,
    offeredItemActions,
    resolveActionLabel,
    ROUTE_ELSEWHERE_LABEL,
    spawnConsentRequestId,
    statusRowText,
} from "./format";
import { CommentBubbleGlyph, MissionGlyph, TrackerGlyph } from "./glyphs";
import { useHandoverCaption } from "./handover";
import { type CommentAuthor, commentAuthor, itemMission, itemMissionText, itemOriginLabel } from "./item-context";
import { buildTrackerMediaCorpus, InlineBody } from "./ItemAttachments";
import { useWorkingLabel, WorkingIndicator } from "./working";

/** Answers one of a comment's buttons; resolves once the tap is sent (or has failed). */
type TapAction = (comment: TrackerComment, label: string) => Promise<void>;

/**
 * The one-tap answers an agent offered with a follow-up question, under the comment that asks. The
 * user's latest tap is marked (`chosen_action`); while the item is open another button can still be
 * tapped, and the journal keeps the latest. On a closed item the row is the record of what was
 * offered and chosen, so the buttons are inert. A journal that predates comment actions sends no
 * `actions` and nothing is drawn.
 */
function CommentActions({
    comment,
    disabled,
    onTap,
}: {
    comment: TrackerComment;
    disabled: boolean;
    onTap: TapAction;
}): React.ReactElement | null {
    const actions = comment.actions ?? [];
    if (actions.length === 0) return null;
    return (
        <div className="mj_TrackerActions" role="group" aria-label="Quick replies">
            {actions.map((label) => {
                const chosen = comment.chosen_action === label;
                return (
                    <button
                        key={label}
                        type="button"
                        className={`mj_TrackerAction${chosen ? " mj_TrackerAction_chosen" : ""}`}
                        aria-pressed={chosen}
                        disabled={disabled}
                        onClick={() => void onTap(comment, label)}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * The one-tap answers an agent filed with the item itself, under its body. Tapping one answers
 * exactly as typing its label would. The chosen one is filled and does nothing when tapped again;
 * the others stay tappable so the user can change their mind. Every button is disabled while the
 * item has a write in flight, since a tap racing a close would reopen the item it closes.
 */
function ItemActions({
    actions,
    chosen,
    disabled,
    onTap,
}: {
    actions: string[];
    chosen: string | null;
    disabled: boolean;
    onTap: (label: string) => void;
}): React.ReactElement | null {
    if (actions.length === 0) return null;
    return (
        <div className="mj_TrackerActions mj_TrackerItemActions" role="group" aria-label="Quick replies">
            {actions.map((label) => {
                const isChosen = label === chosen;
                return (
                    <button
                        key={label}
                        type="button"
                        className={`mj_TrackerAction${isChosen ? " mj_TrackerAction_chosen" : ""}`}
                        aria-pressed={isChosen}
                        disabled={disabled}
                        onClick={isChosen ? undefined : () => onTap(label)}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * The agent-spawn ask a consent item stands for, read from the conversation that asked and read
 * again whenever that conversation moves (a card arriving, its outcome landing). Undefined until
 * the first read for this ask finishes, and for an item that is not a spawn consent item.
 */
function useSpawnConsentRows(
    client: MatronJournalClient,
    convoId: string,
    requestId: string | null,
    convoSeq: number | undefined,
): SpawnConsentRows | undefined {
    const [read, setRead] = useState<{ key: string; rows: SpawnConsentRows } | null>(null);
    const key = requestId ? `${convoId}\n${requestId}` : "";
    useEffect(() => {
        if (!requestId) return;
        let live = true;
        void client.spawnConsentRows(convoId, requestId).then((rows) => {
            if (live) setRead({ key, rows });
        });
        return (): void => {
            live = false;
        };
    }, [client, convoId, requestId, convoSeq, key]);
    return read && read.key === key ? read.rows : undefined;
}

/**
 * The spawn consent card for a consent item, between the item's links and its body so the answer
 * sits near the top. The full card when its own event is in this browser's store: what the user
 * approves is then exactly what the timeline card shows, through the same answer call. Without it
 * there is nothing to approve: the id in the item's link is agent-written and could name an ask the
 * user has never seen, so the placeholder offers no buttons. It says the card has not arrived while
 * the ask may still be waiting, or how the ask ended when its outcome is here (the latest history
 * page can hold the outcome but not the older card) or the item is closed. A closed item settles the
 * card: the journal closes it the moment the ask is answered.
 */
function SpawnConsentCard({
    rows,
    closed,
    onAnswer,
    onOpenRoom,
    onStopSession,
}: {
    rows: SpawnConsentRows;
    closed: boolean;
    onAnswer: (decision: AgentSpawnDecision, signal?: AbortSignal) => Promise<void>;
    onOpenRoom: (roomId: string) => void;
    onStopSession: (convoId: string) => void;
}): React.ReactElement {
    const { request, outcome, coordinatorDecision } = rows;
    if (request) {
        const answerable = isAnswerableAgentSpawn(request.payload);
        return (
            <div className="mj_TrackerConsent">
                <AgentSpawnCard
                    event={request}
                    outcome={outcome}
                    coordinatorDecision={coordinatorDecision}
                    isReadOnly={!answerable}
                    settled={closed}
                    onAnswer={answerable ? onAnswer : undefined}
                    onOpen={onOpenRoom}
                    onStopSession={onStopSession}
                />
            </div>
        );
    }
    const roomId = outcome && spawnOutcomeKind(outcome) === "started" ? asString(outcome.room_id) : "";
    return (
        <div className="mj_TrackerConsent">
            <div className="mj_PromptCard mj_PromptCard_spawn mj_TrackerConsent_waiting">
                <div className="mj_PromptHeader">
                    <span className="mj_PromptLabel">Agent spawn request</span>
                </div>
                <p className="mj_TrackerConsent_note">
                    {outcome
                        ? spawnOutcomeSnippet(outcome)
                        : closed
                          ? "This request is no longer waiting for an answer."
                          : "The request card hasn't reached this browser yet. It can be approved once it arrives, or from the conversation it was asked in."}
                </p>
                {roomId ? (
                    <div className="mj_PromptResolved">
                        <button type="button" className="mj_SpawnOpenButton" onClick={() => onOpenRoom(roomId)}>
                            Open
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/**
 * An ordinary comment card: author, relative time, then the markdown body (links live) with the
 * comment's own attachments placed inline where it refers to them and the rest after it.
 */
function CommentCard({
    client,
    comment,
    author,
    onOpenConvo,
    onTrackerLink,
    actionsDisabled,
    onTap,
}: {
    client: MatronJournalClient;
    comment: TrackerComment;
    author: CommentAuthor | null;
    onOpenConvo: (convoId: string) => void;
    onTrackerLink: TrackerLinkHandler;
    actionsDisabled: boolean;
    onTap: TapAction;
}): React.ReactElement {
    // An agent's comment is headed with the box that wrote it and, when the journal knows it, the
    // conversation (which opens on click); "Agent" only when neither is known.
    const who = comment.author === "user" ? "You" : author?.box || (author?.conversation ? null : "Agent");
    const convoId = author?.convoId;
    return (
        <div className={`mj_TrackerComment mj_TrackerComment_${comment.author}`}>
            <div className="mj_TrackerComment_head">
                {who ? <span className="mj_TrackerComment_author">{who}</span> : null}
                {author?.conversation && convoId ? (
                    <button
                        type="button"
                        className="mj_TrackerComment_convo"
                        aria-label={`Open the conversation ${author.conversation}`}
                        title={author.conversation}
                        onClick={() => onOpenConvo(convoId)}
                    >
                        {author.conversation}
                    </button>
                ) : null}
                <span className="mj_TrackerComment_time">{formatRelativeTime(comment.created_at)}</span>
            </div>
            <InlineBody
                client={client}
                body={comment.body}
                attachments={comment.attachments ?? []}
                label={`comment-${comment.id}`}
                onTrackerLink={onTrackerLink}
            />
            <CommentActions comment={comment} disabled={actionsDisabled} onTap={onTap} />
        </div>
    );
}

/**
 * One thread entry. A `status` comment is the transition as a small centred line ("Agent closed this
 * as done"); the note the closer/reopener wrote travels as that comment's body and, when present,
 * renders beneath the line as an ordinary comment card so it reads (and links) like any comment.
 */
function CommentRow({
    client,
    comment,
    author,
    onOpenConvo,
    onTrackerLink,
    actionsDisabled,
    onTap,
}: {
    client: MatronJournalClient;
    comment: TrackerComment;
    author: CommentAuthor | null;
    onOpenConvo: (convoId: string) => void;
    onTrackerLink: TrackerLinkHandler;
    actionsDisabled: boolean;
    onTap: TapAction;
}): React.ReactElement {
    const card = (
        <CommentCard
            client={client}
            comment={comment}
            author={author}
            onOpenConvo={onOpenConvo}
            onTrackerLink={onTrackerLink}
            actionsDisabled={actionsDisabled}
            onTap={onTap}
        />
    );
    if (comment.kind === "status") {
        const text = statusRowText(comment);
        const hasNote = comment.body.trim().length > 0;
        if (!text && !hasNote) {
            return <div className="mj_TrackerStatusRow" aria-hidden="true" />;
        }
        return (
            <>
                {text ? <div className="mj_TrackerStatusRow">{text}</div> : null}
                {hasNote ? card : null}
            </>
        );
    }
    return card;
}

/**
 * One `item.links[]` chip. The protocol lets a link carry any URL, including the in-app
 * `matron://` scheme, so this applies the SAME guard the markdown renderer does (parseTrackerHref):
 * a valid `matron://item/<N>` / `matron://mission/<N>` opens it in-app, as does an https
 * `/u/<name>/<n>` link to this deployment (parseOwnTrackerUrl); a Files deep link opens the pane in
 * this window; other http(s) opens in a new tab; anything else (an unknown scheme, a malformed
 * tracker link, javascript:) renders as inert text — a custom or unsafe scheme is never handed to
 * the browser as a live href.
 */
function LinkChip({
    link,
    onTrackerLink,
}: {
    link: TrackerLink;
    onTrackerLink: TrackerLinkHandler;
}): React.ReactElement {
    const label = link.title?.trim() || link.url;
    const tracker = parseTrackerHref(link.url);
    if (!tracker && parseOwnTrackerUrl(link.url)) {
        return (
            <a
                className="mj_TrackerLinkChip mj_TrackerLink"
                href={link.url}
                onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onTrackerLink("link", link.url);
                }}
            >
                {label}
            </a>
        );
    }
    if (tracker) {
        return (
            <a
                className="mj_TrackerLinkChip mj_TrackerLink"
                href={link.url}
                onClick={(event) => {
                    event.preventDefault();
                    onTrackerLink(tracker.kind, tracker.num);
                }}
            >
                {label}
            </a>
        );
    }
    const filesHash = filesDeepLinkHash(link.url);
    if (filesHash) {
        return (
            <a
                className="mj_TrackerLinkChip"
                href={link.url}
                onClick={(clickEvent) => handleFilesLinkClick(clickEvent, filesHash)}
            >
                {label}
            </a>
        );
    }
    if (!/^https?:\/\//i.test(link.url)) {
        return (
            <span className="mj_TrackerLinkChip mj_TrackerLinkChip_inert" title={link.url}>
                {label}
            </span>
        );
    }
    return (
        <a className="mj_TrackerLinkChip" href={link.url} target="_blank" rel="noreferrer noopener">
            {label}
        </a>
    );
}

/** A file waiting in the reply box's tray; `preview` is an object URL for an image's thumbnail. */
interface StagedFile {
    id: string;
    file: File;
    preview?: string;
}

function stageFile(file: File): StagedFile {
    const preview =
        file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined;
    return { id: crypto.randomUUID(), file, preview };
}

function releaseStaged(staged: StagedFile): void {
    if (staged.preview && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(staged.preview);
}

/** The staged files above the reply box: a thumbnail or a name chip each, with a remove button.
 *  `locked` while a send is taking them, so a file can't leave the tray after its comment is planned. */
function StagedTray({
    staged,
    locked,
    onRemove,
}: {
    staged: StagedFile[];
    locked: boolean;
    onRemove: (id: string) => void;
}): React.ReactElement | null {
    if (staged.length === 0) return null;
    return (
        <div className="mj_TrackerComposer_tray" role="list" aria-label="Attachments to send">
            {staged.map(({ id, file, preview }) => (
                <span key={id} className="mj_TrackerComposer_chip" role="listitem" title={file.name}>
                    {/* Only ever an object URL minted for the file; anything else draws no thumbnail. */}
                    {preview?.startsWith("blob:") ? (
                        <img className="mj_TrackerComposer_thumb" src={preview} alt="" />
                    ) : null}
                    <span className="mj_TrackerComposer_chipName">{file.name}</span>
                    <span className="mj_TrackerAttachmentChip_size">{humanizeSize(file.size)}</span>
                    <button
                        type="button"
                        className="mj_TrackerComposer_chipRemove"
                        aria-label={`Remove ${file.name}`}
                        disabled={locked}
                        onClick={() => onRemove(id)}
                    >
                        <CloseIcon />
                    </button>
                </span>
            ))}
        </div>
    );
}

/** The idempotency-key slot for a draft: its text plus its staged files, in order. */
function draftOf(body: string, files: StagedFile[]): string {
    return [body, ...files.map((entry) => entry.id)].join("\n");
}

/** A comment that went out from the tray and failed: its text and its files' staged ids. */
interface AttemptedComment {
    body: string;
    ids: string[];
}

/** One comment a send posts: `retry` when it is a failed comment going again as it was,
 *  `carriesText` when it is the one that takes the box's text. */
interface PlannedComment {
    body: string;
    files: StagedFile[];
    retry: boolean;
    carriesText: boolean;
}

/**
 * The comments a reply goes out as, in tray order.
 *
 * A run of files that already went out as one comment and failed (`attempted`) may have landed, so
 * it goes again exactly as it was — its own text and files, hence the same idempotency key — and a
 * copy that did land is not posted twice. The files around it are split into comments of at most
 * JOURNAL_ATTACHMENTS_MAX. The box's text goes on one comment only: an attempted comment that
 * already carries that same text, else the first new comment, else a comment of its own at the end.
 */
function planReply(
    text: string,
    files: readonly StagedFile[],
    attempted: readonly AttemptedComment[],
): PlannedComment[] {
    const planned: PlannedComment[] = [];
    let run: StagedFile[] = [];
    const flushRun = (): void => {
        for (let start = 0; start < run.length; start += JOURNAL_ATTACHMENTS_MAX) {
            planned.push({
                body: "",
                files: run.slice(start, start + JOURNAL_ATTACHMENTS_MAX),
                retry: false,
                carriesText: false,
            });
        }
        run = [];
    };
    let index = 0;
    while (index < files.length) {
        const group = attempted.find(
            (comment) => comment.ids.length > 0 && comment.ids.every((id, offset) => files[index + offset]?.id === id),
        );
        if (group) {
            flushRun();
            const groupFiles = files.slice(index, index + group.ids.length);
            planned.push({ body: group.body, files: groupFiles, retry: true, carriesText: false });
            index += group.ids.length;
        } else {
            run.push(files[index]);
            index += 1;
        }
    }
    flushRun();
    if (!text) return planned.length > 0 ? planned : [{ body: "", files: [], retry: false, carriesText: false }];
    const sameText = planned.find((comment) => comment.retry && comment.body === text);
    if (sameText) {
        sameText.carriesText = true;
        return planned;
    }
    const fresh = planned.find((comment) => !comment.retry);
    if (fresh) {
        fresh.body = text;
        fresh.carriesText = true;
        return planned;
    }
    return [...planned, { body: text, files: [], retry: false, carriesText: true }];
}

/**
 * A typed reply the journal did not take, shown beside the box until the next send or a discard.
 * The text and the files that did not go stay in the box, so Send retries exactly them.
 */
interface ReplyFailure {
    /** Why, in the journal's words when it gave any. */
    reason: string;
    /** Files that went out in earlier comments of the same reply before this one failed. */
    sentFiles: number;
    /** Files of the reply that did not go. */
    unsentFiles: number;
}

/** The voice error line for a note that did not go: the journal's reason when it gave one. */
function voiceFailureMessage(outcome: TrackerCommentOutcome): string {
    const reason = outcome.ok ? undefined : outcome.reason;
    return reason ? `Couldn't send the voice note — ${reason}` : "Couldn't send the voice note — try again.";
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "Reply not sent." or, after earlier comments of the reply went, which of its files did not. */
function replyFailureHeadline(failure: ReplyFailure): string {
    if (failure.sentFiles === 0) return "Reply not sent.";
    const total = failure.sentFiles + failure.unsentFiles;
    return `${failure.sentFiles} of ${plural(total, "file")} sent; ${failure.unsentFiles} not sent.`;
}

/**
 * A voice note that had to go alone (the tray was full, or a typed send held the draft) and failed.
 * It is held beside the box, not put in the tray, so it never displaces a staged file and its retry
 * is exactly the same comment: the same idempotency key and the same uploaded blob ref.
 */
interface HeldVoiceNote {
    entry: StagedFile;
    key: string;
}

export function ItemDetail({
    item,
    comments,
    client,
    onBack,
}: {
    item: TrackerItem;
    comments: TrackerComment[];
    client: MatronJournalClient;
    onBack: () => void;
}): React.ReactElement {
    const [reply, setReply] = useState("");
    const [staged, setStaged] = useState<StagedFile[]>([]);
    const [busy, setBusy] = useState(false);
    const [replyFailure, setReplyFailure] = useState<ReplyFailure | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    // The voice-note path reads the draft and tray from a callback that outlives renders.
    const replyRef = useRef(reply);
    replyRef.current = reply;
    const stagedRef = useRef(staged);
    stagedRef.current = staged;
    const busyRef = useRef(busy);
    busyRef.current = busy;
    const [heldVoice, setHeldVoice] = useState<HeldVoiceNote[]>([]);
    const heldVoiceRef = useRef(heldVoice);
    heldVoiceRef.current = heldVoice;
    const fileInput = useRef<HTMLInputElement>(null);
    // Stable idempotency keys bound to a draft — its TEXT and its staged files (draftOf). A failed
    // send keeps the draft, so a retry of the SAME draft must reuse its key — otherwise a comment
    // that committed before its response was lost would be duplicated on retry (F1). A changed
    // draft is a different comment and gets its own key; a confirmed send drops the key. A failed
    // voice note that took the draft registers its key here under the draft it puts back, so
    // pressing Send on that unchanged draft replays the same comment under the same key.
    const draftKeysRef = useRef<Map<string, string>>(new Map());
    const keyFor = (draft: string): string => {
        let key = draftKeysRef.current.get(draft);
        if (!key) {
            key = crypto.randomUUID();
            draftKeysRef.current.set(draft, key);
        }
        return key;
    };
    // Each staged file's upload, kept until it is sent: a retry posts the same blob refs (so the
    // retried payload matches the key) and does not upload the file again.
    const uploadsRef = useRef<Map<string, TrackerAttachment>>(new Map());
    // Each comment that went out from the tray and failed — its text and its files' staged ids — so
    // Send goes out with that same comment again rather than a different one (planReply). One is
    // dropped once it is sent, or when one of its files is removed (it is a new comment then).
    const attemptedRef = useRef<AttemptedComment[]>([]);
    const forgetAttempted = (ids: readonly string[]): void => {
        attemptedRef.current = attemptedRef.current.filter((group) => !group.ids.some((id) => ids.includes(id)));
    };
    const rememberAttempted = (body: string, files: readonly StagedFile[]): void => {
        const ids = files.map((entry) => entry.id);
        forgetAttempted(ids);
        if (ids.length > 0) attemptedRef.current = [...attemptedRef.current, { body, ids }];
    };

    // Read state: an open item counts as seen, with its comments up to the newest one rendered, and
    // is reported again whenever a newer comment renders.
    const newestCommentAt = comments.reduce((newest, comment) => Math.max(newest, comment.created_at), 0);
    useEffect(() => {
        client.seen.setItemOnScreen(item.id, newestCommentAt);
    }, [client, item.id, newestCommentAt]);
    useEffect(() => () => client.seen.removeItem(item.id), [client, item.id]);

    // The tray's thumbnails are object URLs; let them go with the box.
    useEffect(
        () => () => {
            stagedRef.current.forEach(releaseStaged);
            heldVoiceRef.current.forEach((held) => releaseStaged(held.entry));
        },
        [],
    );

    // Every file is kept: a reply with more than the journal takes on one comment goes as several.
    // Any edit of the draft (text, a file added or removed) makes it a different reply from the one
    // a failure notice describes, so the notice goes; the next failed send raises a fresh one.
    const editReply = (text: string): void => {
        setReply(text);
        setReplyFailure(null);
    };
    const addFiles = (files: File[]): void => {
        if (files.length === 0) return;
        setStaged((current) => [...current, ...files.map(stageFile)]);
        setReplyFailure(null);
    };
    const removeStaged = (id: string): void => {
        forgetAttempted([id]);
        setReplyFailure(null);
        setStaged((current) => {
            const gone = current.find((entry) => entry.id === id);
            if (gone) releaseStaged(gone);
            return current.filter((entry) => entry.id !== id);
        });
        uploadsRef.current.delete(id);
    };
    // The files went out with a comment: drop their thumbnails and remembered uploads.
    const forgetSent = (sent: StagedFile[]): void => {
        forgetAttempted(sent.map((entry) => entry.id));
        for (const entry of sent) {
            releaseStaged(entry);
            uploadsRef.current.delete(entry.id);
        }
    };

    /** Uploads what is not uploaded yet; null when any upload failed (the client has said why). */
    const uploadStaged = async (files: StagedFile[]): Promise<TrackerAttachment[] | null> => {
        const attachments = await Promise.all(
            files.map(async (entry) => {
                const known = uploadsRef.current.get(entry.id);
                if (known) return known;
                const attachment = await client.uploadTrackerAttachment(entry.file);
                if (attachment) uploadsRef.current.set(entry.id, attachment);
                return attachment;
            }),
        );
        return attachments.every((attachment) => attachment !== null) ? (attachments as TrackerAttachment[]) : null;
    };

    /** Uploads (or reuses) the files and posts one comment. An upload failure has already been
     *  reported by the client, naming the file. */
    const postComment = async (body: string, files: StagedFile[], key: string): Promise<TrackerCommentOutcome> => {
        const attachments = await uploadStaged(files);
        if (!attachments) return { ok: false, reason: "A file did not upload." };
        const write: TrackerCommentWrite = body ? { body } : {};
        if (attachments.length > 0) write.attachments = attachments;
        return client.postTrackerComment(item.num, write, key);
    };

    const snapshot = client.getSnapshot();
    const selectedConvoId = snapshot.selectedConversationId;
    // Keyed on the conversation list (replaced on a rename or load), so the line follows it live.
    const conversations = snapshot.conversations;

    // A spawn consent item carries the ask's card, answered here as in the conversation.
    const spawnRequestId = spawnConsentRequestId(item);
    const originSeq = conversations.find((conversation) => conversation.id === item.origin_convo_id)?.last_seq;
    const spawnRows = useSpawnConsentRows(client, item.origin_convo_id, spawnRequestId, originSeq);
    const answerSpawn = async (decision: AgentSpawnDecision, signal?: AbortSignal): Promise<void> => {
        if (spawnRequestId) await client.answerSpawnConsent(item.num, spawnRequestId, decision, signal);
    };
    const openSpawnRoom = (roomId: string): void => {
        client.closeTrackerView();
        void client.selectConversation(roomId, { suppressNotFound: true });
    };
    const stopSpawnSession = (convoId: string): void => {
        void stopSpawnedSession(convoId, (target) => client.sendMessage("/stop", target));
    };

    const urgent = needsUser(item);
    const hasUserReply = useMemo(() => comments.some((comment) => comment.author === "user"), [comments]);
    // A consent item still waiting for its answer offers no close: Approve and Decline are its only
    // honest ones, and dismissing it would hide an ask that stays open on the journal. The journal
    // closes the item itself once the ask is decided. One whose outcome is in has nothing to hide.
    const awaitingConsent = isConsentItem(item) && !spawnRows?.outcome;
    const resolutions = item.state === "open" && !awaitingConsent ? availableResolutions(item, hasUserReply) : [];
    const agents = snapshot.agents;
    const originLabel = useMemo(() => itemOriginLabel(item, conversations, agents), [item, conversations, agents]);
    // Always drawn for an item filed from a conversation, unless the detail is shown inside that
    // conversation; a granted or shared item has no origin ("") and so no row.
    const showOrigin = item.origin_convo_id !== "" && item.origin_convo_id !== selectedConvoId;
    const handoverCaption = useHandoverCaption(item.handover);

    // The item's mission, named from the missions list (it follows renames live).
    const missionNum = item.mission_num;
    const missions = snapshot.missions;
    const mission = missionNum ? itemMission(item, missions) : undefined;
    const missionListed = mission !== undefined;
    // A mission missing from a loaded missions list gets ONE refresh of that list per mission (it
    // may be new since the list loaded); until then, and if it stays missing (closed, or hidden from
    // this user), the label falls back to "Mission #num".
    const missionsRefreshedFor = useRef<number | null>(null);
    useEffect(() => {
        if (!missionNum || missions === undefined || missionListed) return;
        if (missionsRefreshedFor.current === missionNum) return;
        missionsRefreshedFor.current = missionNum;
        void client.loadMissions();
    }, [client, missionNum, missions, missionListed]);

    // A typed reply is one comment, or — with more files than the journal takes on one — several,
    // in order: the text and the first JOURNAL_ATTACHMENTS_MAX files, then the rest in batches
    // with no text (planReply; a comment that failed before goes again exactly as it was). The tray is locked while they go, so the planned comments are
    // the files the user sees. Each comment that lands takes its files out of the tray (and the
    // first, the text); the first that fails stops the send and says why beside the box, keeping
    // its files, every later one, and the text if it had not gone, so nothing is ever dropped (F2).
    // Send then retries exactly what is left: the failed comment again as the same files, and each
    // comment keeps its key across retries of the same draft so the server can dedupe an
    // ambiguous-delivery replay (F1).
    const send = async (): Promise<void> => {
        const body = reply.trim();
        const files = staged;
        if ((!body && files.length === 0) || busy) return;
        setBusy(true);
        setReplyFailure(null);
        try {
            let sentFiles = 0;
            for (const comment of planReply(body, files, attemptedRef.current)) {
                const batch = comment.files;
                const draft = draftOf(comment.body, batch);
                const outcome = await postComment(comment.body, batch, keyFor(draft));
                if (!outcome.ok) {
                    rememberAttempted(comment.body, batch);
                    setReplyFailure({
                        reason: outcome.reason ?? "The reply did not go.",
                        sentFiles,
                        unsentFiles: files.length - sentFiles,
                    });
                    return;
                }
                if (comment.carriesText) setReply("");
                forgetSent(batch);
                setStaged((current) => current.filter((entry) => !batch.includes(entry)));
                draftKeysRef.current.delete(draft);
                sentFiles += batch.length;
            }
        } finally {
            setBusy(false);
        }
    };

    /** Drops a reply the journal did not take: its text and every file still in the tray. */
    const discardReply = (): void => {
        for (const entry of stagedRef.current) {
            releaseStaged(entry);
            uploadsRef.current.delete(entry.id);
        }
        draftKeysRef.current.clear();
        attemptedRef.current = [];
        setStaged([]);
        setReply("");
        setReplyFailure(null);
    };

    // A finished voice note is ONE comment: the typed text as its body, the recording as the first
    // attachment, then the staged files — unless a typed send is already taking those, or the
    // recording and the tray would not fit on one comment, when the note goes alone. Like the chat
    // composer, the draft and tray clear as the send starts. On failure nothing is ever dropped:
    //  - a note that took the draft puts the recording back first in the tray, the files after it,
    //    then anything staged meanwhile; Send goes out with the note's comment exactly as it was —
    //    its text too — then the rest (planReply). The text comes back to the box only if nothing
    //    new was typed; new text goes on a comment of its own.
    //  - a note that went alone is held beside the box (Retry / Discard), never in the tray.
    // Either way the retry is the same comment under the same key with the same uploaded blob refs
    // (the recording's upload is remembered under its staged id), so an ambiguous delivery is not
    // duplicated.
    const sendVoiceNote = async (blob: Blob): Promise<void> => {
        const recording = stageFile(voiceNoteFile(blob));
        const takeDraft = !busyRef.current && stagedRef.current.length < JOURNAL_ATTACHMENTS_MAX;
        const body = takeDraft ? replyRef.current.trim() : "";
        const files = takeDraft ? stagedRef.current : [];
        if (takeDraft) {
            // The refs too: a send that fails before the next render must see the box as cleared.
            replyRef.current = "";
            stagedRef.current = [];
            setReply("");
            setStaged([]);
            // The draft a failure notice was about is going out with the note.
            setReplyFailure(null);
        }
        const parts = [recording, ...files];
        const draft = draftOf(body, parts);
        const key = keyFor(draft);
        let outcome: TrackerCommentOutcome;
        try {
            outcome = await postComment(body, parts, key);
        } catch {
            outcome = { ok: false };
        }
        if (outcome.ok) {
            forgetSent(parts);
            draftKeysRef.current.delete(draft);
            return;
        }
        if (takeDraft) {
            rememberAttempted(body, parts);
            setStaged((current) => [...parts, ...current]);
            if (body && !replyRef.current.trim()) setReply(body);
        } else {
            draftKeysRef.current.delete(draft);
            setHeldVoice((current) => [...current, { entry: recording, key }]);
        }
        voice.reportSendFailure(voiceFailureMessage(outcome));
    };
    const retryHeldVoice = async (held: HeldVoiceNote): Promise<void> => {
        if (busy) return;
        setBusy(true);
        try {
            let outcome: TrackerCommentOutcome;
            try {
                outcome = await postComment("", [held.entry], held.key);
            } catch {
                outcome = { ok: false };
            }
            if (outcome.ok) {
                forgetSent([held.entry]);
                setHeldVoice((current) => current.filter((entry) => entry !== held));
            } else {
                voice.reportSendFailure(voiceFailureMessage(outcome));
            }
        } finally {
            setBusy(false);
        }
    };
    const discardHeldVoice = (held: HeldVoiceNote): void => {
        forgetSent([held.entry]);
        setHeldVoice((current) => current.filter((entry) => entry !== held));
    };
    const voice = useVoiceRecorder({
        contextKey: String(item.num),
        client,
        onRecorded: (blob) => void sendVoiceNote(blob),
        kind: "item",
        title: item.title || `#${item.num}`,
    });

    // A tap on a comment's button is a comment whose body is the label, addressed to the asking
    // comment. Same retry rule as a typed reply: a tap that failed keeps its key, so tapping the same
    // button again cannot post the answer twice if the first one did land. One slot per asking
    // comment, holding the LAST attempted label: tapping a different button replaces it and a sent
    // tap clears it, so a key from an older failed attempt can never be replayed after the answer
    // has moved on (the journal would hand back that old comment and the new choice would be lost).
    const tapKeysRef = useRef<Map<string, { label: string; key: string }>>(new Map());
    const tap = async (comment: TrackerComment, label: string): Promise<void> => {
        if (busy) return;
        let slot = tapKeysRef.current.get(comment.id);
        if (!slot || slot.label !== label) {
            slot = { label, key: crypto.randomUUID() };
            tapKeysRef.current.set(comment.id, slot);
        }
        setBusy(true);
        try {
            const ok = await client.commentItem(item.num, { action: label, reply_to: comment.id }, slot.key);
            if (ok) tapKeysRef.current.delete(comment.id);
        } finally {
            setBusy(false);
        }
    };

    // A tap on one of the item's own buttons: a comment whose body is the label, with no reply_to
    // (the journal records it as the item's `chosen_action`, and closes a notice answered Seen).
    // The tap shows as chosen while it is on its way. Same retry rule as a comment's buttons: one
    // slot holding the last attempted label, so a failed tap retried keeps its key and a different
    // label gets a fresh one. Both the slot and the marker name the item they belong to: this view
    // is reused when another item is opened, and a key from one item's failed tap must never be
    // replayed as another item's answer.
    const offeredActions = offeredItemActions(item);
    const [sendingAction, setSendingAction] = useState<{ itemId: string; label: string } | null>(null);
    const itemTapKeyRef = useRef<{ itemId: string; label: string; key: string } | null>(null);
    const chosenAction =
        [sendingAction?.itemId === item.id ? sendingAction.label : null, item.chosen_action].find(
            (label): label is string => !!label && offeredActions.includes(label),
        ) ?? null;
    const tapItemAction = async (label: string): Promise<void> => {
        if (busy || !offeredActions.includes(label) || label === chosenAction) return;
        let slot = itemTapKeyRef.current;
        if (!slot || slot.itemId !== item.id || slot.label !== label) {
            slot = { itemId: item.id, label, key: crypto.randomUUID() };
            itemTapKeyRef.current = slot;
        }
        setBusy(true);
        setSendingAction({ itemId: item.id, label });
        try {
            const ok = await client.commentItem(item.num, { action: label, body: label }, slot.key);
            if (ok && itemTapKeyRef.current === slot) itemTapKeyRef.current = null;
        } finally {
            setSendingAction(null);
            setBusy(false);
        }
    };

    const resolve = async (resolution: TrackerResolution): Promise<void> => {
        if (busy) return;
        setMenuOpen(false);
        setBusy(true);
        try {
            await client.closeTrackerItem(item.num, resolution);
        } finally {
            setBusy(false);
        }
    };

    const reopen = async (): Promise<void> => {
        if (busy) return;
        setMenuOpen(false);
        setBusy(true);
        try {
            await client.reopenTrackerItem(item.num);
        } finally {
            setBusy(false);
        }
    };

    const openConvo = (convoId: string): void => {
        client.closeTrackerView();
        void client.selectConversation(convoId);
    };
    const openToConvo = (): void => openConvo(item.origin_convo_id);
    const openMission = (): void => {
        if (missionNum) client.openTrackerMission(missionNum);
    };
    const missionText = missionNum ? itemMissionText(missionNum, mission) : "";

    // Set / clear the explicit "handle elsewhere" routing label. Distinct from the
    // informational "opened from another chat" line: this is the operator saying the item belongs in
    // a different session's context, not just noting where it came from.
    const toggleRouteElsewhere = async (): Promise<void> => {
        if (busy) return;
        setMenuOpen(false);
        setBusy(true);
        try {
            const labels = isRouteElsewhere(item)
                ? item.labels.filter((label) => label !== ROUTE_ELSEWHERE_LABEL)
                : [...item.labels, ROUTE_ELSEWHERE_LABEL];
            await client.setItemLabels(item.num, labels);
        } finally {
            setBusy(false);
        }
    };

    // A consent card closes when its request is decided and the journal refuses to reopen it (409),
    // so a closed one offers no Reopen.
    const canReopen = item.state === "closed" && !isConsentItem(item);
    // Even an item with no close/reopen action can toggle the route-elsewhere routing label, but a
    // spawn consent card is answered in place and routing it elsewhere makes no sense.
    const canRoute = !isConsentItem(item);
    const showMenu = canRoute || canReopen || resolutions.length > 0;

    // matron://item / matron://mission deep links inside the item body + comment threads open the
    // target tracker surface in-app (F6) — same handler the timeline uses.
    const onTrackerLink: TrackerLinkHandler = (kind, target) => client.openTrackerLink(kind, target);

    // The lightbox: every image in the body and the thread, in the order they render. A click on any
    // tracker image opens it at that image.
    const [viewerMediaId, setViewerMediaId] = useState<string>();
    const viewerOpenerRef = useRef<HTMLElement | null>(null);
    const mediaCorpus = useMemo(() => buildTrackerMediaCorpus(item, comments), [item, comments]);
    const mediaViewerValue = useMemo<MediaViewerContextValue>(
        () => ({
            openViewer: (mediaId, opener) => {
                viewerOpenerRef.current = opener;
                setViewerMediaId(mediaId);
            },
        }),
        [],
    );
    useEffect(() => setViewerMediaId(undefined), [item.id]);

    // The indicator is the last thing in the thread. When it appears for a reader who is already
    // near the foot of the thread (they have just tapped or replied), bring it into view; a reader
    // further up is left where they are. Only an indicator that APPEARS moves anything: an item
    // opened while its session is already busy starts at the top, like any other.
    const working = useWorkingLabel(item.working);
    const scrollRef = useRef<HTMLDivElement>(null);
    const showsWorking = working !== null;
    const shownFor = useRef<{ id: string; shown: boolean } | null>(null);
    useEffect(() => {
        const prior = shownFor.current;
        shownFor.current = { id: item.id, shown: showsWorking };
        if (!prior || prior.id !== item.id || prior.shown || !showsWorking) return;
        const node = scrollRef.current;
        // Room for the reply that was just added above the indicator.
        if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 320) node.scrollTop = node.scrollHeight;
    }, [item.id, showsWorking]);
    const viewerOpen = viewerMediaId !== undefined && mediaCorpus.some((entry) => entry.mediaId === viewerMediaId);

    const detail = (
        <div className="mj_TrackerDetail">
            <div className="mj_TrackerDetail_head">
                <button type="button" className="mj_TrackerBack" aria-label="Back to For you" onClick={onBack}>
                    <ChevronLeftIcon />
                </button>
                <span className="mj_TrackerItemHead_kind">
                    <span className="mj_TrackerItemHead_glyph" aria-hidden="true">
                        <TrackerGlyph kind={item.kind} />
                    </span>
                    #{item.num} · {kindLabel(item.kind)}
                </span>
                <span
                    className={`mj_TrackerStatusPill ${
                        urgent ? "mj_TrackerStatusPill_needsyou" : "mj_TrackerStatusPill_muted"
                    }`}
                >
                    {itemStatusText(item)}
                </span>
                {showMenu ? (
                    <div className="mj_TrackerMenu">
                        <button
                            type="button"
                            className="mj_IconButton mj_TrackerMenu_button"
                            aria-label="Item actions"
                            aria-expanded={menuOpen}
                            disabled={busy}
                            onClick={() => setMenuOpen((value) => !value)}
                        >
                            <KebabIcon />
                        </button>
                        {menuOpen ? (
                            <div className="mj_TrackerMenu_list" role="menu">
                                {canReopen ? (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="mj_TrackerMenu_item"
                                        onClick={() => void reopen()}
                                    >
                                        Reopen
                                    </button>
                                ) : (
                                    resolutions.map((resolution) => (
                                        <button
                                            key={resolution}
                                            type="button"
                                            role="menuitem"
                                            className={`mj_TrackerMenu_item${
                                                resolution === "cancelled" ? " mj_TrackerMenu_item_danger" : ""
                                            }`}
                                            onClick={() => void resolve(resolution)}
                                        >
                                            {resolveActionLabel(resolution)}
                                        </button>
                                    ))
                                )}
                                {canRoute ? (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="mj_TrackerMenu_item"
                                        onClick={() => void toggleRouteElsewhere()}
                                    >
                                        {isRouteElsewhere(item) ? "Handle here" : "Route elsewhere"}
                                    </button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>

            <div className="mj_TrackerDetail_scroll" ref={scrollRef}>
                {missionNum || showOrigin || handoverCaption ? (
                    <div className="mj_TrackerContext">
                        {missionNum ? (
                            <button
                                type="button"
                                className="mj_TrackerContext_row mj_TrackerContext_mission"
                                aria-label={`Open mission ${missionText}`}
                                title={missionText}
                                onClick={openMission}
                            >
                                <span className="mj_TrackerContext_glyph" aria-hidden="true">
                                    <MissionGlyph state={mission?.state ?? "open"} />
                                </span>
                                <span className="mj_TrackerContext_text">{missionText}</span>
                            </button>
                        ) : null}
                        {showOrigin ? (
                            <button
                                type="button"
                                className="mj_TrackerContext_row mj_TrackerOrigin"
                                aria-label={`Opened from ${originLabel}, open the conversation`}
                                title={originLabel}
                                onClick={openToConvo}
                            >
                                <span className="mj_TrackerContext_glyph" aria-hidden="true">
                                    <CommentBubbleGlyph />
                                </span>
                                <span className="mj_TrackerContext_text">Opened from {originLabel}</span>
                            </button>
                        ) : null}
                        {handoverCaption ? <div className="mj_TrackerHandover">{handoverCaption}</div> : null}
                    </div>
                ) : null}

                <h1 className="mj_TrackerItemTitle">{item.title}</h1>

                {/* The route-elsewhere flag renders as its own actionable chip, not a raw label. */}
                {isRouteElsewhere(item) ? (
                    <div className="mj_TrackerLabels">
                        <span className="mj_TrackerLabel mj_TrackerLabel_routeElsewhere">↪ Handle elsewhere</span>
                    </div>
                ) : null}
                {item.labels.some((label) => label !== ROUTE_ELSEWHERE_LABEL) ? (
                    <div className="mj_TrackerLabels">
                        {item.labels
                            .filter((label) => label !== ROUTE_ELSEWHERE_LABEL)
                            .map((label) => (
                                <span key={label} className="mj_TrackerLabel">
                                    {label}
                                </span>
                            ))}
                    </div>
                ) : null}

                {item.links.length > 0 ? (
                    <div className="mj_TrackerLinks">
                        {item.links.map((link) => (
                            <LinkChip key={link.url} link={link} onTrackerLink={onTrackerLink} />
                        ))}
                    </div>
                ) : null}

                {spawnRequestId && spawnRows ? (
                    <SpawnConsentCard
                        rows={spawnRows}
                        closed={item.state === "closed"}
                        onAnswer={answerSpawn}
                        onOpenRoom={openSpawnRoom}
                        onStopSession={stopSpawnSession}
                    />
                ) : null}

                {/* The item's body attachments ride with the body: placed inline where it refers to
                    them, the rest after it. */}
                <InlineBody
                    client={client}
                    body={item.body}
                    attachments={item.attachments ?? []}
                    label={`item-${item.num}`}
                    onTrackerLink={onTrackerLink}
                    proseClassName="mj_TrackerProse mj_TrackerItemBody"
                />

                <ItemActions
                    actions={offeredActions}
                    chosen={chosenAction}
                    disabled={busy}
                    onTap={(label) => void tapItemAction(label)}
                />

                {comments.length > 0 ? (
                    <div className="mj_TrackerThread">
                        {comments.map((comment) => (
                            <CommentRow
                                key={comment.id}
                                client={client}
                                comment={comment}
                                author={commentAuthor(comment, conversations, agents)}
                                onOpenConvo={openConvo}
                                onTrackerLink={onTrackerLink}
                                actionsDisabled={busy || item.state === "closed"}
                                onTap={tap}
                            />
                        ))}
                    </div>
                ) : null}

                <WorkingIndicator label={working} />
            </div>

            <div className="mj_TrackerComposer" ref={voice.containerRef}>
                <VoiceErrorBanner recorder={voice} />
                {heldVoice.map((held) => (
                    <div key={held.entry.id} className="mj_TrackerComposer_heldVoice" role="status">
                        <span className="mj_TrackerComposer_heldVoiceText">Voice note not sent</span>
                        <button
                            type="button"
                            className="mj_TrackerComposer_heldVoiceRetry"
                            aria-label="Retry the voice note"
                            disabled={busy}
                            onClick={() => void retryHeldVoice(held)}
                        >
                            Retry
                        </button>
                        <button
                            type="button"
                            className="mj_TrackerComposer_heldVoiceDiscard"
                            aria-label="Discard the voice note"
                            disabled={busy}
                            onClick={() => discardHeldVoice(held)}
                        >
                            Discard
                        </button>
                    </div>
                ))}
                {replyFailure && (reply.trim() || staged.length > 0) ? (
                    <div className="mj_TrackerComposer_failure" role="alert">
                        <span className="mj_TrackerComposer_failureText">
                            {replyFailureHeadline(replyFailure)} {replyFailure.reason}
                        </span>
                        <button
                            type="button"
                            className="mj_TrackerComposer_failureRetry"
                            aria-label="Retry the reply"
                            disabled={busy}
                            onClick={() => void send()}
                        >
                            Retry
                        </button>
                        <button
                            type="button"
                            className="mj_TrackerComposer_failureDiscard"
                            aria-label="Discard the reply"
                            disabled={busy}
                            onClick={discardReply}
                        >
                            Discard
                        </button>
                    </div>
                ) : null}
                <StagedTray staged={staged} locked={busy} onRemove={removeStaged} />
                {staged.length > JOURNAL_ATTACHMENTS_MAX ? (
                    <div className="mj_TrackerComposer_limit" role="status">
                        {staged.length} files will go as {planReply(reply.trim(), staged, attemptedRef.current).length}{" "}
                        replies of up to {JOURNAL_ATTACHMENTS_MAX}.
                    </div>
                ) : null}
                {voice.voiceState === "recording" ? (
                    <VoiceRecordingBar recorder={voice} sendLabel="Stop and send voice reply" />
                ) : (
                    <div className="mj_TrackerComposer_row">
                        <button
                            type="button"
                            className="mj_ComposerControl mj_ComposerAttach mj_TrackerComposer_attach"
                            aria-label="Attach photos or files"
                            title="Attach photos or files"
                            disabled={busy}
                            onClick={() => fileInput.current?.click()}
                        >
                            <PlusCircleIcon />
                        </button>
                        <input
                            ref={fileInput}
                            className="mj_TrackerComposer_file"
                            type="file"
                            multiple
                            hidden
                            onChange={(event) => {
                                if (event.target.files) addFiles([...event.target.files]);
                                event.target.value = "";
                            }}
                        />
                        <textarea
                            className="mj_TrackerComposer_input"
                            rows={1}
                            placeholder="Reply…"
                            value={reply}
                            disabled={busy}
                            onChange={(event) => editReply(event.target.value)}
                            onPaste={(event) => {
                                const files = [...(event.clipboardData?.files ?? [])];
                                if (files.length > 0) {
                                    event.preventDefault();
                                    addFiles(files);
                                }
                            }}
                            onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                    event.preventDefault();
                                    void send();
                                }
                            }}
                        />
                        <VoiceMicButton
                            recorder={voice}
                            className="mj_ComposerControl mj_ComposerMic mj_TrackerComposer_mic"
                            label="Record a voice reply"
                        />
                        <button
                            type="button"
                            className="mj_TrackerComposer_send"
                            aria-label="Send reply"
                            disabled={(!reply.trim() && staged.length === 0) || busy}
                            onClick={() => void send()}
                        >
                            <SendIcon />
                        </button>
                    </div>
                )}
            </div>
            {/* Portalled to the body so the tracker pane's stacking context never caps the lightbox. */}
            {viewerOpen
                ? createPortal(
                      <MediaViewer
                          client={client}
                          items={mediaCorpus}
                          initialMediaId={viewerMediaId}
                          opener={viewerOpenerRef.current}
                          onClose={() => setViewerMediaId(undefined)}
                      />,
                      document.body,
                  )
                : null}
        </div>
    );

    return <MediaViewerContext.Provider value={mediaViewerValue}>{detail}</MediaViewerContext.Provider>;
}
