/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The conversation's Media / Files / Links browser, opened from the chat header (as on the Mac).
 * A modal sheet with three tabs: Media is a grid of square thumbnails, Files and Links are lists.
 * Everything comes from the conversation's locally stored events (buildMediaBrowserEntries).
 * An image opens the media viewer, stepping through the grid; a file opens the way its chip in the
 * chat does (viewer, Markdown preview, or download); a link opens in a new tab.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "./client";
import { ImageFileIcon, InactiveIcon, LinkIcon, MediaBrowserIcon, FileIcon } from "./icons";
import { buildMediaBrowserEntries, type MediaBrowserEntries } from "./media-browser-model";
import { MediaViewer, MediaViewerContext, type MediaItem, type MediaViewerContextValue } from "./media-viewer";
import { MarkdownPreviewContext, type MarkdownPreviewContextValue, useMarkdownPreview } from "./markdown-preview";
import { formatRelativeTime } from "./tracker/format";

export type MediaBrowserTab = "media" | "files" | "links";
const TABS: readonly { id: MediaBrowserTab; label: string }[] = [
    { id: "media", label: "Media" },
    { id: "files", label: "Files" },
    { id: "links", label: "Links" },
];

function MediaThumb({
    client,
    item,
    onOpen,
}: {
    client: MatronJournalClient;
    item: MediaItem;
    onOpen: (opener: HTMLElement) => void;
}): React.ReactElement {
    const [url, setUrl] = useState<string>();
    const [expired, setExpired] = useState(() => item.expired === true || client.isMediaExpired(item.mediaId));
    // An image is fetched only once its thumbnail comes near the visible part of the grid, so a
    // chat with hundreds of images does not download every one of them when the sheet opens.
    const thumbRef = useRef<HTMLButtonElement>(null);
    const [near, setNear] = useState(() => typeof IntersectionObserver !== "function");
    useEffect(() => {
        const node = thumbRef.current;
        if (near || expired || !node) return undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    observer.disconnect();
                    setNear(true);
                }
            },
            { rootMargin: "200px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [near, expired]);
    useEffect(() => {
        if (expired || !near) return undefined;
        let cancelled = false;
        client.mediaUrl(item.mediaId).then(
            (loaded) => {
                if (!cancelled) setUrl(loaded);
            },
            () => {
                if (!cancelled && client.isMediaExpired(item.mediaId)) setExpired(true);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [client, item.mediaId, expired, near]);
    const label = item.caption || item.filename || "Image";
    if (expired) {
        return (
            <div
                className="mj_MediaBrowser_thumb mj_MediaBrowser_thumb_expired"
                role="img"
                aria-label={`${label}, expired`}
            >
                <InactiveIcon aria-hidden />
            </div>
        );
    }
    return (
        <button
            ref={thumbRef}
            type="button"
            className="mj_MediaBrowser_thumb"
            aria-label={`Open image, ${label}`}
            onClick={(event) => onOpen(event.currentTarget)}
        >
            {url ? (
                <img src={url} alt="" />
            ) : (
                <span className="mj_MediaBrowser_thumbLoading" aria-hidden="true">
                    <ImageFileIcon />
                </span>
            )}
        </button>
    );
}

function EmptyTab({ icon, title }: { icon: React.ReactNode; title: string }): React.ReactElement {
    return (
        <div className="mj_MediaBrowser_empty" role="status">
            {icon}
            <p>{title}</p>
        </div>
    );
}

export function MediaBrowserSheet({
    client,
    convoId,
    renderFile,
    onClose,
}: {
    client: MatronJournalClient;
    convoId: string;
    /** A file row, drawn as the chat draws a file chip (so it opens the same way). */
    renderFile: (item: MediaItem) => React.ReactNode;
    onClose: () => void;
}): React.ReactElement {
    const [tab, setTab] = useState<MediaBrowserTab>("media");
    const [entries, setEntries] = useState<MediaBrowserEntries | "failed">();
    const [viewer, setViewer] = useState<{ items: MediaItem[]; mediaId: string; opener: HTMLElement | null }>();
    const sheetRef = useRef<HTMLDivElement>(null);
    const doneRef = useRef<HTMLButtonElement>(null);
    const tabRefs = useRef<Partial<Record<MediaBrowserTab, HTMLButtonElement | null>>>({});
    const titleId = useId();
    const panelId = useId();

    useEffect(() => {
        let cancelled = false;
        client.conversationEvents(convoId).then(
            (events) => {
                if (!cancelled) setEntries(buildMediaBrowserEntries(events));
            },
            () => {
                if (!cancelled) setEntries("failed");
            },
        );
        return () => {
            cancelled = true;
        };
    }, [client, convoId]);

    // Focus moves into the sheet and back to whatever opened it.
    useEffect(() => {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        tabRefs.current.media?.focus();
        return () => {
            if (opener?.isConnected) opener.focus();
        };
    }, []);

    // Escape closes the sheet, unless the media viewer on top of it is open (it closes first).
    const viewerOpen = useRef(false);
    viewerOpen.current = viewer !== undefined;
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (viewerOpen.current) return;
            event.preventDefault();
            onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    // Files: the viewer steps through the renderable files, and a Markdown file closes the sheet so
    // its preview, beside the chat, is not hidden behind it.
    const files = entries && entries !== "failed" ? entries.files : [];
    const openFileViewer = useCallback(
        (mediaId: string, opener: HTMLElement | null) => setViewer({ items: files, mediaId, opener }),
        [files],
    );
    const fileViewerValue = useMemo<MediaViewerContextValue>(() => ({ openViewer: openFileViewer }), [openFileViewer]);
    const markdownPreview = useMarkdownPreview();
    const fileMarkdownValue = useMemo<MarkdownPreviewContextValue | undefined>(
        () =>
            markdownPreview && {
                openMarkdownPreview: (target) => {
                    onClose();
                    markdownPreview.openMarkdownPreview(target);
                },
            },
        [markdownPreview, onClose],
    );

    const onTabKey = (event: React.KeyboardEvent): void => {
        const index = TABS.findIndex((candidate) => candidate.id === tab);
        let next: MediaBrowserTab;
        if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length].id;
        else if (event.key === "ArrowLeft") next = TABS[(index + TABS.length - 1) % TABS.length].id;
        else if (event.key === "Home") next = TABS[0].id;
        else if (event.key === "End") next = TABS[TABS.length - 1].id;
        else return;
        event.preventDefault();
        setTab(next);
        tabRefs.current[next]?.focus();
    };

    // Tab cycles inside the sheet while it is open.
    const onSheetKey = (event: React.KeyboardEvent): void => {
        if (event.key !== "Tab" || !sheetRef.current) return;
        const focusable = [
            ...sheetRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    let body: React.ReactNode;
    if (entries === undefined) {
        body = (
            <p className="mj_MediaBrowser_loading" role="status">
                Loading…
            </p>
        );
    } else if (entries === "failed") {
        body = <EmptyTab icon={<InactiveIcon aria-hidden />} title="Couldn't load" />;
    } else if (tab === "media") {
        body =
            entries.media.length === 0 ? (
                <EmptyTab icon={<MediaBrowserIcon aria-hidden />} title="No media yet" />
            ) : (
                <div className="mj_MediaBrowser_grid">
                    {entries.media.map((item, index) => (
                        <MediaThumb
                            // The same blob can be posted twice; its position keeps the key unique.
                            key={`${index}:${item.mediaId}`}
                            client={client}
                            item={item}
                            onOpen={(opener) =>
                                setViewer({
                                    items: entries.media.filter((candidate) => !candidate.expired),
                                    mediaId: item.mediaId,
                                    opener,
                                })
                            }
                        />
                    ))}
                </div>
            );
    } else if (tab === "files") {
        body =
            entries.files.length === 0 ? (
                <EmptyTab icon={<FileIcon aria-hidden />} title="No files yet" />
            ) : (
                <MediaViewerContext.Provider value={fileViewerValue}>
                    <MarkdownPreviewContext.Provider value={fileMarkdownValue}>
                        <ul className="mj_MediaBrowser_list mj_MediaBrowser_files">
                            {entries.files.map((item, index) => (
                                <li key={`${index}:${item.mediaId}`} className="mj_MediaBrowser_file">
                                    {renderFile(item)}
                                </li>
                            ))}
                        </ul>
                    </MarkdownPreviewContext.Provider>
                </MediaViewerContext.Provider>
            );
    } else {
        body =
            entries.links.length === 0 ? (
                <EmptyTab icon={<LinkIcon aria-hidden />} title="No links yet" />
            ) : (
                <ul className="mj_MediaBrowser_list mj_MediaBrowser_links">
                    {entries.links.map((link) => (
                        <li key={link.url}>
                            <a
                                className="mj_MediaBrowser_link"
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Link, ${link.url}`}
                            >
                                <span className="mj_MediaBrowser_linkUrl">{link.url}</span>
                                {link.context && <span className="mj_MediaBrowser_linkContext">{link.context}</span>}
                                <time className="mj_MediaBrowser_linkTime" dateTime={new Date(link.ts).toISOString()}>
                                    {formatRelativeTime(link.ts)}
                                </time>
                            </a>
                        </li>
                    ))}
                </ul>
            );
    }

    return (
        <div
            className="mj_MediaBrowser_scrim"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={sheetRef}
                className="mj_MediaBrowser"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onKeyDown={onSheetKey}
            >
                <h2 id={titleId} className="mj_SrOnly">
                    Media, files and links
                </h2>
                <div className="mj_MediaBrowser_head">
                    <div className="mj_MediaBrowser_tabs" role="tablist" aria-label="Show" onKeyDown={onTabKey}>
                        {TABS.map((candidate) => (
                            <button
                                key={candidate.id}
                                id={`${panelId}-${candidate.id}`}
                                ref={(node) => {
                                    tabRefs.current[candidate.id] = node;
                                }}
                                type="button"
                                role="tab"
                                className="mj_MediaBrowser_tab"
                                aria-selected={tab === candidate.id}
                                aria-controls={panelId}
                                tabIndex={tab === candidate.id ? 0 : -1}
                                onClick={() => setTab(candidate.id)}
                            >
                                {candidate.label}
                            </button>
                        ))}
                    </div>
                    <button ref={doneRef} type="button" className="mj_MediaBrowser_done" onClick={onClose}>
                        Done
                    </button>
                </div>
                <div
                    id={panelId}
                    className="mj_MediaBrowser_body"
                    role="tabpanel"
                    aria-labelledby={`${panelId}-${tab}`}
                >
                    {body}
                </div>
            </div>
            {viewer && viewer.items.length > 0 && (
                <MediaViewer
                    client={client}
                    items={viewer.items}
                    initialMediaId={viewer.mediaId}
                    opener={viewer.opener}
                    onClose={() => setViewer(undefined)}
                />
            )}
        </div>
    );
}
