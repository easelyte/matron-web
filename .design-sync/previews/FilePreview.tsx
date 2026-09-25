import { FilePreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const at = (name: string) => `${FIXTURE_FILES_ROOT}/${name}`;
const pane = { maxWidth: 720 } as const;

const loadingApi = { ...api, fileMeta: () => new Promise<never>(() => {}) };
const goneApi = {
  ...api,
  fileMeta: () => Promise.reject(new Error("This file or folder no longer exists.")),
};

export const Markdown = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <FilePreview api={api} path={at("README.md")} filename="README.md" />
  </div>
);

export const Code = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <FilePreview api={api} path={at("client.ts")} filename="client.ts" />
  </div>
);

export const Image = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <FilePreview api={api} path={at("diagram.png")} filename="diagram.png" />
  </div>
);

export const Unpreviewable = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <FilePreview api={api} path={at("archive.zip")} filename="archive.zip" />
  </div>
);

export const LoadingAndError = () => (
  <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
    <div className="mj_FilesPane_preview">
      <FilePreview api={loadingApi} path={at("report.pdf")} filename="report.pdf" />
    </div>
    <div className="mj_FilesPane_preview">
      <FilePreview api={goneApi} path={at("deploy-notes.md")} filename="deploy-notes.md" />
    </div>
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div className="mj_FilesPane_preview" style={pane}>
      <FilePreview api={api} path={at("client.ts")} filename="client.ts" />
    </div>
  </MatronThemeProvider>
);
