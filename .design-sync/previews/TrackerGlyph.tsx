import { MatronThemeProvider, TrackerGlyph } from "matron-web";

const cell = { display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 6, minWidth: 88 };
const label = { font: "400 12px/16px Inter, sans-serif", color: "var(--cpd-color-text-secondary)" };
const row = { display: "flex", gap: 20, alignItems: "flex-end", fontSize: 32, flexWrap: "wrap" as const };

const Labeled = ({ name, children }: { name: string; children: React.ReactNode }) => (
    <div style={cell}>
        {children}
        <span style={label}>{name}</span>
    </div>
);

export const ItemKinds = () => (
    <div style={row}>
        <Labeled name="question">
            <TrackerGlyph kind="question" />
        </Labeled>
        <Labeled name="task">
            <TrackerGlyph kind="task" />
        </Labeled>
        <Labeled name="decision">
            <TrackerGlyph kind="decision" />
        </Labeled>
    </div>
);

export const MissionsAndMilestones = () => (
    <div style={row}>
        <Labeled name="mission open">
            <TrackerGlyph mission="open" />
        </Labeled>
        <Labeled name="mission closed">
            <TrackerGlyph mission="closed" />
        </Labeled>
        <Labeled name="milestone progress">
            <TrackerGlyph milestone="progress" />
        </Labeled>
        <Labeled name="milestone user_input">
            <TrackerGlyph milestone="user_input" />
        </Labeled>
    </div>
);

export const Sizes = () => (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
        {[14, 20, 28, 40].map((size) => (
            <div key={size} style={{ ...cell, fontSize: size }}>
                <TrackerGlyph kind="question" />
                <span style={label}>{size}px</span>
            </div>
        ))}
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={{ ...row, padding: 16, background: "var(--cpd-color-bg-canvas-default)" }}>
            <Labeled name="question">
                <TrackerGlyph kind="question" />
            </Labeled>
            <Labeled name="task">
                <TrackerGlyph kind="task" />
            </Labeled>
            <Labeled name="decision">
                <TrackerGlyph kind="decision" />
            </Labeled>
            <Labeled name="mission open">
                <TrackerGlyph mission="open" />
            </Labeled>
            <Labeled name="user_input">
                <TrackerGlyph milestone="user_input" />
            </Labeled>
        </div>
    </MatronThemeProvider>
);
