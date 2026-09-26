/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Ops page fixtures. Shapes follow the wire contract
 * (bridge docs/agent-rpc.md, journal docs/protocol.md): the box report is a live device_status
 * row of 2026-09-26 plus the phase-B additions (Codex lines, vitals); the snapshot sections are the
 * bridge's ops_snapshot result envelopes. Times are relative to page load so relative labels read
 * naturally in screenshots.
 *
 * Modes:
 *   ok         — one healthy bridge box + a non-bridge agent; every section answers.
 *   problems   — open P1/P2 alerts, a failed and an overdue timer, a 91% weekly quota.
 *   old-bridge — today's live bridge: no Codex lines, no vitals, and ops_snapshot unknown_method.
 *   two-boxes  — a second (asleep) box, so the box switch shows.
 *   loading    — the snapshot never answers (skeletons).
 *   empty      — no agent boxes at all.
 */

export type OpsFixtureMode = "ok" | "problems" | "old-bridge" | "two-boxes" | "loading" | "empty";

const NOW = Date.now();
const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function boxStatus(mode: OpsFixtureMode, deviceId: number): Record<string, unknown> {
    const hot = mode === "problems";
    const old = mode === "old-bridge";
    const claude = [
        {
            id: "session",
            label: "Session",
            percent: hot ? 64 : 38,
            resets: "",
            resets_at: iso(NOW + 1 * H + 40 * M),
        },
        { id: "week_all", label: "Week (all models)", percent: hot ? 91 : 22, resets_at: iso(NOW + 6 * D + 17 * H) },
        { id: "week_fable", label: "Week (Fable)", percent: 3, resets_at: iso(NOW + 6 * D + 17 * H) },
    ];
    const codex = [
        { id: "codex:codex:primary", label: "Codex · 5-hour", percent: 12, resets_at: iso(NOW + 3 * H + 5 * M) },
        { id: "codex:codex:secondary", label: "Codex · Weekly", percent: 41, resets_at: iso(NOW + 4 * D + 2 * H) },
    ];
    if (deviceId === 21) {
        return {
            reported_at: NOW - 9 * H,
            activity: { live_sessions: 0, last_hour: [] },
            limits: { as_of: NOW - 9 * H, lines: claude.map((l) => ({ ...l, percent: Math.round(l.percent / 3) })) },
            disk: { free_bytes: 412 * GB, total_bytes: 931 * GB },
            account: { email: "operator@example.com" },
            vitals: { cpu_pct: 4, ram_pct: 31, sampled_at_ms: NOW - 9 * H },
        };
    }
    return {
        reported_at: NOW - 2 * M,
        activity: {
            live_sessions: 3,
            last_hour: [
                { path: "/home/operator/workspace", sessions: 2 },
                { path: "/opt/matron/web-journal", sessions: 1 },
            ],
        },
        limits: { as_of: NOW - 2 * M, lines: old ? claude : [...claude, ...codex] },
        disk: { free_bytes: 86 * GB, total_bytes: 144 * GB },
        account: { email: "operator@example.com" },
        ...(old ? {} : { vitals: { cpu_pct: hot ? 78 : 23, ram_pct: hot ? 88 : 61, sampled_at_ms: NOW - 2 * M } }),
    };
}

export function opsDevices(mode: OpsFixtureMode): unknown[] {
    if (mode === "empty") return [];
    const bridge = {
        device_id: 1,
        kind: "agent",
        name: "operator-bridge",
        connected: true,
        is_self: false,
        last_seen_at: NOW - 20_000,
        status: boxStatus(mode, 1),
    };
    const scheduler = {
        device_id: 15,
        kind: "agent",
        name: "scheduler",
        connected: true,
        is_self: false,
        last_seen_at: NOW - M,
    };
    const devices: unknown[] = [bridge];
    if (mode === "two-boxes") {
        devices.push({
            device_id: 21,
            kind: "agent",
            name: "macbook",
            connected: false,
            is_self: false,
            last_seen_at: NOW - 9 * H,
            status: boxStatus(mode, 21),
        });
    }
    devices.push(scheduler);
    return devices;
}

export const opsMetrics = {
    head_seq: 227_677,
    devices: [
        { device_id: 1, kind: "agent", lag: 227_677, last_seen_at: NOW },
        { device_id: 11, kind: "client", lag: 0, last_seen_at: NOW },
        { device_id: 13, kind: "client", lag: 12, last_seen_at: NOW },
        { device_id: 16, kind: "client", lag: 790, last_seen_at: NOW - D },
        { device_id: 2, kind: "client", lag: 127_960, last_seen_at: NOW - 30 * D },
    ],
    sockets_connected: 5,
    journal_row_count: 227_677,
    db_file_size_bytes: 412 * MB,
};

