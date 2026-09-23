/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Item detail — header (kind glyph, #num · kind, status pill), the origin-conversation jump, the
 * item body, its comment thread (status rows rendered as centered muted lines from the structured
 * transition, never the raw body), a pinned reply composer, and a resolve/reopen menu. All
 * mutations go through the client; the store refetch keeps the thread live.
 */

import React, { useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "../client";
import { ChevronLeftIcon, KebabIcon, SendIcon } from "../icons";
import { MarkdownBody } from "../markdown";
import type { TrackerComment, TrackerItem, TrackerResolution } from "../types";
import {
    availableResolutions,
    formatRelativeTime,
    humanizeSize,
    itemStatusText,
    kindLabel,
    needsUser,
    resolveActionLabel,
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

function CommentRow({
    comment,
    onTrackerLink,
}: {
    comment: TrackerComment;
    onTrackerLink: (kind: "item", num: number) => void;
}): React.ReactElement {
    if (comment.kind === "status") {
        const text = statusRowText(comment);
        if (text) {
            return <div className="mj_TrackerStatusRow">{text}</div>;
        }
        // No displayable transition; fall back to the body only if the status carries one.
        if (comment.body.trim()) {
            return <div className="mj_TrackerStatusRow mj_TrackerStatusRow_body">{comment.body}</div>;
        }
        return <div className="mj_TrackerStatusRow" aria-hidden="true" />;
    }
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
    const [busy, setBusy] = useState(false);
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
    const originTitle = useMemo(() => {
        const convo = client.getSnapshot().conversations.find((candidate) => candidate.id === item.origin_convo_id);
        return convo?.title.trim() || undefined;
    }, [client, item.origin_convo_id]);
    const showOrigin = item.origin_convo_id !== selectedConvoId;

    const send = async (): Promise<void> => {
        const body = reply.trim();
        if (!body || busy) return;
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

    const showMenu = item.state === "closed" || resolutions.length > 0;

    // matron://item / matron://mission deep links inside the item body + comment threads open the
    // target tracker surface in-app (F6) — same handler the timeline uses.
    const onTrackerLink = (kind: "item", num: number): void => client.openTrackerLink(kind, num);

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

                {item.labels.length > 0 ? (
                    <div className="mj_TrackerLabels">
                        {item.labels.map((label) => (
                            <span key={label} className="mj_TrackerLabel">
                                {label}
                            </span>
                        ))}
                    </div>
                ) : null}

                {item.links.length > 0 ? (
                    <div className="mj_TrackerLinks">
                        {item.links.map((link) => (
                            <a
                                key={link.url}
                                className="mj_TrackerLinkChip"
                                href={link.url}
                                target="_blank"
                                rel="noreferrer noopener"
                            >
                                {link.title?.trim() || link.url}
                            </a>
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
                <textarea
                    className="mj_TrackerComposer_input"
                    placeholder="Reply…"
                    value={reply}
                    disabled={busy}
                    onChange={(event) => setReply(event.target.value)}
                    onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
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
    );
}
