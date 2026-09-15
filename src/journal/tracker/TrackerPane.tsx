/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Tracker pane — the main-region surface (Phase 3 renders it alongside the Files pane and the
 * conversation view, one at a time). A header with a Missions/Inbox/Work segmented switch and a close
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
import { WorkView } from "./WorkView";

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

    // Prime the two tracker list views, but NOT while Work is the active tab.
    // Work is served by a different endpoint and shares none of this state, yet
    // priming would fetch /missions and walk the paginated /items inbox (up to
    // 20 pages) on its behalf -- and any failure of those lands in the shared
    // `trackerError`, which renders as an error banner ABOVE a perfectly
    // healthy Work view. Work would look degraded because a dependency it never
    // uses failed. The inbox/missions tabs still prime both, so their badges
    // stay warm exactly as before; switching to one of them from Work primes on
    // arrival.
    useEffect(() => {
        if (view === "work") return;
        void client.loadMissions();
        void client.loadInbox();
    }, [client, view]);

    useEffect(() => {
        if (selectedItemId != null) void client.loadItem(selectedItemId);
    }, [client, selectedItemId]);

    useEffect(() => {
        if (selectedMissionId != null) void client.loadMission(selectedMissionId);
    }, [client, selectedMissionId]);

    // The view switch (and the detail back buttons) clear any open detail selection. openTrackerView
    // merges with the previous view, so it can't clear a selected id on its own; closing first resets
    // the view, then reopening on the wanted tab lands on a clean list.
    const switchView = (next: "missions" | "inbox" | "work"): void => {
        client.closeTrackerView();
        client.openTrackerView({ view: next });
    };

    const body = ((): React.ReactElement => {
        // Render a cached detail ONLY when it belongs to the current selection. A detail loaded for
        // a previously selected row is cleared to null on selection change (openTracker*), but the
        // id/num match here is the belt-and-braces guard so a stale record can never drive the detail
        // (whose action handlers close/reopen by that record's num) against the new selection (F1).
        if (
            view === "inbox" &&
            selectedItemId != null &&
            state.trackerItem &&
            state.trackerItem.item.num === selectedItemId
        ) {
            return (
                <ItemDetail
                    item={state.trackerItem.item}
                    comments={state.trackerItem.comments}
                    client={client}
                    onBack={() => switchView("inbox")}
                />
            );
        }
        if (
            view === "missions" &&
            selectedMissionId != null &&
            state.trackerMission &&
            state.trackerMission.mission?.num === selectedMissionId
        ) {
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
        if (view === "work") {
            return <WorkView api={client} />;
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
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === "work"}
                        className={`mj_TrackerViewSwitch_tab${view === "work" ? " mj_TrackerViewSwitch_tab_active" : ""}`}
                        onClick={() => switchView("work")}
                    >
                        Work
                    </button>
                </div>
                {state.trackerLoading && view !== "work" ? (
                    // Same isolation as the error banner below, and for the same
                    // reason: `trackerLoading` belongs to missions/inbox, which
                    // Work never reads. Gating one without the other would leave a
                    // healthy Work view showing an unrelated tab's spinner
                    // indefinitely if that request hangs.
                    <span className="mj_TrackerPane_spinner" aria-label="Loading" />
                ) : null}
            </div>

            {state.trackerError && view !== "work" ? (
                // `trackerError` belongs to missions/inbox. Work surfaces its own
                // failures inline (fail-loud, never a blank list), so showing this
                // banner over it would attribute an unrelated tab's failure to Work.
                <div className="mj_TrackerErrorBanner" role="alert">
                    {state.trackerError}
                </div>
            ) : null}

            <div className="mj_TrackerPane_body">{body}</div>
        </div>
    );
}
