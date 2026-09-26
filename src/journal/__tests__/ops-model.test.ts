/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

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
} from "../ops/format";
import {
    parseBoxStatus,
    parseBoxStatusFrame,
    parseMetrics,
    sectionStateFromReply,
    splitLimitLines,
} from "../ops/model";

// A real device_status row (2026-09-26), verbatim shape, identifiers replaced.
const LIVE_STATUS = {
    reported_at: 1790440934560,
    activity: { live_sessions: 1, last_hour: [{ path: "/home/operator/workspace", sessions: 1 }] },
    limits: {
        as_of: 1790440934387,
        lines: [
            {
                id: "session",
                label: "Session",
                percent: 38,
                resets: "Sep 26, 1:40pm",
                resets_at: "2026-09-26T17:40:00.000Z",
            },
            { id: "week_all", label: "Week (all models)", percent: 7, resets_at: "2026-10-03T09:00:00.000Z" },
            { id: "codex:codex:primary", label: "Codex · 5-hour", percent: 12 },
        ],
    },
    disk: { free_bytes: 92635176960, total_bytes: 154894188544 },
    account: { email: "operator@example.com" },
};

describe("parseBoxStatus", () => {
    it("keeps every block of a real report", () => {
        const s = parseBoxStatus(LIVE_STATUS)!;
        expect(s.reported_at).toBe(1790440934560);
        expect(s.activity?.live_sessions).toBe(1);
        expect(s.limits?.lines).toHaveLength(3);
        expect(s.disk?.total_bytes).toBe(154894188544);
        expect(s.account?.email).toBe("operator@example.com");
        expect(s.vitals).toBeUndefined();
    });

    it("reads vitals only when all three fields are valid", () => {
        expect(parseBoxStatus({ vitals: { cpu_pct: 12.5, ram_pct: 40, sampled_at_ms: 5 } })!.vitals).toEqual({
            cpu_pct: 12.5,
            ram_pct: 40,
            sampled_at_ms: 5,
        });
        expect(parseBoxStatus({ vitals: { cpu_pct: 120, ram_pct: 40, sampled_at_ms: 5 } })!.vitals).toBeUndefined();
        expect(parseBoxStatus({ vitals: { cpu_pct: 1, ram_pct: 40 } })!.vitals).toBeUndefined();
    });

    it("drops a bad block without losing the others, and never throws", () => {
        const s = parseBoxStatus({ ...LIVE_STATUS, disk: { free_bytes: "x" }, limits: "nope" })!;
        expect(s.disk).toBeUndefined();
        expect(s.limits).toBeUndefined();
        expect(s.account?.email).toBe("operator@example.com");
        expect(parseBoxStatus(null)).toBeUndefined();
        expect(parseBoxStatus([1])).toBeUndefined();
    });

    it("skips malformed limit lines individually", () => {
        const s = parseBoxStatus({ limits: { as_of: 1, lines: [{ id: "a" }, { id: "b", label: "B", percent: 3 }] } })!;
        expect(s.limits!.lines).toEqual([{ id: "b", label: "B", percent: 3 }]);
    });
});

describe("parseBoxStatusFrame", () => {
    it("reads the live fan-out frame", () => {
        const f = parseBoxStatusFrame({ kind: "box_status", device_id: 1, ...LIVE_STATUS });
        expect(f?.deviceId).toBe(1);
        expect(f?.status.account?.email).toBe("operator@example.com");
    });
    it("rejects frames without a device id or of another kind", () => {
        expect(parseBoxStatusFrame({ kind: "box_status" })).toBeNull();
        expect(parseBoxStatusFrame({ kind: "ephemeral", device_id: 1 })).toBeNull();
    });
});

it("splits Claude and Codex limit lines, keeping order", () => {
    const { claude, codex } = splitLimitLines(parseBoxStatus(LIVE_STATUS)!.limits!.lines);
    expect(claude.map((l) => l.id)).toEqual(["session", "week_all"]);
    expect(codex.map((l) => l.id)).toEqual(["codex:codex:primary"]);
});

