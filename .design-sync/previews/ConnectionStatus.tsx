import { ConnectionStatus, MatronThemeProvider, createFixtureClient } from "matron-web";

const online = createFixtureClient({ screen: "list" });
const connecting = createFixtureClient({ screen: "list", state: { connection: "connecting" } });
const offline = createFixtureClient({ screen: "offline" });

// ConnectionStatus lives inside the Settings (account) menu; its label/button styles are scoped
// to .mj_HeaderMenu, so the menu panel class is kept (position static instead of the popover).
const menu = { position: "static" as const, width: 280 };

export const Connected = () => (
    <div className="mj_HeaderMenu" style={menu}>
        <ConnectionStatus client={online} state={online.getSnapshot()} />
    </div>
);

export const States = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="mj_HeaderMenu" style={menu}>
            <ConnectionStatus client={online} state={online.getSnapshot()} />
        </div>
        <div className="mj_HeaderMenu" style={menu}>
            <ConnectionStatus client={connecting} state={connecting.getSnapshot()} />
        </div>
        <div className="mj_HeaderMenu" style={menu}>
            <ConnectionStatus client={offline} state={offline.getSnapshot()} />
        </div>
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="mj_HeaderMenu" style={menu}>
                <ConnectionStatus client={online} state={online.getSnapshot()} />
            </div>
            <div className="mj_HeaderMenu" style={menu}>
                <ConnectionStatus client={offline} state={offline.getSnapshot()} />
            </div>
        </div>
    </MatronThemeProvider>
);
