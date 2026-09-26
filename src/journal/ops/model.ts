/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Ops page data model: the box report a bridge persists in the journal (`box_status`, served as
 * `status` on GET /devices and fanned live as a `box_status` frame) and the on-demand
 * `ops_snapshot` agent RPC. Wire contract: loop #542 phase B (bridge lib/ops-snapshot.js, journal
 * src/spawns.js sanitizeBoxStatus). Every parser here is total: it never throws, drops what it
 * cannot read, and returns null for a block that is unusable, so an older or newer bridge degrades
 * to "less shown", never to a broken page.
 */

export interface BoxLimitLine {
    id: string;
    label: string;
    percent: number;
    resets?: string;
    resets_at?: string;
}

export interface BoxStatus {
    reported_at?: number;
    activity?: { live_sessions: number; last_hour: { path: string; sessions: number }[] };
    limits?: { as_of: number; lines: BoxLimitLine[] };
    disk?: { free_bytes: number; total_bytes: number };
    account?: { email: string };
    vitals?: { cpu_pct: number; ram_pct: number; sampled_at_ms: number };
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
}
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const int = (v: unknown): v is number => Number.isSafeInteger(v);
const str = (v: unknown): v is string => typeof v === "string";
const pct = (v: unknown): v is number => num(v) && v >= 0 && v <= 100;

function optNum(v: unknown): number | null {
    return num(v) ? v : null;
}
function optStr(v: unknown, max = 400): string | null {
    return str(v) && v.length > 0 ? v.slice(0, max) : null;
}

export function parseBoxStatus(raw: unknown): BoxStatus | undefined {
    const o = obj(raw);
    if (!o) return undefined;
    const out: BoxStatus = {};
    if (int(o.reported_at) && o.reported_at > 0) out.reported_at = o.reported_at;

    const activity = obj(o.activity);
    if (activity && int(activity.live_sessions) && activity.live_sessions >= 0 && Array.isArray(activity.last_hour)) {
        out.activity = {
            live_sessions: activity.live_sessions,
            last_hour: activity.last_hour
                .map(obj)
                .filter((e): e is Obj => !!e && str(e.path) && int(e.sessions))
                .map((e) => ({ path: e.path as string, sessions: e.sessions as number })),
        };
    }

    const limits = obj(o.limits);
    if (limits && int(limits.as_of) && Array.isArray(limits.lines)) {
        const lines: BoxLimitLine[] = [];
        for (const l of limits.lines.map(obj)) {
            if (!l || !str(l.id) || !str(l.label) || !num(l.percent)) continue;
            const line: BoxLimitLine = { id: l.id, label: l.label, percent: l.percent };
            if (str(l.resets)) line.resets = l.resets;
            if (str(l.resets_at)) line.resets_at = l.resets_at;
            lines.push(line);
        }
        out.limits = { as_of: limits.as_of, lines };
    }

    const disk = obj(o.disk);
    if (disk && int(disk.free_bytes) && int(disk.total_bytes) && disk.total_bytes > 0) {
        out.disk = { free_bytes: disk.free_bytes, total_bytes: disk.total_bytes };
    }

    const account = obj(o.account);
    if (account && str(account.email) && account.email) out.account = { email: account.email };

    const vitals = obj(o.vitals);
    if (vitals && pct(vitals.cpu_pct) && pct(vitals.ram_pct) && int(vitals.sampled_at_ms)) {
        out.vitals = { cpu_pct: vitals.cpu_pct, ram_pct: vitals.ram_pct, sampled_at_ms: vitals.sampled_at_ms };
    }
    return out;
}

/** The live `box_status` frame: `{kind, device_id, reported_at, ...status}`. */
export function parseBoxStatusFrame(raw: unknown): { deviceId: number; status: BoxStatus } | null {
    const o = obj(raw);
    if (!o || o.kind !== "box_status" || !int(o.device_id)) return null;
    const status = parseBoxStatus(o);
    if (!status) return null;
    return { deviceId: o.device_id, status };
}

/** Claude lines first (ids without a `codex:` prefix), then Codex; each keeps its bridge order. */
export function splitLimitLines(lines: BoxLimitLine[] | undefined): { claude: BoxLimitLine[]; codex: BoxLimitLine[] } {
    const claude: BoxLimitLine[] = [];
    const codex: BoxLimitLine[] = [];
    for (const line of lines ?? []) (line.id.startsWith("codex:") ? codex : claude).push(line);
    return { claude, codex };
}

