/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * A project page, latest first, after the Mac's MacProjectPage: the title and a pulse line, the
 * status as the headline, then two columns — Needs you and the merged Latest feed on the left;
 * the missions and the reference sections folded (decisions, files, sessions, the description) on
 * the right. Built from GET /projects/:id; "Show more" on Latest pages the roll-up through
 * GET /projects/:id/feed once every loaded row shows. The head's "…" menu holds "Merge into…", and
 * a mission row's right-click menu "Move to project…".
 */

import React, { useState } from "react";

import { KebabIcon } from "../icons";
import type { Project, ProjectDecisionRow, ProjectDetail, ProjectFileRow } from "../types";
import { formatRelativeTime, oneLine } from "./format";
import { TrackerGlyph } from "./glyphs";
import {
    activityDays,
    activityHasMore,
    activityNote,
    activityRows,
    activityTitle,
    type ActivityEvent,
    canOpen,
    dayLabel,
    decisionAt,
    decisionMark,
    FIRST_PAGE_LIMIT,
    fileName,
    fileRowId,
    headlineCaption,
    headlineText,
    isImage,
    isStruck,
    missionParts,
    sessionsLine,
    SHOW_MORE_STEP,
    showsAboutFold,
    timeOfDay,
} from "./projectActivity";
import { MergeProjectSheet, mergeTargets, useRowMove } from "./ProjectFiling";
import { activityClass, NeedsYouPill } from "./ProjectsDashboard";

