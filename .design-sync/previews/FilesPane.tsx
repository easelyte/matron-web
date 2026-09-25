import { FilesPane, MatronThemeProvider, createFixtureClient, FIXTURE_FILES_ROOT } from "matron-web";

const browse = createFixtureClient({ screen: "files" });
const preview = createFixtureClient({ screen: "files-preview" });
const readOnly = createFixtureClient({ screen: "files-preview", filesWritable: false });
const empty = createFixtureClient({
  screen: "files",
  state: { filesView: { open: true, path: `${FIXTURE_FILES_ROOT}/empty-dir` } },
});
const denied = createFixtureClient({
  screen: "files",
  filesWritable: false,
  state: { filesView: { open: true, path: `${FIXTURE_FILES_ROOT}/denied-dir` } },
});
const dark = createFixtureClient({ screen: "files-preview" });

const frame = { display: "flex", height: 700, width: "100%" } as const;

export const PreviewOpen = () => (
  <div style={frame}>
    <FilesPane client={preview} state={preview.getSnapshot()} />
  </div>
);

export const Browsing = () => (
  <div style={frame}>
    <FilesPane client={browse} state={browse.getSnapshot()} />
  </div>
);

export const ReadOnly = () => (
  <div style={frame}>
    <FilesPane client={readOnly} state={readOnly.getSnapshot()} />
  </div>
);

export const EmptyFolder = () => (
  <div style={{ ...frame, height: 420 }}>
    <FilesPane client={empty} state={empty.getSnapshot()} />
  </div>
);

export const AccessDenied = () => (
  <div style={{ ...frame, height: 420 }}>
    <FilesPane client={denied} state={denied.getSnapshot()} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div style={frame}>
      <FilesPane client={dark} state={dark.getSnapshot()} />
    </div>
  </MatronThemeProvider>
);
