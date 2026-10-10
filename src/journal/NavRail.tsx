/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Mac app's navigation rail (MacNavColumn.swift): a fixed 72px column of large icons with
 * labels beneath, one red count badge per entry that has something to show, and the app's
 * chrome (theme, settings, account) at its foot. Entries route to the tracker views or back to
 * the conversation list; the parent owns that routing, so this component knows nothing about
 * the client. The Mac's Coordinator entry is omitted: the web has no Coordinator conversation
 * setting to open (decision on the tracker).
 */

import React from "react";

import { ConversationsIcon, DecisionsIcon, FolderIcon, MemoriesIcon, ProjectsIcon, PulseIcon } from "./icons";

export type NavKey = "projects" | "decisions" | "conversations" | "memories" | "files" | "ops";

/** Width of the rail in CSS px; the list panel's resizer subtracts it. */
export const NAV_RAIL_WIDTH = 72;

const ENTRIES: ReadonlyArray<{
    key: NavKey;
    label: string;
    Icon: (props: React.SVGProps<SVGSVGElement>) => React.ReactElement;
    /** Noun for the badge in the accessible name: "3 unread" / "3 need you". */
    countNoun: string;
}> = [
    { key: "projects", label: "Projects", Icon: ProjectsIcon, countNoun: "need you" },
    // "For you" (was "Decisions"): questions, things to read and secret requests. The key stays.
    { key: "decisions", label: "For you", Icon: DecisionsIcon, countNoun: "need you" },
    { key: "conversations", label: "Conversations", Icon: ConversationsIcon, countNoun: "unread" },
    { key: "memories", label: "Memories", Icon: MemoriesIcon, countNoun: "need you" },
    // Fork additions: the file explorer and the ops page (boxes, quotas, host, alerts, timers).
    { key: "files", label: "Files", Icon: FolderIcon, countNoun: "" },
    { key: "ops", label: "Ops", Icon: PulseIcon, countNoun: "" },
];

export function NavRail({
    active,
    counts,
    onSelect,
    footer,
    filesAvailable = true,
}: {
    active: NavKey;
    counts: Partial<Record<NavKey, number>>;
    onSelect: (key: NavKey) => void;
    footer?: React.ReactNode;
    /** The Files entry is hidden where the file pane cannot run (the packaged desktop app). */
    filesAvailable?: boolean;
}): React.ReactElement {
    return (
        <nav className="mj_NavRail" aria-label="Sections" data-testid="nav-rail">
            {ENTRIES.filter((entry) => entry.key !== "files" || filesAvailable).map(
                ({ key, label, Icon, countNoun }) => {
                    const count = counts[key] ?? 0;
                    const selected = key === active;
                    return (
                        <button
                            key={key}
                            type="button"
                            className="mj_NavRail_entry"
                            data-nav={key}
                            aria-current={selected ? "page" : undefined}
                            aria-label={count > 0 ? `${label}, ${count} ${countNoun}` : label}
                            title={label}
                            onClick={() => onSelect(key)}
                        >
                            <span className="mj_NavRail_icon" aria-hidden="true">
                                <Icon />
                                {count > 0 && <span className="mj_NavRail_badge">{count > 99 ? "99+" : count}</span>}
                            </span>
                            <span className="mj_NavRail_label" aria-hidden="true">
                                {label}
                            </span>
                        </button>
                    );
                },
            )}
            {footer && <div className="mj_NavRail_footer">{footer}</div>}
        </nav>
    );
}
