import { UsageCluster, MatronThemeProvider, buildUsageMeters } from "matron-web";

const NOW = Date.now();
const MIN = 60_000;

// A live Claude session: host vitals fresh, context filling up, weekly quota mid-range.
const status = {
    model: "claude-opus-5",
    workdir: "/opt/matron/web-journal",
    context: { tokens: 144_000, window: 200_000, pct: 72 },
    vitals: { cpu_pct: 34, ram_pct: 58, sampled_at_ms: NOW - 8_000 },
};
const limits = [
    { id: "session", label: "Session", percent: 41, resets: "3h20" },
    { id: "week_fable", label: "Week (Fable)", percent: 22, resets: "4d" },
    { id: "week_all", label: "Week (all models)", percent: 63, resets: "4d" },
];
const meters = buildUsageMeters(status, limits);

// Near the limits: 5h window almost spent, context past the compaction line.
const hot = buildUsageMeters(
    { ...status, context: { tokens: 186_000, window: 200_000, pct: 93 }, vitals: { cpu_pct: 91, ram_pct: 88, sampled_at_ms: NOW - 5_000 } },
    [
        { id: "session", label: "Session", percent: 96, resets: "22m" },
        { id: "week_fable", label: "Week (Fable)", percent: 71, resets: "2d" },
        { id: "week_all", label: "Week (all models)", percent: 88, resets: "2d" },
    ],
);

// Idle conversation: the bridge replays an old host sample (dimmed), one quota unknown.
const idle = buildUsageMeters(
    { ...status, context: { tokens: 18_000, window: 200_000, pct: 9 }, vitals: { cpu_pct: 12, ram_pct: 47, sampled_at_ms: NOW - 14 * MIN } },
    [
        { id: "session", label: "Session", percent: 4, resets: "4h51" },
        { id: "week_fable", label: "Week (Fable)", percent: null as unknown as number },
        { id: "week_all", label: "Week (all models)", percent: 18, resets: "6d" },
    ],
);

const cluster = { display: "inline-flex" } as const;

export const HeaderMeters = () => (
    <div className="mj_HeaderCluster mj_UsageCluster" style={cluster}>
        <UsageCluster limits={meters} />
    </div>
);

export const NearLimits = () => (
    <div className="mj_HeaderCluster mj_UsageCluster" style={cluster}>
        <UsageCluster limits={hot} />
    </div>
);

export const IdleStaleHost = () => (
    <div className="mj_HeaderCluster mj_UsageCluster" style={cluster}>
        <UsageCluster limits={idle} />
    </div>
);

export const ContextOnly = () => (
    <div className="mj_HeaderCluster mj_UsageCluster" style={cluster}>
        <UsageCluster limits={buildUsageMeters({ context: { tokens: 61_000, window: 1_000_000, pct: 6 } }, [])} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div className="mj_HeaderCluster mj_UsageCluster" style={cluster}>
            <UsageCluster limits={hot} />
        </div>
    </MatronThemeProvider>
);
