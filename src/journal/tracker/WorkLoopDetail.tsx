/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Loop detail -- the Work tab's counterpart to ItemDetail, built from the same shell (a head row
 * with back + "#id · Loop" + status pill, then a centred scroll column): the title, a meta grid,
 * the next step as a callout when the server sends one, and the full description rendered through
 * the app's sanitised markdown renderer (bold labels, bullets, the Reference section, code spans,
 * links). Read-only: loops are changed through the loop store, not from here.
 *
 * It renders from the Work payload the list already loaded, so opening a row is instant and the
 * detail refreshes with the list. A loop missing from that payload (closed since, or a stale deep
 * link) gets an explicit not-found state instead of a blank pane.
 */

import React from "react";

import { ChevronLeftIcon } from "../icons";
import { MarkdownBody } from "../markdown";
import type { WorkViewLoadState } from "../use-work-view";
import type { WorkViewLoop } from "../work-view";
import { claimCopy, compactAge, needsAttention, openedDate, openedMs, ownerLabel, statusLabel } from "./work-format";
import { WorkGlyph, WorkStatusChip } from "./work-parts";

function MetaCell({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
    return (
        <div className="mj_WorkMeta_cell">
            <dt className="mj_WorkMeta_label">{label}</dt>
            <dd className="mj_WorkMeta_value">{children}</dd>
        </div>
    );
}

function Head({
    loopId,
    loop,
    onBack,
}: {
    loopId: number;
    loop?: WorkViewLoop;
    onBack: () => void;
}): React.ReactElement {
    return (
        <div className="mj_TrackerDetail_head">
            <button type="button" className="mj_TrackerBack" aria-label="Back to work" onClick={onBack}>
                <ChevronLeftIcon />
            </button>
            <span className="mj_TrackerItemHead_kind">
                {loop ? (
                    <span className="mj_TrackerItemHead_glyph">
                        <WorkGlyph status={loop.status} />
                    </span>
                ) : null}
                #{loopId} · Loop
            </span>
            {loop ? <WorkStatusChip status={loop.status} /> : null}
        </div>
    );
}

export function WorkLoopDetail({
    loopId,
    loop,
    state,
    now,
    onBack,
    onTrackerLink,
}: {
    loopId: number;
    loop: WorkViewLoop | undefined;
    state: WorkViewLoadState;
    now: number;
    onBack: () => void;
    onTrackerLink?: (kind: "item" | "mission", num: number) => void;
}): React.ReactElement {
    if (!loop) {
        const body =
            state.status === "loading" ? (
                <div className="mj_WorkLoading" role="status">
                    <p>Loading Work…</p>
                </div>
            ) : state.status === "error" || state.status === "request_error" ? (
                <div className="mj_WorkError" role="alert">
                    <p className="mj_WorkError_title">Work unavailable</p>
                    <p className="mj_WorkError_message">{state.error.message}</p>
                </div>
            ) : (
                <div className="mj_TrackerEmpty">
                    <p className="mj_TrackerEmpty_title">Loop #{loopId} isn’t open</p>
                    <p className="mj_TrackerEmpty_hint">It may have been closed since, or the link is out of date.</p>
                    <button type="button" className="mj_TrackerTextButton" onClick={onBack}>
                        Back to work
                    </button>
                </div>
            );
        return (
            <div className="mj_TrackerDetail mj_WorkDetail">
                <Head loopId={loopId} onBack={onBack} />
                {body}
            </div>
        );
    }

    const opened = openedMs(loop);
    const age = compactAge(opened, now);
    const owner = ownerLabel(loop.owner);
    const description = loop.description.trim();

    return (
        <div className="mj_TrackerDetail mj_WorkDetail">
            <Head loopId={loopId} loop={loop} onBack={onBack} />
            <div className="mj_TrackerDetail_scroll">
                <h1 className="mj_TrackerItemTitle">{loop.title}</h1>

                <dl className="mj_WorkMeta">
                    <MetaCell label="Priority">
                        <span className="mj_WorkPriority">P{loop.priority}</span>
                    </MetaCell>
                    <MetaCell label="Domain">{loop.domain}</MetaCell>
                    <MetaCell label="Repo">{loop.repo}</MetaCell>
                    {owner ? <MetaCell label="Owner">{owner}</MetaCell> : null}
                    {opened !== null ? (
                        <MetaCell label="Opened">
                            <time dateTime={loop.opened}>{openedDate(opened)}</time>
                            {age && age !== "today" ? <span className="mj_WorkMeta_sub"> · {age} ago</span> : null}
                        </MetaCell>
                    ) : null}
                    {loop.claim ? (
                        <MetaCell label="Claim">
                            <span className={`mj_WorkClaim mj_WorkClaim_${loop.claim.liveness}`}>
                                {claimCopy(loop.claim)}
                            </span>
                        </MetaCell>
                    ) : null}
                </dl>

                {loop.next_action ? (
                    <section
                        className={`mj_WorkNext${needsAttention(loop) ? " mj_WorkNext_attention" : ""}`}
                        aria-label="Next step"
                    >
                        <p className="mj_TrackerCaption">Next step</p>
                        <p className="mj_WorkNext_text">{loop.next_action}</p>
                    </section>
                ) : null}

                {description ? (
                    <div className="mj_TrackerProse mj_Markdown mj_WorkDetail_body">
                        <MarkdownBody text={description} label={`loop-${loop.id}`} onTrackerLink={onTrackerLink} />
                    </div>
                ) : (
                    <p className="mj_WorkDetail_empty">No description yet.</p>
                )}
            </div>
        </div>
    );
}
