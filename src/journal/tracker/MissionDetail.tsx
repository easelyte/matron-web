/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Mission detail, after the Mac's mission page — a "Projects › project › #N" breadcrumb, the header
 * (with close-summary when closed), the status card (hidden when the mission has none),
 * milestones newest-first with jump-to-conversation (20 at a time), the mission's open items split
 * into "Needs you" and "Open tasks & decisions", its closed items (fetched on demand, a page at a
 * time), its conversations, and a close-with-summary affordance for an open mission. An open
 * mission's header offers "Move to project…". Mutations route through the client; the store
 * refetch keeps the view live.
 */

import React, { useMemo, useState } from "react";

import { sessionTagForBox } from "../boxes";
import { MISSION_CLOSED_PAGE, type MatronJournalClient } from "../client";
import { ChevronLeftIcon } from "../icons";
import { MarkdownBody } from "../markdown";
import { displayRawTitle, SessionTagMark } from "../SessionTag";
import type {
    AgentRosterEntry,
    Mission,
    MissionConversation,
    MissionDetail as MissionDetailData,
    MissionItemRef,
    Milestone,
    Project,
    TrackerItem,
    TrackerLinkHandler,
} from "../types";
import {
    closedStatusLabel,
    formatRelativeTime,
    kindLabel,
    missionItemGroups,
    missionLabel,
    oneLine,
    statusByline,
} from "./format";
import { JumpGlyph, MilestoneGlyph, TrackerGlyph } from "./glyphs";
import { MoveToProjectSheet, moveTargets } from "./ProjectFiling";

