/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The read-only Work surface: the loop store as a tracker list, and a loop detail.
 *
 * The journal endpoint stays the source of the loop data and its grouping. This component owns the
 * view choices (grouping, status/domain/search filters) and renders either the list or, when the
 * tracker has a loop selected, that loop's detail. Both render from the SAME loaded payload, and the
 * component stays mounted across the switch, so filters, grouping and scroll position survive a
 * round trip into a detail and back.
 *
 * Rows reuse the tracker's row anatomy (mj_TrackerItemRow and its sub-elements, shared with ItemRow
 * and MissionsList) so Work reads as the same surface as Inbox and Missions: glyph, a title line
 * leading with the tabular #id, the description's lead sentence, and one meta line. Blocked is the
 * one status that asks for attention and gets the tracker's needs-you treatment.
 *
 * Claims are advisory collision hints, never locks, and the copy says so.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SearchIcon } from "../icons";
import { useWorkView, type WorkViewLoader } from "../use-work-view";
import type { WorkViewGroupBy, WorkViewLoop } from "../work-view";
import { WorkLoopDetail } from "./WorkLoopDetail";
import { WorkGlyph, WorkStatusChip } from "./work-parts";
import {
    allLoops,
    applyFilters,
    claimCopy,
    compactAge,
    countBy,
    DEFAULT_WORK_FILTERS,
    findLoop,
    needsAttention,
    openedMs,
    otherDimension,
    ownerLabel,
    spokenAge,
    statusFilterLabel,
    statusLabel,
    summaryLine,
    WORK_STATUS_ORDER,
    type WorkFilters,
    type WorkStatusFilter,
} from "./work-format";

export { summaryLine } from "./work-format";

function WorkRow({
    loop,
    groupBy,
    now,
    onOpen,
}: {
    loop: WorkViewLoop;
    groupBy: WorkViewGroupBy;
    now: number;
    onOpen: (id: number) => void;
}): React.ReactElement {
    const lead = summaryLine(loop.description);
    const attention = needsAttention(loop);
    const opened = openedMs(loop);
    const age = compactAge(opened, now);
    const dimension = otherDimension(loop, groupBy);
    const owner = ownerLabel(loop.owner);

    const label = [
        `Loop ${loop.id}`,
        loop.title,
        statusLabel(loop.status),
        `priority ${loop.priority}`,
        dimension,
        owner ? `owner ${owner}` : "",
        loop.claim ? claimCopy(loop.claim) : "",
        spokenAge(opened, now),
    ]
        .filter(Boolean)
        .join(", ");

    return (
        <button
            type="button"
            className={`mj_TrackerItemRow mj_WorkRow${attention ? " mj_TrackerItemRow_needsyou" : ""}`}
            data-loop-id={loop.id}
            aria-label={label}
            onClick={() => onOpen(loop.id)}
        >
            <span className="mj_TrackerItemRow_glyph">
                <WorkGlyph status={loop.status} />
            </span>
            <span className="mj_TrackerItemRow_main">
                <span className="mj_TrackerItemRow_title">
                    <span className="mj_TrackerItemRow_num">#{loop.id}</span>
                    {loop.title}
                </span>
                <span className={`mj_WorkRow_lead${lead ? "" : " mj_WorkRow_lead_empty"}`}>
                    {lead || "No description yet."}
                </span>
                <span className="mj_TrackerItemRow_meta mj_WorkRow_meta">
                    <WorkStatusChip status={loop.status} />
                    <span className="mj_WorkPriority" title={`Priority ${loop.priority}`}>
                        P{loop.priority}
                    </span>
                    <span className="mj_WorkRow_dimension">{dimension}</span>
                    {owner ? <span className="mj_WorkRow_owner">{owner}</span> : null}
                    {loop.claim ? (
                        <span className={`mj_WorkClaim mj_WorkClaim_${loop.claim.liveness}`}>
                            {claimCopy(loop.claim)}
                        </span>
                    ) : null}
                    {age ? (
                        <span className="mj_WorkRow_age" title={loop.opened}>
                            {age === "today" ? "opened today" : `${age} old`}
                        </span>
                    ) : null}
                </span>
            </span>
        </button>
    );
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
            className={`mj_Seg_item mj_TrackerToggleTab${current === value ? " mj_Seg_item_on mj_TrackerToggleTab_active" : ""}`}
            onClick={() => onSelect(value)}
        >
            {children}
        </button>
    );
}

