import { MatronThemeProvider, QueuedReleaseCard, createFixtureClient } from "matron-web";

const client = createFixtureClient({ screen: "chat" });
const ts = Date.now() - 3 * 60_000;

const queued = {
    seq: 30,
    convo_id: "c1",
    ts,
    sender: "journal",
    type: "prompt",
    payload: {
        kind: "queued_release",
        items: [{ id: "pr_30::0", text: "Also bump the cache TTL on /journal/media to 1h once the deploy is green." }],
        actions: [
            { id: "send", label: "Send now", intent: "primary" },
            { id: "cancel", label: "Cancel", intent: "neutral" },
        ],
    },
};

const queuedMany = {
    ...queued,
    seq: 31,
    payload: {
        ...queued.payload,
        items: [
            { id: "pr_31::0", text: "After the restart, tail the nginx error log for 5 minutes and post anything above warn." },
            { id: "pr_31::1", text: "Then open a tracker item for the websocket reconnect spike we saw yesterday." },
            {
                id: "pr_31::2",
                text: "Last thing: write up the rollback steps in the runbook, including the symlink repoint, the nginx reload, how to verify the previous release is actually serving, and who to page if the checksum verification fails halfway through a deploy.",
            },
        ],
    },
};

const resolvedAs = (action: "send" | "cancel" | "expired") => () => action;

export const Pending = () => (
    <div style={{ maxWidth: 560 }}>
        <QueuedReleaseCard client={client} event={queued} />
    </div>
);

export const SeveralQueued = () => (
    <div style={{ maxWidth: 560 }}>
        <QueuedReleaseCard client={client} event={queuedMany} />
    </div>
);

export const Resolved = () => (
    <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 12 }}>
        <QueuedReleaseCard client={client} event={queued} resolvedAction={resolvedAs("send")} />
        <QueuedReleaseCard client={client} event={queued} resolvedAction={resolvedAs("cancel")} />
        <QueuedReleaseCard client={client} event={queued} resolvedAction={resolvedAs("expired")} />
    </div>
);

export const ReadOnlySubagent = () => (
    <div style={{ maxWidth: 560 }}>
        <QueuedReleaseCard client={client} event={queued} isReadOnly />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark" surface="default">
        <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 12 }}>
            <QueuedReleaseCard client={client} event={queued} />
            <QueuedReleaseCard client={client} event={queued} resolvedAction={resolvedAs("send")} />
        </div>
    </MatronThemeProvider>
);

export const PhoneWidth = () => (
    <div style={{ width: 360 }}>
        <QueuedReleaseCard client={client} event={queuedMany} />
    </div>
);
