import { DownloadControl, MatronThemeProvider, MediaError, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const retry = () => {};
const video = `${FIXTURE_FILES_ROOT}/billing-app/recordings/onboarding-walkthrough.mp4`;

const Panel = ({ width = 480, children }: { width?: number; children: React.ReactNode }) => (
    <div style={{ width }}>
        <MatronThemeProvider surface="default" padding={16}>
            {children}
        </MatronThemeProvider>
    </div>
);

export const ImageFailed = () => (
    <Panel>
        <MediaError error="This image couldn't be loaded." onRetry={retry} />
    </Panel>
);

export const TooLargeUnderDownload = () => (
    <Panel>
        <div className="mj_FilesPreview_downloadRow">
            <DownloadControl api={api} path={video} filename="onboarding-walkthrough.mp4" />
        </div>
        <MediaError error="This file is too large to preview — download it instead." onRetry={retry} />
    </Panel>
);

export const Timeout = () => (
    <Panel>
        <MediaError error="This took too long to load. Try again." onRetry={retry} />
    </Panel>
);

export const Dark = () => (
    <div style={{ width: 480 }}>
        <MatronThemeProvider theme="dark" surface="default">
            <MediaError error="This file or folder can't be accessed." onRetry={retry} />
        </MatronThemeProvider>
    </div>
);

export const PhoneWidth = () => (
    <Panel width={360}>
        <MediaError error="This took too long to load. Try again." onRetry={retry} />
    </Panel>
);