function host(mode: OpsFixtureMode): unknown {
    const hot = mode === "problems";
    return {
        hostname: "box-01",
        cpu_cores: 6,
        uptime_s: 11 * 86_400 + 4 * 3600,
        load: hot ? [5.41, 4.2, 3.1] : [0.52, 0.61, 0.58],
        cpu_pct: hot ? 78 : 23,
        memory: { total_bytes: Math.round(11.7 * GB), available_bytes: Math.round((hot ? 1.4 : 4.6) * GB) },
        swap: { total_bytes: 6 * GB, free_bytes: Math.round((hot ? 3.9 : 5.8) * GB) },
        disk: { path: "/home/operator/workspace", free_bytes: 86 * GB, total_bytes: 144 * GB },
        agents: { claude: 4, codex: 1 },
        live_sessions: 3,
        processes: [
            { pid: 2211, name: "claude", rss_bytes: 612 * MB, cpu_pct: hot ? 41.2 : 6.3, user: "root" },
            { pid: 1034, name: "node index.js", rss_bytes: 488 * MB, cpu_pct: 2.1, user: "root" },
            { pid: 4410, name: "claude", rss_bytes: 431 * MB, cpu_pct: 0.4, user: "root" },
            { pid: 981, name: "node server.js", rss_bytes: 214 * MB, cpu_pct: 0.9, user: "root" },
            { pid: 1702, name: "python3 uvicorn", rss_bytes: 174 * MB, cpu_pct: 1.2, user: "root" },
            { pid: 5120, name: "codex", rss_bytes: 142 * MB, cpu_pct: 0.2, user: "root" },
            { pid: 733, name: "dockerd", rss_bytes: 96 * MB, cpu_pct: 0.1, user: "root" },
            { pid: 612, name: "tailscaled", rss_bytes: 58 * MB, cpu_pct: 0.3, user: "root" },
            { pid: 540, name: "nginx", rss_bytes: 12 * MB, cpu_pct: 0, user: "www-data" },
        ],
    };
}

function timers(mode: OpsFixtureMode): unknown {
    const hot = mode === "problems";
    const t = (
        unit: string,
        description: string,
        interval: number,
        lastAgo: number,
        extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
        unit,
        service: unit.replace(/\.timer$/, ".service"),
        group: unit.split("-")[0],
        description,
        last_run_ms: NOW - lastAgo,
        next_run_ms: NOW - lastAgo + interval * 1000,
        result: "success",
        interval_s: interval,
        stale: false,
        ...extra,
    });
    return {
        timers: [
            ...(hot
                ? [
                      t("ops-sysadmin-maintenance-daily.timer", "Daily maintenance", 86_400, 26 * H, {
                          result: "failed",
                      }),
                      t("snafu-studio-cron@reconcile.timer", "SNAFU reconcile", 3600, 5 * H, { stale: true }),
                  ]
                : []),
            t("ops-watchdog-15m.timer", "Watchdog probes", 900, 6 * M),
            t("matron-codex-prune.timer", "Prune Codex run sinks", 86_400, 13 * H),
            t("ops-production-truth-sync-daily.timer", "Production truth sync", 86_400, 4 * H),
            t("ops-auto-fix-loop.timer", "Auto-fix loop", 1800, 11 * M, { result: hot ? "running" : "success" }),
            t("ops-metrics-anomaly-detector-daily.timer", "Anomaly detector", 86_400, 4 * H + 20 * M),
            t("snafu-studio-backup.timer", "SNAFU studio backup", 86_400, 20 * H),
        ],
        cron: [
            { schedule: "*/30 * * * *", label: "mc_smoke_test.py" },
            { schedule: "15 3 * * *", label: "backup_workspace.sh" },
            { schedule: "0 4 * * 0", label: "restore_drill.py" },
            { schedule: "*/5 * * * *", label: "vps-autopush.sh" },
        ],
    };
}

