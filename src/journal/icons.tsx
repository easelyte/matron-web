/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

type IconProps = React.SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...props}
        >
            {children}
        </svg>
    );
}

export function SettingsIcon(props: IconProps): React.ReactElement {
    // v3 mock uses a sliders/faders glyph (not the cog) for settings (#519).
    return (
        <Icon {...props}>
            <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
            <circle cx="15" cy="8" r="2" />
            <circle cx="9" cy="16" r="2" />
        </Icon>
    );
}

export function SystemThemeIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <rect x="3" y="4" width="18" height="13" rx="2" />
            <path d="M8 21h8M12 17v4" />
        </Icon>
    );
}

export function LightThemeIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
        </Icon>
    );
}

export function DarkThemeIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />
        </Icon>
    );
}

export function ComposeIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M12 20h8" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
        </Icon>
    );
}

export function FileEditIcon(props: IconProps): React.ReactElement {
    return (
        <Icon width={16} height={16} {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="M15.5 12.5a2.1 2.1 0 0 1 3 3L12 22l-4 1 1-4Z" />
        </Icon>
    );
}

export function SearchIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
        </Icon>
    );
}

export function MarkAllReadIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="m3 12 4 4 8-9" />
            <path d="m11 15 2 2 8-9" />
        </Icon>
    );
}

export function MarkReadIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="m5 12 4 4 10-10" />
        </Icon>
    );
}

export function CheckIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="m5 12 4 4 10-10" />
        </Icon>
    );
}

export function InactiveIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <circle cx="12" cy="12" r="7" />
            <path d="M9 12h6" />
        </Icon>
    );
}

export function AnthropicMark(props: IconProps): React.ReactElement {
    return (
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
            <path d="M13.7 3h3.1L22 21h-3.5l-1.4-5h-6.7l1-3h4.9l-2-7.1L9.4 21H6L12.2 3h1.5ZM5.6 8.2 9.9 21H6.5L2 8.2h3.6Z" />
        </svg>
    );
}

export function OpenAIMark(props: IconProps): React.ReactElement {
    return (
        <svg viewBox="-4 -4 32 32" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
            <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
        </svg>
    );
}

export function InterruptedIcon(props: IconProps): React.ReactElement {
    return (
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
            <path d="M4 5.5h5V8H4zM11 5.5h2V8h-2zM15 5.5h5V8h-5zM4 10.75h3.5v2.5H4zM9.5 10.75H14v2.5H9.5zM16 10.75h4v2.5h-4zM4 16h5v2.5H4zM11 16h2v2.5h-2zM15 16h5v2.5h-5z" />
        </svg>
    );
}

export function FailedIcon(props: IconProps): React.ReactElement {
    return (
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
            <path
                fillRule="evenodd"
                d="M10.3 3a2 2 0 0 1 3.4 0l8 14A2 2 0 0 1 20 20H4a2 2 0 0 1-1.7-3l8-14ZM12 7a1 1 0 0 0-1 1v5a1 1 0 1 0 2 0V8a1 1 0 0 0-1-1Zm0 8.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"
                clipRule="evenodd"
            />
        </svg>
    );
}

export function PinIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" />
            <path d="M12 16v4" />
        </Icon>
    );
}

export function StarIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.9 7.2 19l.9-5.4L4.2 9.7l5.4-.8L12 4Z" />
        </Icon>
    );
}

export function StarFilledIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props} fill="currentColor">
            <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.9 7.2 19l.9-5.4L4.2 9.7l5.4-.8L12 4Z" />
        </Icon>
    );
}

export function MarkUnreadIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <circle cx="17" cy="7" r="3" fill="currentColor" stroke="none" />
            <path d="M4 7h7M4 12h16M4 17h16" />
        </Icon>
    );
}

export function ArchiveIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M4 7h16v13H4Z" />
            <path d="M3 4h18v3H3ZM9 11h6" />
        </Icon>
    );
}

export function UnarchiveIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M4 7h16v13H4Z" />
            <path d="M3 4h18v3H3ZM12 16v-5m-3 3 3-3 3 3" />
        </Icon>
    );
}

export function KebabIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props} fill="currentColor" stroke="none">
            <circle cx="5" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="19" cy="12" r="1.5" />
        </Icon>
    );
}

export function ChevronLeftIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="m15 18-6-6 6-6" />
        </Icon>
    );
}

export function ReactionIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
            <path d="M9 9h.01M15 9h.01" />
        </Icon>
    );
}

export function AttachmentIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9 17.4a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        </Icon>
    );
}

export function MicOnIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
        </Icon>
    );
}

