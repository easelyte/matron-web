import { MatronThemeProvider, NeedsYouBadge } from "matron-web";

const cell = { display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 8, minWidth: 80 };
const label = { font: "400 12px/16px Inter, sans-serif", color: "var(--cpd-color-text-secondary)" };

const Labeled = ({ name, count }: { name: string; count: number }) => (
    <div style={cell}>
        <NeedsYouBadge count={count} />
        <span style={label}>{name}</span>
    </div>
);

export const Default = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, font: "600 15px/20px Inter, sans-serif" }}>
        <span style={{ color: "var(--cpd-color-text-primary)" }}>Inbox</span>
        <NeedsYouBadge count={2} />
    </div>
);

export const Counts = () => (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
        <Labeled name="1 item" count={1} />
        <Labeled name="12 items" count={12} />
        <Labeled name="99 items" count={99} />
        <Labeled name="140 (capped)" count={140} />
        <div style={cell}>
            <NeedsYouBadge count={0} />
            <span style={label}>0: renders nothing</span>
        </div>
    </div>
);

export const InContext = () => (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 10, font: "400 14px/20px Inter, sans-serif" }}>
        {[
            ["Inbox", 2],
            ["matron-web · deploy", 1],
            ["postgres upgrade dry-run", 14],
            ["All sessions", 140],
        ].map(([name, count]) => (
            <div key={name as string} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "var(--cpd-color-text-primary)" }}>
                <span>{name}</span>
                <NeedsYouBadge count={count as number} />
            </div>
        ))}
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={{ display: "flex", gap: 20, alignItems: "flex-end", padding: 16, background: "var(--cpd-color-bg-canvas-default)" }}>
            <Labeled name="1 item" count={1} />
            <Labeled name="12 items" count={12} />
            <Labeled name="99+" count={140} />
        </div>
    </MatronThemeProvider>
);
