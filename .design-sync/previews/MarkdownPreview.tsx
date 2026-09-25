import { MarkdownPreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const RUNBOOK = [
  "# Journal deploy runbook",
  "",
  "Promote a staged **matron-web** build to production with one rollback point.",
  "",
  "## Steps",
  "",
  "1. Build on the VPS inside a memory-capped scope",
  "2. `rsync` the bundle into `/var/www/webapp`",
  "3. Reload nginx and watch the 5xx rate for 10 minutes",
  "",
  "| Check | Threshold |",
  "| --- | --- |",
  "| 5xx rate | < 0.1% |",
  "| p95 latency | < 400 ms |",
  "",
  "> Never restart the bridge during a deploy without a greenlight.",
].join("\n");

const base = createFixtureFilesApi();
const api = {
  ...base,
  textContent: async (path: string) => (path.endsWith("RUNBOOK.md") ? RUNBOOK : base.textContent(path)),
};
const loadingApi = { ...base, textContent: () => new Promise<string>(() => {}) };

const meta = (size: number) => ({
  kind: "file" as const,
  size,
  mtime: Date.now() - 3_600_000,
  mime: "text/markdown",
  isText: true,
});
const at = (name: string) => `${FIXTURE_FILES_ROOT}/${name}`;
const pane = { maxWidth: 720 } as const;

export const Readme = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <MarkdownPreview api={api} path={at("README.md")} filename="README.md" meta={meta(4310)} />
  </div>
);

export const Runbook = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <MarkdownPreview api={api} path={at("docs/RUNBOOK.md")} filename="RUNBOOK.md" meta={meta(1920)} />
  </div>
);

export const Loading = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <MarkdownPreview api={loadingApi} path={at("README.md")} filename="README.md" meta={meta(4310)} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div className="mj_FilesPane_preview" style={pane}>
      <MarkdownPreview api={api} path={at("docs/RUNBOOK.md")} filename="RUNBOOK.md" meta={meta(1920)} />
    </div>
  </MatronThemeProvider>
);
