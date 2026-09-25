import { MatronThemeProvider, MilestoneCard, createFixtureClient } from "matron-web";

const client = createFixtureClient({ screen: "chat" });

const ev = (seq: number, payload: Record<string, unknown>) => ({
    kind: "journal",
    seq,
    convo_id: "c1",
    ts: Date.now() - (40 - seq) * 60_000,
    sender: "agent:claude",
    type: "milestone",
    payload,
});

const progress = ev(16, {
    num: 11,
    mission_num: 5,
    mission_title: "Ship the tracker web port",
    kind: "progress",
    title: "Deployed the reskin to staging",
    body: "Bubbles, sidebar and header now share one type scale; error rate flat at 0.02% after the swap.",
});
const userInput = ev(17, {
    num: 12,
    mission_num: 5,
    mission_title: "Ship the tracker web port",
    kind: "user_input",
    title: "Approved the prod rollout plan",
    body: "go for it, but keep the old release dir around for a week",
});
const bare = ev(18, { num: 13, mission_num: 6, kind: "progress", title: "Merged PR #414: OOMPolicy=continue" });

const col = { maxWidth: 560, display: "flex", flexDirection: "column" as const, gap: 12 };

export const Progress = () => (
    <div style={{ maxWidth: 560 }}>
        <MilestoneCard client={client} event={progress} />
    </div>
);

export const Kinds = () => (
    <div style={col}>
        <MilestoneCard client={client} event={userInput} />
        <MilestoneCard client={client} event={progress} />
        <MilestoneCard client={client} event={bare} />
    </div>
);

export const PhoneWidth = () => (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
        <MilestoneCard client={client} event={userInput} />
        <MilestoneCard client={client} event={progress} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={col}>
            <MilestoneCard client={client} event={userInput} />
            <MilestoneCard client={client} event={progress} />
        </div>
    </MatronThemeProvider>
);
