/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Projects home (unify step 7): the Mac's card dashboard (MacProjectsHome / ProjectCardView).
 * One card per open project — title, a red "Needs you · n" pill, the status preview (or "No status
 * yet"), and a footer with the open-mission count and the last activity. Missions in no project
 * follow, the ones quiet for over a week folded away, and closed projects sit behind a toggle. A
 * filter field narrows the page to the projects and missions the typed words name; "New project"
 * opens its sheet. Presentational: the pane owns loading, routing and the writes.
 */

import React, { useState } from "react";

import { SearchField } from "../search-field";
import type { Mission, Project } from "../types";
import { formatRelativeTime, oneLine } from "./format";
import { NewProjectSheet, useRowMove } from "./ProjectFiling";
import { filterProjects, filterTerms, missionMatches } from "./projectsFilter";

/** "Quiet for over a week": the journal's own threshold, quiet from exactly seven days. */
export const QUIET_AFTER_MS = 7 * 86_400_000;

/** When anything last happened on a mission: the journal's `last_activity_at` when it sends one,
 *  else the newest of its last milestone, status and update. */
export function missionLastActivity(mission: Mission): number {
    return (
        mission.last_activity_at ??
        Math.max(mission.last_milestone_at ?? 0, mission.status_updated_at ?? 0, mission.updated_at, mission.created_at)
    );
}

/** Quiet: the journal's rollup when it sends one, else a week without activity. Anything asking
 *  the user is never quiet, so the fold can never hide a question. */
export function isQuietMission(mission: Mission, now: number): boolean {
    if (mission.needs_you > 0) return false;
    if (mission.activity) return mission.activity === "quiet";
    return now - missionLastActivity(mission) >= QUIET_AFTER_MS;
}

/** The row dot both project views use: running, waiting (a waiting rollup or anything needing you), or idle. */
export function activityClass(activity: string | undefined, needsYou: number, open: boolean): string {
    if (!open) return "idle";
    if (activity === "running") return "running";
    if (activity === "waiting" || needsYou > 0) return "waiting";
    return "idle";
}

export function NeedsYouPill({ count }: { count: number }): React.ReactElement | null {
    if (count <= 0) return null;
    return <span className="mj_NeedsYouPill">Needs you · {count}</span>;
}

export function openMissionCount(project: Project): number {
    const { running, waiting, idle, quiet } = project.missions;
    return running + waiting + idle + quiet;
}

export function plural(count: number, noun: string, nounPlural = `${noun}s`): string {
    return `${count} ${count === 1 ? noun : nounPlural}`;
}

function ProjectCard({
    project,
    matchedMission,
    onOpen,
}: {
    project: Project;
    /** Filtering: the mission that put this project in the results, when its title didn't. */
    matchedMission?: string;
    onOpen: (num: number) => void;
}): React.ReactElement {
    const status = project.status ? oneLine(project.status) : null;
    return (
        <button
            type="button"
            className={`mj_ProjectCard${project.state === "closed" ? " mj_ProjectCard_closed" : ""}`}
            onClick={() => onOpen(project.num)}
        >
            <span className="mj_ProjectCard_head">
                <span className="mj_ProjectCard_title">{project.title}</span>
                <NeedsYouPill count={project.needs_you} />
            </span>
            <span className={`mj_ProjectCard_status${status ? "" : " mj_ProjectCard_status_empty"}`}>
                {status ?? "No status yet"}
            </span>
            {matchedMission ? <span className="mj_ProjectCard_match">Mission: {matchedMission}</span> : null}
            <span className="mj_ProjectCard_footer">
                {plural(openMissionCount(project), "open mission")} · last activity{" "}
                {formatRelativeTime(project.last_activity_at)}
            </span>
        </button>
    );
}

function LooseMissionRow({
    mission,
    onOpen,
    rowProps,
}: {
    mission: Mission;
    onOpen: (num: number) => void;
    rowProps: Record<string, unknown>;
}): React.ReactElement {
    return (
        <button type="button" className="mj_ProjectMission" onClick={() => onOpen(mission.num)} {...rowProps}>
            <span
                className={`mj_ProjectMission_dot mj_ProjectMission_dot_${activityClass(mission.activity, mission.needs_you, true)}`}
                aria-hidden="true"
            />
            <span className="mj_ProjectNum">#{mission.num}</span>
            <span className="mj_ProjectMission_main">
                <span className="mj_ProjectMission_title">{mission.title}</span>
                <span className="mj_ProjectMission_status">
                    {mission.last_milestone ? oneLine(mission.last_milestone.title) : "No milestones yet"}
                </span>
            </span>
            <NeedsYouPill count={mission.needs_you} />
        </button>
    );
}

export function ProjectsDashboard({
    header,
    projects,
    unfiled = [],
    onOpenProject,
    onOpenMission = () => undefined,
    onCreateProject,
    onMoveMission,
    now = Date.now(),
}: {
    /** Heads the dashboard above the cards (the Coordinator's latest briefing card). */
    header?: React.ReactNode;
    projects: Project[];
    /** All loaded missions; the open ones in no project are listed below the cards (Mac "Unfiled"). */
    unfiled?: Mission[];
    onOpenProject: (num: number) => void;
    onOpenMission?: (num: number) => void;
    /** "New project": resolves to why it failed, or null once made. Without it there is no button. */
    onCreateProject?: (title: string, body: string) => Promise<string | null>;
    /** A mission row's right-click "Move to project…". Resolves to why it did not, or null once moved. */
    onMoveMission?: (missionId: string, projectId: string) => Promise<string | null>;
    /** Injectable for tests. */
    now?: number;
}): React.ReactElement {
    const [showClosed, setShowClosed] = useState(false);
    const [showQuiet, setShowQuiet] = useState(false);
    const [creating, setCreating] = useState(false);
    const [query, setQuery] = useState("");
    const rowMove = useRowMove(projects, onMoveMission);
    const terms = filterTerms(query);
    const filtering = terms.length > 0;
    const allOpen = projects.filter((project) => project.state === "open");
    const open = filterProjects(terms, allOpen, unfiled);
    // Merged projects are closed into another; their missions moved, so they are not listed.
    const closed = filterProjects(
        terms,
        projects.filter((project) => project.state !== "open" && project.merged_into_num == null),
        unfiled,
    );
    const allLoose = unfiled.filter(
        (mission) => mission.state === "open" && !mission.project_id && missionMatches(terms, mission),
    );
    const loose = allLoose.filter((mission) => !isQuietMission(mission, now));
    const quiet = allLoose
        .filter((mission) => isQuietMission(mission, now))
        .sort((a, b) => missionLastActivity(b) - missionLastActivity(a));
    // Closed projects that match are results too, so the filter shows them without the toggle; the
    // quiet fold's rows likewise, and a tap on it then changes nothing until the filter clears.
    const closedShown = showClosed || filtering;
    const quietShown = showQuiet || filtering;

    const newProject = onCreateProject ? (
        <button type="button" className="mj_TrackerButton mj_ProjectsNew" onClick={() => setCreating(true)}>
            New project
        </button>
    ) : null;
    const newProjectSheet =
        creating && onCreateProject ? (
            <NewProjectSheet onCreate={onCreateProject} onClose={() => setCreating(false)} />
        ) : null;

    if (projects.length === 0 && allLoose.length === 0 && !filtering) {
        const empty = (
            <div className="mj_TrackerEmpty">
                <p className="mj_TrackerEmpty_title">No projects yet</p>
                <p className="mj_TrackerEmpty_hint">Agents file their missions into projects as they start work.</p>
                {newProject}
                {newProjectSheet}
            </div>
        );
        return header ? (
            <div className="mj_ProjectsDashboard">
                {header}
                {empty}
            </div>
        ) : (
            empty
        );
    }

    return (
        <div className="mj_ProjectsDashboard">
            {header}
            <div className="mj_ProjectsFilter">
                <SearchField
                    className="mj_ProjectsFilter_field"
                    label="Filter projects"
                    placeholder="Filter projects"
                    value={query}
                    onChange={setQuery}
                />
                {filtering ? (
                    <span className="mj_ProjectsFilter_count" role="status">
                        {open.length} of {allOpen.length}
                    </span>
                ) : null}
                {newProject}
            </div>
            {newProjectSheet}
            {rowMove.layer}
            {filtering && open.length === 0 && closed.length === 0 && allLoose.length === 0 ? (
                <div className="mj_TrackerEmpty">
                    <p className="mj_TrackerEmpty_title">No projects match “{query.trim()}”</p>
                    <p className="mj_TrackerEmpty_hint">Check the spelling or try another word.</p>
                </div>
            ) : null}
            <div className="mj_ProjectsGrid">
                {open.map(({ project, matchedMission }) => (
                    <ProjectCard
                        key={project.id}
                        project={project}
                        matchedMission={matchedMission}
                        onOpen={onOpenProject}
                    />
                ))}
                {closedShown &&
                    closed.map(({ project, matchedMission }) => (
                        <ProjectCard
                            key={project.id}
                            project={project}
                            matchedMission={matchedMission}
                            onOpen={onOpenProject}
                        />
                    ))}
            </div>
            {loose.length > 0 && (
                <section className="mj_ProjectCardSection mj_ProjectsUnfiled">
                    <h2 className="mj_ProjectSection_head">
                        <span className="mj_ProjectSection_title">Not in a project</span>
                        <span className="mj_ProjectSection_count">{loose.length}</span>
                    </h2>
                    {loose.map((mission) => (
                        <LooseMissionRow
                            key={mission.id}
                            mission={mission}
                            onOpen={onOpenMission}
                            rowProps={rowMove.rowProps(mission)}
                        />
                    ))}
                </section>
            )}
            {quiet.length > 0 && (
                <section className="mj_ProjectsQuiet">
                    <button
                        type="button"
                        className="mj_ProjectsQuietToggle"
                        aria-expanded={quietShown}
                        onClick={() => {
                            if (!filtering) setShowQuiet((value) => !value);
                        }}
                    >
                        <span className="mj_ProjectsQuietToggle_chevron" aria-hidden="true">
                            ›
                        </span>
                        Quiet for over a week ({quiet.length})
                    </button>
                    {quietShown ? (
                        <div className="mj_ProjectCardSection mj_ProjectsQuiet_rows">
                            {quiet.map((mission) => (
                                <LooseMissionRow
                                    key={mission.id}
                                    mission={mission}
                                    onOpen={onOpenMission}
                                    rowProps={rowMove.rowProps(mission)}
                                />
                            ))}
                        </div>
                    ) : null}
                </section>
            )}
            {closed.length > 0 && !filtering && (
                <button
                    type="button"
                    className="mj_TrackerTextButton mj_ProjectsClosedToggle"
                    aria-expanded={showClosed}
                    onClick={() => setShowClosed((value) => !value)}
                >
                    {showClosed ? "Hide closed" : `Closed (${closed.length})`}
                </button>
            )}
        </div>
    );
}
