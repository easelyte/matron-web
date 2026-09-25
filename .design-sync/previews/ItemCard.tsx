import { ItemCard, MatronThemeProvider, createFixtureClient } from "matron-web";

const client = createFixtureClient({ screen: "chat" });

const ev = (seq: number, payload: Record<string, unknown>) => ({
    kind: "journal",
    seq,
    convo_id: "c1",
    ts: Date.now() - (40 - seq) * 60_000,
    sender: "agent:claude",
    type: "item",
    payload,
});

const question = ev(13, {
    num: 12,
    kind: "question",
    title: "Which brand colour for the tracker accent?",
    action: "created",
    awaiting: "user",
});
const task = ev(14, {
    num: 18,
    kind: "task",
    title: "Quarantine the flaky upload-timeout test",
    action: "created",
    awaiting: "agent",
});
const decision = ev(15, {
    num: 9,
    kind: "decision",
    title: "Keep nginx as the websocket proxy, no Caddy swap",
    action: "created",
});
const closedDecision = ev(16, {
    num: 7,
    kind: "decision",
    title: "Deploy into versioned release dirs",
    action: "closed",
    awaiting: "user",
    resolution: "decided",
    comment: {
        body: "Went with `/opt/matron/releases/<sha>` plus a **current** symlink, so rollback is a repoint instead of a rebuild.",
    },
});
const closedTask = ev(17, {
    num: 21,
    kind: "task",
    title: "Rotate the journal TLS certificate",
    action: "closed",
    resolution: "done",
    comment: { body: "Rotated and reloaded nginx; error rate held at 0.02%.", attachments: [{ name: "cert-chain.pem" }] },
});

const col = { maxWidth: 560, display: "flex", flexDirection: "column" as const, gap: 12 };

export const NeedsYou = () => (
    <div style={{ maxWidth: 560 }}>
        <ItemCard client={client} event={question} />
    </div>
);

export const Kinds = () => (
    <div style={col}>
        <ItemCard client={client} event={question} />
        <ItemCard client={client} event={task} />
        <ItemCard client={client} event={decision} />
    </div>
);

export const Closed = () => (
    <div style={col}>
        <ItemCard client={client} event={closedDecision} />
        <ItemCard client={client} event={closedTask} />
    </div>
);

export const Untitled = () => (
    <div style={{ maxWidth: 560 }}>
        <ItemCard client={client} event={ev(18, { num: 30, kind: "question", action: "created", awaiting: "user" })} />
    </div>
);

export const PhoneWidth = () => (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
        <ItemCard client={client} event={question} />
        <ItemCard client={client} event={closedDecision} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={col}>
            <ItemCard client={client} event={question} />
            <ItemCard client={client} event={task} />
            <ItemCard client={client} event={closedDecision} />
        </div>
    </MatronThemeProvider>
);
