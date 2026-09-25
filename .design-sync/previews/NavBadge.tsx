import { ChecklistIcon, MatronThemeProvider, NavBadge } from "matron-web";

const label = { font: "400 12px/16px Inter, sans-serif", color: "var(--cpd-color-text-secondary)" };

const OnIcon = ({ name, count, partial }: { name: string; count: number; partial?: boolean }) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, minWidth: 84 }}>
        <span style={{ position: "relative", display: "inline-flex", color: "var(--cpd-color-text-secondary)" }}>
            <ChecklistIcon width={28} height={28} />
            <NavBadge count={count} partial={partial} />
        </span>
        <span style={label}>{name}</span>
    </div>
);

export const OnTrackerIcon = () => (
    <div style={{ padding: 8 }}>
        <OnIcon name="Tracker, 2 need you" count={2} />
    </div>
);

export const Counts = () => (
    <div style={{ display: "flex", gap: 16, padding: 8 }}>
        <OnIcon name="exact: 3" count={3} />
        <OnIcon name="exact: 42" count={42} />
        <OnIcon name="lower bound: 20+" count={20} partial />
        <OnIcon name="over 99" count={250} />
        <OnIcon name="0: hidden" count={0} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={{ display: "flex", gap: 16, padding: 16, background: "var(--cpd-color-bg-canvas-default)" }}>
            <OnIcon name="exact: 3" count={3} />
            <OnIcon name="lower bound: 20+" count={20} partial />
            <OnIcon name="over 99" count={250} />
        </div>
    </MatronThemeProvider>
);
