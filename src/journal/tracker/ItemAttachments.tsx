/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Attachments in a tracker item: the item body and each comment render as segments (text through
 * the markdown renderer, an inline `![caption](attachment:<ref>)` as the attachment in place), then
 * the attachments no ref placed. Images load through the client's authenticated blob cache and open
 * the media viewer lightbox on click; other files are a name chip that downloads the file.
 */

import React, { useEffect, useMemo, useState } from "react";

import type { MatronJournalClient } from "../client";
import { DownloadIcon } from "../icons";
import { MarkdownBody } from "../markdown";
import { isPreviewableMarkdown, useMarkdownPreview } from "../markdown-preview";
import { type MediaItem, mediaRenderKind, useMediaViewer } from "../media-viewer";
import {
    fileKindFromMime,
    IMAGE_FRAME_MAX_HEIGHT_PX,
    imageFrameStyle,
    type MediaDims,
    type TrackerAttachment,
    type TrackerComment,
    type TrackerItem,
    type TrackerLinkHandler,
} from "../types";
import { humanizeSize, splitFilenameForMiddleTruncation } from "./format";
import { splitInlineAttachments } from "./inline-attachments";

// SVG is left out: fetched media blobs carry no SVG type (api.ts: inertMediaType), so an <img>
// could not paint one, and an SVG attachment shows as a file chip instead.
export function isImageAttachment(attachment: TrackerAttachment): boolean {
    const mime = attachment.mime.toLowerCase();
    return mime.startsWith("image/") && !mime.startsWith("image/svg");
}

function attachmentDims(attachment: TrackerAttachment): MediaDims | undefined {
    const { width, height } = attachment;
    return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
        ? { width, height }
        : undefined;
}

/** One attachment as the media viewer's item. */
export function trackerMediaItem(attachment: TrackerAttachment, caption?: string): MediaItem {
    const isImage = isImageAttachment(attachment);
    return {
        mediaId: attachment.blob_ref,
        kind: mediaRenderKind(isImage, attachment.mime, attachment.name),
        fileKind: fileKindFromMime(attachment.mime),
        isImageEvent: isImage,
        contentType: attachment.mime,
        filename: attachment.name,
        caption: caption || undefined,
        dims: attachmentDims(attachment),
        size: attachment.size,
    };
}

/**
 * The lightbox corpus for an item: every image in the body and then each comment, in the order
 * they render (inline placements first in text order, then that body's trailing attachments).
 */
export function buildTrackerMediaCorpus(item: TrackerItem, comments: readonly TrackerComment[]): MediaItem[] {
    const corpus: MediaItem[] = [];
    const seen = new Set<string>();
    const add = (attachment: TrackerAttachment, caption?: string): void => {
        if (!isImageAttachment(attachment) || seen.has(attachment.blob_ref)) return;
        seen.add(attachment.blob_ref);
        corpus.push(trackerMediaItem(attachment, caption));
    };
    const addBody = (body: string, attachments: readonly TrackerAttachment[]): void => {
        const { segments, trailing } = splitInlineAttachments(body, attachments);
        for (const segment of segments) {
            if (segment.type === "attachment") add(segment.attachment, segment.caption);
        }
        for (const attachment of trailing) add(attachment);
    };
    addBody(item.body, item.attachments ?? []);
    for (const comment of comments) addBody(comment.body, comment.attachments ?? []);
    return corpus;
}

/**
 * The name-and-size chip a non-image attachment renders as. A markdown file up to 2 MB is a button
 * that opens the side preview panel (where it can also be downloaded) when the app provides one.
 * Any other file is a button that downloads it under its own name: a chip that only showed the
 * name left no way to get the file at all.
 */
