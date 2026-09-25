import { ImagePreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const loadingApi = { ...api, contentUrl: () => new Promise<string>(() => {}) };
const tooLargeApi = {
  ...api,
  contentUrl: () => Promise.reject(new Error("This file is too large to preview — download it instead.")),
};

const meta = {
  kind: "file" as const,
  size: 18_224,
  mtime: Date.now() - 5 * 3_600_000,
  mime: "image/png",
  isText: false,
};
const path = `${FIXTURE_FILES_ROOT}/diagram.png`;
const pane = { maxWidth: 720 } as const;

export const Chart = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <ImagePreview api={api} path={path} filename="diagram.png" meta={meta} />
  </div>
);

export const Narrow = () => (
  <div className="mj_FilesPane_preview" style={{ width: 360 }}>
    <ImagePreview api={api} path={path} filename="diagram.png" meta={meta} />
  </div>
);

export const LoadingAndTooLarge = () => (
  <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
    <div className="mj_FilesPane_preview">
      <ImagePreview api={loadingApi} path={path} filename="diagram.png" meta={meta} />
    </div>
    <div className="mj_FilesPane_preview">
      <ImagePreview api={tooLargeApi} path={`${FIXTURE_FILES_ROOT}/screen-recording-frame.png`} filename="screen-recording-frame.png" meta={{ ...meta, size: 9_400_000 }} />
    </div>
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div className="mj_FilesPane_preview" style={pane}>
      <ImagePreview api={api} path={path} filename="diagram.png" meta={meta} />
    </div>
  </MatronThemeProvider>
);