function MilestoneRow({
    milestone,
    convo,
    onJump,
}: {
    milestone: Milestone;
    convo?: MissionConversation;
    onJump: (milestone: Milestone) => void;
}): React.ReactElement {
    const hint = [convo?.box, convo?.title ? displayRawTitle(convo.title) : undefined].filter(Boolean).join(" · ");
    const body = oneLine(milestone.body);
    return (
        <button
            type="button"
            className="mj_TrackerMilestoneRow"
            aria-label={`Milestone number ${milestone.num}, ${milestone.title || `#${milestone.num}`}, jump to conversation`}
            onClick={() => onJump(milestone)}
        >
            <span className="mj_TrackerMilestoneRow_glyph" aria-hidden="true">
                <MilestoneGlyph kind={milestone.kind} />
            </span>
            <span className="mj_TrackerMilestoneRow_main">
                <span className="mj_TrackerMilestoneRow_title">
                    <span className="mj_TrackerMilestoneRow_num">#{milestone.num}</span>
                    {milestone.title || `#${milestone.num}`}
                </span>
                {body ? <span className="mj_TrackerMilestoneRow_body">{body}</span> : null}
                <span className="mj_TrackerMilestoneRow_meta">
                    <span>{formatRelativeTime(milestone.created_at)}</span>
                    {hint ? <span className="mj_TrackerMilestoneRow_hint">{hint}</span> : null}
                </span>
            </span>
            <span className="mj_TrackerMilestoneRow_jump" aria-hidden="true">
                <JumpGlyph />
            </span>
        </button>
    );
}

function OpenItemRow({ item, onOpen }: { item: MissionItemRef; onOpen: (num: number) => void }): React.ReactElement {
    const urgent = item.state === "open" && item.awaiting === "user";
    return (
        <button
            type="button"
            className={`mj_TrackerMiniItem${urgent ? " mj_TrackerMiniItem_needsyou" : ""}`}
            aria-label={`${kindLabel(item.kind)} number ${item.num}, ${item.title}${urgent ? ", needs you" : ""}`}
            onClick={() => onOpen(item.num)}
        >
            <span className="mj_TrackerMiniItem_glyph" aria-hidden="true">
                <TrackerGlyph kind={item.kind} />
            </span>
            <span className="mj_TrackerMiniItem_num">#{item.num}</span>
            <span className="mj_TrackerMiniItem_title">{item.title}</span>
            {urgent ? <span className="mj_TrackerMiniItem_needsyouTag">Needs you</span> : null}
        </button>
    );
}

function ClosedItemRow({ item, onOpen }: { item: TrackerItem; onOpen: (num: number) => void }): React.ReactElement {
    const status = closedStatusLabel(item);
    return (
        <button
            type="button"
            className="mj_TrackerMiniItem mj_TrackerMiniItem_closed"
            aria-label={`${kindLabel(item.kind)} number ${item.num}, ${item.title}, ${status}`}
            onClick={() => onOpen(item.num)}
        >
            <span className="mj_TrackerMiniItem_glyph" aria-hidden="true">
                <TrackerGlyph kind={item.kind} />
            </span>
            <span className="mj_TrackerMiniItem_num">#{item.num}</span>
            <span className="mj_TrackerMiniItem_title">{item.title}</span>
            <span className="mj_TrackerMiniItem_status">{status}</span>
        </button>
    );
}

/** Milestones show this many at first, and "Show more" adds as many again (the Mac's page size). */
export const MILESTONE_PAGE = 20;

/**
 * The mission's closed items, most recently updated first, fetched only when asked for: the
 * journal can only list them by walking the closed items updated since the mission began, so a
 * page open never pays for it.
 * Keyed by mission, so another mission starts over.
 */
function ClosedItems({
    mission,
    client,
    onOpen,
}: {
    mission: Pick<Mission, "id" | "created_at">;
    client: MatronJournalClient;
    onOpen: (num: number) => void;
}): React.ReactElement {
    const [items, setItems] = useState<TrackerItem[] | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);

    const load = async (from: string | null): Promise<void> => {
        if (loading) return;
        setLoading(true);
        setFailed(false);
        try {
            const page = await client.fetchMissionClosedItems(mission, from, MISSION_CLOSED_PAGE);
            setItems((current) => [...(from ? (current ?? []) : []), ...page.items]);
            setCursor(page.cursor);
        } catch {
            setFailed(true);
        } finally {
            setLoading(false);
        }
    };

    return (
        <section className="mj_TrackerSection" aria-label="Closed items">
            <h2 className="mj_TrackerSection_header">Closed</h2>
            {items?.map((item) => (
                <ClosedItemRow key={item.id} item={item} onOpen={onOpen} />
            ))}
            {items && items.length === 0 ? (
                <p className="mj_TrackerCaption">{cursor ? "None found yet." : "No closed items."}</p>
            ) : null}
            {failed ? <p className="mj_TrackerCaption">Couldn't load closed items.</p> : null}
            {items === null || cursor ? (
                <button
                    type="button"
                    className="mj_TrackerTextButton mj_TrackerShowMore"
                    disabled={loading}
                    onClick={() => void load(items === null ? null : cursor)}
                >
                    {loading ? "Loading…" : items !== null ? "Show more" : failed ? "Try again" : "Show closed items"}
                </button>
            ) : null}
        </section>
    );
}

/**
 * The line a mission's conversation row reads. On a mission the journal names every conversation
 * after the mission, so the titles would all read alike; the bridge's own title (`auto_title`, the
 * generated topic) tells them apart, so it leads when the journal sends it — in display form, the
 * `[xx]` short peeled off (it shows as the session tag). An older journal sends none: the title,
 * as before, then the id for an untitled conversation.
 */
export function missionConvoTopic(convo: Pick<MissionConversation, "id" | "title" | "auto_title">): string {
    const auto = typeof convo.auto_title === "string" ? convo.auto_title.trim() : "";
    if (auto) return displayRawTitle(auto);
    return convo.title ? displayRawTitle(convo.title) : convo.id;
}

export function MissionConvoRow({
    convo,
    agents,
}: {
    convo: MissionConversation;
    agents?: AgentRosterEntry[];
}): React.ReactElement {
    const tag = convo.title ? sessionTagForBox(convo.box, convo.title, agents) : undefined;
    return (
        <div className="mj_TrackerConvoRow">
            {convo.box ? <span className="mj_TrackerConvoRow_box">{convo.box}</span> : null}
            <span className="mj_TrackerConvoRow_main">
                <span className="mj_TrackerConvoRow_title">
                    {tag ? <SessionTagMark tag={tag} /> : null}
                    {missionConvoTopic(convo)}
                </span>
            </span>
            <span className="mj_TrackerConvoRow_state">{convo.state}</span>
        </div>
    );
}

export function MissionDetail({
    detail,
    client,
    agents,
    project,
    rootLabel = "Projects",
    onOpenItem,
    onBack,
    onOpenRoot,
    onOpenProject,
    projects,
    now,
}: {
    detail: MissionDetailData | null | undefined;
    client: MatronJournalClient;
    /** The box roster, for the `A:bc` session tag on conversation rows (shown with two or more boxes). */
    agents?: AgentRosterEntry[];
    /** The project the mission is filed in, when it is known on this device: the breadcrumb's
     *  middle crumb. */
    project?: Pick<Project, "num" | "title"> | null;
    /** The breadcrumb's first crumb: "Projects", or "Missions" on a journal without projects. */
    rootLabel?: string;
    onOpenItem: (num: number) => void;
    onBack: () => void;
    /** The first crumb's target (the Projects dashboard); `onBack` when not given. */
    onOpenRoot?: () => void;
    onOpenProject?: (num: number) => void;
    /** Every known project, for "Move to project…" (its open ones). Without any, no move. */
    projects?: Project[];
    /** Injectable for tests. */
    now?: number;
}): React.ReactElement {
    const [moving, setMoving] = useState(false);
    const [inputsOnly, setInputsOnly] = useState(false);
    const [milestoneLimit, setMilestoneLimit] = useState(MILESTONE_PAGE);
    const [summary, setSummary] = useState("");
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);

    const convoById = useMemo(() => {
        const map = new Map<string, MissionConversation>();
        for (const convo of detail?.conversations ?? []) map.set(convo.id, convo);
        return map;
    }, [detail?.conversations]);

    const milestones = useMemo(() => {
        const list = detail?.milestones ?? [];
        return inputsOnly ? list.filter((milestone) => milestone.kind === "user_input") : list;
    }, [detail?.milestones, inputsOnly]);
    const shownMilestones = milestones.slice(0, milestoneLimit);
    const moreMilestones = milestones.length - shownMilestones.length;

    const itemGroups = useMemo(() => missionItemGroups(detail?.items ?? []), [detail?.items]);

    if (!detail || !detail.mission) {
        return (
            <div className="mj_TrackerDetail">
                <div className="mj_TrackerDetail_head">
                    <button type="button" className="mj_TrackerBack" aria-label="Back" onClick={onBack}>
                        <ChevronLeftIcon />
                    </button>
                </div>
                <div className="mj_TrackerEmpty">
                    <p className="mj_TrackerEmpty_title">Mission not on this device yet</p>
                    <button
                        type="button"
                        className="mj_TrackerTextButton"
                        onClick={() => {
                            const id = client.getSnapshot().trackerView?.selectedMissionId;
                            if (id) void client.loadMission(id);
                        }}
                    >
                        Try again
                    </button>
                </div>
            </div>
        );
    }

    const { mission } = detail;
    const closed = mission.state === "closed";
    const status = mission.status?.trim() ? mission.status : null;
    const byline = status ? statusByline(mission.status_updated_at, mission.status_by, now) : null;

    // Every open project; the button only when there is one besides the mission's own.
    const targets = moveTargets(projects);
    const canMove = !closed && targets.some((target) => target.id !== mission.project_id);

    // A milestone opens its conversation on the message it was posted at, not at the tail.
    const jump = (milestone: Milestone): void => {
        void client.focusMessage(milestone.convo_id, milestone.seq);
    };

    // matron://item / matron://mission deep links inside the mission body + close summary open the
    // target tracker surface in-app (F6) — same handler the timeline uses.
    const onTrackerLink: TrackerLinkHandler = (kind, target) => client.openTrackerLink(kind, target);

    const doClose = async (): Promise<void> => {
        const body = summary.trim();
        if (!body || busy) return;
        setBusy(true);
        try {
            // Dismiss the confirm dialog ONLY on a confirmed successful close — a failed close
            // (offline/auth/5xx) keeps the dialog and the typed summary so nothing is lost (F2).
            const ok = await client.closeTrackerMission(mission.id, body);
            if (ok) setConfirming(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mj_TrackerDetail">
            <div className="mj_TrackerDetail_head">
                <nav className="mj_TrackerCrumbs" aria-label="Breadcrumb">
                    <button type="button" className="mj_TrackerCrumb" onClick={onOpenRoot ?? onBack}>
                        ‹ {rootLabel}
                    </button>
                    {project ? (
                        <>
                            <span className="mj_TrackerCrumbs_sep" aria-hidden="true">
                                ›
                            </span>
                            <button
                                type="button"
                                className="mj_TrackerCrumb"
                                onClick={() => (onOpenProject ? onOpenProject(project.num) : onBack())}
                            >
                                {project.title}
                            </button>
                        </>
                    ) : null}
                    <span className="mj_TrackerCrumbs_sep" aria-hidden="true">
                        ›
                    </span>
                    <span className="mj_TrackerCrumb mj_TrackerCrumb_current" aria-current="page">
                        #{mission.num}
                    </span>
                </nav>
            </div>

            {moving ? (
                <MoveToProjectSheet
                    missionLabel={`#${mission.num}`}
                    currentProjectId={mission.project_id}
                    targets={targets}
                    onMove={(projectId) => client.moveTrackerMission(mission.id, projectId)}
                    onClose={() => setMoving(false)}
                />
            ) : null}
            <div className="mj_TrackerDetail_scroll">
                <header className="mj_TrackerMissionHead">
                    <div className="mj_TrackerMissionHead_title">
                        <span className="mj_TrackerMissionHead_num">#{mission.num}</span>
                        <h1 className="mj_TrackerMissionHead_name">{missionLabel(mission)}</h1>
                        <span
                            className={`mj_TrackerStateLabel ${
                                closed ? "mj_TrackerStateLabel_closed" : "mj_TrackerStateLabel_open"
                            }`}
                        >
                            {closed ? "Closed" : "Open"}
                        </span>
                        {canMove ? (
                            <button
                                type="button"
                                className="mj_TrackerTextButton mj_TrackerMissionHead_move"
                                onClick={() => setMoving(true)}
                            >
                                Move to project…
                            </button>
                        ) : null}
                    </div>
                    {mission.body.trim() ? (
                        <div className="mj_TrackerProse">
                            <MarkdownBody
                                text={mission.body}
                                label={`mission-${mission.num}`}
                                onTrackerLink={onTrackerLink}
                            />
                        </div>
                    ) : null}
                    {closed && mission.close_summary ? (
                        <div className="mj_TrackerCloseSummary">
                            <hr className="mj_TrackerDivider" />
                            <p className="mj_TrackerCaption">Closed</p>
                            <div className="mj_TrackerProse">
                                <MarkdownBody
                                    text={mission.close_summary}
                                    label={`mission-close-${mission.num}`}
                                    onTrackerLink={onTrackerLink}
                                />
                            </div>
                            {mission.closed_over_open_items > 0 ? (
                                <p className="mj_TrackerClosedOver">
                                    Closed over {mission.closed_over_open_items} open item
                                    {mission.closed_over_open_items === 1 ? "" : "s"}.
                                </p>
                            ) : null}
                        </div>
                    ) : null}
                </header>

                {status ? (
                    <section className="mj_ProjectCardSection mj_TrackerMissionStatus" aria-label="Status">
                        <div className="mj_TrackerMissionStatus_head">
                            <span className="mj_TrackerMissionStatus_label">Status</span>
                            {byline ? <span className="mj_TrackerMissionStatus_by">{byline}</span> : null}
                        </div>
                        <div className="mj_TrackerMissionStatus_text">
                            <MarkdownBody
                                text={status}
                                label={`mission-status-${mission.num}`}
                                onTrackerLink={onTrackerLink}
                            />
                        </div>
                    </section>
                ) : null}

                <section className="mj_TrackerSection">
                    <div className="mj_TrackerSection_headRow">
                        <h2 className="mj_TrackerSection_header">Milestones</h2>
                        {(detail.milestones ?? []).some((milestone) => milestone.kind === "user_input") ? (
                            <label className="mj_TrackerToggle">
                                <input
                                    type="checkbox"
                                    checked={inputsOnly}
                                    onChange={(event) => {
                                        setInputsOnly(event.target.checked);
                                        setMilestoneLimit(MILESTONE_PAGE);
                                    }}
                                />
                                My inputs only
                            </label>
                        ) : null}
                    </div>
                    {milestones.length === 0 ? (
                        <p className="mj_TrackerCaption">No milestones yet.</p>
                    ) : (
                        shownMilestones.map((milestone) => (
                            <MilestoneRow
                                key={milestone.id}
                                milestone={milestone}
                                convo={convoById.get(milestone.convo_id)}
                                onJump={jump}
                            />
                        ))
                    )}
                    {moreMilestones > 0 ? (
                        <button
                            type="button"
                            className="mj_TrackerTextButton mj_TrackerShowMore"
                            onClick={() => setMilestoneLimit((limit) => limit + MILESTONE_PAGE)}
                        >
                            Show more ({moreMilestones})
                        </button>
                    ) : null}
                </section>

                {itemGroups.needsYou.length > 0 ? (
                    <section className="mj_TrackerSection mj_TrackerMissionNeedsYou">
                        <h2 className="mj_TrackerSection_header">Needs you</h2>
                        {itemGroups.needsYou.map((item) => (
                            <OpenItemRow key={item.id} item={item} onOpen={onOpenItem} />
                        ))}
                    </section>
                ) : null}

                <section className="mj_TrackerSection">
                    <h2 className="mj_TrackerSection_header">Open tasks &amp; decisions</h2>
                    {itemGroups.others.length === 0 ? (
                        <p className="mj_TrackerCaption">
                            {itemGroups.needsYou.length > 0 ? "Nothing else open." : "Nothing open."}
                        </p>
                    ) : (
                        itemGroups.others.map((item) => <OpenItemRow key={item.id} item={item} onOpen={onOpenItem} />)
                    )}
                </section>

                <ClosedItems key={mission.id} mission={mission} client={client} onOpen={onOpenItem} />

                {detail.conversations.length > 0 ? (
                    <section className="mj_TrackerSection">
                        <h2 className="mj_TrackerSection_header">Conversations</h2>
                        {detail.conversations.map((convo) => (
                            <MissionConvoRow key={convo.id} convo={convo} agents={agents} />
                        ))}
                    </section>
                ) : null}

                {!closed ? (
                    <section className="mj_TrackerSection mj_TrackerCloseMission">
                        <h2 className="mj_TrackerSection_header">Close mission</h2>
                        <textarea
                            className="mj_TrackerTextarea"
                            placeholder="How it went"
                            value={summary}
                            disabled={busy}
                            onChange={(event) => setSummary(event.target.value)}
                        />
                        {confirming ? (
                            <div className="mj_TrackerConfirm">
                                <p className="mj_TrackerConfirm_title">
                                    {mission.open_items > 0
                                        ? `Close with ${mission.open_items} item${
                                              mission.open_items === 1 ? "" : "s"
                                          } still open?`
                                        : "Close this mission?"}
                                </p>
                                <div className="mj_TrackerConfirm_actions">
                                    <button
                                        type="button"
                                        className="mj_TrackerTextButton"
                                        disabled={busy}
                                        onClick={() => setConfirming(false)}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="mj_Btn mj_Btn_danger mj_TrackerButton"
                                        disabled={busy}
                                        onClick={() => void doClose()}
                                    >
                                        {busy ? "Closing…" : "Close mission"}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="mj_Btn mj_Btn_primary mj_TrackerButton"
                                disabled={!summary.trim() || busy}
                                onClick={() => setConfirming(true)}
                            >
                                Close mission
                            </button>
                        )}
                    </section>
                ) : null}
            </div>
        </div>
    );
}
