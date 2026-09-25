import { DownloadControl, MatronThemeProvider, TooLargePreview, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const logPath = `${FIXTURE_FILES_ROOT}/logs/bridge-journal-2026-09-24.log`;

const Panel = ({ width = 480, children }: { width?: number; children: React.ReactNode }) => (
    <div style={{ width }}>
        <MatronThemeProvider surface="default" padding={16}>
            {children}
        </MatronThemeProvider>
    </div>
);

export const Default = () => (
    <Panel>
        <TooLargePreview />
    </Panel>
);

export const UnderDownload = () => (
    <Panel>
        <div className="mj_FilesPreview_downloadRow">
            <DownloadControl api={api} path={logPath} filename="bridge-journal-2026-09-24.log" />
        </div>
        <TooLargePreview note="bridge-journal-2026-09-24.log is 38.4 MB, too large to preview inline. Download it to read the whole log." />
    </Panel>
);

export const MediaTooLarge = () => (
    <Panel>
        <TooLargePreview note="This file is too large to preview — download it instead." />
    </Panel>
);

export const Dark = () => (
    <div style={{ width: 480 }}>
        <MatronThemeProvider theme="dark" surface="default">
            <div className="mj_FilesPreview_downloadRow">
                <DownloadControl api={api} path={logPath} filename="bridge-journal-2026-09-24.log" />
            </div>
            <TooLargePreview />
        </MatronThemeProvider>
    </div>
);

export const PhoneWidth = () => (
    <Panel width={360}>
        <TooLargePreview />
    </Panel>
);
