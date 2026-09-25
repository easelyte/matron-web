import { EventContent, MatronThemeProvider, createFixtureClient, fixtureEvents } from "matron-web";

const client = createFixtureClient({ screen: "chat" });
const noAnswers = new Map<string, { choice?: string }>();
const bySeq = (seq: number) => fixtureEvents.find((event) => event.seq === seq)!;

const report = bySeq(8);
const nginxRestart = bySeq(6);
const nginxDiff = bySeq(7);
const permission = bySeq(3);
const question = bySeq(11);
const spawnRequest = bySeq(14);
const dashboard = bySeq(9);
const peer = bySeq(20);
const priorityPeer = bySeq(22);

const failedBuild = {
    seq: 40,
    convo_id: "c1",
    ts: Date.now() - 20 * 60_000,
    sender: "agent:claude",
    type: "tool_output",
    payload: {
        command: "npm run build",
        exit_code: 1,
        snippet:
            "ERROR in ./src/journal/components.tsx 4297:9\nModule parse failed: Unexpected token (4297:9)\nwebpack 5.98.0 compiled with 1 error in 38112 ms",
    },
};

const answeredPermissions = new Map([
    ["c1:3", { choice: "Allow" }],
    ["c1:11", { choice: "Staging" }],
]);

const spawnOutcomes = new Map([
    ["spawn-fixture-1", { request_id: "spawn-fixture-1", outcome: "started", room_id: "s1", child_convo_id: "s1" }],
]);

const unknownEvent = {
    seq: 41,
    convo_id: "c1",
    ts: Date.now() - 10 * 60_000,
    sender: "agent:claude",
    type: "cost_report",
    payload: { model: "claude-opus-5", input_tokens: 184_220, output_tokens: 12_904, cache_hit_rate: 0.87 },
};

export const MarkdownText = () => (
    <div className="markdown-body" style={{ maxWidth: 640 }}>
        <EventContent client={client} event={report} answeredPromptReplies={noAnswers} />
    </div>
);

export const ToolOutput = () => (
    <div className="markdown-body" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
        <EventContent client={client} event={nginxRestart} answeredPromptReplies={noAnswers} />
        <EventContent client={client} event={failedBuild} answeredPromptReplies={noAnswers} />
    </div>
);

export const Diff = () => (
    <div className="markdown-body" style={{ maxWidth: 640 }}>
        <EventContent client={client} event={nginxDiff} answeredPromptReplies={noAnswers} />
    </div>
);

export const PromptsUnanswered = () => (
    <div className="markdown-body" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
        <EventContent client={client} event={permission} answeredPromptReplies={noAnswers} />
        <EventContent client={client} event={question} answeredPromptReplies={noAnswers} />
    </div>
);

export const PromptsAnswered = () => (
    <div className="markdown-body" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
        <EventContent client={client} event={permission} answeredPromptReplies={answeredPermissions} />
        <EventContent client={client} event={question} answeredPromptReplies={answeredPermissions} />
    </div>
);

export const AgentSpawn = () => (
    <div className="markdown-body" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
        <EventContent client={client} event={spawnRequest} answeredPromptReplies={noAnswers} />
        <EventContent
            client={client}
            event={spawnRequest}
            answeredPromptReplies={noAnswers}
            spawnOutcomes={spawnOutcomes}
        />
    </div>
);

export const PeerMessages = () => (
    <div className="markdown-body" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
        <EventContent client={client} event={peer} answeredPromptReplies={noAnswers} />
        <EventContent client={client} event={priorityPeer} answeredPromptReplies={noAnswers} />
    </div>
);

export const Image = () => (
    <div className="markdown-body" style={{ maxWidth: 640 }}>
        <EventContent client={client} event={dashboard} answeredPromptReplies={noAnswers} />
    </div>
);

export const UnknownType = () => (
    <div className="markdown-body" style={{ maxWidth: 640 }}>
        <EventContent client={client} event={unknownEvent} answeredPromptReplies={noAnswers} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark" surface="default">
        <div className="markdown-body" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
            <EventContent client={client} event={report} answeredPromptReplies={noAnswers} />
            <EventContent client={client} event={permission} answeredPromptReplies={noAnswers} />
            <EventContent client={client} event={priorityPeer} answeredPromptReplies={noAnswers} />
        </div>
    </MatronThemeProvider>
);

export const PhoneWidth = () => (
    <div className="markdown-body" style={{ width: 360, display: "flex", flexDirection: "column", gap: 16 }}>
        <EventContent client={client} event={nginxRestart} answeredPromptReplies={noAnswers} />
        <EventContent client={client} event={spawnRequest} answeredPromptReplies={noAnswers} />
    </div>
);
