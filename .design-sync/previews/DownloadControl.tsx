import { DownloadControl, GenericPreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const pdfPath = `${FIXTURE_FILES_ROOT}/real-estate/offers/bra-signed-2026-09.pdf`;
const zip = {
    filename: "release-2026.09.24.zip",
    path: `${FIXTURE_FILES_ROOT}/dist/release-2026.09.24.zip`,
    meta: { kind: "file" as const, size: 5_242_880, mtime: Date.now() - 4 * 86_400_000, mime: "application/zip", isText: false },
};

const Panel = ({ width = 480, children }: { width?: number; children: React.ReactNode }) => (
    <div style={{ width }}>
        <MatronThemeProvider surface="default" padding={16}>
            {children}
        </MatronThemeProvider>
    </div>
);

export const Default = () => (
    <Panel>
        <div className="mj_FilesPreview_downloadRow">
            <DownloadControl api={api} path={pdfPath} filename="bra-signed-2026-09.pdf" />
        </div>
    </Panel>
);

export const AbovePreview = () => (
    <Panel>
        <div className="mj_FilesPreview_downloadRow">
            <DownloadControl api={api} path={zip.path} filename={zip.filename} />
        </div>
        <GenericPreview api={api} {...zip} />
    </Panel>
);

export const CustomLabel = () => (
    <Panel>
        <div className="mj_FilesPreview_downloadRow">
            <DownloadControl api={api} path={pdfPath} filename="bra-signed-2026-09.pdf" label="Download PDF" />
        </div>
    </Panel>
);

export const SignedOut = () => (
    <Panel>
        <div className="mj_FilesPreview_downloadRow">
            <DownloadControl api={undefined} path={pdfPath} filename="bra-signed-2026-09.pdf" />
        </div>
    </Panel>
);

export const Dark = () => (
    <div style={{ width: 480 }}>
        <MatronThemeProvider theme="dark" surface="default">
            <div className="mj_FilesPreview_downloadRow">
                <DownloadControl api={api} path={zip.path} filename={zip.filename} />
            </div>
            <GenericPreview api={api} {...zip} />
        </MatronThemeProvider>
    </div>
);
