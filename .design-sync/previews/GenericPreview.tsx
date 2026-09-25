import { DownloadControl, GenericPreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const now = Date.now();

const archive = {
    filename: "release-2026.09.24.zip",
    path: `${FIXTURE_FILES_ROOT}/dist/release-2026.09.24.zip`,
    meta: { kind: "file" as const, size: 5_242_880, mtime: now - 4 * DAY, mime: "application/zip", isText: false },
};
const sqlite = {
    filename: "outcomes.sqlite",
    path: `${FIXTURE_FILES_ROOT}/agent/memory/outcomes.sqlite`,
    meta: { kind: "file" as const, size: 1_310_720, mtime: now - 2 * HOUR, mime: "application/vnd.sqlite3", isText: false },
};
const font = {
    filename: "Inter-SemiBold.woff2",
    path: `${FIXTURE_FILES_ROOT}/assets/fonts/Inter-SemiBold.woff2`,
    meta: { kind: "file" as const, size: 112_640, mtime: now - 9 * DAY, mime: "font/woff2", isText: false },
};

const Panel = ({ width = 480, children }: { width?: number; children: React.ReactNode }) => (
    <div style={{ width }}>
        <MatronThemeProvider surface="default" padding={16}>
            {children}
        </MatronThemeProvider>
    </div>
);

export const Archive = () => (
    <Panel>
        <GenericPreview api={api} {...archive} />
    </Panel>
);

export const InPreviewPanel = () => (
    <Panel>
        <div className="mj_FilesPreview_downloadRow">
            <DownloadControl api={api} path={sqlite.path} filename={sqlite.filename} />
        </div>
        <GenericPreview api={api} {...sqlite} />
    </Panel>
);

export const UnknownBinary = () => (
    <Panel>
        <GenericPreview api={api} {...font} />
    </Panel>
);

export const Dark = () => (
    <div style={{ width: 480 }}>
        <MatronThemeProvider theme="dark" surface="default">
            <div className="mj_FilesPreview_downloadRow">
                <DownloadControl api={api} path={archive.path} filename={archive.filename} />
            </div>
            <GenericPreview api={api} {...archive} />
        </MatronThemeProvider>
    </div>
);

export const PhoneWidth = () => (
    <Panel width={360}>
        <GenericPreview api={api} {...sqlite} />
    </Panel>
);
