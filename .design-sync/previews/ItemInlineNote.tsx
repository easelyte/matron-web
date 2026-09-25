import { ItemInlineNote, MatronThemeProvider, createFixtureClient } from "matron-web";

const client = createFixtureClient({ screen: "chat" });

const ev = (seq: number, payload: Record<string, unknown>) => ({
    kind: "journal",
    seq,
    convo_id: "c1",
    ts: Date.now() - (40 - seq) * 60_000,
    sender: "journal",
    type: "item",
    payload,
});

const userReply = ev(20, {
    num: 12,
    kind: "question",
    title: "Which brand colour for the tracker accent?",
    action: "commented",
    by: "user",
    comment: { body: "Go with the **teal** we already use for links; keep orange for needs-you only." },
});
const agentReply = ev(21, {
    num: 18,
    kind: "task",
    title: "Quarantine the flaky upload-timeout test",
    action: "commented",
    by: "agent",
    comment: { body: "Reproduced 3/20 runs locally. Quarantined behind `@flaky` and linked #19 for the real fix." },
});
const reopened = ev(22, {
    num: 9,
    kind: "decision",
    title: "Keep nginx as the websocket proxy",
    action: "reopened",
    by: "user",
});

const col = { maxWidth: 560, display: "flex", flexDirection: "column" as const, gap: 12 };

export const Replied = () => (
    <div style={{ maxWidth: 560 }}>
        <ItemInlineNote client={client} event={userReply} />
    </div>
);

export const Actions = () => (
    <div style={col}>
        <ItemInlineNote client={client} event={userReply} />
        <ItemInlineNote client={client} event={agentReply} />
        <ItemInlineNote client={client} event={reopened} />
        <ItemInlineNote client={client} event={ev(23, { num: 4, kind: "task", action: "reopened", by: "agent" })} />
    </div>
);

export const PhoneWidth = () => (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
        <ItemInlineNote client={client} event={userReply} />
        <ItemInlineNote client={client} event={reopened} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={col}>
            <ItemInlineNote client={client} event={userReply} />
            <ItemInlineNote client={client} event={agentReply} />
            <ItemInlineNote client={client} event={reopened} />
        </div>
    </MatronThemeProvider>
);
