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
 * asks a follow-up question carries its own one-tap answer buttons; an open notice carries its
 * item-level Seen button under the body), a pinned reply
 * composer, and a resolve/reopen menu. All mutations go through the client; the store refetch keeps
 * the thread live.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type MatronJournalClient, voiceNoteFile } from "../client";
import { humanizeSize } from "../files/format";
import { filesDeepLinkHash, handleFilesLinkClick } from "../files-link";
import { ChevronLeftIcon, CloseIcon, KebabIcon, PlusCircleIcon, SendIcon } from "../icons";
import { parseTrackerHref } from "../markdown";
import { MediaViewer, MediaViewerContext, type MediaViewerContextValue } from "../media-viewer";
import type {
    TrackerAttachment,
    TrackerComment,
    TrackerCommentWrite,
    TrackerItem,
    TrackerLink,
    TrackerLinkHandler,
    TrackerResolution,
} from "../types";
import { useVoiceRecorder, VoiceErrorBanner, VoiceMicButton, VoiceRecordingBar } from "../voice-recorder";
import {
    awaitsSeen,
    availableResolutions,
    formatRelativeTime,
    isRouteElsewhere,
    itemStatusText,
    kindLabel,
    needsUser,
    resolveActionLabel,
    ROUTE_ELSEWHERE_LABEL,
    statusRowText,
} from "./format";
import { CommentBubbleGlyph, MissionGlyph, TrackerGlyph } from "./glyphs";
import { type CommentAuthor, commentAuthor, itemMission, itemMissionText, itemOriginLabel } from "./item-context";
import { buildTrackerMediaCorpus, InlineBody } from "./ItemAttachments";

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
 * a valid `matron://item/<N>` / `matron://mission/<N>` opens it in-app; a Files deep link opens the
 * pane in this window; http(s) opens in a new tab; anything else (an unknown scheme, a malformed
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

/** The journal takes at most this many attachments on one comment. */
const MAX_COMMENT_ATTACHMENTS = 20;

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

/** The staged files above the reply box: a thumbnail or a name chip each, with a remove button. */
function StagedTray({
    staged,
    onRemove,
}: {
    staged: StagedFile[];
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

    // The tray's thumbnails are object URLs; let them go with the box.
    useEffect(
        () => () => {
            stagedRef.current.forEach(releaseStaged);
            heldVoiceRef.current.forEach((held) => releaseStaged(held.entry));
        },
        [],
    );

    const addFiles = (files: File[]): void => {
        if (files.length === 0) return;
        setStaged((current) => [
            ...current,
            ...files.slice(0, Math.max(0, MAX_COMMENT_ATTACHMENTS - current.length)).map(stageFile),
        ]);
    };
    const removeStaged = (id: string): void => {
        setStaged((current) => {
            const gone = current.find((entry) => entry.id === id);
            if (gone) releaseStaged(gone);
            return current.filter((entry) => entry.id !== id);
        });
        uploadsRef.current.delete(id);
    };
    // The files went out with a comment: drop their thumbnails and remembered uploads.
    const forgetSent = (sent: StagedFile[]): void => {
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

    /** Uploads (or reuses) the files and posts one comment; false when anything failed. */
    const postComment = async (body: string, files: StagedFile[], key: string): Promise<boolean> => {
        const attachments = await uploadStaged(files);
        if (!attachments) return false;
        const write: TrackerCommentWrite = body ? { body } : {};
        if (attachments.length > 0) write.attachments = attachments;
        return client.commentItem(item.num, write, key);
    };

    const urgent = needsUser(item);
    const hasUserReply = useMemo(() => comments.some((comment) => comment.author === "user"), [comments]);
    const resolutions = item.state === "open" ? availableResolutions(item, hasUserReply) : [];

    const snapshot = client.getSnapshot();
    const selectedConvoId = snapshot.selectedConversationId;
    // Keyed on the conversation list (replaced on a rename or load), so the line follows it live.
    const conversations = snapshot.conversations;
    const agents = snapshot.agents;
    const originLabel = useMemo(() => itemOriginLabel(item, conversations, agents), [item, conversations, agents]);
    // Always drawn for an item filed from a conversation, unless the detail is shown inside that
    // conversation; a granted or shared item has no origin ("") and so no row.
    const showOrigin = item.origin_convo_id !== "" && item.origin_convo_id !== selectedConvoId;

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

    const send = async (): Promise<void> => {
        const body = reply.trim();
        const files = staged;
        if ((!body && files.length === 0) || busy || files.length > MAX_COMMENT_ATTACHMENTS) return;
        setBusy(true);
        try {
            // Reuse the key across retries of an identical draft so the server can dedupe an
            // ambiguous-delivery replay (F1).
            const draft = draftOf(body, files);
            const key = keyFor(draft);
            // Clear the draft ONLY on a confirmed successful post — a failed send (offline/auth/5xx)
            // resolves false and keeps the typed text and the files so they aren't silently lost (F2).
            const ok = await postComment(body, files, key);
            if (ok) {
                setReply("");
                forgetSent(files);
                setStaged((current) => current.filter((entry) => !files.includes(entry)));
                draftKeysRef.current.delete(draft);
            }
        } finally {
            setBusy(false);
        }
    };

    // A finished voice note is ONE comment: the typed text as its body, the recording as the first
    // attachment, then the staged files — unless a typed send is already taking those, or the tray
    // is full (no room for the recording), when the note goes alone. Like the chat composer, the
    // draft and tray clear as the send starts. On failure nothing is ever dropped:
    //  - a note that took the draft puts the recording back first in the tray, the files after it,
    //    then anything staged meanwhile — the tray may then exceed the limit, and Send stays blocked
    //    until it is trimmed (it says so); the text comes back only if nothing new was typed.
    //  - a note that went alone is held beside the box (Retry / Discard), never in the tray.
    // Either way the retry is the same comment under the same key with the same uploaded blob refs
    // (the recording's upload is remembered under its staged id), so an ambiguous delivery is not
    // duplicated.
    const sendVoiceNote = async (blob: Blob): Promise<void> => {
        const recording = stageFile(voiceNoteFile(blob));
        const takeDraft = !busyRef.current && stagedRef.current.length < MAX_COMMENT_ATTACHMENTS;
        const body = takeDraft ? replyRef.current.trim() : "";
        const files = takeDraft ? stagedRef.current : [];
        if (takeDraft) {
            // The refs too: a send that fails before the next render must see the box as cleared.
            replyRef.current = "";
            stagedRef.current = [];
            setReply("");
            setStaged([]);
        }
        const parts = [recording, ...files];
        const draft = draftOf(body, parts);
        const key = keyFor(draft);
        let ok = false;
        try {
            ok = await postComment(body, parts, key);
        } catch {
            ok = false;
        }
        if (ok) {
            forgetSent(parts);
            draftKeysRef.current.delete(draft);
            return;
        }
        if (takeDraft) {
            setStaged((current) => [...parts, ...current]);
            if (body && !replyRef.current.trim()) setReply(body);
        } else {
            draftKeysRef.current.delete(draft);
            setHeldVoice((current) => [...current, { entry: recording, key }]);
        }
        voice.reportSendFailure("Couldn't send the voice note — try again.");
    };
    const retryHeldVoice = async (held: HeldVoiceNote): Promise<void> => {
        if (busy) return;
        setBusy(true);
        try {
            let ok = false;
            try {
                ok = await postComment("", [held.entry], held.key);
            } catch {
                ok = false;
            }
            if (ok) {
                forgetSent([held.entry]);
                setHeldVoice((current) => current.filter((entry) => entry !== held));
            } else {
                voice.reportSendFailure("Couldn't send the voice note — try again.");
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

    // The notice's Seen button: an item-level tap (no reply_to), which the journal answers by closing
    // the notice. One-shot like the menu actions: a repeat after a lost response is harmless, since
    // the notice is closed either way.
    const seen = async (): Promise<void> => {
        if (busy) return;
        setBusy(true);
        try {
            await client.markItemSeen(item.num);
        } finally {
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

    // Always show the kebab now: even an item with no close/reopen action can toggle the
    // route-elsewhere routing label.
    const showMenu = true;

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
                                {item.state === "closed" ? (
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
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="mj_TrackerMenu_item"
                                    onClick={() => void toggleRouteElsewhere()}
                                >
                                    {isRouteElsewhere(item) ? "Handle here" : "Route elsewhere"}
                                </button>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>

            <div className="mj_TrackerDetail_scroll">
                {missionNum || showOrigin ? (
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

                {awaitsSeen(item) ? (
                    <div className="mj_TrackerActions" role="group" aria-label="Quick replies">
                        <button
                            type="button"
                            className="mj_TrackerAction"
                            data-action="seen"
                            disabled={busy}
                            onClick={() => void seen()}
                        >
                            Seen
                        </button>
                    </div>
                ) : null}

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
                <StagedTray staged={staged} onRemove={removeStaged} />
                {staged.length > MAX_COMMENT_ATTACHMENTS ? (
                    <div className="mj_TrackerComposer_limit" role="status">
                        Up to {MAX_COMMENT_ATTACHMENTS} attachments per reply — remove{" "}
                        {staged.length - MAX_COMMENT_ATTACHMENTS} to send.
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
                            disabled={busy || staged.length >= MAX_COMMENT_ATTACHMENTS}
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
                            onChange={(event) => setReply(event.target.value)}
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
                            disabled={
                                (!reply.trim() && staged.length === 0) ||
                                busy ||
                                staged.length > MAX_COMMENT_ATTACHMENTS
                            }
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