// ───────────────────────── ops_snapshot ─────────────────────────

export type OpsSection = "host" | "timers" | "alerts" | "usage" | "posture";
export const OPS_SECTIONS: OpsSection[] = ["host", "alerts", "timers", "usage", "posture"];

export interface OpsProcess {
    pid: number;
    name: string;
    rss_bytes: number;
    cpu_pct: number;
    user: string | null;
}
export interface OpsHost {
    hostname: string | null;
    cpu_cores: number | null;
    uptime_s: number | null;
    load: number[] | null;
    cpu_pct: number | null;
    memory: { total_bytes: number; available_bytes: number } | null;
    swap: { total_bytes: number; free_bytes: number } | null;
    disk: { path: string | null; free_bytes: number; total_bytes: number } | null;
    agents: { claude: number; codex: number } | null;
    live_sessions: number | null;
    processes: OpsProcess[];
}
export interface OpsTimer {
    unit: string;
    group: string;
    description: string | null;
    last_run_ms: number | null;
    next_run_ms: number | null;
    result: string;
    interval_s: number | null;
    stale: boolean;
}
export interface OpsTimers {
    timers: OpsTimer[];
    cron: { schedule: string; label: string }[];
}
export interface OpsAlert {
    key: string;
    severity: string;
    message: string;
    first_seen_ms: number | null;
    last_seen_ms: number | null;
    count: number | null;
    acked: boolean;
    muted_until_ms: number | null;
}
export interface OpsResolvedAlert {
    key: string;
    severity: string;
    message: string;
    resolved_ms: number | null;
    resolved_by: string | null;
}
export interface OpsAlerts {
    active: OpsAlert[];
    resolved_24h: OpsResolvedAlert[];
}
export interface UsageWindow {
    tokens: number;
    cost_usd: number;
    sessions: number;
    codex_runs: number;
}
export interface OpsUsage {
    windows: { "1d": UsageWindow | null; "7d": UsageWindow | null; "30d": UsageWindow | null };
    daily: { day: string; tokens: number; cost_usd: number }[];
    by_model_7d: { model: string; tokens: number; cost_usd: number }[];
    by_machine_7d: { machine: string; tokens: number; cost_usd: number }[];
    recent_sessions: {
        ended_ms: number | null;
        machine: string | null;
        model: string | null;
        project: string | null;
        tokens: number;
        cost_usd: number;
        duration_s: number | null;
    }[];
}
export interface OpsPosture {
    security: { status: string; generated_ms: number | null; actions: string[] } | null;
    api_usage:
        | { name: string; used: number | null; limit: number | null; unit: string | null; period: string | null }[]
        | null;
}

export interface OpsSectionData {
    host: OpsHost;
    timers: OpsTimers;
    alerts: OpsAlerts;
    usage: OpsUsage;
    posture: OpsPosture;
}

/** One section's state on the page. */
export type OpsSectionState<S extends OpsSection> =
    | { phase: "loading" }
    // `stale`: the last good reading, kept visible after the box stopped answering (never counts
    // as a current check).
    | { phase: "ok"; data: OpsSectionData[S]; generatedAt: number | null; truncated: boolean; stale?: boolean }
    | { phase: "unsupported" } // bridge predates ops_snapshot
    | { phase: "not_configured" }
    | { phase: "asleep" }
    | { phase: "error"; message: string };

function list<T>(v: unknown, map: (o: Obj) => T | null): T[] {
    if (!Array.isArray(v)) return [];
    const out: T[] = [];
    for (const item of v) {
        const o = obj(item);
        if (!o) continue;
        const mapped = map(o);
        if (mapped !== null) out.push(mapped);
    }
    return out;
}

