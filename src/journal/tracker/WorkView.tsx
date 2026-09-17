/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The read-only Work surface. The journal endpoint remains the source of grouping and loop data;
 * this component owns the repo/domain view choice, the active/all scope filter, and per-loop
 * expansion state. The claim language is deliberately advisory because Phase 1 claims are
 * collision hints, not locks.
 *
 * Rows deliberately reuse the tracker's own row anatomy (mj_TrackerItemRow and its sub-elements,
 * shared with ItemRow and MissionsList) rather than a bespoke card: glyph, a title line leading
 * with the tabular-num id, a single-line body preview that the stylesheet ellipsises, and one meta
 * line carrying at most ONE status token. Loop descriptions are written for machines and run to a
 * ~1.1k-character median, so the CSS ellipsis is what makes them readable at a glance; the full
 * text is opt-in via expansion.
 *
 * Unlike the other tracker rows, a Work row is not a navigation target -- Phase 1 has no loop
 * detail view -- so the button toggles expansion in place rather than opening anything.
 */

import React, { useMemo, useState } from "react";

import { useWorkView, type WorkViewLoader } from "../use-work-view";
import type { WorkViewClaim, WorkViewGroup, WorkViewGroupBy, WorkViewLoop } from "../work-view";
import { oneLine } from "./format";
import { TaskGlyph } from "./glyphs";

/** "active" hides parked/paused work; "all" shows everything the endpoint returned. */
export type WorkScope = "active" | "all";

/** Statuses treated as set-aside rather than in play. */
const SET_ASIDE_STATUSES: ReadonlySet<string> = new Set(["parked", "paused"]);

/**
 * The collapsed row's one-line summary.
 *
 * Takes the FIRST PARAGRAPH rather than the whole description flattened. For a description written
 * as a lead sentence followed by detail, that is the summary the author intended -- and for the
 * older single-paragraph descriptions it is the entire text, i.e. exactly what this used to do, so
 * nothing regresses. Flattening everything instead jams headings and bullets into the preview,
 * which is what made structured descriptions read worse than unstructured ones.
 */
export function summaryLine(description: string): string {
    const [first = ""] = description.trim().split(/\n\s*\n/, 1);
    return oneLine(first);
}

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
    // Collapsed: one line, ellipsised by the stylesheet at whatever width the pane happens to be,
    // rather than cut at a fixed character count mid-word. Expanded: the original text with its
    // paragraph breaks intact, because a 5k-character description reflowed into one block is
    // unreadable.
    const preview = summaryLine(loop.description);
    // Expandability is a property of the DESCRIPTION alone, never of the expanded flag. Deriving it
    // from `expanded` made a description-less row silently expandable: it rendered no preview, no
    // affordance and no aria-expanded, yet clicking it revealed a placeholder out of nowhere.
    // Eight of thirty live loops have an empty description, so that is a quarter of the board.
    const expandable = preview.length > 0;
    const isOpen = expandable && expanded;

    const label = [
        `loop ${loop.id}`,
        loop.title,
        `priority ${loop.priority}`,
        loop.status,
        loop.claim ? claimCopy(loop.claim) : "",
        expandable ? (isOpen ? "collapse description" : "expand description") : "",
    ]
        .filter(Boolean)
        .join(", ");

    // A row with nothing to reveal is not a control: render it as static content rather than a
    // button that looks actionable and does nothing.
    const RowTag = expandable ? "button" : "div";
    const rowProps = expandable
        ? ({
              type: "button",
              "aria-expanded": isOpen,
              onClick: () => setExpanded((value) => !value),
          } as const)
        : ({} as const);

    return (
        <div className="mj_TrackerWorkRow_wrap">
            <RowTag
                className={`mj_TrackerItemRow mj_TrackerWorkRow${expandable ? "" : " mj_TrackerWorkRow_static"}`}
                aria-label={label}
                {...rowProps}
            >
                <span className="mj_TrackerItemRow_glyph" aria-hidden="true">
                    <TaskGlyph />
                </span>
                <span className="mj_TrackerItemRow_main">
                    <span className="mj_TrackerItemRow_title">
                        <span className="mj_TrackerItemRow_num">#{loop.id}</span>
                        {loop.title}
                    </span>
                    {/* The placeholder stays visible in the collapsed row, so a description-less
                        loop reads as "nothing written here" rather than as a blank, contentless
                        row whose emptiness might be a rendering bug. */}
                    {!isOpen ? (
                        <span className="mj_TrackerItemRow_body">{preview || "No description provided."}</span>
                    ) : null}
                    <span className="mj_TrackerItemRow_meta">
                        <span className="mj_TrackerWorkRow_priority">P{loop.priority}</span>
                        {/* ONE status token, matching ItemRow's rule that the ordinary case shows
                            none -- here "active" is ordinary, because being listed at all says it.
                            Everything else is real signal and keeps its token: `blocked` gets the
                            attention treatment (it is the one status you would act on), parked and
                            paused are muted (set aside on purpose). */}
                        {loop.status !== "active" ? (
                            <span
                                className={`mj_TrackerItemRow_status ${
                                    SET_ASIDE_STATUSES.has(loop.status)
                                        ? "mj_TrackerItemRow_status_muted"
                                        : "mj_TrackerItemRow_status_needsyou"
                                }`}
                            >
                                {loop.status}
                            </span>
                        ) : null}
                        {loop.claim ? (
                            <span className={`mj_WorkClaimBadge mj_WorkClaimBadge_${loop.claim.liveness}`}>
                                {claimCopy(loop.claim)}
                            </span>
                        ) : null}
                    </span>
                </span>
            </RowTag>
            {isOpen ? <p className="mj_TrackerWorkRow_full">{loop.description}</p> : null}
        </div>
    );
}

