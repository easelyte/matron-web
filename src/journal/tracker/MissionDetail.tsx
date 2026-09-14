/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Mission detail — header (with close-summary when closed), milestones newest-first with jump-to-
 * conversation, the mission's open items (awaiting-user first, ordered by the server), its
 * conversations, and a close-with-summary affordance for an open mission. Mutations route through
 * the client; the store refetch keeps the view live.
 */

import React, { useMemo, useState } from "react";

import type { MatronJournalClient } from "../client";
import { ChevronLeftIcon } from "../icons";
import { MarkdownBody } from "../markdown";
import type { MissionConversation, MissionDetail as MissionDetailData, MissionItemRef, Milestone } from "../types";
import { formatRelativeTime, kindLabel, missionLabel, oneLine } from "./format";
import { JumpGlyph, MilestoneGlyph, TrackerGlyph } from "./glyphs";

function MilestoneRow({
    milestone,
    convo,
    onJump,
}: {
    milestone: Milestone;
    convo?: MissionConversation;
    onJump: (milestone: Milestone) => void;
}): React.ReactElement {
    const hint = [convo?.box, convo?.title].filter(Boolean).join(" · ");
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

export function MissionDetail({
    detail,
    client,
    onOpenItem,
    onBack,
}: {
    detail: MissionDetailData | null | undefined;
    client: MatronJournalClient;
    onOpenItem: (num: number) => void;
    onBack: () => void;
}): React.ReactElement {
    const [inputsOnly, setInputsOnly] = useState(false);
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

    const jump = (milestone: Milestone): void => {
        client.closeTrackerView();
        if (milestone.seq > 0) void client.selectConversationAtSeq(milestone.convo_id, milestone.seq);
        else void client.selectConversation(milestone.convo_id);
    };

    const doClose = async (): Promise<void> => {
        const body = summary.trim();
        if (!body || busy) return;
        setBusy(true);
        try {
            await client.closeTrackerMission(mission.id, body);
        } finally {
            setBusy(false);
            setConfirming(false);
        }
    };

    return (
        <div className="mj_TrackerDetail">
            <div className="mj_TrackerDetail_head">
                <button type="button" className="mj_TrackerBack" aria-label="Back to missions" onClick={onBack}>
                    <ChevronLeftIcon />
                </button>
            </div>

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
                    </div>
                    {mission.body.trim() ? (
                        <div className="mj_TrackerProse">
                            <MarkdownBody text={mission.body} label={`mission-${mission.num}`} />
                        </div>
                    ) : null}
                    {closed && mission.close_summary ? (
                        <div className="mj_TrackerCloseSummary">
                            <hr className="mj_TrackerDivider" />
                            <p className="mj_TrackerCaption">Closed</p>
                            <div className="mj_TrackerProse">
                                <MarkdownBody text={mission.close_summary} label={`mission-close-${mission.num}`} />
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

                <section className="mj_TrackerSection">
                    <div className="mj_TrackerSection_headRow">
                        <h2 className="mj_TrackerSection_header">Milestones</h2>
                        {(detail.milestones ?? []).some((milestone) => milestone.kind === "user_input") ? (
                            <label className="mj_TrackerToggle">
                                <input
                                    type="checkbox"
                                    checked={inputsOnly}
                                    onChange={(event) => setInputsOnly(event.target.checked)}
                                />
                                My inputs only
                            </label>
                        ) : null}
                    </div>
                    {milestones.length === 0 ? (
                        <p className="mj_TrackerCaption">No milestones yet.</p>
                    ) : (
                        milestones.map((milestone) => (
                            <MilestoneRow
                                key={milestone.id}
                                milestone={milestone}
                                convo={convoById.get(milestone.convo_id)}
                                onJump={jump}
                            />
                        ))
                    )}
                </section>

                {detail.items.length > 0 ? (
                    <section className="mj_TrackerSection">
                        <h2 className="mj_TrackerSection_header">Open items</h2>
                        {detail.items.map((item) => (
                            <OpenItemRow key={item.id} item={item} onOpen={onOpenItem} />
                        ))}
                    </section>
                ) : null}

                {detail.conversations.length > 0 ? (
                    <section className="mj_TrackerSection">
                        <h2 className="mj_TrackerSection_header">Conversations</h2>
                        {detail.conversations.map((convo) => (
                            <div key={convo.id} className="mj_TrackerConvoRow">
                                {convo.box ? <span className="mj_TrackerConvoRow_box">{convo.box}</span> : null}
                                <span className="mj_TrackerConvoRow_title">{convo.title || convo.id}</span>
                                <span className="mj_TrackerConvoRow_state">{convo.state}</span>
                            </div>
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
                                        className="mj_TrackerButton mj_TrackerButton_danger"
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
                                className="mj_TrackerButton"
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
