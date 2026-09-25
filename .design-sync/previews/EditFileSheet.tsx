import { EditFileSheet, MatronThemeProvider, createFixtureClient } from "matron-web";

const close = () => {};

// The card root is the containing block for the fixed-position scrim, so give it a stage the
// height of the declared viewport (minus the capture gutter) for the overlay to cover.
const Stage = ({ children }: { children: React.ReactNode }) => <div style={{ height: 600 }}>{children}</div>;
const HOUR = 3_600_000;

// Default fixture: one connected box (vps) → the sheet opens straight on the edit form.
const client = createFixtureClient({ screen: "chat" });

// Several boxes connected → pick which box to edit on first.
const multiBox = createFixtureClient({ screen: "chat" });
Object.assign(multiBox, {
    listAgents: async () => [
        { device_id: 1, connected: true, name: "vps · ops-repo" },
        { device_id: 4, connected: true, name: "eric" },
        { device_id: 7, connected: false, name: "laptop", last_seen_at: Date.now() - 5 * HOUR },
    ],
});

// No boxes online at all.
const none = createFixtureClient({ screen: "chat" });
Object.assign(none, { listAgents: async () => [] });

const loading = createFixtureClient({ screen: "chat" });
Object.assign(loading, { listAgents: () => new Promise(() => {}) });

export const EditForm = () => <Stage><EditFileSheet client={client} onClose={close} /></Stage>;

export const PickABox = () => <Stage><EditFileSheet client={multiBox} onClose={close} /></Stage>;

export const NoAgents = () => <Stage><EditFileSheet client={none} onClose={close} /></Stage>;

export const LoadingAgents = () => <Stage><EditFileSheet client={loading} onClose={close} /></Stage>;

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <Stage><EditFileSheet client={client} onClose={close} /></Stage>
    </MatronThemeProvider>
);