export function StopIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props} fill="currentColor" stroke="none">
            <rect x="6" y="6" width="12" height="12" rx="1" />
        </Icon>
    );
}

export function TrashIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" />
        </Icon>
    );
}

export function SendIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props} fill="currentColor" stroke="none">
            <path d="M3.4 3.2 21 11.3a.8.8 0 0 1 0 1.4L3.4 20.8a.8.8 0 0 1-1.1-.9L4 13l9-1-9-1-1.7-6.9a.8.8 0 0 1 1.1-.9Z" />
        </Icon>
    );
}

export function CompactIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            {/* two arrows collapsing inward — compress, matches apple's arrow.down.right.and.arrow.up.left */}
            <path d="M9 9 4 4M4 8V4h4" />
            <path d="m15 15 5 5M20 16v4h-4" />
        </Icon>
    );
}

export function ChevronDownIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="m6 9 6 6 6-6" />
        </Icon>
    );
}

export function CloseIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M18 6 6 18M6 6l12 12" />
        </Icon>
    );
}

// Upload-modal header glyph: an up-arrow rising out of a tray (design *-upload-* statics).
export function UploadTrayIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M12 16V4M12 4 7 9M12 4l5 5" />
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
        </Icon>
    );
}

// Document glyph for the upload file-info row (folded-corner sheet, design *-upload-* statics).
export function FileIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
        </Icon>
    );
}

// File-kind affordances (§6): the file tile picks one of these from payload.content_type
// via fileKindFromMime(). All share the folded-sheet silhouette + a kind mark; unknown MIME
// falls back to the plain FileIcon above.
export function ImageFileIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <circle cx="9" cy="13" r="1.3" />
            <path d="m8 19 3-3 2 2 2-2 3 3" />
        </Icon>
    );
}

export function PdfFileIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="M8 13v5M8 13h1.5a1.3 1.3 0 0 1 0 2.6H8M13 13v5M13 13h2M13 15.5h1.5M17.5 13v5M17.5 13h1.8" />
        </Icon>
    );
}

export function TextFileIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8M8 16h8M8 19h5" />
        </Icon>
    );
}

export function AudioFileIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="M15 12v5.2a1.7 1.7 0 1 1-1.6-1.7H15M15 12l-4 1v4.2a1.7 1.7 0 1 1-1.6-1.7H11" />
        </Icon>
    );
}

export function VideoFileIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="m10 13 5 3-5 3Z" />
        </Icon>
    );
}

export function ArchiveFileIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="M11 12v1M11 15v1M11 18v1.5a1 1 0 0 0 2 0V18M11 13h2M11 16h2" />
        </Icon>
    );
}

// Message-context-menu gutter icons (§10.7: every row carries an icon).
export function ClipboardIcon(props: IconProps): React.ReactElement {
    // Plain "Copy" — a clipboard/overlapping-sheets glyph (design light-message-menu).
    return (
        <Icon {...props}>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" />
        </Icon>
    );
}

export function MarkdownIcon(props: IconProps): React.ReactElement {
    // "Copy as Markdown" — a document with the M/V markdown glyph.
    return (
        <Icon {...props}>
            <rect x="3" y="6" width="18" height="12" rx="2" />
            <path d="M7 15V9l2.5 3L12 9v6M16 9v6M16 15h2.5" />
        </Icon>
    );
}

export function CodeBracketsIcon(props: IconProps): React.ReactElement {
    // "View source" — code angle-brackets (also the event-source header glyph).
    return (
        <Icon {...props}>
            <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
        </Icon>
    );
}

// Media-viewer glyphs (loop #568). Chevron-right mirrors ChevronLeftIcon; the rest are the
// zoom + download affordances the lightbox needs.
export function ChevronRightIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="m9 18 6-6-6-6" />
        </Icon>
    );
}

export function DownloadIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M12 3v12" />
            <path d="m7 11 5 4 5-4" />
            <path d="M5 20h14" />
        </Icon>
    );
}

export function ZoomInIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M6 12h12" />
            <path d="M12 6v12" />
        </Icon>
    );
}

export function ZoomOutIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M6 12h12" />
        </Icon>
    );
}

// Fit ↔ 100% toggle — four corner arrows folding inward.
export function FitIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M9 4H5a1 1 0 0 0-1 1v4" />
            <path d="M15 4h4a1 1 0 0 1 1 1v4" />
            <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
            <path d="M15 20h4a1 1 0 0 0 1-1v-4" />
        </Icon>
    );
}

export function ResetIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M4 12a8 8 0 1 1 2.34 5.66" />
            <path d="M4 20v-4h4" />
        </Icon>
    );
}
