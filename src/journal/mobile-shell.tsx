/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Shell pieces that exist for the phone layout (and the connection-status move out of the old
 * persistent sidebar footer):
 *   - mainSurfaceOpen: which region a phone shows (sidebar XOR main region, CSS-toggled).
 *   - ConnectionStatus / ConnectionBanner: status line for the Settings menu, and a thin banner
 *     that appears ONLY when the connection is down (silent disconnects are worse than noise).
 */

import React, { useEffect, useState } from "react";

import type { MatronJournalClient } from "./client";
import type { ClientState, ConnectionState } from "./types";

/**
 * True when the main region (tracker, files, or a conversation) is the surface in front. On a phone
 * the sidebar and the main region are mutually exclusive, so this one predicate drives BOTH
 * `mj_Sidebar_mobileHidden` and `mj_Chat_mobileHidden`. Keying the sidebar on the selected
 * conversation alone is what made the tracker (and Files) open to a zero-width pane from the list.
 */
export function mainSurfaceOpen(state: ClientState, filesAvailable: boolean): boolean {
    return Boolean(
        state.trackerView?.open ||
        state.opsView?.open ||
        (filesAvailable && state.filesView?.open) ||
        state.selectedConversationId,
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
