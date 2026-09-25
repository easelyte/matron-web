import { MatronThemeProvider, PreviewStatus } from "matron-web";

const retry = () => {};

const Panel = ({ width = 480, children }: { width?: number; children: React.ReactNode }) => (
    <div style={{ width }}>
        <MatronThemeProvider surface="default" padding={16}>
            {children}
        </MatronThemeProvider>
    </div>
);

export const Loading = () => (
    <Panel>
        <PreviewStatus variant="loading">Loading…</PreviewStatus>
    </Panel>
);

export const ErrorWithRetry = () => (
    <Panel>
        <PreviewStatus variant="error" onRetry={retry}>
            This took too long to load. Try again.
        </PreviewStatus>
    </Panel>
);

export const ErrorNoRetry = () => (
    <Panel>
        <PreviewStatus variant="error">This file or folder can&apos;t be accessed.</PreviewStatus>
    </Panel>
);

export const Empty = () => (
    <Panel>
        <PreviewStatus variant="empty">This file is empty.</PreviewStatus>
    </Panel>
);

export const Dark = () => (
    <div style={{ width: 480 }}>
        <MatronThemeProvider theme="dark" surface="default">
            <PreviewStatus variant="loading">Loading…</PreviewStatus>
            <PreviewStatus variant="error" onRetry={retry}>
                This file or folder no longer exists.
            </PreviewStatus>
        </MatronThemeProvider>
    </div>
);

export const PhoneWidth = () => (
    <Panel width={360}>
        <PreviewStatus variant="error" onRetry={retry}>
            This took too long to load. Try again.
        </PreviewStatus>
    </Panel>
);
