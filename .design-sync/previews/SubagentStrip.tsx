import { MatronThemeProvider, SubagentStrip, createFixtureClient, fixtureConversations } from "matron-web";

const NOW = Date.now();

// c1's children in the fixture (s1 running, s2 done) plus a failed and an interrupted child.
const conversations = [
    ...fixtureConversations,
    {
        id: "s3",
        title: "bundle size audit",
        session_state: "done",
        session_outcome: "failed",
        last_seq: 5,
        unread_count: 0,
        snippet: "webpack stats unreadable",
        created_at: NOW - 90 * 60_000,
        last_ts: NOW - 30 * 60_000,
        parent_convo_id: "c1",
        read_up_to_seq: 5,
        agent_kind: "claude",
    },
    {
        id: "s4",
        title: "i18n string sweep",
        session_state: "running",
        last_seq: 7,
        unread_count: 0,
        snippet: "12 of 40 strings extracted",
        created_at: NOW - 20 * 60_000,
        last_ts: NOW - 2 * 60_000,
        parent_convo_id: "c1",
        read_up_to_seq: 7,
        agent_kind: "codex",
    },
];

const parentClient = createFixtureClient({ screen: "chat" });
const parentState = parentClient.getSnapshot();

const busyClient = createFixtureClient({ screen: "chat", state: { conversations } });
const busyState = busyClient.getSnapshot();

const childClient = createFixtureClient({ screen: "subagent", state: { conversations } });
const childState = childClient.getSnapshot();

export const Parent = () => (
    <div style={{ maxWidth: 760 }}>
        <SubagentStrip client={parentClient} state={parentState} mode="parent" />
    </div>
);

export const MixedOutcomes = () => (
    <div style={{ maxWidth: 760 }}>
        <SubagentStrip client={busyClient} state={busyState} mode="parent" />
    </div>
);

export const ChildView = () => (
    <div style={{ maxWidth: 760 }}>
        <SubagentStrip client={childClient} state={childState} mode="child" />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark" surface="default">
        <div style={{ maxWidth: 760 }}>
            <SubagentStrip client={childClient} state={childState} mode="child" />
        </div>
    </MatronThemeProvider>
);

export const PhoneWidth = () => (
    <div style={{ width: 360 }}>
        <SubagentStrip client={childClient} state={childState} mode="child" />
    </div>
);