function parseHost(d: Obj): OpsHost {
    const memory = obj(d.memory);
    const swap = obj(d.swap);
    const disk = obj(d.disk);
    const agents = obj(d.agents);
    return {
        hostname: optStr(d.hostname, 120),
        cpu_cores: int(d.cpu_cores) && d.cpu_cores > 0 ? d.cpu_cores : null,
        uptime_s: optNum(d.uptime_s),
        load: Array.isArray(d.load) && d.load.length === 3 && d.load.every(num) ? (d.load as number[]) : null,
        cpu_pct: pct(d.cpu_pct) ? d.cpu_pct : null,
        memory:
            memory && int(memory.total_bytes) && int(memory.available_bytes) && memory.total_bytes > 0
                ? { total_bytes: memory.total_bytes, available_bytes: memory.available_bytes }
                : null,
        swap:
            swap && int(swap.total_bytes) && int(swap.free_bytes)
                ? { total_bytes: swap.total_bytes, free_bytes: swap.free_bytes }
                : null,
        disk:
            disk && int(disk.free_bytes) && int(disk.total_bytes) && disk.total_bytes > 0
                ? { path: optStr(disk.path), free_bytes: disk.free_bytes, total_bytes: disk.total_bytes }
                : null,
        agents:
            agents && int(agents.claude) && int(agents.codex) ? { claude: agents.claude, codex: agents.codex } : null,
        live_sessions: int(d.live_sessions) ? d.live_sessions : null,
        processes: list(d.processes, (p) =>
            int(p.pid) && str(p.name) && int(p.rss_bytes)
                ? {
                      pid: p.pid,
                      name: p.name.slice(0, 64),
                      rss_bytes: p.rss_bytes,
                      cpu_pct: num(p.cpu_pct) ? p.cpu_pct : 0,
                      user: optStr(p.user, 32),
                  }
                : null,
        ),
    };
}

function parseTimers(d: Obj): OpsTimers {
    return {
        timers: list(d.timers, (t) =>
            str(t.unit)
                ? {
                      unit: t.unit,
                      group: optStr(t.group, 32) ?? "system",
                      description: optStr(t.description, 200),
                      last_run_ms: int(t.last_run_ms) ? t.last_run_ms : null,
                      next_run_ms: int(t.next_run_ms) ? t.next_run_ms : null,
                      result: optStr(t.result, 32) ?? "unknown",
                      interval_s: int(t.interval_s) ? t.interval_s : null,
                      stale: t.stale === true,
                  }
                : null,
        ),
        cron: list(d.cron, (c) => (str(c.schedule) && str(c.label) ? { schedule: c.schedule, label: c.label } : null)),
    };
}

function parseAlerts(d: Obj): OpsAlerts {
    return {
        active: list(d.active, (a) =>
            str(a.key)
                ? {
                      key: a.key,
                      severity: optStr(a.severity, 16) ?? "",
                      message: optStr(a.message, 400) ?? a.key,
                      first_seen_ms: int(a.first_seen_ms) ? a.first_seen_ms : null,
                      last_seen_ms: int(a.last_seen_ms) ? a.last_seen_ms : null,
                      count: int(a.count) ? a.count : null,
                      acked: a.acked === true,
                      muted_until_ms: int(a.muted_until_ms) ? a.muted_until_ms : null,
                  }
                : null,
        ),
        resolved_24h: list(d.resolved_24h, (a) =>
            str(a.key)
                ? {
                      key: a.key,
                      severity: optStr(a.severity, 16) ?? "",
                      message: optStr(a.message, 400) ?? a.key,
                      resolved_ms: int(a.resolved_ms) ? a.resolved_ms : null,
                      resolved_by: optStr(a.resolved_by, 40),
                  }
                : null,
        ),
    };
}

function parseWindow(v: unknown): UsageWindow | null {
    const w = obj(v);
    if (!w || !num(w.tokens) || !num(w.cost_usd)) return null;
    return {
        tokens: w.tokens,
        cost_usd: w.cost_usd,
        sessions: num(w.sessions) ? w.sessions : 0,
        codex_runs: num(w.codex_runs) ? w.codex_runs : 0,
    };
}

function parseUsage(d: Obj): OpsUsage {
    const windows = obj(d.windows) ?? {};
    const tc = (o: Obj): { tokens: number; cost_usd: number } | null =>
        num(o.tokens) && num(o.cost_usd) ? { tokens: o.tokens, cost_usd: o.cost_usd } : null;
    return {
        windows: {
            "1d": parseWindow(windows["1d"]),
            "7d": parseWindow(windows["7d"]),
            "30d": parseWindow(windows["30d"]),
        },
        daily: list(d.daily, (o) => {
            const v = tc(o);
            return v && str(o.day) ? { day: o.day, ...v } : null;
        }),
        by_model_7d: list(d.by_model_7d, (o) => {
            const v = tc(o);
            return v && str(o.model) ? { model: o.model, ...v } : null;
        }),
        by_machine_7d: list(d.by_machine_7d, (o) => {
            const v = tc(o);
            return v && str(o.machine) ? { machine: o.machine, ...v } : null;
        }),
        recent_sessions: list(d.recent_sessions, (o) => {
            const v = tc(o);
            return v
                ? {
                      ...v,
                      ended_ms: int(o.ended_ms) ? o.ended_ms : null,
                      machine: optStr(o.machine, 60),
                      model: optStr(o.model, 60),
                      project: optStr(o.project, 120),
                      duration_s: num(o.duration_s) ? o.duration_s : null,
                  }
                : null;
        }),
    };
}