export function AttachmentChip({
    client,
    attachment,
}: {
    client?: MatronJournalClient;
    attachment: TrackerAttachment;
}): React.ReactElement {
    const markdownPreview = useMarkdownPreview();
    const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
    if (markdownPreview && isPreviewableMarkdown(attachment)) {
        return (
            <button
                type="button"
                className="mj_TrackerAttachmentChip mj_TrackerAttachmentChip_preview"
                aria-label={`Preview ${attachment.name}`}
                onClick={() =>
                    markdownPreview.openMarkdownPreview({
                        blobRef: attachment.blob_ref,
                        name: attachment.name || "attachment.md",
                        size: attachment.size,
                    })
                }
            >
                {attachment.name}
                <span className="mj_TrackerAttachmentChip_size">{humanizeSize(attachment.size)}</span>
            </button>
        );
    }
    if (client) {
        const download = async (): Promise<void> => {
            setState("loading");
            try {
                saveBlobUrl(await client.mediaUrl(attachment.blob_ref), attachment.name || "attachment");
                setState("idle");
            } catch {
                setState("failed");
            }
        };
        return (
            <button
                type="button"
                className="mj_TrackerAttachmentChip mj_TrackerAttachmentChip_download"
                aria-label={`Download ${attachment.name || "attachment"}`}
                title={`Download ${attachment.name || "attachment"}`}
                disabled={state === "loading"}
                onClick={() => void download()}
            >
                <DownloadIcon className="mj_TrackerAttachmentChip_icon" aria-hidden />
                {attachment.name}
                <span className="mj_TrackerAttachmentChip_size">
                    {state === "loading"
                        ? "Preparing download…"
                        : state === "failed"
                          ? "Couldn't download, try again"
                          : humanizeSize(attachment.size)}
                </span>
            </button>
        );
    }
    return (
        <span className="mj_TrackerAttachmentChip">
            {attachment.name}
            <span className="mj_TrackerAttachmentChip_size">{humanizeSize(attachment.size)}</span>
        </span>
    );
}

/** Saves an object URL from the media cache as `filename`, through a transient download link. */
export function saveBlobUrl(url: string, filename: string): void {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function useBlobUrl(client: MatronJournalClient, blobRef: string): { url?: string; failed: boolean } {
    const [state, setState] = useState<{ ref: string; url?: string; failed: boolean }>({ ref: blobRef, failed: false });
    useEffect(() => {
        let live = true;
        setState({ ref: blobRef, failed: false });
        client.mediaUrl(blobRef).then(
            (url) => {
                if (live) setState({ ref: blobRef, url, failed: false });
            },
            () => {
                if (live) setState({ ref: blobRef, failed: true });
            },
        );
        return () => {
            live = false;
        };
    }, [client, blobRef]);
    // Never show a previous blob's URL for a new ref while it loads.
    return state.ref === blobRef ? state : { failed: false };
}

/**
 * The `name · size` line under an image in a thread. The name is truncated in the middle so the
 * extension stays, the size never truncates, and the line is never wider than the image above it;
 * the full name and size show on hover. `stacked` puts the size on its own line, for the narrow
 * thumbnail tiles. Just the size when the attachment has no name, just the name when it has no size.
 */
export function ImageNameLine({
    attachment,
    stacked = false,
}: {
    attachment: TrackerAttachment;
    stacked?: boolean;
}): React.ReactElement | null {
    const name = attachment.name?.trim() ?? "";
    // A missing size arrives as 0: leave it out rather than claim "0 B".
    const size = attachment.size > 0 ? humanizeSize(attachment.size) : "";
    const { head, tail } = splitFilenameForMiddleTruncation(name);
    const full = [name, size].filter(Boolean).join(" · ");
    if (!full) return null;
    return (
        <span className={`mj_TrackerImageName${stacked ? " mj_TrackerImageName_stacked" : ""}`} title={full}>
            {name ? (
                <span className="mj_TrackerImageName_name">
                    <span className="mj_TrackerImageName_head">{head}</span>
                    <span className="mj_TrackerImageName_tail">{tail}</span>
                </span>
            ) : null}
            {name && size && !stacked ? <span aria-hidden> · </span> : null}
            {size ? <span className="mj_TrackerImageName_size">{size}</span> : null}
        </span>
    );
}

/**
 * An image attachment. `inline` is the full in-text view, sized from the attachment's dimensions so
 * the thread does not reflow when it loads (capped by the column width and the shared frame height);
 * `thumb` is the small square tile a trailing image renders as. Either opens the lightbox on click,
 * and either has its `name · size` line under it.
 */
export function TrackerImage({
    client,
    attachment,
    caption,
    variant,
}: {
    client: MatronJournalClient;
    attachment: TrackerAttachment;
    caption?: string;
    variant: "inline" | "thumb";
}): React.ReactElement {
    const { url, failed } = useBlobUrl(client, attachment.blob_ref);
    const viewer = useMediaViewer();
    const [broken, setBroken] = useState(false);
    const label = caption?.trim() || attachment.name;

    if (failed || broken) {
        return (
            <span className="mj_TrackerImage_failed" role="note">
                <AttachmentChip client={client} attachment={attachment} />
                <span className="mj_TrackerImage_failedText">Image failed to load</span>
            </span>
        );
    }

    const open = (opener: HTMLElement): void => viewer?.openViewer(attachment.blob_ref, opener);
    // Only ever an object URL minted by the client's media cache.
    const img = url?.startsWith("blob:") ? (
        <img src={url} alt={label} onError={() => setBroken(true)} />
    ) : (
        <span className="mj_MediaLoading">{variant === "inline" ? "Loading image…" : ""}</span>
    );
    const zoomable = viewer
        ? {
              role: "button",
              tabIndex: 0,
              "aria-label": `Open image, ${label}`,
              onClick: (event: React.MouseEvent<HTMLElement>) => open(event.currentTarget),
              onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      open(event.currentTarget);
                  }
              },
          }
        : {};

    if (variant === "thumb") {
        return (
            <span className="mj_TrackerThumbTile">
                <span className={`mj_TrackerThumb${viewer ? " mj_Image_zoomable" : ""}`} {...zoomable}>
                    {img}
                </span>
                <ImageNameLine attachment={attachment} stacked />
            </span>
        );
    }

    const dims = attachmentDims(attachment);
    const figureStyle = { "--mj-image-frame-max-height": `${IMAGE_FRAME_MAX_HEIGHT_PX}px` } as React.CSSProperties;
    return (
        <figure className="mj_Image mj_TrackerImage" style={figureStyle}>
            <div
                className={`mj_ImageFrame${dims ? " mj_ImageFrame_sized" : ""}${viewer ? " mj_Image_zoomable" : ""}`}
                style={dims ? imageFrameStyle(dims) : undefined}
                {...zoomable}
            >
                {img}
            </div>
            <ImageNameLine attachment={attachment} />
            {caption?.trim() ? <figcaption>{caption}</figcaption> : null}
        </figure>
    );
}

