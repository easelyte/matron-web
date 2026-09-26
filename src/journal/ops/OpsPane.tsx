/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Ops pane (loop #542 phase B): the standing page that replaces the useful half of Mission
 * Control. Two data paths, both read-only:
 *
 *  - Boxes: GET /devices (`status` = each bridge's persisted box report: Claude + Codex quotas,
 *    live sessions, disk, account, host vitals), refreshed live by `box_status` frames.
 *  - One box's detail: the `ops_snapshot` agent RPC, one call per section (host, alerts, timers,
 *    usage, posture), each under the relay's 16 KiB frame cap. A bridge that predates the RPC
 *    answers unknown_method, which renders as "needs bridge update", never as an error.
 *
 * Everything is presentational over the client's fetch helpers; the pane holds its own data (no
 * store churn for a page nobody may open) except the live box reports, which the client keeps.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "../client";
import { CheckIcon, CloseIcon } from "../icons";
import { normalizePercent, resetDisplay, usageLevel } from "../status";
import type { ClientState, DeviceDTO } from "../types";
import {
    formatBytes,
    formatCount,
    formatDuration,
    formatInterval,
    formatRelative,
    formatUsd,
    limitLabel,
    severityTone,
    usedPercent,
} from "./format";
import {
    type BoxLimitLine,
    type BoxStatus,
    type JournalMetrics,
    type OpsAlerts,
    type OpsHost,
    type OpsPosture,
    type OpsSection,
    type OpsSectionState,
    type OpsTimer,
    type OpsTimers,
    type OpsUsage,
    splitLimitLines,
} from "./model";

// Host refreshes while the page is open and visible (the MC tab polled every 5 s; the bridge
// samples CPU over ~300 ms per call, so 15 s keeps it cheap). Everything else on open + Refresh.
const HOST_REFRESH_MS = 15_000;
const DEVICES_REFRESH_MS = 60_000;

type SectionStates = { [S in OpsSection]: OpsSectionState<S> };
const LOADING: SectionStates = {
    host: { phase: "loading" },
    alerts: { phase: "loading" },
    timers: { phase: "loading" },
    usage: { phase: "loading" },
    posture: { phase: "loading" },
};

function useClock(intervalMs: number): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
}

/** Merge the persisted report with a newer live frame (newest reported_at wins). */
export function effectiveStatus(device: DeviceDTO, live: Record<number, BoxStatus> | undefined): BoxStatus | undefined {
    const pushed = live?.[device.device_id];
    if (!pushed) return device.status;
    if (!device.status) return pushed;
    return (pushed.reported_at ?? 0) >= (device.status.reported_at ?? 0) ? pushed : device.status;
}

/** Boxes that can answer ops_snapshot: agent devices with a box report (only bridges send one),
 *  fetched or live, so a box whose first report lands after the roster fetch is still asked. */
export function snapshotTargets(devices: DeviceDTO[], live?: Record<number, BoxStatus>): DeviceDTO[] {
    return devices.filter((d) => d.kind === "agent" && effectiveStatus(d, live) !== undefined);
}

