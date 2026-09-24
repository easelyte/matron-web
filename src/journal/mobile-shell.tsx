/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Shell pieces that exist for the phone layout (and the connection-status move out of the old
 * persistent sidebar footer):
 *   - mainSurfaceOpen: which region a phone shows (sidebar XOR main region, CSS-toggled).
 *   - MobileNav: bottom tab bar (Chats / Tracker / Files) shown at phone widths outside a chat.
 *   - NavBadge: the needs-you count pill shared by the mobile nav and the header tracker button.
 *   - ConnectionStatus / ConnectionBanner: status line for the Settings menu, and a thin banner
 *     that appears ONLY when the connection is down (silent disconnects are worse than noise).
 */

import React, { useEffect, useState } from "react";

import type { MatronJournalClient } from "./client";
import { ChatsIcon, ChecklistIcon, FolderIcon } from "./icons";
import type { ClientState, ConnectionState } from "./types";

/**
 * True when the main region (tracker, files, or a conversation) is the surface in front. On a phone
 * the sidebar and the main region are mutually exclusive, so this one predicate drives BOTH
 * `mj_Sidebar_mobileHidden` and `mj_Chat_mobileHidden`. Keying the sidebar on the selected
 * conversation alone is what made the tracker (and Files) open to a zero-width pane from the list.
 */
export function mainSurfaceOpen(state: ClientState, filesAvailable: boolean): boolean {
    return Boolean(
        state.trackerView?.open || (filesAvailable && state.filesView?.open) || state.selectedConversationId,
    );
}

export function NavBadge({ count }: { count: number | undefined }): React.ReactElement | null {
    if (!count || count <= 0) return null;
    return (
        <span className="mj_NavBadge" aria-hidden="true">
            {count > 99 ? "99+" : count}
        </span>
    );
}

/** Accessible name for a tracker entry point: the count rides in the name, not a hidden span. */
export function trackerLabel(count: number | undefined): string {
    return count && count > 0 ? `Tracker, ${count} need you` : "Tracker";
}

type NavKey = "chats" | "tracker" | "files";

export function MobileNav({
    client,
    state,
    filesAvailable,
}: {
    client: MatronJournalClient;
    state: ClientState;
    filesAvailable: boolean;
}): React.ReactElement | null {
    const tracker = Boolean(state.trackerView?.open);
    const files = filesAvailable && Boolean(state.filesView?.open);
    // Inside an open conversation the composer owns the bottom edge; the header back button leads
    // to the list, which carries this nav.
    if (!tracker && !files && state.selectedConversationId) return null;
    const current: NavKey = tracker ? "tracker" : files ? "files" : "chats";
    const go = (key: NavKey): void => {
        if (key === "chats") {
            client.closeTrackerView();
            client.closeFilesView();
        } else if (key === "tracker") {
            if (!tracker) client.openTrackerView();
        } else if (!files) {
            client.openFilesView();
        }
    };
    const tab = (key: NavKey, label: string, icon: React.ReactElement, badge?: number): React.ReactElement => (
        <button
            key={key}
            type="button"
            data-nav={key}
            className={`mj_MobileNav_tab${current === key ? " mj_MobileNav_tab_active" : ""}`}
            aria-current={current === key ? "page" : undefined}
            aria-label={key === "tracker" ? trackerLabel(badge) : label}
            onClick={() => go(key)}
        >
            <span className="mj_MobileNav_icon">
                {icon}
                <NavBadge count={badge} />
            </span>
            <span className="mj_MobileNav_label">{label}</span>
        </button>
    );
    return (
        <nav className="mj_MobileNav" aria-label="Primary">
            {tab("chats", "Chats", <ChatsIcon />)}
            {tab("tracker", "Tracker", <ChecklistIcon />, state.trackerNeedsYou)}
            {filesAvailable && tab("files", "Files", <FolderIcon />)}
        </nav>
    );
}

export function connectionLabel(connection: ConnectionState): string {
    return connection === "online" ? "Connected" : connection === "connecting" ? "Reconnecting…" : "Offline";
}

/** Status row for the Settings menu: dot + label, plus Reconnect whenever not online. */
export function ConnectionStatus({
    client,
    state,
}: {
    client: MatronJournalClient;
    state: ClientState;
}): React.ReactElement {
    return (
        <div className={`mj_AccountStatus mj_AccountStatus_${state.connection}`}>
            <span className="mj_AccountStatus_dot" aria-hidden="true" />
            <span className="mj_AccountStatus_label" role="status">
                {connectionLabel(state.connection)}
            </span>
            {state.connection !== "online" && (
                <button
                    type="button"
                    className="mj_AccountStatus_reconnect"
                    data-action="reconnect"
                    onClick={() => client.reconnect()}
                >
                    Reconnect
                </button>
            )}
        </div>
    );
}

/** How long the connection must stay down before the banner shows. A normal reconnect or resync
 *  blips through "connecting" for well under this, and sign-in passes through "offline" before the
 *  socket starts; neither should flash a warning. */
export const CONNECTION_BANNER_DELAY_MS = 2_500;

export function ConnectionBanner({
    client,
    state,
}: {
    client: MatronJournalClient;
    state: ClientState;
}): React.ReactElement | null {
    const down = state.connection !== "online";
    const [downLong, setDownLong] = useState(false);
    useEffect(() => {
        if (!down) {
            setDownLong(false);
            return;
        }
        const timer = window.setTimeout(() => setDownLong(true), CONNECTION_BANNER_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [down]);
    if (!down || !downLong) return null;
    return (
        <div
            className={`mj_ConnectionBanner mj_ConnectionBanner_${state.connection}`}
            role="status"
            title={state.connectionError}
        >
            <span className="mj_ConnectionBanner_dot" aria-hidden="true" />
            <span className="mj_ConnectionBanner_text">
                {state.connection === "offline" ? "Offline" : "Reconnecting…"}
            </span>
            <button type="button" className="mj_ConnectionBanner_action" onClick={() => client.reconnect()}>
                Reconnect
            </button>
        </div>
    );
}
