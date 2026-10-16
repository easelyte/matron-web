/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * A subagent's transcript in a pane beside its parent chat, as on the Mac: read-only, with no
 * composer. It opens 380px wide and its left edge drags wider (never narrower than that, and never
 * leaving the chat less than 420px); the width is not remembered. When the chat area is narrower
 * than 820px the pane covers the chat instead, with a back button in place of the close button.
 * A Subtask line inside the pane switches the pane to that sibling, and a menu in the header
 * switches between siblings when there are several.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "./client";
import { ChevronLeftIcon, CloseIcon } from "./icons";
import { buildMediaCorpus, MediaViewer, MediaViewerContext, type MediaViewerContextValue } from "./media-viewer";
import { MarkdownPreviewContext, type MarkdownPreviewContextValue, useMarkdownPreview } from "./markdown-preview";
import { displayTitle } from "./SessionTag";
import { clampSidePaneWidth, SIDE_BY_SIDE_MIN_WIDTH, SIDE_PANE_MIN_WIDTH } from "./subtask";
import { childrenOf, type Conversation, type JournalEvent } from "./types";

/** One transcript row and its rendered content. */
export interface SubChatRow {
    event: JournalEvent;
    content: React.ReactNode;
}

/** Where the chat area is on screen: from the chat's left edge to the app's right edge. */
export interface ChatArea {
    left: number;
    top: number;
    bottom: number;
    width: number;
    /** `width` less a Markdown preview open at the right edge: the room the chat and the pane
     *  share beside it. Only the pane's width is limited by it; whether the pane covers the chat
     *  is decided from `width`, so opening a preview never flips the pane over the preview. */
    room: number;
}

/**
 * Measures the chat area while `active`, following window and layout resizes. The pane decides
 * from it whether it fits beside the chat or covers it.
 */
export function useChatArea(
    app: React.RefObject<HTMLElement | null>,
    chat: React.RefObject<HTMLElement | null>,
    active: boolean,
): ChatArea | undefined {
    const [area, setArea] = useState<ChatArea>();
    useLayoutEffect(() => {
        if (!active) {
            setArea(undefined);
            return undefined;
        }
        const measure = (): void => {
            const appNode = app.current;
            const chatNode = chat.current;
            if (!appNode || !chatNode) return;
            const appRect = appNode.getBoundingClientRect();
            const chatRect = chatNode.getBoundingClientRect();
            // A Markdown preview open beside them takes its own room from the chat and the pane.
            const preview = appNode.querySelector(".mj_MdPreview");
            const previewWidth = preview ? preview.getBoundingClientRect().width : 0;
            const width = Math.round(appRect.right - chatRect.left);
            const next = {
                left: Math.round(chatRect.left),
                top: Math.round(chatRect.top),
                bottom: Math.round(chatRect.bottom),
                width,
                room: Math.round(width - previewWidth),
            };
            setArea((previous) =>
                previous &&
                previous.left === next.left &&
                previous.top === next.top &&
                previous.bottom === next.bottom &&
                previous.width === next.width &&
                previous.room === next.room
                    ? previous
                    : next,
            );
        };
        measure();
        window.addEventListener("resize", measure);
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
        if (app.current) observer?.observe(app.current);
        if (chat.current) observer?.observe(chat.current);
        return () => {
            window.removeEventListener("resize", measure);
            observer?.disconnect();
        };
    }, [app, chat, active]);
    return area;
}

/** Whether the pane covers the chat rather than sitting beside it. Unmeasured counts as wide. */
export function paneCoversChat(area: ChatArea | undefined): boolean {
    return area !== undefined && area.width < SIDE_BY_SIDE_MIN_WIDTH;
}

// Overlays that own Escape while they are open; the covering pane defers to them.
const PANE_ESCAPE_OWNERS =
    ".mj_MediaViewer_scrim, .mj_MediaBrowser_scrim, .mj_EventSource_scrim, .mj_UploadConfirm_scrim, .mj_NewSessionSheet, .mj_SettingsScrim, .mj_HeaderMenu, [role='menu']";