export function OpsPane({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const now = useClock(15_000);
    const [devices, setDevices] = useState<DeviceDTO[] | null>(null);
    const [devicesError, setDevicesError] = useState<string | null>(null);
    const [metrics, setMetrics] = useState<JournalMetrics | null | undefined>(undefined);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [sections, setSections] = useState<SectionStates>(LOADING);
    const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const generation = useRef(0);
    // Newest request whose reply has landed, per section. A reply lands unless a NEWER one already
    // did, so a slow host poll can never overwrite a fresher reading, yet a box that is always
    // slower than the poll interval still settles (every reply is newer than the last applied).
    const applied = useRef<Record<string, number>>({});
    const seq = useRef(0);

    const loadDevices = useCallback(async (): Promise<void> => {
        try {
            const agents = await client.listAgents();
            setDevices(agents);
            setDevicesError(null);
        } catch (e) {
            setDevicesError(e instanceof Error ? e.message : "Could not load boxes.");
        }
        setMetrics(await client.journalMetrics());
    }, [client]);

    const targets = useMemo(() => snapshotTargets(devices ?? [], state.boxStatusLive), [devices, state.boxStatusLive]);
    const target =
        targets.find((d) => d.device_id === selectedId) ?? targets.find((d) => d.connected) ?? targets[0] ?? null;
    const targetId = target?.device_id ?? null;

    const loadSections = useCallback(
        async (deviceId: number, only?: OpsSection[], keepGoodOnError = only !== undefined): Promise<void> => {
            const gen = generation.current;
            const wanted = only ?? (["host", "alerts", "timers", "usage", "posture"] as OpsSection[]);
            await Promise.all(
                wanted.map(async (section) => {
                    const ticket = ++seq.current;
                    const result = await client.opsSnapshot(deviceId, section);
                    if (generation.current !== gen || (applied.current[section] ?? 0) > ticket) return;
                    applied.current[section] = ticket;
                    setSections((prev) => {
                        // Keep the last good data on a transient failure of a periodic refresh.
                        const before = prev[section];
                        if (keepGoodOnError && result.phase !== "ok" && before.phase === "ok") return prev;
                        return { ...prev, [section]: result };
                    });
                }),
            );
            if (generation.current === gen) setRefreshedAt(Date.now());
        },
        [client],
    );

    const refresh = useCallback(async (): Promise<void> => {
        setRefreshing(true);
        await loadDevices();
        if (targetId !== null) await loadSections(targetId);
        setRefreshing(false);
    }, [loadDevices, loadSections, targetId]);

    useEffect(() => {
        void loadDevices();
        const timer = window.setInterval(() => void loadDevices(), DEVICES_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [loadDevices]);

    // A new target box starts from a clean slate; stale sections from another box never show.
    useEffect(() => {
        if (targetId === null) return undefined;
        generation.current += 1;
        setSections(LOADING);
        void loadSections(targetId);
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") void loadSections(targetId, ["host"]);
        }, HOST_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [targetId, loadSections]);

    // The roster says the selected box is offline: re-ask alerts and timers right away, and let a
    // failure REPLACE the last good reading, so the page never keeps claiming health from checks
    // it can no longer repeat. A request can also wake the box, in which case the re-read is fresh.
    const targetOnline = target?.connected ?? true;
    useEffect(() => {
        if (targetId === null || targetOnline) return;
        // Drop the old readings first: until the box answers again there is no current reading.
        setSections((prev) => ({ ...prev, alerts: { phase: "loading" }, timers: { phase: "loading" } }));
        void loadSections(targetId, ["alerts", "timers"], false);
    }, [devices, targetId, targetOnline, loadSections]);

    const agents = devices ?? [];
    const noBridge = devices !== null && targets.length === 0;

    return (
        <div className="mj_OpsPane" data-spec="ops.pane">
            <div className="mj_TrackerPane_top mj_OpsPane_top">
                <button
                    type="button"
                    className="mj_IconButton mj_TrackerPane_close"
                    aria-label="Close ops"
                    onClick={() => client.closeOpsView()}
                >
                    <CloseIcon />
                </button>
                <h1 className="mj_TrackerPane_title">Ops</h1>
                {targets.length > 1 ? (
                    <div className="mj_Seg mj_OpsBoxSwitch" role="tablist" aria-label="Box">
                        {targets.map((d) => (
                            <button
                                key={d.device_id}
                                type="button"
                                role="tab"
                                aria-selected={d.device_id === targetId}
                                className={`mj_Seg_item${d.device_id === targetId ? " mj_Seg_item_on" : ""}`}
                                onClick={() => setSelectedId(d.device_id)}
                            >
                                {d.name || `Box ${d.device_id}`}
                            </button>
                        ))}
                    </div>
                ) : null}
                <span className="mj_OpsPane_updated" aria-live="polite">
                    {refreshedAt ? `Updated ${formatRelative(refreshedAt, now)}` : ""}
                </span>
                <button
                    type="button"
                    className="mj_Btn mj_OpsPane_refresh"
                    onClick={() => void refresh()}
                    disabled={refreshing}
                >
                    {refreshing ? "Refreshing…" : "Refresh"}
                </button>
            </div>

            <div className="mj_OpsPane_body">
                <div className="mj_OpsPane_column">
                    <OpsSummary agents={agents} live={state.boxStatusLive} sections={sections} target={target} />

                    <OpsSectionFrame title="Boxes" meta={devices ? `${agents.length}` : undefined} spec="ops.boxes">
                        {devicesError ? (
                            <OpsNote tone="error">{devicesError}</OpsNote>
                        ) : devices === null ? (
                            <OpsNote>Loading boxes…</OpsNote>
                        ) : agents.length === 0 ? (
                            <OpsNote>No agent boxes on this account yet.</OpsNote>
                        ) : (
                            <>
                                <div className="mj_OpsBoxes">
                                    {agents
                                        .filter((d) => effectiveStatus(d, state.boxStatusLive))
                                        .map((d) => (
                                            <BoxCard
                                                key={d.device_id}
                                                device={d}
                                                status={effectiveStatus(d, state.boxStatusLive)}
                                                now={now}
                                                selected={targets.length > 1 && d.device_id === targetId}
                                            />
                                        ))}
                                </div>
                                <OtherAgents
                                    agents={agents.filter((d) => !effectiveStatus(d, state.boxStatusLive))}
                                    now={now}
                                />
                            </>
                        )}
                    </OpsSectionFrame>

                    {!noBridge &&
                    (Object.values(sections) as { phase: string }[]).every((x) => x.phase === "unsupported") ? (
                        // An old bridge answers every section the same way: say it once.
                        <OpsSectionFrame title="Host, alerts, timers, usage" meta={target?.name} spec="ops.detail">
                            <SectionBody state={sections.host} render={() => null} />
                        </OpsSectionFrame>
                    ) : noBridge ? (
                        <OpsNote>
                            No box has sent a report yet, so there is nothing to ask for processes, timers or usage.
                        </OpsNote>
                    ) : (
                        <>
                            <OpsSectionFrame
                                title="Host"
                                meta={
                                    sections.host.phase === "ok" && sections.host.data.hostname
                                        ? sections.host.data.hostname
                                        : target?.name
                                }
                                spec="ops.host"
                            >
                                <SectionBody state={sections.host} render={(d) => <HostView host={d} />} />
                            </OpsSectionFrame>

                            <OpsSectionFrame title="Alerts" meta={alertMeta(sections.alerts)} spec="ops.alerts">
                                <SectionBody
                                    state={sections.alerts}
                                    render={(d) => <AlertsView alerts={d} now={now} />}
                                />
                            </OpsSectionFrame>

                            <OpsSectionFrame title="Timers" meta={timerMeta(sections.timers)} spec="ops.timers">
                                <SectionBody
                                    state={sections.timers}
                                    render={(d) => <TimersView data={d} now={now} />}
                                />
                            </OpsSectionFrame>

                            <OpsSectionFrame title="Usage" meta="Claude + Codex, all machines" spec="ops.usage">
                                <SectionBody state={sections.usage} render={(d) => <UsageView usage={d} now={now} />} />
                            </OpsSectionFrame>

                            <OpsSectionFrame title="Security and APIs" spec="ops.posture">
                                <SectionBody
                                    state={sections.posture}
                                    render={(d) => <PostureView posture={d} now={now} />}
                                />
                            </OpsSectionFrame>
                        </>
                    )}

                    <OpsSectionFrame title="Journal" spec="ops.journal">
                        <JournalView metrics={metrics} />
                    </OpsSectionFrame>
                </div>
            </div>
        </div>
    );
}

// ───────────────────────── frame + states ─────────────────────────

function OpsSectionFrame({
    title,
    meta,
    spec,
    children,
}: {
    title: string;
    meta?: string;
    spec: string;
    children: React.ReactNode;
}): React.ReactElement {
    const id = `ops-${spec.replace(/\W/g, "-")}`;
    return (
        <section className="mj_OpsSection" aria-labelledby={id} data-spec={spec}>
            <h2 className="mj_OpsSection_title" id={id}>
                <span>{title}</span>
                {meta ? <span className="mj_OpsSection_meta">{meta}</span> : null}
            </h2>
            {children}
        </section>
    );
}

function OpsNote({
    tone = "quiet",
    children,
}: {
    tone?: "quiet" | "error" | "update";
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <p className={`mj_OpsNote mj_OpsNote_${tone}`} role={tone === "error" ? "alert" : undefined}>
            {children}
        </p>
    );
}

function SectionBody<S extends OpsSection>({
    state,
    render,
}: {
    state: OpsSectionState<S>;
    render: (data: Extract<OpsSectionState<S>, { phase: "ok" }>["data"]) => React.ReactNode;
}): React.ReactElement {
    switch (state.phase) {
        case "loading":
            return (
                <div className="mj_OpsCard mj_OpsCard_loading" aria-busy="true">
                    <span className="mj_OpsSkeleton" />
                    <span className="mj_OpsSkeleton mj_OpsSkeleton_short" />
                </div>
            );
        case "unsupported":
            return (
                <OpsNote tone="update">
                    <strong>Needs bridge update.</strong> This box's bridge predates the ops snapshot. Host, alerts,
                    timers, usage and security show up here after its next restart.
                </OpsNote>
            );
        case "not_configured":
            return <OpsNote>Not set up on this box.</OpsNote>;
        case "asleep":
            return (
                <OpsNote>The box is asleep or offline. It wakes on the next request; try Refresh in a minute.</OpsNote>
            );
        case "error":
            return <OpsNote tone="error">{state.message}</OpsNote>;
        case "ok":
            return (
                <>
                    {render(state.data)}
                    {state.truncated ? <p className="mj_OpsFootnote">Trimmed to fit one reply.</p> : null}
                </>
            );
    }
}

function alertMeta(s: OpsSectionState<"alerts">): string | undefined {
    if (s.phase !== "ok") return undefined;
    return s.data.active.length ? `${s.data.active.length} open` : "none open";
}

function timerMeta(s: OpsSectionState<"timers">): string | undefined {
    if (s.phase !== "ok") return undefined;
    const bad = s.data.timers.filter(timerNeedsAttention).length;
    return bad ? `${bad} need attention` : `${s.data.timers.length} healthy`;
}

// ───────────────────────── summary line ─────────────────────────

function OpsSummary({
    agents,
    live,
    sections,
    target,
}: {
    agents: DeviceDTO[];
    live: Record<number, BoxStatus> | undefined;
    sections: SectionStates;
    target: DeviceDTO | null;
}): React.ReactElement | null {
    const parts: { text: string; tone: "critical" | "warn" | "ok" }[] = [];
    if (sections.alerts.phase === "ok") {
        const critical = sections.alerts.data.active.filter((a) => severityTone(a.severity) === "critical").length;
        const open = sections.alerts.data.active.length;
        if (open)
            parts.push({ text: `${open} open alert${open === 1 ? "" : "s"}`, tone: critical ? "critical" : "warn" });
    }
    if (sections.timers.phase === "ok") {
        const failed = sections.timers.data.timers.filter((t) => t.result === "failed").length;
        const stale = sections.timers.data.timers.filter((t) => t.result !== "failed" && t.stale).length;
        if (failed) parts.push({ text: `${failed} timer${failed === 1 ? "" : "s"} failing`, tone: "critical" });
        if (stale) parts.push({ text: `${stale} timer${stale === 1 ? "" : "s"} overdue`, tone: "warn" });
    }
    let worst: { label: string; percent: number } | null = null;
    for (const d of agents) {
        for (const line of effectiveStatus(d, live)?.limits?.lines ?? []) {
            if (!worst || line.percent > worst.percent)
                worst = { label: limitLabel(line.id, line.label), percent: line.percent };
        }
    }
    if (worst && worst.percent >= 85)
        parts.push({ text: `${worst.label} quota at ${Math.round(worst.percent)}%`, tone: "critical" });
    else if (worst && worst.percent >= 50)
        parts.push({ text: `${worst.label} quota at ${Math.round(worst.percent)}%`, tone: "warn" });

    // A sleeping box is normal (boxes idle-stop and wake on demand), so it is shown on its card,
    // not raised here.

    // "All quiet" is a claim that the checks ran: it needs a real alerts AND timers reading. Without
    // them, say what is unknown rather than implying health.
    // Only words the message: an offline roster read already re-asked alerts and timers (see the
    // effect in OpsPane), so an "ok" here is a reading the box gave after that read.
    const targetOffline = target !== null && !target.connected;
    const checked = sections.alerts.phase === "ok" && sections.timers.phase === "ok";
    const pending = sections.alerts.phase === "loading" || sections.timers.phase === "loading";
    if (!parts.length && !checked) {
        if (pending || agents.length === 0) return null;
        const outdated = sections.alerts.phase === "unsupported" || sections.timers.phase === "unsupported";
        return (
            <div className="mj_OpsSummary mj_OpsSummary_unknown" role="status" data-spec="ops.summary">
                <span className="mj_OpsSummary_glyph" aria-hidden="true">
                    <span className="mj_OpsDot" />
                </span>
                <span className="mj_OpsSummary_text">
                    {targetOffline
                        ? `${target?.name || "This box"} is offline, so alerts and timers aren't current.`
                        : outdated
                          ? "Alerts and timers can't be checked until this box's bridge is updated."
                          : "Alerts and timers couldn't be checked just now."}
                </span>
            </div>
        );
    }
    const tone = parts.some((p) => p.tone === "critical") ? "critical" : parts.length ? "warn" : "ok";
    return (
        <div className={`mj_OpsSummary mj_OpsSummary_${tone}`} role="status" data-spec="ops.summary">
            <span className="mj_OpsSummary_glyph" aria-hidden="true">
                {tone === "ok" ? <CheckIcon /> : <span className="mj_OpsDot" />}
            </span>
            <span className="mj_OpsSummary_text">
                {parts.length === 0 ? "All quiet. Nothing needs you." : parts.map((p) => p.text).join(" · ")}
            </span>
        </div>
    );
}

// ───────────────────────── boxes ─────────────────────────

function Meter({
    label,
    percent,
    detail,
    spec,
}: {
    label: string;
    percent: number | null;
    detail?: string;
    spec?: string;
}): React.ReactElement {
    const norm = percent === null ? null : normalizePercent(percent);
    const level = norm === null ? "unknown" : usageLevel(norm);
    return (
        <div className="mj_OpsMeter" data-spec={spec}>
            <span className="mj_OpsMeter_label">{label}</span>
            <span
                className="mj_OpsMeter_track"
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={norm ?? undefined}
                aria-valuetext={norm === null ? "unknown" : `${Math.round(norm)}%${detail ? `, ${detail}` : ""}`}
            >
                <span className={`mj_UsageFill mj_UsageFill_${level}`} style={{ width: `${norm ?? 0}%` }} />
            </span>
            <span className={`mj_OpsMeter_value mj_UsagePercent_${level}`}>
                {norm === null ? "—" : `${Math.round(norm)}%`}
            </span>
            <span className="mj_OpsMeter_detail">{detail ?? ""}</span>
        </div>
    );
}

function LimitMeters({ title, lines, now }: { title: string; lines: BoxLimitLine[]; now: number }): React.ReactElement {
    return (
        <div className="mj_OpsBox_group">
            <h3 className="mj_OpsBox_groupTitle">{title}</h3>
            {lines.map((line) => {
                const reset = resetDisplay(line.resets_at, line.resets, now);
                return (
                    <Meter
                        key={line.id}
                        label={limitLabel(line.id, line.label)}
                        percent={line.percent}
                        detail={reset ? `resets ${/^\d/.test(reset) ? `in ${reset}` : reset}` : undefined}
                    />
                );
            })}
        </div>
    );
}

function BoxCard({
    device,
    status,
    now,
    selected,
}: {
    device: DeviceDTO;
    status: BoxStatus | undefined;
    now: number;
    selected: boolean;
}): React.ReactElement {
    const { claude, codex } = splitLimitLines(status?.limits?.lines);
    const state = device.connected ? "online" : "asleep";
    const seen = device.last_seen_at ? formatRelative(device.last_seen_at, now) : null;
    const vitals = status?.vitals;
    const vitalsStale = vitals ? now - vitals.sampled_at_ms > 15 * 60_000 : false;
    const disk = status?.disk;
    return (
        <article
            className={`mj_OpsCard mj_OpsBox${selected ? " mj_OpsBox_selected" : ""}`}
            data-spec="ops.box"
            data-device-id={device.device_id}
        >
            <header className="mj_OpsBox_head">
                <span className={`mj_OpsState mj_OpsState_${state}`}>
                    <span className="mj_OpsDot" aria-hidden="true" />
                    {device.connected ? "Online" : "Asleep"}
                </span>
                <h3 className="mj_OpsBox_name">{device.name || `Box ${device.device_id}`}</h3>
                <span className="mj_OpsBox_seen">
                    {device.connected
                        ? status?.activity
                            ? liveSessionsText(status.activity.live_sessions)
                            : ""
                        : seen
                          ? `seen ${seen}`
                          : ""}
                </span>
            </header>
            {status?.account || status?.reported_at ? (
                <p className="mj_OpsBox_sub">
                    {[
                        status?.account?.email,
                        status?.reported_at ? `reported ${formatRelative(status.reported_at, now)}` : null,
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </p>
            ) : null}
            {!status ? (
                <p className="mj_OpsBox_empty">No box report. Only a Matron bridge sends one.</p>
            ) : (
                <>
                    {claude.length ? <LimitMeters title="Claude" lines={claude} now={now} /> : null}
                    {codex.length ? <LimitMeters title="Codex" lines={codex} now={now} /> : null}
                    {!claude.length && !codex.length ? (
                        <p className="mj_OpsBox_empty">No quota reading yet; it arrives after the next turn ends.</p>
                    ) : null}
                    <div className={`mj_OpsBox_group mj_OpsBox_host${vitalsStale ? " mj_OpsBox_host_stale" : ""}`}>
                        <h3 className="mj_OpsBox_groupTitle">
                            Host
                            {vitals ? (
                                <span className="mj_OpsBox_groupMeta">
                                    {vitalsStale ? `sampled ${formatRelative(vitals.sampled_at_ms, now)}` : ""}
                                </span>
                            ) : null}
                        </h3>
                        {vitals ? (
                            <>
                                <Meter label="CPU" percent={vitals.cpu_pct} />
                                <Meter label="Memory" percent={vitals.ram_pct} />
                            </>
                        ) : null}
                        {disk ? (
                            <Meter
                                label="Disk"
                                percent={usedPercent(disk.free_bytes, disk.total_bytes)}
                                detail={`${formatBytes(disk.free_bytes)} free`}
                            />
                        ) : null}
                        {!vitals && !disk ? <p className="mj_OpsBox_empty">No host reading in the report.</p> : null}
                    </div>
                    {status.activity && status.activity.last_hour.length ? (
                        <div className="mj_OpsBox_group">
                            <h3 className="mj_OpsBox_groupTitle">Last hour</h3>
                            <ul className="mj_OpsBox_folders">
                                {status.activity.last_hour.slice(0, 4).map((f) => (
                                    <li key={f.path} title={f.path}>
                                        <span className="mj_OpsBox_folder">{basename(f.path)}</span>
                                        <span className="mj_OpsBox_folderCount">
                                            {f.sessions} session{f.sessions === 1 ? "" : "s"}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </>
            )}
        </article>
    );
}

/** Agents that never send a box report (e.g. the anton agent): one quiet line each, not a card. */
function OtherAgents({ agents, now }: { agents: DeviceDTO[]; now: number }): React.ReactElement | null {
    if (!agents.length) return null;
    return (
        <ul className="mj_OpsAgents" aria-label="Other agents">
            {agents.map((d) => (
                <li key={d.device_id} className="mj_OpsAgents_row" data-spec="ops.agent">
                    <span className={`mj_OpsState mj_OpsState_${d.connected ? "online" : "asleep"}`}>
                        <span className="mj_OpsDot" aria-hidden="true" />
                        {d.connected ? "Online" : "Offline"}
                    </span>
                    <span className="mj_OpsAgents_name">{d.name || `Agent ${d.device_id}`}</span>
                    <span className="mj_OpsAgents_meta">
                        {d.connected || !d.last_seen_at
                            ? "agent, no box report"
                            : `seen ${formatRelative(d.last_seen_at, now)}`}
                    </span>
                </li>
            ))}
        </ul>
    );
}

function liveSessionsText(n: number): string {
    return n === 0 ? "idle" : `${n} live session${n === 1 ? "" : "s"}`;
}

function basename(p: string): string {
    const trimmed = p.replace(/\/+$/, "");
    return trimmed.slice(trimmed.lastIndexOf("/") + 1) || p;
}

// ───────────────────────── host ─────────────────────────

function Tile({
    label,
    value,
    sub,
    percent,
}: {
    label: string;
    value: string;
    sub?: string;
    percent?: number | null;
}): React.ReactElement {
    const norm = percent === undefined || percent === null ? null : normalizePercent(percent);
    return (
        <div className="mj_OpsTile" data-spec="ops.tile">
            <span className="mj_OpsTile_label">{label}</span>
            <span className="mj_OpsTile_value">{value}</span>
            {sub ? <span className="mj_OpsTile_sub">{sub}</span> : null}
            {norm !== null ? (
                <span className="mj_OpsTile_track" aria-hidden="true">
                    <span className={`mj_UsageFill mj_UsageFill_${usageLevel(norm)}`} style={{ width: `${norm}%` }} />
                </span>
            ) : null}
        </div>
    );
}

function HostView({ host }: { host: OpsHost }): React.ReactElement {
    const memUsed = host.memory ? usedPercent(host.memory.available_bytes, host.memory.total_bytes) : null;
    const diskUsed = host.disk ? usedPercent(host.disk.free_bytes, host.disk.total_bytes) : null;
    const swapUsed =
        host.swap && host.swap.total_bytes > 0 ? usedPercent(host.swap.free_bytes, host.swap.total_bytes) : null;
    const maxRss = Math.max(1, ...host.processes.map((p) => p.rss_bytes));
    return (
        <div className="mj_OpsCard mj_OpsHost">
            <div className="mj_OpsTiles">
                <Tile
                    label="CPU"
                    value={host.cpu_pct === null ? "—" : `${Math.round(host.cpu_pct)}%`}
                    sub={host.cpu_cores ? `${host.cpu_cores} cores` : undefined}
                    percent={host.cpu_pct}
                />
                <Tile
                    label="Memory"
                    value={memUsed === null ? "—" : `${memUsed}%`}
                    sub={
                        host.memory
                            ? `${formatBytes(host.memory.total_bytes - host.memory.available_bytes)} of ${formatBytes(host.memory.total_bytes)}`
                            : undefined
                    }
                    percent={memUsed}
                />
                <Tile
                    label="Load"
                    value={host.load ? host.load[0].toFixed(2) : "—"}
                    sub={host.load ? `5m ${host.load[1].toFixed(2)} · 15m ${host.load[2].toFixed(2)}` : undefined}
                    percent={host.load && host.cpu_cores ? (host.load[0] / host.cpu_cores) * 100 : null}
                />
                <Tile
                    label="Disk"
                    value={diskUsed === null ? "—" : `${diskUsed}%`}
                    sub={host.disk ? `${formatBytes(host.disk.free_bytes)} free` : undefined}
                    percent={diskUsed}
                />
                <Tile
                    label="Swap"
                    value={swapUsed === null ? (host.swap ? "off" : "—") : `${swapUsed}%`}
                    sub={
                        host.swap && host.swap.total_bytes > 0 ? `of ${formatBytes(host.swap.total_bytes)}` : undefined
                    }
                    percent={swapUsed}
                />
                <Tile
                    label="Up"
                    value={host.uptime_s === null ? "—" : formatDuration(host.uptime_s)}
                    sub={
                        host.agents
                            ? `${host.agents.claude} claude · ${host.agents.codex} codex`
                            : host.live_sessions !== null
                              ? liveSessionsText(host.live_sessions)
                              : undefined
                    }
                />
            </div>
            {host.processes.length ? (
                <table className="mj_OpsTable mj_OpsProcs" data-spec="ops.processes">
                    <caption className="mj_OpsTable_caption">Top processes by memory</caption>
                    <thead>
                        <tr>
                            <th scope="col">Process</th>
                            <th scope="col" className="mj_OpsTable_user">
                                User
                            </th>
                            <th scope="col" className="mj_OpsTable_num">
                                CPU
                            </th>
                            <th scope="col" className="mj_OpsTable_mem">
                                Memory
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {host.processes.map((p) => (
                            <tr key={p.pid}>
                                <td className="mj_OpsProcs_name" title={`${p.name} (pid ${p.pid})`}>
                                    {p.name}
                                </td>
                                <td className="mj_OpsTable_user">{p.user ?? ""}</td>
                                <td className="mj_OpsTable_num">
                                    {p.cpu_pct >= 0.05 ? `${p.cpu_pct.toFixed(1)}%` : "0%"}
                                </td>
                                <td className="mj_OpsTable_mem">
                                    <span className="mj_OpsBarCell">
                                        <span className="mj_OpsBarCell_track" aria-hidden="true">
                                            <span
                                                className="mj_OpsBarCell_fill"
                                                style={{ width: `${Math.max(2, (p.rss_bytes / maxRss) * 100)}%` }}
                                            />
                                        </span>
                                        <span className="mj_OpsBarCell_value">{formatBytes(p.rss_bytes)}</span>
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
        </div>
    );
}

// ───────────────────────── alerts ─────────────────────────

function SeverityChip({ severity }: { severity: string }): React.ReactElement {
    const tone = severityTone(severity);
    const word = tone === "critical" ? "critical" : tone === "warn" ? "warning" : "info";
    return (
        <span className={`mj_OpsSev mj_OpsSev_${tone}`} title={word}>
            <span className="mj_OpsDot" aria-hidden="true" />
            {severity || word}
        </span>
    );
}

function AlertsView({ alerts, now }: { alerts: OpsAlerts; now: number }): React.ReactElement {
    const [showResolved, setShowResolved] = useState(false);
    return (
        <div className="mj_OpsCard mj_OpsList">
            {alerts.active.length === 0 ? (
                <p className="mj_OpsEmpty">
                    <CheckIcon />
                    No open alerts.
                </p>
            ) : (
                <ul className="mj_OpsRows">
                    {alerts.active.map((a) => (
                        <li key={a.key} className="mj_OpsRow mj_OpsAlert" data-spec="ops.alert">
                            <SeverityChip severity={a.severity} />
                            <div className="mj_OpsRow_main">
                                <span className="mj_OpsRow_lead">{a.message}</span>
                                <span className="mj_OpsRow_meta">
                                    {[
                                        a.key,
                                        a.first_seen_ms ? `since ${formatRelative(a.first_seen_ms, now)}` : null,
                                        a.count && a.count > 1 ? `${a.count}×` : null,
                                        a.acked ? "acknowledged" : null,
                                        a.muted_until_ms && a.muted_until_ms > now
                                            ? `muted ${formatRelative(a.muted_until_ms, now).replace(/^in /, "for ")}`
                                            : null,
                                    ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </span>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {alerts.resolved_24h.length ? (
                <div className="mj_OpsDisclosure">
                    <button
                        type="button"
                        className="mj_OpsDisclosure_toggle"
                        aria-expanded={showResolved}
                        onClick={() => setShowResolved((v) => !v)}
                    >
                        <span className="mj_OpsChevron" aria-hidden="true" />
                        Resolved in the last day ({alerts.resolved_24h.length})
                    </button>
                    {showResolved ? (
                        <ul className="mj_OpsRows mj_OpsRows_quiet">
                            {alerts.resolved_24h.map((a) => (
                                <li key={`${a.key}-${a.resolved_ms ?? ""}`} className="mj_OpsRow">
                                    <span className="mj_OpsSev mj_OpsSev_ok">
                                        <CheckIcon />
                                        {a.severity || "ok"}
                                    </span>
                                    <div className="mj_OpsRow_main">
                                        <span className="mj_OpsRow_lead">{a.message}</span>
                                        <span className="mj_OpsRow_meta">
                                            {[
                                                a.resolved_ms ? `resolved ${formatRelative(a.resolved_ms, now)}` : null,
                                                a.resolved_by ? `by ${a.resolved_by}` : null,
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

// ───────────────────────── timers ─────────────────────────

export function timerNeedsAttention(t: OpsTimer): boolean {
    return t.result === "failed" || t.stale;
}

export function nextRunText(nextMs: number | null, now: number): string {
    if (!nextMs) return "not scheduled";
    if (nextMs < now - 60_000) return `was due ${formatRelative(nextMs, now)}`;
    return `next ${formatRelative(nextMs, now)}`;
}

function timerName(unit: string): string {
    return unit.replace(/\.timer$/, "");
}

function TimersView({ data, now }: { data: OpsTimers; now: number }): React.ReactElement {
    const problems = data.timers.filter(timerNeedsAttention);
    const [filter, setFilter] = useState<"problems" | "all">(problems.length ? "problems" : "all");
    const [showCron, setShowCron] = useState(false);
    const shown = filter === "problems" ? problems : data.timers;
    return (
        <div className="mj_OpsCard mj_OpsList">
            <div className="mj_OpsList_toolbar">
                <div className="mj_Seg" role="tablist" aria-label="Timers shown">
                    {(
                        [
                            ["problems", `Needs attention ${problems.length}`],
                            ["all", `All ${data.timers.length}`],
                        ] as const
                    ).map(([key, label]) => (
                        <button
                            key={key}
                            type="button"
                            role="tab"
                            aria-selected={filter === key}
                            className={`mj_Seg_item${filter === key ? " mj_Seg_item_on" : ""}`}
                            onClick={() => setFilter(key)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>
            {shown.length === 0 ? (
                <p className="mj_OpsEmpty">
                    <CheckIcon />
                    {filter === "problems" ? "Every timer ran on schedule." : "No timers found."}
                </p>
            ) : (
                <ul className="mj_OpsRows">
                    {shown.map((t) => {
                        const tone =
                            t.result === "failed"
                                ? "critical"
                                : t.stale
                                  ? "warn"
                                  : t.result === "running"
                                    ? "run"
                                    : "ok";
                        const interval = formatInterval(t.interval_s);
                        return (
                            <li key={t.unit} className="mj_OpsRow mj_OpsTimer" data-spec="ops.timer">
                                <span className={`mj_OpsTimer_dot mj_OpsTimer_dot_${tone}`} aria-hidden="true" />
                                <div className="mj_OpsRow_main">
                                    <span className="mj_OpsRow_lead">
                                        <span className="mj_OpsTimer_name">{timerName(t.unit)}</span>
                                        {tone === "critical" ? (
                                            <span className="mj_OpsTag mj_OpsTag_critical">failed</span>
                                        ) : null}
                                        {tone === "warn" ? (
                                            <span className="mj_OpsTag mj_OpsTag_warn">overdue</span>
                                        ) : null}
                                    </span>
                                    <span className="mj_OpsRow_meta">
                                        {[
                                            t.description,
                                            interval,
                                            t.last_run_ms ? `ran ${formatRelative(t.last_run_ms, now)}` : "never ran",
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </span>
                                </div>
                                <span className="mj_OpsRow_aside">{nextRunText(t.next_run_ms, now)}</span>
                            </li>
                        );
                    })}
                </ul>
            )}
            {data.cron.length ? (
                <div className="mj_OpsDisclosure">
                    <button
                        type="button"
                        className="mj_OpsDisclosure_toggle"
                        aria-expanded={showCron}
                        onClick={() => setShowCron((v) => !v)}
                    >
                        <span className="mj_OpsChevron" aria-hidden="true" />
                        Cron jobs ({data.cron.length})
                    </button>
                    {showCron ? (
                        <ul className="mj_OpsRows mj_OpsRows_quiet">
                            {data.cron.map((c, i) => (
                                <li key={`${c.schedule}-${c.label}-${i}`} className="mj_OpsRow mj_OpsCron">
                                    <code className="mj_OpsCron_schedule">{c.schedule}</code>
                                    <span className="mj_OpsRow_lead">{c.label}</span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

// ───────────────────────── usage ─────────────────────────

function DailyChart({ daily }: { daily: OpsUsage["daily"] }): React.ReactElement | null {
    const [hover, setHover] = useState<number | null>(null);
    if (daily.length === 0) return null;
    const max = Math.max(...daily.map((d) => d.cost_usd), 0.01);
    const total = daily.reduce((s, d) => s + d.cost_usd, 0);
    const shown = hover === null ? null : daily[hover];
    return (
        <figure className="mj_OpsChart" data-spec="ops.dailyChart">
            <figcaption className="mj_OpsChart_caption">
                <span>Daily cost, last {daily.length} days</span>
                <span className="mj_OpsChart_readout" aria-live="polite">
                    {shown
                        ? `${formatDay(shown.day)} · ${formatUsd(shown.cost_usd)} · ${formatCount(shown.tokens)} tokens`
                        : `${formatUsd(total)} total · peak ${formatUsd(max)}`}
                </span>
            </figcaption>
            <div className="mj_OpsChart_plot" role="list" onMouseLeave={() => setHover(null)}>
                {daily.map((d, i) => (
                    <button
                        key={d.day}
                        type="button"
                        role="listitem"
                        className={`mj_OpsChart_bar${hover === i ? " mj_OpsChart_bar_on" : ""}`}
                        aria-label={`${formatDay(d.day)}: ${formatUsd(d.cost_usd)}, ${formatCount(d.tokens)} tokens`}
                        onMouseEnter={() => setHover(i)}
                        onFocus={() => setHover(i)}
                        onBlur={() => setHover(null)}
                    >
                        <span
                            className="mj_OpsChart_fill"
                            style={{ height: `${d.cost_usd > 0 ? Math.max(2, (d.cost_usd / max) * 100) : 0}%` }}
                        />
                    </button>
                ))}
            </div>
            <div className="mj_OpsChart_axis" aria-hidden="true">
                <span>{formatDay(daily[0].day)}</span>
                <span>{formatDay(daily[daily.length - 1].day)}</span>
            </div>
        </figure>
    );
}

function formatDay(day: string): string {
    const d = new Date(`${day}T12:00:00`);
    if (!Number.isFinite(d.getTime())) return day;
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

function BarList({
    title,
    rows,
}: {
    title: string;
    rows: { name: string; tokens: number; cost_usd: number }[];
}): React.ReactElement | null {
    if (!rows.length) return null;
    const max = Math.max(...rows.map((r) => r.cost_usd), 0.01);
    return (
        <div className="mj_OpsBars" data-spec="ops.barList">
            <h3 className="mj_OpsBox_groupTitle">{title}</h3>
            <ul>
                {rows.map((r) => (
                    <li key={r.name} className="mj_OpsBars_row">
                        <span className="mj_OpsBars_name" title={r.name}>
                            {r.name}
                        </span>
                        <span className="mj_OpsBars_track" aria-hidden="true">
                            <span
                                className="mj_OpsBarCell_fill"
                                style={{ width: `${Math.max(2, (r.cost_usd / max) * 100)}%` }}
                            />
                        </span>
                        <span className="mj_OpsBars_value">{formatUsd(r.cost_usd)}</span>
                        <span className="mj_OpsBars_sub">{formatCount(r.tokens)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function UsageView({ usage, now }: { usage: OpsUsage; now: number }): React.ReactElement {
    const windows: [string, keyof OpsUsage["windows"]][] = [
        ["Today", "1d"],
        ["7 days", "7d"],
        ["30 days", "30d"],
    ];
    return (
        <div className="mj_OpsCard mj_OpsUsage">
            <div className="mj_OpsTiles mj_OpsTiles_three">
                {windows.map(([label, key]) => {
                    const w = usage.windows[key];
                    return (
                        <Tile
                            key={key}
                            label={label}
                            value={w ? formatUsd(w.cost_usd) : "—"}
                            sub={
                                w
                                    ? `${formatCount(w.tokens)} tokens · ${w.sessions} session${w.sessions === 1 ? "" : "s"}${w.codex_runs ? ` · ${w.codex_runs} codex` : ""}`
                                    : undefined
                            }
                        />
                    );
                })}
            </div>
            <DailyChart daily={usage.daily} />
            <div className="mj_OpsBars_pair">
                <BarList title="By model, 7 days" rows={usage.by_model_7d.map((r) => ({ ...r, name: r.model }))} />
                <BarList
                    title="By machine, 7 days"
                    rows={usage.by_machine_7d.map((r) => ({ ...r, name: r.machine }))}
                />
            </div>
            {usage.recent_sessions.length ? (
                <div className="mj_OpsRecent">
                    <h3 className="mj_OpsBox_groupTitle">Recent sessions</h3>
                    <ul className="mj_OpsRows">
                        {usage.recent_sessions.map((s, i) => (
                            <li key={`${s.ended_ms ?? i}-${i}`} className="mj_OpsRow mj_OpsSession">
                                <div className="mj_OpsRow_main">
                                    <span className="mj_OpsRow_lead">{s.project ?? "Session"}</span>
                                    <span className="mj_OpsRow_meta">
                                        {[
                                            s.machine,
                                            s.model,
                                            s.duration_s !== null ? formatDuration(s.duration_s) : null,
                                            s.ended_ms ? formatRelative(s.ended_ms, now) : null,
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </span>
                                </div>
                                <span className="mj_OpsRow_aside mj_OpsRow_aside_num">
                                    {formatUsd(s.cost_usd)}
                                    <span className="mj_OpsRow_asideSub">{formatCount(s.tokens)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}

// ───────────────────────── posture ─────────────────────────

function PostureView({ posture, now }: { posture: OpsPosture; now: number }): React.ReactElement {
    const sec = posture.security;
    const status = sec?.status.toLowerCase() ?? "unknown";
    const tone = status === "red" ? "critical" : status === "yellow" ? "warn" : status === "green" ? "ok" : "info";
    const word = { red: "Red", yellow: "Yellow", green: "Green" }[status] ?? "Unknown";
    return (
        <div className="mj_OpsCard mj_OpsPosture">
            <div className="mj_OpsPosture_security" data-spec="ops.security">
                <h3 className="mj_OpsBox_groupTitle">Security posture</h3>
                {sec ? (
                    <>
                        <p className="mj_OpsPosture_status">
                            <span className={`mj_OpsSev mj_OpsSev_${tone}`}>
                                {tone === "ok" ? <CheckIcon /> : <span className="mj_OpsDot" aria-hidden="true" />}
                                {word}
                            </span>
                            {sec.generated_ms ? (
                                <span className="mj_OpsRow_meta">checked {formatRelative(sec.generated_ms, now)}</span>
                            ) : null}
                        </p>
                        {sec.actions.length ? (
                            <ul className="mj_OpsPosture_actions">
                                {sec.actions.map((a) => (
                                    <li key={a}>{a}</li>
                                ))}
                            </ul>
                        ) : (
                            <p className="mj_OpsRow_meta">No actions.</p>
                        )}
                    </>
                ) : (
                    <p className="mj_OpsRow_meta">No posture report on this box.</p>
                )}
            </div>
            <div className="mj_OpsPosture_api" data-spec="ops.apiUsage">
                <h3 className="mj_OpsBox_groupTitle">API usage</h3>
                {posture.api_usage && posture.api_usage.length ? (
                    posture.api_usage.map((a) => {
                        const pctUsed = a.used !== null && a.limit ? (a.used / a.limit) * 100 : null;
                        const detail =
                            a.used !== null
                                ? `${formatCount(a.used)}${a.limit ? ` of ${formatCount(a.limit)}` : ""}${a.unit ? ` ${a.unit}` : ""}${a.period ? ` / ${a.period}` : ""}`
                                : undefined;
                        if (pctUsed === null)
                            return (
                                <div key={a.name} className="mj_OpsCount">
                                    <span className="mj_OpsMeter_label">{a.name}</span>
                                    <span className="mj_OpsCount_value">{detail ?? "—"}</span>
                                </div>
                            );
                        return <Meter key={a.name} label={a.name} percent={pctUsed} detail={detail} />;
                    })
                ) : (
                    <p className="mj_OpsRow_meta">No tracked APIs.</p>
                )}
            </div>
        </div>
    );
}

// ───────────────────────── journal ─────────────────────────

function JournalView({ metrics }: { metrics: JournalMetrics | null | undefined }): React.ReactElement {
    if (metrics === undefined)
        return (
            <div className="mj_OpsCard mj_OpsCard_loading" aria-busy="true">
                <span className="mj_OpsSkeleton" />
            </div>
        );
    if (metrics === null) return <OpsNote>This journal server does not report metrics.</OpsNote>;
    // Agents never ack a cursor (theirs stays 0), and a long-retired client's lag grows forever, so
    // per-device lag is not a health signal. "In sync" counts clients within a small window of head.
    const clients = metrics.devices.filter((d) => d.kind === "client");
    const inSync = clients.filter((d) => d.lag <= 50).length;
    return (
        <div className="mj_OpsCard">
            <div className="mj_OpsTiles">
                <Tile
                    label="Database"
                    value={metrics.db_file_size_bytes === null ? "—" : formatBytes(metrics.db_file_size_bytes)}
                    sub={
                        metrics.journal_row_count === null
                            ? undefined
                            : `${formatCount(metrics.journal_row_count)} events`
                    }
                />
                <Tile label="Head" value={formatCount(metrics.head_seq)} sub="your journal sequence" />
                <Tile
                    label="Sockets"
                    value={metrics.sockets_connected === null ? "—" : String(metrics.sockets_connected)}
                    sub="connected now"
                />
                <Tile label="Clients in sync" value={`${inSync} of ${clients.length}`} sub="within 50 events of head" />
            </div>
        </div>
    );
}