describe("sectionStateFromReply", () => {
    it("maps an old bridge to unsupported, and the degrade codes", () => {
        expect(sectionStateFromReply("host", { ok: false, code: "unknown_method" })).toEqual({ phase: "unsupported" });
        expect(sectionStateFromReply("timers", { ok: false, code: "not_configured" })).toEqual({
            phase: "not_configured",
        });
        expect(sectionStateFromReply("host", { ok: false, code: "agent_unreachable" })).toEqual({ phase: "asleep" });
        expect(sectionStateFromReply("host", { ok: false, code: "timeout" }).phase).toBe("error");
    });

    it("parses a host section and keeps truncation", () => {
        const state = sectionStateFromReply("host", {
            ok: true,
            result: {
                section: "host",
                generated_at_ms: 10,
                truncated: true,
                data: {
                    hostname: "vmi",
                    cpu_cores: 6,
                    uptime_s: 3600,
                    load: [0.5, 0.4, 0.3],
                    cpu_pct: 12,
                    memory: { total_bytes: 100, available_bytes: 40 },
                    processes: [
                        { pid: 1, name: "node index.js", rss_bytes: 5e8, cpu_pct: 3.1, user: "root" },
                        { pid: "x", name: "bad" },
                    ],
                },
            },
        });
        expect(state.phase).toBe("ok");
        if (state.phase !== "ok") return;
        expect(state.truncated).toBe(true);
        expect(state.generatedAt).toBe(10);
        expect(state.data.processes).toHaveLength(1);
        expect(state.data.load).toEqual([0.5, 0.4, 0.3]);
        expect(state.data.swap).toBeNull();
    });

    it("parses usage windows and lists defensively", () => {
        const state = sectionStateFromReply("usage", {
            ok: true,
            result: {
                data: {
                    windows: { "1d": { tokens: 10, cost_usd: 1.5, sessions: 2, codex_runs: 1 }, "7d": "bad" },
                    daily: [{ day: "2026-09-25", tokens: 5, cost_usd: 0.4 }, { day: 3 }],
                },
            },
        });
        if (state.phase !== "ok") throw new Error("expected ok");
        expect(state.data.windows["1d"]?.cost_usd).toBe(1.5);
        expect(state.data.windows["7d"]).toBeNull();
        expect(state.data.daily).toHaveLength(1);
        expect(state.data.by_model_7d).toEqual([]);
    });

    it("reports an unreadable reply as an error, not a crash", () => {
        expect(sectionStateFromReply("alerts", { ok: true, result: "nope" }).phase).toBe("error");
    });
});

it("parses journal metrics", () => {
    const m = parseMetrics({
        user: { head_seq: 50, devices: [{ device_id: 1, kind: "agent", cursor: 48, lag: 2, last_seen_at: 9 }] },
        sockets_connected: 3,
        journal_row_count: 1000,
        db_file_size_bytes: 2048,
    })!;
    expect(m.devices[0].lag).toBe(2);
    expect(m.db_file_size_bytes).toBe(2048);
    expect(parseMetrics({})).toBeNull();
});

describe("format", () => {
    it("formats bytes, counts, money", () => {
        expect(formatBytes(92635176960)).toBe("86 GB");
        expect(formatBytes(3.4 * 1024 ** 3)).toBe("3.4 GB");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatCount(12_400)).toBe("12.4k");
        expect(formatCount(3_000_000)).toBe("3M");
        expect(formatUsd(0.4)).toBe("$0.40");
        expect(formatUsd(1284.2)).toBe("$1,284");
    });
    it("formats durations and relative times", () => {
        expect(formatDuration(45)).toBe("45s");
        expect(formatDuration(12_000)).toBe("3h 20m");
        expect(formatDuration(4 * 86_400 + 6 * 3600)).toBe("4d 6h");
        expect(formatRelative(0, 10_000)).toBe("just now");
        expect(formatRelative(0, 240_000)).toBe("4m ago");
        expect(formatRelative(7_200_000, 0)).toBe("in 2h");
        expect(formatInterval(900)).toBe("every 15m");
        expect(formatInterval(86_400)).toBe("daily");
        expect(formatInterval(null)).toBeNull();
    });
    it("computes used percent and labels", () => {
        expect(usedPercent(40, 100)).toBe(60);
        expect(usedPercent(1, 0)).toBeNull();
        expect(limitLabel("session", "Session")).toBe("5-hour");
        expect(limitLabel("codex:codex:secondary", "Codex · Weekly")).toBe("Weekly");
        expect(limitLabel("week_fable", "Week (Fable)")).toBe("Week · Fable");
        expect(severityTone("P1")).toBe("critical");
        expect(severityTone("P2")).toBe("warn");
        expect(severityTone("P3")).toBe("info");
    });
});
