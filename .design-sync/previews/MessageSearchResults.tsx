import { MatronThemeProvider, MessageSearchResults, createFixtureClient } from "matron-web";

const search = createFixtureClient({ screen: "search" }).getSnapshot().messageSearch!;
const now = Date.now();
const select = () => {};

export const Hits = () => (
    <div style={{ width: 300 }}>
        <MessageSearchResults query="nginx" search={search} now={now} onSelect={select} />
    </div>
);

export const Searching = () => (
    <div style={{ width: 300 }}>
        <MessageSearchResults
            query="rollback"
            search={{ query: "rollback", hits: [], loading: true, failed: false }}
            now={now}
            onSelect={select}
        />
    </div>
);

export const NoMatches = () => (
    <div style={{ width: 300 }}>
        <MessageSearchResults
            query="kubernetes"
            search={{ query: "kubernetes", hits: [], loading: false, failed: false }}
            now={now}
            onSelect={select}
        />
    </div>
);

export const Unavailable = () => (
    <div style={{ width: 300 }}>
        <MessageSearchResults
            query="nginx"
            search={{ query: "nginx", hits: [], loading: false, failed: true }}
            now={now}
            onSelect={select}
        />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark" surface="default">
        <div style={{ width: 300 }}>
            <MessageSearchResults query="nginx" search={search} now={now} onSelect={select} />
        </div>
    </MatronThemeProvider>
);

export const PhoneWidth = () => (
    <div style={{ width: 360 }}>
        <MessageSearchResults query="nginx" search={search} now={now} onSelect={select} />
    </div>
);
