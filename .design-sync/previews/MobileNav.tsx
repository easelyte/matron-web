import { MatronThemeProvider, MobileNav, createFixtureClient } from "matron-web";

const listClient = createFixtureClient({ screen: "list" });
const trackerClient = createFixtureClient({ screen: "tracker-inbox" });
const filesClient = createFixtureClient({ screen: "files" });
const busyClient = createFixtureClient({ screen: "list", state: { trackerNeedsYou: 140 } });
const partialClient = createFixtureClient({ screen: "list", state: { trackerNeedsYou: 20, trackerNeedsYouPartial: true } });
const quietClient = createFixtureClient({ screen: "list", state: { trackerNeedsYou: 0 } });

export const Chats = () => <MobileNav client={listClient} state={listClient.getSnapshot()} filesAvailable />;

export const TrackerActive = () => (
    <MobileNav client={trackerClient} state={trackerClient.getSnapshot()} filesAvailable />
);

export const FilesActive = () => <MobileNav client={filesClient} state={filesClient.getSnapshot()} filesAvailable />;

export const BadgeCounts = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <MobileNav client={busyClient} state={busyClient.getSnapshot()} filesAvailable />
        <MobileNav client={partialClient} state={partialClient.getSnapshot()} filesAvailable />
        <MobileNav client={quietClient} state={quietClient.getSnapshot()} filesAvailable />
    </div>
);

export const NoFiles = () => <MobileNav client={listClient} state={listClient.getSnapshot()} filesAvailable={false} />;

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <MobileNav client={trackerClient} state={trackerClient.getSnapshot()} filesAvailable />
    </MatronThemeProvider>
);
