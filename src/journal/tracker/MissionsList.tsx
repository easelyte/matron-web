/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Missions list — an Open section (sorted by most-recent milestone) and a collapsible Closed
 * section (default collapsed, sorted by close time). Rows lead with a state glyph and a #number,
 * carry a one-line last-milestone summary, and show a NeedsYou badge for missions with items
 * awaiting the user. Purely presentational — the parent supplies the missions and the open handler.
 */

import React, { useMemo, useState } from "react";

import type { Mission } from "../types";
import { formatRelativeTime, missionLabel, oneLine } from "./format";
import { MilestoneGlyph, MissionGlyph, NeedsYouBadge } from "./glyphs";

function MissionRow({ mission, onOpen }: { mission: Mission; onOpen: (num: number) => void }): React.ReactElement {
    const closed = mission.state === "closed";
    const last = mission.last_milestone;
    const summary = closed ? oneLine(mission.close_summary ?? "") : "";
    return (
        <button
            type="button"
            className="mj_TrackerMissionRow"
            aria-label={`Mission number ${mission.num}, ${missionLabel(mission)}${
                mission.needs_you > 0 ? `, ${mission.needs_you} awaiting you` : ""
            }`}
            onClick={() => onOpen(mission.num)}
        >
            <span className="mj_TrackerMissionRow_glyph" aria-hidden="true">
                <MissionGlyph state={mission.state} />
            </span>
            <span className="mj_TrackerMissionRow_main">
                <span className="mj_TrackerMissionRow_title">{missionLabel(mission)}</span>
                <span className="mj_TrackerMissionRow_meta">
                    <span className="mj_TrackerMissionRow_num">#{mission.num}</span>
                    <span className="mj_TrackerMissionRow_sep">·</span>
                    {last ? (
                        <>
                            <MilestoneGlyph kind={last.kind} aria-hidden="true" />
                            <span className="mj_TrackerMissionRow_milestone">{oneLine(last.title)}</span>
                            <span className="mj_TrackerMissionRow_age">{formatRelativeTime(last.created_at)}</span>
                        </>
                    ) : (
                        <span className="mj_TrackerMissionRow_milestone">
                            {closed ? "Closed" : "No milestones yet"}
                        </span>
                    )}
                </span>
                {summary ? <span className="mj_TrackerMissionRow_summary">{summary}</span> : null}
            </span>
            <NeedsYouBadge count={mission.needs_you} />
        </button>
    );
}

export function MissionsList({
    missions,
    onOpenMission,
}: {
    missions: Mission[];
    onOpenMission: (num: number) => void;
}): React.ReactElement {
    const [showClosed, setShowClosed] = useState(false);

    const { open, closed } = useMemo(() => {
        const openList = missions
            .filter((mission) => mission.state === "open")
            .sort(
                (a, b) =>
                    (b.last_milestone_at ?? -Infinity) - (a.last_milestone_at ?? -Infinity) ||
                    b.created_at - a.created_at,
            );
        const closedList = missions
            .filter((mission) => mission.state === "closed")
            .sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
        return { open: openList, closed: closedList };
    }, [missions]);

    if (missions.length === 0) {
        return (
            <div className="mj_TrackerEmpty">
                <p className="mj_TrackerEmpty_title">No missions yet</p>
                <p className="mj_TrackerEmpty_hint">An agent starts one with mission_start.</p>
            </div>
        );
    }

    return (
        <div className="mj_TrackerList">
            {open.length > 0 ? (
                <section className="mj_TrackerSection">
                    <h2 className="mj_TrackerSection_header">Open</h2>
                    {open.map((mission) => (
                        <MissionRow key={mission.id} mission={mission} onOpen={onOpenMission} />
                    ))}
                </section>
            ) : null}

            {closed.length > 0 ? (
                <section className="mj_TrackerSection">
                    <button
                        type="button"
                        className="mj_TrackerSection_toggle"
                        aria-expanded={showClosed}
                        onClick={() => setShowClosed((value) => !value)}
                    >
                        <span
                            className={`mj_TrackerSection_chevron${showClosed ? " mj_TrackerSection_chevron_open" : ""}`}
                        >
                            ›
                        </span>
                        Closed ({closed.length})
                    </button>
                    {showClosed
                        ? closed.map((mission) => (
                              <MissionRow key={mission.id} mission={mission} onOpen={onOpenMission} />
                          ))
                        : null}
                </section>
            ) : null}
        </div>
    );
}