/** The attachments no ref placed: images as thumbnails, other files as chips. */
export function TrailingAttachments({
    client,
    attachments,
}: {
    client: MatronJournalClient;
    attachments: readonly TrackerAttachment[];
}): React.ReactElement | null {
    if (attachments.length === 0) return null;
    return (
        <div className="mj_TrackerAttachments">
            {attachments.map((attachment) =>
                isImageAttachment(attachment) ? (
                    <TrackerImage key={attachment.blob_ref} client={client} attachment={attachment} variant="thumb" />
                ) : (
                    <AttachmentChip key={attachment.blob_ref} client={client} attachment={attachment} />
                ),
            )}
        </div>
    );
}

/**
 * A body (the item's or a comment's) with its own attachments: the text and inline attachments in
 * order, then the attachments no ref placed.
 */
export function InlineBody({
    client,
    body,
    attachments,
    label,
    onTrackerLink,
    proseClassName = "mj_TrackerProse",
}: {
    client: MatronJournalClient;
    body: string;
    attachments: readonly TrackerAttachment[];
    label: string;
    onTrackerLink: TrackerLinkHandler;
    proseClassName?: string;
}): React.ReactElement | null {
    const { segments, trailing } = useMemo(() => splitInlineAttachments(body, attachments), [body, attachments]);
    if (segments.length === 0 && trailing.length === 0) return null;
    return (
        <>
            {segments.length > 0 ? (
                <div className={proseClassName}>
                    {segments.map((segment, index) =>
                        segment.type === "text" ? (
                            <MarkdownBody
                                key={`t${index}`}
                                text={segment.text}
                                label={`${label}-${index}`}
                                onTrackerLink={onTrackerLink}
                            />
                        ) : isImageAttachment(segment.attachment) ? (
                            <TrackerImage
                                key={`a${index}`}
                                client={client}
                                attachment={segment.attachment}
                                caption={segment.caption}
                                variant="inline"
                            />
                        ) : (
                            <div key={`a${index}`} className="mj_TrackerAttachments">
                                <AttachmentChip client={client} attachment={segment.attachment} />
                            </div>
                        ),
                    )}
                </div>
            ) : null}
            <TrailingAttachments client={client} attachments={trailing} />
        </>
    );
}