function FilterBar({
    loops,
    filters,
    groupBy,
    onFilters,
    onGroupBy,
}: {
    loops: readonly WorkViewLoop[];
    filters: WorkFilters;
    groupBy: WorkViewGroupBy;
    onFilters: (next: WorkFilters) => void;
    onGroupBy: (next: WorkViewGroupBy) => void;
}): React.ReactElement {
    const statusCounts = countBy(loops, (loop) => loop.status);
    const inPlay = loops.filter((loop) => loop.status === "active" || loop.status === "blocked").length;
    const domainCounts = countBy(loops, (loop) => loop.domain);
    const domains = [...domainCounts.keys()].sort((a, b) => a.localeCompare(b));
    // A deep-linked or remembered domain that has since emptied still needs an option, or the
    // <select> would silently show a different value from the one filtering the list.
    if (filters.domain && !domainCounts.has(filters.domain)) domains.unshift(filters.domain);
    const statusOptions: WorkStatusFilter[] = [
        "open",
        "all",
        ...WORK_STATUS_ORDER.filter((status) => (statusCounts.get(status) ?? 0) > 0 || filters.status === status),
    ];
    const statusCount = (value: WorkStatusFilter): number =>
        value === "open" ? inPlay : value === "all" ? loops.length : (statusCounts.get(value) ?? 0);

    return (
        <div className="mj_WorkFilters" role="search" aria-label="Filter work">
            <label className="mj_InputIcon mj_WorkSearch">
                <SearchIcon className="mj_WorkSearch_icon" aria-hidden="true" />
                <input
                    type="search"
                    className="mj_Input mj_WorkSearch_input"
                    placeholder="Search work"
                    aria-label="Search work"
                    value={filters.query}
                    onChange={(event) => onFilters({ ...filters, query: event.target.value })}
                />
            </label>
            <select
                className={`mj_Input mj_Input_select mj_WorkSelect${filters.status !== "open" ? " mj_WorkSelect_set" : ""}`}
                aria-label="Status"
                value={filters.status}
                onChange={(event) => onFilters({ ...filters, status: event.target.value as WorkStatusFilter })}
            >
                {statusOptions.map((value) => (
                    <option key={value} value={value}>
                        {statusFilterLabel(value)} ({statusCount(value)})
                    </option>
                ))}
            </select>
            <select
                className={`mj_Input mj_Input_select mj_WorkSelect${filters.domain ? " mj_WorkSelect_set" : ""}`}
                aria-label="Domain"
                value={filters.domain}
                onChange={(event) => onFilters({ ...filters, domain: event.target.value })}
            >
                <option value="">All domains</option>
                {domains.map((domain) => (
                    <option key={domain} value={domain}>
                        {domain} ({domainCounts.get(domain) ?? 0})
                    </option>
                ))}
            </select>
            <div
                className="mj_Seg mj_Seg_rect mj_TrackerInboxToggle mj_WorkGroupToggle"
                role="tablist"
                aria-label="Group by"
            >
                <ToggleTab value="repo" current={groupBy} onSelect={onGroupBy}>
                    Repo
                </ToggleTab>
                <ToggleTab value="domain" current={groupBy} onSelect={onGroupBy}>
                    Domain
                </ToggleTab>
            </div>
        </div>
    );
}

function filtersActive(filters: WorkFilters): boolean {
    return (
        filters.status !== DEFAULT_WORK_FILTERS.status ||
        filters.domain !== DEFAULT_WORK_FILTERS.domain ||
        filters.query.trim() !== ""
    );
}