function alerts(mode: OpsFixtureMode): unknown {
    const hot = mode === "problems";
    return {
        active: hot
            ? [
                  {
                      key: "AUDIT_NET_DOWN",
                      severity: "P1",
                      message: "Memory-corpus audit net is not recording on operator-bridge",
                      first_seen_ms: NOW - 2 * H - 10 * M,
                      last_seen_ms: NOW - 5 * M,
                      count: 3,
                      acked: false,
                      muted_until_ms: null,
                  },
                  {
                      key: "security_posture",
                      severity: "P2",
                      message: "Security posture is yellow: 1 provider credential should be rotated",
                      first_seen_ms: NOW - 26 * H,
                      last_seen_ms: NOW - 3 * H,
                      count: 1,
                      acked: true,
                      muted_until_ms: null,
                  },
              ]
            : [],
        resolved_24h: [
            {
                key: "CODEX_MISSING",
                severity: "P0",
                message: "Codex CLI is missing from PATH on operator-bridge",
                resolved_ms: NOW - 7 * H,
                resolved_by: "reconciler",
            },
            {
                key: "BRIDGE_DOWN",
                severity: "P1",
                message: "Operator bridge is not running",
                resolved_ms: NOW - 20 * H,
                resolved_by: "heal",
            },
        ],
    };
}

function usage(): unknown {
    const costs = [18.2, 22.4, 9.1, 4.3, 31.8, 27.5, 24.9, 12.2, 6.8, 29.4, 35.1, 33.6, 28.7, 19.4];
    const daily = costs.map((cost, i) => {
        const day = new Date(NOW - (costs.length - 1 - i) * D).toISOString().slice(0, 10);
        return { day, cost_usd: cost, tokens: Math.round(cost * 410_000) };
    });
    return {
        windows: {
            "1d": { tokens: 7_954_000, cost_usd: 19.4, sessions: 11, codex_runs: 6 },
            "7d": { tokens: 76_120_000, cost_usd: 185.2, sessions: 64, codex_runs: 41 },
            "30d": { tokens: 301_900_000, cost_usd: 734.6, sessions: 251, codex_runs: 176 },
        },
        daily,
        by_model_7d: [
            { model: "claude-opus-5-5", tokens: 51_200_000, cost_usd: 131.4 },
            { model: "claude-sonnet-5", tokens: 14_900_000, cost_usd: 31.2 },
            { model: "gpt-5.5-codex", tokens: 8_700_000, cost_usd: 18.3 },
            { model: "claude-haiku-5", tokens: 1_320_000, cost_usd: 4.3 },
        ],
        by_machine_7d: [
            { machine: "vps", tokens: 60_300_000, cost_usd: 149.9 },
            { machine: "macbook", tokens: 11_100_000, cost_usd: 26.1 },
            { machine: "win-desktop", tokens: 4_720_000, cost_usd: 9.2 },
        ],
        recent_sessions: [
            {
                ended_ms: NOW - 14 * M,
                machine: "vps",
                model: "claude-opus-5-5",
                project: "workspace",
                tokens: 2_310_000,
                cost_usd: 6.12,
                duration_s: 3 * 3600 + 12 * 60,
            },
            {
                ended_ms: NOW - 52 * M,
                machine: "vps",
                model: "gpt-5.5-codex",
                project: "matron-bridge",
                tokens: 640_000,
                cost_usd: 1.38,
                duration_s: 21 * 60,
            },
            {
                ended_ms: NOW - 3 * H,
                machine: "macbook",
                model: "claude-sonnet-5",
                project: "snafu-studio",
                tokens: 1_120_000,
                cost_usd: 2.44,
                duration_s: 47 * 60,
            },
        ],
    };
}

function posture(mode: OpsFixtureMode): unknown {
    return {
        security: {
            status: mode === "problems" ? "yellow" : "green",
            generated_ms: NOW - 5 * H,
            actions: mode === "problems" ? ["Rotate or restrict 1 high-risk provider credential: proxy_key"] : [],
        },
        api_usage: [
            { name: "Tavily", used: 612, limit: 1000, unit: "credits", period: "month" },
            { name: "Gmail send", used: 38, limit: null, unit: "calls", period: "month" },
            { name: "Vercel builds", used: 71, limit: 100, unit: null, period: "day" },
        ],
    };
}

export function opsReply(
    mode: OpsFixtureMode,
    deviceId: number,
    section: string,
): Promise<{ ok: true; origin: "agent"; result: unknown } | { ok: false; origin: "agent" | "relay"; code: string }> {
    if (mode === "loading") return new Promise(() => undefined);
    if (mode === "old-bridge") return Promise.resolve({ ok: false, origin: "agent", code: "unknown_method" });
    if (deviceId === 21) return Promise.resolve({ ok: false, origin: "relay", code: "agent_unreachable" });
    const data =
        section === "host"
            ? host(mode)
            : section === "timers"
              ? timers(mode)
              : section === "alerts"
                ? alerts(mode)
                : section === "usage"
                  ? usage()
                  : posture(mode);
    return Promise.resolve({
        ok: true,
        origin: "agent",
        result: { section, generated_at_ms: Date.now(), truncated: false, data },
    });
}
