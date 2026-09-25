import { PdfPreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const failingApi = {
  ...api,
  fileBytes: () => Promise.reject(new Error("unreadable")),
};

const meta = {
  kind: "file" as const,
  size: 240_512,
  mtime: Date.now() - 9 * 3_600_000,
  mime: "application/pdf",
  isText: false,
};
const path = `${FIXTURE_FILES_ROOT}/report.pdf`;
// The pane scrolls in the app; the height shows page 1 whole and the top of page 2.
const pane = { width: 440, height: 640 } as const;

export const Report = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <PdfPreview api={api} path={path} filename="report.pdf" meta={meta} />
  </div>
);

export const RenderFailed = () => (
  <div className="mj_FilesPane_preview" style={{ maxWidth: 720 }}>
    <PdfPreview api={failingApi} path={`${FIXTURE_FILES_ROOT}/scan-2026-09.pdf`} filename="scan-2026-09.pdf" meta={meta} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div className="mj_FilesPane_preview" style={pane}>
      <PdfPreview api={api} path={path} filename="report.pdf" meta={meta} />
    </div>
  </MatronThemeProvider>
);
