/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Tracker pane — the main-region surface (Phase 3 renders it alongside the Files pane and the
 * conversation view, one at a time). A header with a Missions/Inbox segmented switch and a close
 * button; the body follows the store's selection precedence: an open item detail wins, then an open
 * mission detail, then the list for the active view. Loads are issued from effects and the data is
 * store-resident, so WS invalidation keeps every surface live. Presentational composition only —
 * all fetching + mutation lives on the client.
 */

import React, { useEffect } from "react";

import type { MatronJournalClient } from "../client";
import { CloseIcon } from "../icons";
import type { ClientState } from "../types";
import { ItemDetail } from "./ItemDetail";
import { ItemsInbox } from "./ItemsInbox";
import { MissionDetail } from "./MissionDetail";
import { MissionsList } from "./MissionsList";

export function TrackerPane({
    client,
    state,
}: {
    client: MatronJournalClient;
    state: ClientState;
}): React.ReactElement {
    const view = state.trackerView?.view ?? "inbox";
    const selectedItemId = state.trackerView?.selectedItemId;
    const selectedMissionId = state.trackerView?.selectedMissionId;

    // Opening the pane primes both list views so the sidebar badges + either tab are ready.
    useEffect(() => {
        void client.loadMissions();
        void client.loadInbox();
    }, [client]);

    useEffect(() => {
        if (selectedItemId != null) void client.loadItem(selectedItemId);
    }, [client, selectedItemId]);

    useEffect(() => {
        if (selectedMissionId != null) void client.loadMission(selectedMissionId);
    }, [client, selectedMissionId]);

    // The view switch (and the detail back buttons) clear any open detail selection. openTrackerView
    // merges with the previous view, so it can't clear a selected id on its own; closing first resets
    // the view, then reopening on the wanted tab lands on a clean list.
    const switchView = (next: "missions" | "inbox"): void => {
        client.closeTrackerView();
        client.openTrackerView({ view: next });
    };

    const body = ((): React.ReactElement => {
        if (selectedItemId != null && state.trackerItem) {
            return (
                <ItemDetail
                    item={state.trackerItem.item}
                    comments={state.trackerItem.comments}
                    client={client}
                    onBack={() => switchView("inbox")}
                />
            );
        }
        if (selectedMissionId != null && state.trackerMission) {
            return (
                <MissionDetail
                    detail={state.trackerMission}
                    client={client}
                    onOpenItem={(num) => client.openTrackerItem(num)}
                    onBack={() => switchView("missions")}
                />
            );
        }
        if (view === "missions") {
            return (
                <MissionsList missions={state.missions ?? []} onOpenMission={(num) => client.openTrackerMission(num)} />
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
                <div className="mj_TrackerViewSwitch" role="tablist" aria-label="Tracker view">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === "missions"}
                        className={`mj_TrackerViewSwitch_tab${view === "missions" ? " mj_TrackerViewSwitch_tab_active" : ""}`}
                        onClick={() => switchView("missions")}
                    >
                        Missions
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === "inbox"}
                        className={`mj_TrackerViewSwitch_tab${view === "inbox" ? " mj_TrackerViewSwitch_tab_active" : ""}`}
                        onClick={() => switchView("inbox")}
                    >
                        Inbox
                    </button>
                </div>
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
