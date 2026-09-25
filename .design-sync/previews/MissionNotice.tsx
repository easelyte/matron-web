import { MatronThemeProvider, MissionNotice, createFixtureClient } from "matron-web";

const client = createFixtureClient({ screen: "chat" });

const ev = (seq: number, payload: Record<string, unknown>) => ({
    kind: "journal",
    seq,
    convo_id: "c1",
    ts: Date.now() - (40 - seq) * 60_000,
    sender: "journal",
    type: "mission",
    payload,
});

const col = { maxWidth: 560, display: "flex", flexDirection: "column" as const, gap: 12 };

export const Started = () => (
    <div style={{ maxWidth: 560 }}>
        <MissionNotice client={client} event={ev(1, { num: 5, action: "created", title: "Ship the tracker web port" })} />
    </div>
);

export const Actions = () => (
    <div style={col}>
        <MissionNotice client={client} event={ev(1, { num: 5, action: "created", title: "Ship the tracker web port" })} />
        <MissionNotice client={client} event={ev(2, { num: 7, action: "joined" })} />
        <MissionNotice client={client} event={ev(3, { num: 5, action: "updated", title: "Ship the tracker (web + iOS)" })} />
        <MissionNotice client={client} event={ev(4, { num: 5, action: "closed", open_item_nums: [18, 21] })} />
        <MissionNotice client={client} event={ev(5, { num: 3, action: "closed" })} />
    </div>
);

export const PhoneWidth = () => (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
        <MissionNotice client={client} event={ev(1, { num: 5, action: "created", title: "Ship the tracker web port" })} />
        <MissionNotice client={client} event={ev(4, { num: 5, action: "closed", open_item_nums: [18, 21] })} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={col}>
            <MissionNotice client={client} event={ev(1, { num: 5, action: "created", title: "Ship the tracker web port" })} />
            <MissionNotice client={client} event={ev(4, { num: 5, action: "closed", open_item_nums: [18, 21] })} />
        </div>
    </MatronThemeProvider>
);