function parsePosture(d: Obj): OpsPosture {
    const sec = obj(d.security);
    return {
        security: sec
            ? {
                  status: optStr(sec.status, 16) ?? "unknown",
                  generated_ms: int(sec.generated_ms) ? sec.generated_ms : null,
                  actions: Array.isArray(sec.actions) ? sec.actions.filter(str).map((a) => a.slice(0, 240)) : [],
              }
            : null,
        api_usage: Array.isArray(d.api_usage)
            ? list(d.api_usage, (a) =>
                  str(a.name)
                      ? {
                            name: a.name,
                            used: optNum(a.used),
                            limit: optNum(a.limit),
                            unit: optStr(a.unit, 24),
                            period: optStr(a.period, 24),
                        }
                      : null,
              )
            : null,
    };
}

const PARSERS: { [S in OpsSection]: (d: Obj) => OpsSectionData[S] } = {
    host: parseHost,
    timers: parseTimers,
    alerts: parseAlerts,
    usage: parseUsage,
    posture: parsePosture,
};

// The fields a section must carry to count as a reading at all. Optional detail may be missing,
// but a success without these is not evidence of "nothing wrong": an alerts reply with no
// `active` list must not render as "No open alerts".
const REQUIRED: { [S in OpsSection]: (d: Obj) => boolean } = {
    host: (d) => Array.isArray(d.processes),
    timers: (d) => Array.isArray(d.timers),
    alerts: (d) => Array.isArray(d.active),
    usage: (d) => obj(d.windows) !== null,
    posture: (d) => "security" in d || "api_usage" in d,
};

/** Map an RPC reply (see client RpcReply) onto a section state. */
export function sectionStateFromReply<S extends OpsSection>(
    section: S,
    reply: { ok: true; result: unknown } | { ok: false; code: string; detail?: string },
): OpsSectionState<S> {
    if (!reply.ok) {
        switch (reply.code) {
            case "unknown_method":
                return { phase: "unsupported" };
            case "not_configured":
                return { phase: "not_configured" };
            case "agent_unreachable":
            case "not_found":
                return { phase: "asleep" };
            case "timeout":
                return { phase: "error", message: "The box did not answer in time." };
            case "not_connected":
                return { phase: "error", message: "Not connected to the journal." };
            case "unavailable":
                return {
                    phase: "error",
                    message: reply.detail ? `Unavailable: ${reply.detail}` : "Unavailable on this box.",
                };
            default:
                return { phase: "error", message: reply.detail || `The box answered ${reply.code}.` };
        }
    }
    const result = obj(reply.result);
    const data = result ? obj(result.data) : null;
    if (!result || !data || !REQUIRED[section](data))
        return { phase: "error", message: "The box sent a reply this page can't read." };
    return {
        phase: "ok",
        data: PARSERS[section](data) as OpsSectionData[S],
        generatedAt: int(result.generated_at_ms) ? result.generated_at_ms : null,
        truncated: result.truncated === true,
    };
}

// ───────────────────────── journal /metrics ─────────────────────────

export interface JournalMetrics {
    head_seq: number;
    devices: { device_id: number; kind: string; lag: number; last_seen_at: number | null }[];
    sockets_connected: number | null;
    journal_row_count: number | null;
    db_file_size_bytes: number | null;
}

export function parseMetrics(raw: unknown): JournalMetrics | null {
    const o = obj(raw);
    const user = o ? obj(o.user) : null;
    if (!o || !user || !int(user.head_seq)) return null;
    return {
        head_seq: user.head_seq,
        devices: list(user.devices, (d) =>
            int(d.device_id) && str(d.kind) && num(d.lag)
                ? {
                      device_id: d.device_id,
                      kind: d.kind,
                      lag: d.lag,
                      last_seen_at: int(d.last_seen_at) ? d.last_seen_at : null,
                  }
                : null,
        ),
        sockets_connected: int(o.sockets_connected) ? o.sockets_connected : null,
        journal_row_count: int(o.journal_row_count) ? o.journal_row_count : null,
        db_file_size_bytes: int(o.db_file_size_bytes) ? o.db_file_size_bytes : null,
    };
}
