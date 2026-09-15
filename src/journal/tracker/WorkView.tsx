/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The read-only Work surface. The journal endpoint remains the source of grouping and loop data;
 * this component owns only the repo/domain view choice and per-description expansion state. The
 * claim language is deliberately advisory because Phase 1 claims are collision hints, not locks.
 */

import React, { useState } from "react";

import { useWorkView, type WorkViewLoader } from "../use-work-view";
import type { WorkViewClaim, WorkViewGroupBy, WorkViewLoop } from "../work-view";

const DESCRIPTION_CLAMP_CHARS = 180;

function claimHolder(claim: WorkViewClaim): string {
    const label = claim.holder_label?.trim();
    if (label) return label;
    return `Session ${claim.convo_id.slice(0, 6) || "unknown"}`;
}

function claimCopy(claim: WorkViewClaim): string {
    const holder = claimHolder(claim);
    switch (claim.liveness) {
        case "live":
            return `${holder} appears to be on this`;
        case "stale":
            return `${holder} · looks abandoned`;
        case "unknown":
            return `${holder} · claimed — liveness unknown`;
    }
}

function WorkLoop({ loop }: { loop: WorkViewLoop }): React.ReactElement {
    const [expanded, setExpanded] = useState(false);
    const clampable = loop.description.length > DESCRIPTION_CLAMP_CHARS;
    const description =
        clampable && !expanded ? `${loop.description.slice(0, DESCRIPTION_CLAMP_CHARS).trimEnd()}…` : loop.description;

    return (
        <article className="mj_WorkLoop">
            <div className="mj_WorkLoop_head">
                <h3 className="mj_WorkLoop_title">{loop.title}</h3>
                <span className="mj_WorkPriority">Priority {loop.priority}</span>
                <span className={`mj_WorkStatus mj_WorkStatus_${loop.status}`}>{loop.status}</span>
            </div>
            <p className="mj_WorkLoop_description">{description || "No description provided."}</p>
            {clampable ? (
                <button
                    type="button"
                    className="mj_WorkLoop_expand"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? "Show less" : "Expand"}
                </button>
            ) : null}
            {loop.claim ? (
                <span className={`mj_WorkClaimBadge mj_WorkClaimBadge_${loop.claim.liveness}`}>
                    {claimCopy(loop.claim)}
                </span>
            ) : null}
        </article>
    );
}

export function WorkView({ api }: { api: WorkViewLoader }): React.ReactElement {
    const [groupBy, setGroupBy] = useState<WorkViewGroupBy>("repo");
    const { state } = useWorkView(api, groupBy);

    const body = ((): React.ReactElement => {
        switch (state.status) {
            case "loading":
                return (
                    <div className="mj_WorkLoading" role="status">
                        Loading Work…
                    </div>
                );
            case "request_error":
                return (
                    <div className="mj_WorkError" role="alert">
                        <p className="mj_WorkError_title">Work unavailable</p>
                        <p className="mj_WorkError_message">{state.error.message}</p>
                    </div>
                );
            case "error":
                return (
                    <div className="mj_WorkError" role="alert">
                        <p className="mj_WorkError_title">Work unavailable</p>
                        <p className="mj_WorkError_message">
                            <span className="mj_WorkError_code">{state.error.code}</span> {state.error.message}
                        </p>
                    </div>
                );
            case "empty":
                return (
                    <div className="mj_TrackerEmpty">
                        <p className="mj_TrackerEmpty_title">No active work</p>
                    </div>
                );
            case "ok":
                return (
                    <div className="mj_WorkGroups">
                        {state.groups.map((group) => (
                            <section className="mj_WorkGroup" key={group.key}>
                                <h2 className="mj_WorkGroup_header">{group.key}</h2>
                                {[...group.loops]
                                    .sort((a, b) => b.priority - a.priority || a.id - b.id)
                                    .map((loop) => (
                                        <WorkLoop key={loop.id} loop={loop} />
                                    ))}
                            </section>
                        ))}
                    </div>
                );
        }
    })();

    return (
        <div className="mj_TrackerList mj_WorkView">
            <div className="mj_TrackerInboxToggle" role="tablist" aria-label="Work grouping">
                <button
                    type="button"
                    role="tab"
                    aria-selected={groupBy === "repo"}
                    className={`mj_TrackerToggleTab${groupBy === "repo" ? " mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setGroupBy("repo")}
                >
                    Repository
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={groupBy === "domain"}
                    className={`mj_TrackerToggleTab${groupBy === "domain" ? " mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setGroupBy("domain")}
                >
                    Domain
                </button>
            </div>
            {body}
        </div>
    );
}
