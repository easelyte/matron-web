import { NewSessionSheet, MatronThemeProvider, createFixtureClient } from "matron-web";

const close = () => {};

// The card root is the containing block for the fixed-position scrim, so give it a stage the
// height of the declared viewport (minus the capture gutter) for the overlay to cover.
const Stage = ({ children }: { children: React.ReactNode }) => <div style={{ height: 600 }}>{children}</div>;
const HOUR = 3_600_000;

// Default fixture: one connected box (vps) → the sheet skips straight to its recent folders.
const client = createFixtureClient({ screen: "chat" });

// Several boxes connected → the box picker step.
const multiBox = createFixtureClient({ screen: "chat" });
Object.assign(multiBox, {
    listAgents: async () => [
        { device_id: 1, connected: true, name: "vps · ops-repo" },
        { device_id: 4, connected: true, name: "eric" },
        { device_id: 7, connected: false, name: "laptop", last_seen_at: Date.now() - 5 * HOUR },
    ],
});

// Agent listing still in flight.
const loading = createFixtureClient({ screen: "chat" });
Object.assign(loading, { listAgents: () => new Promise(() => {}) });

// Relay down: the listing rejects.
const failed = createFixtureClient({ screen: "chat" });
Object.assign(failed, { listAgents: async () => Promise.reject(new Error("relay unreachable")) });

export const RecentFolders = () => <Stage><NewSessionSheet client={client} onClose={close} /></Stage>;

export const PickABox = () => <Stage><NewSessionSheet client={multiBox} onClose={close} /></Stage>;

export const LoadingAgents = () => <Stage><NewSessionSheet client={loading} onClose={close} /></Stage>;

export const AgentsError = () => <Stage><NewSessionSheet client={failed} onClose={close} /></Stage>;

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <Stage><NewSessionSheet client={client} onClose={close} /></Stage>
    </MatronThemeProvider>
);