/** The head's "…" menu: "Merge into…", disabled with nowhere to merge into. */
function ProjectActionsMenu({ canMerge, onMerge }: { canMerge: boolean; onMerge: () => void }): React.ReactElement {
    const [open, setOpen] = useState(false);
    return (
        <div
            className="mj_TrackerMenu"
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
            }}
        >
            <button
                type="button"
                className="mj_IconButton mj_TrackerMenu_button"
                aria-label="Project actions"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <KebabIcon />
            </button>
            {open ? (
                <div className="mj_TrackerMenu_list" role="menu">
                    <button
                        type="button"
                        role="menuitem"
                        className="mj_TrackerMenu_item"
                        disabled={!canMerge}
                        onClick={() => {
                            setOpen(false);
                            onMerge();
                        }}
                    >
                        Merge into…
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export function ProjectPage({
    detail,
    loadingMore = false,
    onBack,
    onOpenMission,
    onOpenItem,
    onLoadMore,
    projects,
    onMerge,
    onMoveMission,
    now = Date.now(),
}: {
    detail: ProjectDetail;
    /** The Latest feed's next pages are in flight. */
    loadingMore?: boolean;
    onBack: () => void;
    onOpenMission: (num: number) => void;
    onOpenItem: (num: number) => void;
    /** "Show more" once every loaded row shows: fetch the next page of every kind that has one. */
    onLoadMore?: () => void;
    /** Every known project: the merge and move choices are its open ones. */
    projects?: Project[];
    /** "Merge into…": this project into another; resolves to why it did not, or null once merged. Without it, no menu. */
    onMerge?: (projectId: string, intoId: string) => Promise<string | null>;
    /** A mission row's "Move to project…"; resolves to why it did not, or null once moved. */
    onMoveMission?: (missionId: string, projectId: string) => Promise<string | null>;
    /** Injectable for tests. */
    now?: number;
}): React.ReactElement {
    const { project, missions, needs_you: needsYou, sessions_by_box: boxes } = detail;
    const boxEntries = Object.entries(boxes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const sessionCount = boxEntries.reduce((total, [, count]) => total + count, 0);
    const openMissions = missions.filter((mission) => mission.state === "open");
    const closedMissions = missions.filter((mission) => mission.state !== "open");
    const [limit, setLimit] = useState<number | null>(FIRST_PAGE_LIMIT);
    // The project the merge sheet was opened for. A reload can swap the page to another project in
    // place (a merge made elsewhere follows to the survivor); the sheet then closes rather than
    // offer to merge a project the user did not pick.
    const [mergingId, setMergingId] = useState<string | null>(null);
    const rowMove = useRowMove(projects, onMoveMission, project.id);
    const merges = mergeTargets(project, projects);
    const rows = activityRows(detail, limit);
    const relative = (ms: number): string => formatRelativeTime(ms, now);

    /** First the rows already loaded past the fold, then the next page of every kind. */
    const showMore = (): void => {
        const loaded = activityRows(detail, null).length;
        if (rows.length < loaded) {
            setLimit(rows.length + SHOW_MORE_STEP);
        } else {
            setLimit(null);
            onLoadMore?.();
        }
    };

    const open = (event: ActivityEvent): void => {
        switch (event.kind) {
            case "milestone":
                if (event.missionNum != null) onOpenMission(event.missionNum);
                return;
            case "decision":
                onOpenItem(event.decision.num);
                return;
            case "file":
                if ("item_num" in event.file.source) onOpenItem(event.file.source.item_num);
                return;
            case "item":
                onOpenItem(event.item.num);
        }
    };

    return (
        <div className="mj_TrackerDetail mj_ProjectPage">
            <div className="mj_TrackerDetail_head">
                <button type="button" className="mj_TrackerTextButton" onClick={onBack}>
                    ‹ Projects
                </button>
                {onMerge && project.state === "open" ? (
                    <ProjectActionsMenu canMerge={merges.length > 0} onMerge={() => setMergingId(project.id)} />
                ) : null}
            </div>
            {mergingId === project.id && project.state === "open" && onMerge ? (
                <MergeProjectSheet
                    project={project}
                    targets={merges}
                    onMerge={(intoId) => onMerge(mergingId, intoId)}
                    onClose={() => setMergingId(null)}
                />
            ) : null}
            {rowMove.layer}
            <div className="mj_ProjectPage_scroll">
                <header className="mj_ProjectPage_header">
                    <div className="mj_ProjectPage_heading">
                        <h1 className="mj_ProjectPage_title">{project.title}</h1>
                        <NeedsYouPill count={needsYou.length} />
                    </div>
                    <p className="mj_ProjectPage_meta mj_ProjectPulse">
                        {missionParts(project.missions).map((part) => (
                            <span key={part.text} className="mj_ProjectPulse_part">
                                <span
                                    className={`mj_ProjectPulse_dot mj_ProjectPulse_dot_${part.activity ?? "closed"}`}
                                    aria-hidden="true"
                                />
                                {part.text}
                            </span>
                        ))}
                        <span className="mj_ProjectPulse_sessions">{sessionsLine(detail, relative)}</span>
                    </p>
                </header>
                <section className="mj_ProjectCardSection mj_ProjectPage_status" aria-label={headlineCaption(project)}>
                    <div className="mj_ProjectPage_statusHead">
                        <span className="mj_ProjectPage_statusLabel">{headlineCaption(project)}</span>
                        {project.status && project.status_updated_at ? (
                            <span className="mj_ProjectPage_statusBy">
                                Updated {relative(project.status_updated_at)} by{" "}
                                {project.status_by === "user" ? "you" : "an agent"}
                            </span>
                        ) : null}
                    </div>
                    <p className="mj_ProjectPage_statusText">{headlineText(project)}</p>
                </section>
                <div className="mj_ProjectPage_columns">
                    <div className="mj_ProjectPage_column">
                        {needsYou.length > 0 && (
                            <section className="mj_ProjectCardSection mj_ProjectNeedsYou">
                                <h2 className="mj_ProjectSection_head">
                                    <span className="mj_ProjectSection_title">Needs you</span>
                                    <span className="mj_ProjectSection_count">{needsYou.length}</span>
                                </h2>
                                {needsYou.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className="mj_ProjectNeedsYou_row"
                                        onClick={() => onOpenItem(item.num)}
                                    >
                                        <TrackerGlyph kind={item.kind} aria-hidden="true" />
                                        <span className="mj_ProjectNeedsYou_title">{item.title}</span>
                                        <span className="mj_ProjectNum">#{item.mission_num}</span>
                                        <span className="mj_ProjectNeedsYou_age">{relative(item.updated_at)}</span>
                                    </button>
                                ))}
                            </section>
                        )}
                        <section className="mj_ProjectCardSection mj_ProjectLatest" aria-label="Latest">
                            <h2 className="mj_ProjectSection_head">
                                <span className="mj_ProjectSection_title">Latest</span>
                            </h2>
                            {rows.length === 0 && !loadingMore ? (
                                <p className="mj_TrackerCaption">Nothing has happened on this project yet.</p>
                            ) : null}
                            {activityDays(rows, now).map((day) => (
                                <div key={day.key} className="mj_ProjectDay">
                                    <h3 className="mj_ProjectDay_label">{day.label}</h3>
                                    <ul className="mj_ProjectActivity">
                                        {day.events.map((event) => (
                                            <li key={event.id}>
                                                <ActivityRowShell event={event} onOpen={open}>
                                                    <ActivityGlyph event={event} />
                                                    <span className="mj_ProjectActivity_main">
                                                        <span
                                                            className={`mj_ProjectActivity_title${isStruck(event) ? " mj_ProjectActivity_struck" : ""}`}
                                                        >
                                                            {activityTitle(event)}
                                                        </span>
                                                        {activityNote(event) ? (
                                                            <span className="mj_ProjectActivity_note">
                                                                {activityNote(event)}
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                    <span className="mj_ProjectActivity_meta">
                                                        {event.missionNum != null ? (
                                                            <span className="mj_ProjectNum">#{event.missionNum}</span>
                                                        ) : null}
                                                        <span className="mj_ProjectActivity_time">
                                                            {timeOfDay(event.at)}
                                                        </span>
                                                    </span>
                                                </ActivityRowShell>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                            {activityHasMore(detail, limit) ? (
                                <button
                                    type="button"
                                    className="mj_TrackerTextButton mj_ProjectLatest_more"
                                    onClick={showMore}
                                    disabled={loadingMore}
                                >
                                    {loadingMore ? "Loading…" : "Show more"}
                                </button>
                            ) : null}
                        </section>
                    </div>
                    <div className="mj_ProjectPage_column">
                        <section className="mj_ProjectCardSection">
                            <h2 className="mj_ProjectSection_head">
                                <span className="mj_ProjectSection_title">Missions</span>
                                <span className="mj_ProjectSection_count">
                                    {openMissions.length} open
                                    {closedMissions.length ? ` · ${closedMissions.length} closed` : ""}
                                </span>
                            </h2>
                            {[...openMissions, ...closedMissions].map((mission) => (
                                <button
                                    key={mission.id}
                                    type="button"
                                    className={`mj_ProjectMission${mission.state === "open" ? "" : " mj_ProjectMission_closed"}`}
                                    onClick={() => onOpenMission(mission.num)}
                                    {...(mission.state === "open"
                                        ? rowMove.rowProps({ ...mission, project_id: mission.project_id ?? project.id })
                                        : {})}
                                >
                                    <span
                                        className={`mj_ProjectMission_dot mj_ProjectMission_dot_${activityClass(mission.activity, mission.needs_you, mission.state === "open")}`}
                                        aria-hidden="true"
                                    />
                                    <span className="mj_ProjectNum">#{mission.num}</span>
                                    <span className="mj_ProjectMission_main">
                                        <span className="mj_ProjectMission_title">{mission.title}</span>
                                        <span className="mj_ProjectMission_status">
                                            {mission.status ? oneLine(mission.status) : "No status"}
                                        </span>
                                    </span>
                                    <NeedsYouPill count={mission.needs_you} />
                                </button>
                            ))}
                        </section>
                        {detail.decisions && detail.decisions.rows.length > 0 ? (
                            <Fold title="Decisions" detail={String(detail.decisions.total)} name="decisions">
                                <ul className="mj_ProjectActivity">
                                    {detail.decisions.rows.map((decision) => (
                                        <li key={decision.id}>
                                            <DecisionRow decision={decision} now={now} onOpen={onOpenItem} />
                                        </li>
                                    ))}
                                </ul>
                            </Fold>
                        ) : null}
                        {detail.files && detail.files.rows.length > 0 ? (
                            <Fold title="Files and images" detail={String(detail.files.total)} name="files">
                                <ul className="mj_ProjectActivity">
                                    {detail.files.rows.map((file) => (
                                        <li key={fileRowId(file)}>
                                            <FileRow file={file} relative={relative} onOpenItem={onOpenItem} />
                                        </li>
                                    ))}
                                </ul>
                            </Fold>
                        ) : null}
                        <Fold title="Sessions on it now" detail={String(sessionCount)} name="sessions">
                            {boxEntries.length === 0 ? (
                                <p className="mj_TrackerCaption">No sessions are working on it.</p>
                            ) : (
                                <p className="mj_ProjectSessions">
                                    {boxEntries.map(([box, count]) => (
                                        <span key={box} className="mj_ProjectSessions_box">
                                            {box} {count}
                                        </span>
                                    ))}
                                </p>
                            )}
                        </Fold>
                        {showsAboutFold(project) ? (
                            <Fold title="About this project" name="about">
                                <p className="mj_ProjectPage_body">{project.body}</p>
                            </Fold>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** A reference section folded behind its heading and count; `<details>` so it opens in place. */
function Fold({
    title,
    detail,
    name,
    children,
}: {
    title: string;
    detail?: string;
    name: string;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <details className={`mj_ProjectCardSection mj_ProjectFold mj_ProjectFold_${name}`}>
            <summary className="mj_ProjectFold_summary">
                <span className="mj_ProjectSection_title">{title}</span>
                {detail ? <span className="mj_ProjectSection_count">{detail}</span> : null}
                <span className="mj_ProjectFold_chevron" aria-hidden="true" />
            </summary>
            <div className="mj_ProjectFold_body">{children}</div>
        </details>
    );
}

/** A feed row: a button when the row opens something, a plain row otherwise. */
function ActivityRowShell({
    event,
    onOpen,
    children,
}: {
    event: ActivityEvent;
    onOpen: (event: ActivityEvent) => void;
    children: React.ReactNode;
}): React.ReactElement {
    return canOpen(event) ? (
        <button type="button" className="mj_ProjectActivity_row" onClick={() => onOpen(event)}>
            {children}
        </button>
    ) : (
        <span className="mj_ProjectActivity_row mj_ProjectActivity_row_static">{children}</span>
    );
}

/** The feed row's glyph: a milestone's marker, a decision's mark, a file, an item's kind. */
function ActivityGlyph({ event }: { event: ActivityEvent }): React.ReactElement {
    switch (event.kind) {
        case "milestone":
            return <TrackerGlyph milestone={event.milestone.kind} className="mj_ProjectActivity_glyph" />;
        case "decision":
            return (
                <TrackerGlyph
                    kind={event.decision.kind}
                    className={`mj_ProjectActivity_glyph mj_ProjectActivity_glyph_${decisionMark(event.decision)}`}
                />
            );
        case "file":
            return (
                <span
                    className={`mj_ProjectActivity_glyph mj_ProjectActivity_fileGlyph${isImage(event.file) ? " mj_ProjectActivity_fileGlyph_image" : ""}`}
                    aria-hidden="true"
                />
            );
        case "item":
            return (
                <TrackerGlyph
                    kind={event.item.kind}
                    className={`mj_ProjectActivity_glyph${event.item.awaiting === "user" ? " mj_ProjectActivity_glyph_needsYou" : ""}`}
                />
            );
    }
}

/** One decision in the fold: its mark (a reversed one struck through), the title, a question's
 *  answer quoted beneath, then the mission and day. */
function DecisionRow({
    decision,
    now,
    onOpen,
}: {
    decision: ProjectDecisionRow;
    now: number;
    onOpen: (num: number) => void;
}): React.ReactElement {
    const struck = decision.resolution === "reversed";
    return (
        <button type="button" className="mj_ProjectActivity_row" onClick={() => onOpen(decision.num)}>
            <TrackerGlyph
                kind={decision.kind}
                className={`mj_ProjectActivity_glyph mj_ProjectActivity_glyph_${decisionMark(decision)}`}
            />
            <span className="mj_ProjectActivity_main">
                <span className={`mj_ProjectActivity_title${struck ? " mj_ProjectActivity_struck" : ""}`}>
                    {decision.title}
                </span>
                {decision.answer?.trim() ? (
                    <span className="mj_ProjectActivity_note mj_ProjectActivity_answer">
                        {oneLine(decision.answer)}
                    </span>
                ) : null}
            </span>
            <span className="mj_ProjectActivity_meta">
                {decision.mission_num != null ? <span className="mj_ProjectNum">#{decision.mission_num}</span> : null}
                <span className="mj_ProjectActivity_time">{dayLabel(decisionAt(decision), now)}</span>
            </span>
        </button>
    );
}

/** One file in the fold: its name, where it was posted and when. A file on an item opens the item. */
function FileRow({
    file,
    relative,
    onOpenItem,
}: {
    file: ProjectFileRow;
    relative: (ms: number) => string;
    onOpenItem: (num: number) => void;
}): React.ReactElement {
    const itemNum = "item_num" in file.source ? file.source.item_num : null;
    const where = itemNum != null ? `#${itemNum}` : "chat";
    const meta = file.posted_at ? `${where} · ${relative(file.posted_at)}` : where;
    const body = (
        <>
            <span
                className={`mj_ProjectActivity_glyph mj_ProjectActivity_fileGlyph${isImage(file) ? " mj_ProjectActivity_fileGlyph_image" : ""}`}
                aria-hidden="true"
            />
            <span className="mj_ProjectActivity_main">
                <span className="mj_ProjectActivity_title">{fileName(file)}</span>
                <span className="mj_ProjectActivity_note">{meta}</span>
            </span>
            {file.mission_num != null ? <span className="mj_ProjectNum">#{file.mission_num}</span> : null}
        </>
    );
    return itemNum != null ? (
        <button type="button" className="mj_ProjectActivity_row" onClick={() => onOpenItem(itemNum)}>
            {body}
        </button>
    ) : (
        <span className="mj_ProjectActivity_row mj_ProjectActivity_row_static">{body}</span>
    );
}