/*
 * A group as RENDERED. The wire type constrains `loops` to a non-empty tuple (the schema's
 * minItems: 1 -- the producer never emits an empty group), which is a guarantee about the
 * payload, not about a filtered view of it. Filtering is expressed over a plain array so the
 * wire contract keeps its stronger shape instead of being weakened to accommodate the UI.
 */
export interface WorkDisplayGroup {
    key: string;
    loops: WorkViewLoop[];
}

/** Apply the scope filter and drop groups it empties, so no bare header is left behind. */
export function applyScope(groups: readonly WorkViewGroup[], scope: WorkScope): WorkDisplayGroup[] {
    return groups
        .map((group) => ({
            key: group.key,
            loops:
                scope === "all" ? [...group.loops] : group.loops.filter((loop) => !SET_ASIDE_STATUSES.has(loop.status)),
        }))
        .filter((group) => group.loops.length > 0);
}

function ToggleTab<T extends string>({
    value,
    current,
    onSelect,
    children,
}: {
    value: T;
    current: T;
    onSelect: (value: T) => void;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={current === value}
            className={`mj_TrackerToggleTab${current === value ? " mj_TrackerToggleTab_active" : ""}`}
            onClick={() => onSelect(value)}
        >
            {children}
        </button>
    );
}

export function WorkView({ api }: { api: WorkViewLoader }): React.ReactElement {
    const [groupBy, setGroupBy] = useState<WorkViewGroupBy>("repo");
    // Defaults to the focused view, mirroring the Inbox defaulting to "Needs you": parked work is
    // real but set aside, and it is 8 of 30 loops today.
    const [scope, setScope] = useState<WorkScope>("active");
    const { state } = useWorkView(api, groupBy);

    const scoped = useMemo(() => (state.status === "ok" ? applyScope(state.groups, scope) : []), [state, scope]);

    const body = ((): React.ReactElement => {
        switch (state.status) {
            case "loading":
                return (
                    <div className="mj_WorkLoading" role="status">
                        <p>Loading Work…</p>
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
                // Everything can be filtered away while the store itself is non-empty; say so
                // rather than rendering a blank pane that looks broken.
                if (scoped.length === 0) {
                    return (
                        <div className="mj_TrackerEmpty">
                            <p className="mj_TrackerEmpty_title">Nothing active</p>
                            <p className="mj_TrackerEmpty_body">
                                Every loop here is parked. Switch to All to see them.
                            </p>
                        </div>
                    );
                }
                return (
                    <div className="mj_WorkGroups">
                        {scoped.map((group) => (
                            <section className="mj_WorkGroup" key={group.key}>
                                <h2 className="mj_WorkGroup_header">
                                    {group.key}
                                    <span className="mj_WorkGroup_count">{group.loops.length}</span>
                                </h2>
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
            <div className="mj_TrackerInboxToggle" role="tablist" aria-label="Work scope">
                <ToggleTab value="active" current={scope} onSelect={setScope}>
                    Active
                </ToggleTab>
                <ToggleTab value="all" current={scope} onSelect={setScope}>
                    All
                </ToggleTab>
            </div>
            <div className="mj_TrackerInboxToggle mj_WorkGroupToggle" role="tablist" aria-label="Work grouping">
                <ToggleTab value="repo" current={groupBy} onSelect={setGroupBy}>
                    Repository
                </ToggleTab>
                <ToggleTab value="domain" current={groupBy} onSelect={setGroupBy}>
                    Domain
                </ToggleTab>
            </div>
            {body}
        </div>
    );
}