function isNearBottom(node: HTMLElement): boolean {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

export function SubChatPane({
    client,
    conversations,
    parentId,
    childId,
    area,
    transcript,
}: {
    client: MatronJournalClient;
    conversations: Conversation[];
    parentId: string;
    childId: string;
    area: ChatArea | undefined;
    /** The rows to show, read-only: the chat's own filtering and folding of the transcript. */
    transcript: (events: JournalEvent[], client: MatronJournalClient) => SubChatRow[];
}): React.ReactElement {
    const covering = paneCoversChat(area);
    const child = conversations.find((conversation) => conversation.id === childId);
    const siblings = useMemo(() => childrenOf(conversations, parentId), [conversations, parentId]);
    // An id that is not (yet) among the children still opens: its header says "Subagent".
    const title = child ? displayTitle(child) : "Subagent";
    const running = child ? child.session_state === "running" : true;

    // Tagged with the subagent they belong to, so switching never shows the previous one's rows.
    const [loaded, setLoaded] = useState<{ childId: string; events: JournalEvent[] }>();
    const events = loaded?.childId === childId ? loaded.events : undefined;
    const lastSeq = child?.last_seq;
    // Reloaded whenever the subagent's newest event moves on (live rows land in the local store
    // before the conversation list hears of them).
    useEffect(() => {
        let cancelled = false;
        void client.conversationEvents(childId).then((next) => {
            if (!cancelled) setLoaded({ childId, events: next });
        });
        return () => {
            cancelled = true;
        };
    }, [client, childId, lastSeq]);
    const rows = useMemo(() => (events ? transcript(events, client) : []), [events, transcript, client]);

    // Follows the tail while the reader is at the bottom, like the chat does.
    const scrollRef = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    useEffect(() => {
        following.current = true;
    }, [childId]);
    useLayoutEffect(() => {
        const node = scrollRef.current;
        if (node && following.current) node.scrollTop = node.scrollHeight;
    }, [rows]);

    // The pane's own media viewer: images and files of this subagent.
    const [viewerMediaId, setViewerMediaId] = useState<string>();
    const viewerOpener = useRef<HTMLElement | null>(null);
    const mediaCorpus = useMemo(() => buildMediaCorpus(events ?? []), [events]);
    const openViewer = useCallback((mediaId: string, opener: HTMLElement | null): void => {
        viewerOpener.current = opener;
        setViewerMediaId(mediaId);
    }, []);
    const viewerValue = useMemo<MediaViewerContextValue>(() => ({ openViewer }), [openViewer]);
    useEffect(() => setViewerMediaId(undefined), [childId]);

    // Covering the chat, the pane would hide the Markdown preview that opens beside the chat, so a
    // Markdown file closes the pane first (as the media browser closes itself).
    const markdownPreview = useMarkdownPreview();
    const markdownValue = useMemo<MarkdownPreviewContextValue | undefined>(
        () =>
            markdownPreview && covering
                ? {
                      openMarkdownPreview: (target) => {
                          client.closeSubChat();
                          markdownPreview.openMarkdownPreview(target);
                      },
                  }
                : markdownPreview,
        [markdownPreview, covering, client],
    );

    const openSibling = useCallback((id: string) => client.openSubChat(id), [client]);

    // Beside the chat, opening the pane leaves focus where it was (the Subtask card or pill).
    // Covering the chat, the pane takes focus like a page. Either way, closing it while focus is
    // inside hands focus back to what opened it, or to the composer when that row is gone (the
    // transcript only mounts the rows near the viewport).
    const asideRef = useRef<HTMLElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    useLayoutEffect(() => {
        const active = document.activeElement;
        openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
        const aside = asideRef.current;
        return () => {
            const focused = document.activeElement;
            if (!focused || !aside?.contains(focused)) return;
            const opener = openerRef.current;
            const target =
                opener?.isConnected && !aside.contains(opener)
                    ? opener
                    : document.querySelector<HTMLElement>(".mj_Composer textarea");
            target?.focus();
        };
    }, []);
    useEffect(() => {
        if (covering) closeRef.current?.focus();
    }, [covering]);
    // Covering the chat, the pane is a page on top of it: Escape goes back, unless an overlay on
    // top (the media viewer, a menu) owns the press.
    useEffect(() => {
        if (!covering) return undefined;
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (document.querySelector(PANE_ESCAPE_OWNERS)) return;
            event.preventDefault();
            client.closeSubChat();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [covering, client]);

    const [width, setWidth] = useState(SIDE_PANE_MIN_WIDTH);
    const areaWidth = area?.room;
    const shownWidth = areaWidth === undefined ? width : clampSidePaneWidth(width, areaWidth);
    const stopDragging = useRef<() => void>(() => undefined);
    useEffect(() => () => stopDragging.current(), []);
    const maxWidth = areaWidth === undefined ? SIDE_PANE_MIN_WIDTH : clampSidePaneWidth(Infinity, areaWidth);
    // The handle sits on the pane's left edge: left widens the pane, right narrows it.
    const onResizeKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (areaWidth === undefined) return;
        const step = event.shiftKey ? 64 : 16;
        let next: number | undefined;
        if (event.key === "ArrowLeft") next = shownWidth + step;
        else if (event.key === "ArrowRight") next = shownWidth - step;
        else if (event.key === "Home") next = SIDE_PANE_MIN_WIDTH;
        else if (event.key === "End") next = maxWidth;
        if (next === undefined) return;
        event.preventDefault();
        setWidth(clampSidePaneWidth(next, areaWidth));
    };
    const onResizeStart = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0 || areaWidth === undefined) return;
        event.preventDefault();
        const right = event.clientX + shownWidth;
        const onMove = (move: PointerEvent): void => setWidth(clampSidePaneWidth(right - move.clientX, areaWidth));
        const stop = (): void => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            stopDragging.current = () => undefined;
        };
        stopDragging.current();
        stopDragging.current = stop;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
    };

    const style: React.CSSProperties =
        covering && area ? { left: area.left, top: area.top, height: area.bottom - area.top } : { width: shownWidth };

    return (
        <>
            {!covering && (
                <div
                    className="mj_ResizeHandle mj_ResizeHandle--horizontal mj_SubChatPane_resizer"
                    role="separator"
                    tabIndex={0}
                    aria-orientation="vertical"
                    aria-label="Resize subagent pane"
                    aria-valuenow={shownWidth}
                    aria-valuemin={SIDE_PANE_MIN_WIDTH}
                    aria-valuemax={maxWidth}
                    onPointerDown={onResizeStart}
                    onKeyDown={onResizeKey}
                >
                    <div />
                </div>
            )}
            <aside
                ref={asideRef}
                className={`mj_SubChatPane${covering ? " mj_SubChatPane_covering" : ""}`}
                style={style}
                aria-label={`Subagent ${title}`}
            >
                <header className="mj_SubChatPane_header">
                    {covering && (
                        <button
                            ref={closeRef}
                            type="button"
                            className="mj_IconButton mj_SubChatPane_close"
                            aria-label="Back to chat"
                            title="Back to chat"
                            onClick={() => client.closeSubChat()}
                        >
                            <ChevronLeftIcon aria-hidden />
                        </button>
                    )}
                    <div className="mj_SubChatPane_heading">
                        <h2 className="mj_SubChatPane_title">
                            {running && <span className="mj_Spinner mj_SubChatPane_spinner" aria-hidden="true" />}
                            <span className="mj_SubChatPane_titleText">{title}</span>
                        </h2>
                        <span className="mj_SubChatPane_state">{running ? "Running" : "Finished"}</span>
                    </div>
                    {siblings.length > 1 && (
                        <select
                            className="mj_SubChatPane_switch"
                            aria-label="Switch subagent"
                            title="Switch subagent"
                            value={childId}
                            onChange={(event) => openSibling(event.currentTarget.value)}
                        >
                            {!child && <option value={childId}>Subagent</option>}
                            {siblings.map((sibling) => (
                                <option key={sibling.id} value={sibling.id}>
                                    {`${sibling.session_state === "running" ? "● " : "○ "}${displayTitle(sibling)}`}
                                </option>
                            ))}
                        </select>
                    )}
                    {!covering && (
                        <button
                            ref={closeRef}
                            type="button"
                            className="mj_IconButton mj_SubChatPane_close"
                            aria-label="Close subagent"
                            title="Close subagent"
                            onClick={() => client.closeSubChat()}
                        >
                            <CloseIcon aria-hidden />
                        </button>
                    )}
                </header>
                <div
                    ref={scrollRef}
                    className="mj_SubChatPane_body"
                    onScroll={(event) => {
                        following.current = isNearBottom(event.currentTarget);
                    }}
                >
                    {events === undefined ? (
                        <p className="mj_SubChatPane_empty" role="status">
                            Loading…
                        </p>
                    ) : rows.length === 0 ? (
                        <p className="mj_SubChatPane_empty" role="status">
                            No messages yet
                        </p>
                    ) : (
                        <MediaViewerContext.Provider value={viewerValue}>
                            <MarkdownPreviewContext.Provider value={markdownValue}>
                                <ol className="mj_SubChatPane_list" aria-label="Subagent transcript">
                                    {rows.map(({ event, content }) => (
                                        <li
                                            key={event.seq}
                                            className="mj_SubChatPane_row"
                                            data-self={event.sender.startsWith("user:")}
                                        >
                                            <div className="mj_TextBody">
                                                <div className="markdown-body">{content}</div>
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                            </MarkdownPreviewContext.Provider>
                        </MediaViewerContext.Provider>
                    )}
                </div>
                <div className="mj_ReadOnlyHint">Read-only — subagent transcript</div>
            </aside>
            {viewerMediaId && mediaCorpus.length > 0 && (
                <MediaViewer
                    client={client}
                    items={mediaCorpus}
                    initialMediaId={viewerMediaId}
                    opener={viewerOpener.current}
                    onClose={() => setViewerMediaId(undefined)}
                />
            )}
        </>
    );
}
