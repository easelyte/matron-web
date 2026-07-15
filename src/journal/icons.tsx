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
    return (
        <Icon {...props}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V20h-2v-.09A1.7 1.7 0 0 0 12.4 18.4a1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.44 15a1.7 1.7 0 0 0-1.55-1H8v-2h.09A1.7 1.7 0 0 0 9.6 10.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06L10.62 7.6l.06.06A1.7 1.7 0 0 0 12.56 8a1.7 1.7 0 0 0 1-1.55V6h2v.09a1.7 1.7 0 0 0 1.04 1.51 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.42 1.42-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1H21v2h-.09A1.7 1.7 0 0 0 19.4 15Z" />
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

export function SearchIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
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

export function SendIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props} fill="currentColor" stroke="none">
            <path d="M3.4 3.2 21 11.3a.8.8 0 0 1 0 1.4L3.4 20.8a.8.8 0 0 1-1.1-.9L4 13l9-1-9-1-1.7-6.9a.8.8 0 0 1 1.1-.9Z" />
        </Icon>
    );
}