export function WorkView({
    api,
    selectedLoopId,
    onOpenLoop,
    onCloseLoop,
    onTrackerLink,
    now,
}: {
    api: WorkViewLoader;
    /** The loop whose detail is open; undefined shows the list. */
    selectedLoopId?: number;
    onOpenLoop?: (id: number) => void;
    onCloseLoop?: () => void;
    /** matron://item and matron://mission links inside a description open in-app. */
    onTrackerLink?: (kind: "item" | "mission", num: number) => void;
    /** Clock injection for tests and fixtures; defaults to the wall clock at render time. */
    now?: number;
}): React.ReactElement {
    const [groupBy, setGroupBy] = useState<WorkViewGroupBy>("repo");
    // Defaults to work in play (active + blocked), mirroring the Inbox defaulting to "Needs you":
    // parked work is real but set aside, and it is half the store on a typical day.
    const [filters, setFilters] = useState<WorkFilters>(DEFAULT_WORK_FILTERS);
    // Uncontrolled fallback so the component also works without a tracker-level selection owner.
    const [localSelection, setLocalSelection] = useState<number | undefined>(undefined);
    const controlled = onOpenLoop !== undefined;
    const selected = controlled ? selectedLoopId : localSelection;
    const { state } = useWorkView(api, groupBy);
    const clock = now ?? Date.now();

    const rootRef = useRef<HTMLDivElement>(null);
    const listScrollRef = useRef(0);
    const returnFocusRef = useRef<number | null>(null);
    // True once a detail has been shown, so the list only claims focus on the way BACK from one,
    // never on first mount.
    const cameFromDetailRef = useRef(false);

    const scroller = (): HTMLElement | null => rootRef.current?.closest(".mj_TrackerPane_body") ?? null;

    const openLoop = useCallback(
        (id: number) => {
            listScrollRef.current = scroller()?.scrollTop ?? 0;
            returnFocusRef.current = id;
            if (controlled) onOpenLoop?.(id);
            else setLocalSelection(id);
        },
        [controlled, onOpenLoop],
    );

    const closeLoop = useCallback(() => {
        if (controlled) onCloseLoop?.();
        else setLocalSelection(undefined);
    }, [controlled, onCloseLoop]);

    // Back from a detail: restore the list's scroll position and return focus to the row that was
    // opened, so keyboard and screen-reader users land where they left rather than at the top.
    useLayoutEffect(() => {
        if (selected !== undefined) {
            cameFromDetailRef.current = true;
            scroller()?.scrollTo?.({ top: 0 });
            return;
        }
        const id = returnFocusRef.current;
        returnFocusRef.current = null;
        if (id !== null) {
            const body = scroller();
            if (body) body.scrollTop = listScrollRef.current;
        }
        if (!cameFromDetailRef.current) return;
        cameFromDetailRef.current = false;
        // Land on the row that was opened; a detail reached by deep link has no originating row, so
        // fall back to the search field rather than leaving focus on a control that just unmounted.
        const row = id !== null ? rootRef.current?.querySelector<HTMLElement>(`[data-loop-id="${id}"]`) : null;
        const target = row ?? rootRef.current?.querySelector<HTMLElement>('input[aria-label="Search work"]');
        target?.focus({ preventScroll: true });
    }, [selected]);

    const loops = useMemo(() => (state.status === "ok" ? allLoops(state.groups) : []), [state]);
    const groups = useMemo(() => (state.status === "ok" ? applyFilters(state.groups, filters) : []), [state, filters]);

    if (selected !== undefined) {
        const loop = state.status === "ok" ? findLoop(state.groups, selected) : undefined;
        return (
            <div ref={rootRef} className="mj_WorkView mj_WorkView_detail">
                <WorkLoopDetail
                    loopId={selected}
                    loop={loop}
                    state={state}
                    now={clock}
                    onBack={closeLoop}
                    onTrackerLink={onTrackerLink}
                />
            </div>
        );
    }

    const shown = groups.reduce((sum, group) => sum + group.loops.length, 0);

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
                        <p className="mj_TrackerEmpty_title">No open work</p>
                        <p className="mj_TrackerEmpty_hint">Every loop is closed. New loops show up here.</p>
                    </div>
                );
            case "ok":
                // Everything can be filtered away while the store itself is non-empty; say so and
                // offer the way back rather than rendering a blank pane that looks broken.
                if (groups.length === 0) {
                    const onlySetAside = !filtersActive({ ...filters, status: "open" }) && filters.status === "open";
                    return (
                        <div className="mj_TrackerEmpty">
                            <p className="mj_TrackerEmpty_title">
                                {onlySetAside ? "Nothing in play" : "No loops match"}
                            </p>
                            <p className="mj_TrackerEmpty_hint">
                                {onlySetAside
                                    ? "Every loop here is parked or paused."
                                    : "Try a different search, status or domain."}
                            </p>
                            <button
                                type="button"
                                className="mj_TrackerTextButton"
                                onClick={() =>
                                    setFilters(onlySetAside ? { ...filters, status: "all" } : DEFAULT_WORK_FILTERS)
                                }
                            >
                                {onlySetAside ? "Show all statuses" : "Clear filters"}
                            </button>
                        </div>
                    );
                }
                return (
                    <div className="mj_WorkGroups">
                        {groups.map((group) => (
                            <section className="mj_WorkGroup" key={group.key} aria-label={group.key}>
                                <h2 className="mj_WorkGroup_header">
                                    <span className="mj_WorkGroup_key">{group.key}</span>
                                    <span className="mj_WorkGroup_count">{group.loops.length}</span>
                                </h2>
                                {group.loops.map((loop) => (
                                    <WorkRow
                                        key={loop.id}
                                        loop={loop}
                                        groupBy={groupBy}
                                        now={clock}
                                        onOpen={openLoop}
                                    />
                                ))}
                            </section>
                        ))}
                    </div>
                );
        }
    })();

    return (
        <div ref={rootRef} className="mj_TrackerList mj_WorkView">
            <FilterBar
                loops={loops}
                filters={filters}
                groupBy={groupBy}
                onFilters={setFilters}
                onGroupBy={setGroupBy}
            />
            {state.status === "ok" && filtersActive(filters) && groups.length > 0 ? (
                <div className="mj_WorkSummary" role="status">
                    <span>
                        {shown} of {loops.length} loops
                    </span>
                    <button
                        type="button"
                        className="mj_TrackerTextButton"
                        onClick={() => setFilters(DEFAULT_WORK_FILTERS)}
                    >
                        Clear filters
                    </button>
                </div>
            ) : null}
            {body}
        </div>
    );
}
