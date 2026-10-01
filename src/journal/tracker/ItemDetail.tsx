/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Item detail — header (kind glyph, #num · kind, status pill), the origin-conversation jump, the
 * item body, its comment thread (status rows rendered as centered muted lines from the structured
 * transition, with any closing/reopening note beneath as an ordinary comment card), a pinned reply
 * composer, and a resolve/reopen menu. All mutations go through the client; the store refetch keeps
 * the thread live.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "../client";
import { isSendKey, useAutoGrow } from "../composer-input";
import { humanizeSize } from "../files/format";
import { filesDeepLinkHash, handleFilesLinkClick } from "../files-link";
import { ChevronLeftIcon, KebabIcon, SendIcon } from "../icons";
import { MarkdownBody, parseTrackerHref } from "../markdown";
import type { TrackerComment, TrackerItem, TrackerLink, TrackerResolution } from "../types";
import {
    availableResolutions,
    formatRelativeTime,
    isRouteElsewhere,
    itemOriginTitle,
    itemStatusText,
    kindLabel,
    needsUser,
    resolveActionLabel,
    ROUTE_ELSEWHERE_LABEL,
    statusRowText,
} from "./format";
import { TrackerGlyph } from "./glyphs";

function AttachmentChips({ comment }: { comment: TrackerComment }): React.ReactElement | null {
    if (comment.attachments.length === 0) return null;
    return (
        <div className="mj_TrackerAttachments">
            {comment.attachments.map((attachment) => (
                <span key={attachment.blob_ref} className="mj_TrackerAttachmentChip">
                    {attachment.name}
                    <span className="mj_TrackerAttachmentChip_size">{humanizeSize(attachment.size)}</span>
                </span>
            ))}
        </div>
    );
}

/** An ordinary comment card: author, relative time, markdown body (links live) and attachments. */
function CommentCard({
    comment,
    onTrackerLink,
}: {
    comment: TrackerComment;
    onTrackerLink: (kind: "item" | "mission", num: number) => void;
}): React.ReactElement {
    const who = comment.author === "user" ? "You" : "Agent";
    return (
        <div className={`mj_TrackerComment mj_TrackerComment_${comment.author}`}>
            <div className="mj_TrackerComment_head">
                <span className="mj_TrackerComment_author">{who}</span>
                <span className="mj_TrackerComment_time">{formatRelativeTime(comment.created_at)}</span>
            </div>
            {comment.body.trim() ? (
                <div className="mj_TrackerProse">
                    <MarkdownBody text={comment.body} label={`comment-${comment.id}`} onTrackerLink={onTrackerLink} />
                </div>
            ) : null}
            <AttachmentChips comment={comment} />
        </div>
    );
}

/**
 * One thread entry. A `status` comment is the transition as a small centred line ("Agent closed this
 * as done"); the note the closer/reopener wrote travels as that comment's body and, when present,
 * renders beneath the line as an ordinary comment card so it reads (and links) like any comment.
 */
function CommentRow({
    comment,
    onTrackerLink,
}: {
    comment: TrackerComment;
    onTrackerLink: (kind: "item" | "mission", num: number) => void;
}): React.ReactElement {
    if (comment.kind === "status") {
        const text = statusRowText(comment);
        const hasNote = comment.body.trim().length > 0;
        if (!text && !hasNote) {
            return <div className="mj_TrackerStatusRow" aria-hidden="true" />;
        }
        return (
            <>
                {text ? <div className="mj_TrackerStatusRow">{text}</div> : null}
                {hasNote ? <CommentCard comment={comment} onTrackerLink={onTrackerLink} /> : null}
            </>
        );
    }
    return <CommentCard comment={comment} onTrackerLink={onTrackerLink} />;
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
    onTrackerLink: (kind: "item" | "mission", num: number) => void;
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
    // Operator call T3: the reply box behaves like the chat composer. One line tall at rest, grows
    // with its content up to the composer max (then scrolls), Send sits inside the box, no drag
    // handle; Enter sends and Shift+Enter inserts a newline, through the composer's own helpers.
    const replyRef = useRef<HTMLTextAreaElement>(null);
    useAutoGrow(replyRef, reply);
    const [busy, setBusy] = useState(false);
    // The box is disabled while a reply posts, which drops its focus. With Enter as the send key
    // the operator is typing when that happens, so hand the focus back once the post settles, but
    // only if the focus is still nowhere (the drop itself): a deliberate move to another control
    // while the post was pending is left alone.
    const refocusReplyRef = useRef(false);
    useEffect(() => {
        if (busy || !refocusReplyRef.current) return;
        refocusReplyRef.current = false;
        const active = document.activeElement;
        if (active === null || active === document.body || active === replyRef.current) replyRef.current?.focus();
    }, [busy]);
    const [menuOpen, setMenuOpen] = useState(false);
    // Stable idempotency key bound to the current draft TEXT. A failed send keeps the draft, so a
    // retry of the SAME text must reuse this key — otherwise a comment that committed before its
    // response was lost would be duplicated on retry (F1). We regenerate only when the text differs
    // from the last attempt (a genuinely new comment) or after a confirmed send.
    const sendKeyRef = useRef<{ body: string; key: string } | null>(null);

    const urgent = needsUser(item);
    const hasUserReply = useMemo(() => comments.some((comment) => comment.author === "user"), [comments]);
    const resolutions = item.state === "open" ? availableResolutions(item, hasUserReply) : [];

    const selectedConvoId = client.getSnapshot().selectedConversationId;
    // Keyed on the conversation list (replaced on a rename or load), so the line follows it live.
    const conversations = client.getSnapshot().conversations;
    const originTitle = useMemo(() => {
        const convo = conversations.find((candidate) => candidate.id === item.origin_convo_id);
        // The live conversation list first (it tracks renames), then the title the journal put on
        // the item: it resolves origins that are not in the loaded list (older or archived chats).
        return convo?.title.trim() || itemOriginTitle(item) || undefined;
    }, [conversations, item]);
    const showOrigin = item.origin_convo_id !== selectedConvoId;

    const send = async (): Promise<void> => {
        const body = reply.trim();
        if (!body || busy) return;
        refocusReplyRef.current = document.activeElement === replyRef.current;
        setBusy(true);
        try {
            // Reuse the key across retries of identical text; mint a fresh one when the text changed
            // (a different comment) so the server can dedupe an ambiguous-delivery replay (F1).
            if (!sendKeyRef.current || sendKeyRef.current.body !== body) {
                sendKeyRef.current = { body, key: crypto.randomUUID() };
            }
            // Clear the draft ONLY on a confirmed successful post — a failed send (offline/auth/5xx)
            // resolves false and keeps the typed text so it isn't silently lost (F2).
            const ok = await client.commentItem(item.num, { body }, sendKeyRef.current.key);
            if (ok) {
                setReply("");
                sendKeyRef.current = null;
            }
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

    const openToConvo = (): void => {
        client.closeTrackerView();
        void client.selectConversation(item.origin_convo_id);
    };

    // Set / clear the explicit "handle elsewhere" routing label (#213). Distinct from the
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
    const onTrackerLink = (kind: "item" | "mission", num: number): void => client.openTrackerLink(kind, num);

    return (
        <div className="mj_TrackerDetail">
            <div className="mj_TrackerDetail_head">
                <button type="button" className="mj_TrackerBack" aria-label="Back to inbox" onClick={onBack}>
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
                <h1 className="mj_TrackerItemTitle">{item.title}</h1>

                {showOrigin ? (
                    <button type="button" className="mj_TrackerOrigin" onClick={openToConvo}>
                        Opened from {originTitle ?? "another chat"}
                    </button>
                ) : null}

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

                {item.body.trim() ? (
                    <div className="mj_TrackerProse mj_TrackerItemBody">
                        <MarkdownBody text={item.body} label={`item-${item.num}`} onTrackerLink={onTrackerLink} />
                    </div>
                ) : null}

                {comments.length > 0 ? (
                    <div className="mj_TrackerThread">
                        {comments.map((comment) => (
                            <CommentRow key={comment.id} comment={comment} onTrackerLink={onTrackerLink} />
                        ))}
                    </div>
                ) : null}
            </div>

            <div className="mj_TrackerComposer">
                <div className="mj_TrackerComposer_row">
                    <textarea
                        ref={replyRef}
                        className="mj_TrackerComposer_input"
                        rows={1}
                        aria-label="Reply"
                        placeholder="Reply…"
                        value={reply}
                        disabled={busy}
                        onChange={(event) => setReply(event.target.value)}
                        onKeyDown={(event) => {
                            if (isSendKey(event)) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="mj_TrackerComposer_send"
                        aria-label="Send reply"
                        disabled={!reply.trim() || busy}
                        onClick={() => void send()}
                    >
                        <SendIcon />
                    </button>
                </div>
            </div>
        </div>
    );
}
