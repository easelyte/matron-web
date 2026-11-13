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

import { shortcutLabel } from "./shortcuts";
import {
    ConversationsIcon,
    DecisionsIcon,
    MemoriesIcon,
    PersonCheckIcon,
    ProjectsIcon,
    PulseIcon,
    SearchIcon,
} from "./icons";

export type NavKey = "search" | "projects" | "decisions" | "conversations" | "memories" | "ops";

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
    // Host health and usage.
    { key: "ops", label: "Ops", Icon: PulseIcon, countNoun: "" },
];

/** The Coordinator entry: whether its conversation is on screen, its unread count, and the tap. */
export interface NavRailCoordinator {
    selected: boolean;
    unread: number;
    onOpen: () => void;
}

export function NavRail({
    active,
    counts,
    onSelect,
    coordinator,
    footer,
}: {
    active: NavKey;
    counts: Partial<Record<NavKey, number>>;
    onSelect: (key: NavKey) => void;
    coordinator?: NavRailCoordinator;
    footer?: React.ReactNode;
}): React.ReactElement {
    return (
        <nav className="mj_NavRail" aria-label="Sections" data-testid="nav-rail">
            {coordinator && (
                <button
                    type="button"
                    className="mj_NavRail_entry"
                    data-nav="coordinator"
                    aria-current={coordinator.selected ? "page" : undefined}
                    aria-label={coordinator.unread > 0 ? `Coordinator, ${coordinator.unread} unread` : "Coordinator"}
                    title="Coordinator"
                    onClick={coordinator.onOpen}
                >
                    <span className="mj_NavRail_icon" aria-hidden="true">
                        <PersonCheckIcon />
                        {coordinator.unread > 0 && (
                            <span className="mj_NavRail_badge">
                                {coordinator.unread > 99 ? "99+" : coordinator.unread}
                            </span>
                        )}
                    </span>
                    <span className="mj_NavRail_label" aria-hidden="true">
                        Coordinator
                    </span>
                </button>
            )}
            {ENTRIES.map(({ key, label, Icon, countNoun }) => {
                const count = counts[key] ?? 0;
                // The Coordinator's conversation is under Conversations, but its own entry is current.
                const selected = key === active && !(key === "conversations" && coordinator?.selected);
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
            })}
            <div className="mj_NavRail_spacer" />
            {/* Search sits at the foot, where the Mac had "Go to": it reaches every section and every number. */}
            <button
                type="button"
                className="mj_NavRail_entry mj_NavRail_search"
                data-nav="search"
                aria-current={active === "search" ? "page" : undefined}
                aria-label="Search"
                title={`Search (${shortcutLabel("k")})`}
                onClick={() => onSelect("search")}
            >
                <span className="mj_NavRail_icon" aria-hidden="true">
                    <SearchIcon />
                </span>
                <span className="mj_NavRail_label" aria-hidden="true">
                    Search
                </span>
            </button>
            {footer && <div className="mj_NavRail_footer">{footer}</div>}
        </nav>
    );
}
