import { MediaPreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const loadingApi = { ...api, contentUrl: () => new Promise<string>(() => {}) };
const tooLargeApi = {
  ...api,
  contentUrl: () => Promise.reject(new Error("This file is too large to preview — download it instead.")),
};

const audio = {
  kind: "file" as const,
  size: 1_842_112,
  mtime: Date.now() - 2 * 86_400_000,
  mime: "audio/mpeg",
  isText: false,
};
const path = `${FIXTURE_FILES_ROOT}/standup.mp3`;
const pane = { maxWidth: 720 } as const;

export const Audio = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <MediaPreview api={api} path={path} filename="standup.mp3" meta={audio} />
  </div>
);

export const LoadingAndTooLarge = () => (
  <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
    <div className="mj_FilesPane_preview">
      <MediaPreview api={loadingApi} path={path} filename="standup.mp3" meta={audio} />
    </div>
    <div className="mj_FilesPane_preview">
      <MediaPreview
        api={tooLargeApi}
        path={`${FIXTURE_FILES_ROOT}/deploy-walkthrough.mp4`}
        filename="deploy-walkthrough.mp4"
        meta={{ ...audio, size: 84_000_000, mime: "video/mp4" }}
      />
    </div>
  </div>
);

export const PhoneWidth = () => (
  <div className="mj_FilesPane_preview" style={{ width: 360 }}>
    <MediaPreview api={api} path={path} filename="standup.mp3" meta={audio} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div className="mj_FilesPane_preview" style={pane}>
      <MediaPreview api={api} path={path} filename="standup.mp3" meta={audio} />
    </div>
  </MatronThemeProvider>
);
