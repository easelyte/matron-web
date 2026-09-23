/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Tracker pane — the main-region surface (rendered alongside the conversation view, one at a
 * time). A header with a close button; the body follows the store's selection: an open item detail
 * wins, otherwise the Decisions/Items inbox. Loads are issued from effects and the data is
 * store-resident, so WS invalidation keeps every surface live. Presentational composition only —
 * all fetching + mutation lives on the client.
 */

import React, { useEffect } from "react";

import type { MatronJournalClient } from "../client";
import { CloseIcon } from "../icons";
import type { ClientState } from "../types";
import { ItemDetail } from "./ItemDetail";
import { ItemsInbox } from "./ItemsInbox";

export function TrackerPane({
    client,
    state,
}: {
    client: MatronJournalClient;
    state: ClientState;
}): React.ReactElement {
    const selectedItemId = state.trackerView?.selectedItemId;

    // Opening the pane primes the inbox so the sidebar badge + list are ready.
    useEffect(() => {
        void client.loadInbox();
    }, [client]);

    useEffect(() => {
        if (selectedItemId != null) void client.loadItem(selectedItemId);
    }, [client, selectedItemId]);

    // The detail back button clears the open item selection. openTrackerView merges with the previous
    // view, so it can't clear a selected id on its own; closing first resets the view, then reopening
    // lands on a clean list.
    const backToInbox = (): void => {
        client.closeTrackerView();
        client.openTrackerView({ view: "inbox" });
    };

    const body = ((): React.ReactElement => {
        // Render a cached detail ONLY when it belongs to the current selection. A detail loaded for
        // a previously selected row is cleared to null on selection change (openTrackerItem), but the
        // num match here is the belt-and-braces guard so a stale record can never drive the detail
        // (whose action handlers close/reopen by that record's num) against the new selection (F1).
        if (selectedItemId != null && state.trackerItem && state.trackerItem.item.num === selectedItemId) {
            return (
                <ItemDetail
                    item={state.trackerItem.item}
                    comments={state.trackerItem.comments}
                    client={client}
                    onBack={backToInbox}
                />
            );
        }
        return (
            <ItemsInbox
                items={state.inboxItems ?? []}
                client={client}
                onOpenItem={(num) => client.openTrackerItem(num)}
            />
        );
    })();

    return (
        <div className="mj_TrackerPane">
            <div className="mj_TrackerPane_top">
                <button
                    type="button"
                    className="mj_IconButton mj_TrackerPane_close"
                    aria-label="Close tracker"
                    onClick={() => client.closeTrackerView()}
                >
                    <CloseIcon />
                </button>
                <h1 className="mj_TrackerPane_title">Tracker</h1>
                {state.trackerLoading ? <span className="mj_TrackerPane_spinner" aria-label="Loading" /> : null}
            </div>

            {state.trackerError ? (
                <div className="mj_TrackerErrorBanner" role="alert">
                    {state.trackerError}
                </div>
            ) : null}

            <div className="mj_TrackerPane_body">{body}</div>
        </div>
    );
}
