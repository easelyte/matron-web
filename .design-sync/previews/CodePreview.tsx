import { CodePreview, MatronThemeProvider, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const DEPLOY_TS = [
  'import { execFile } from "node:child_process";',
  "",
  "// Swap the staged web bundle into place, keeping one rollback point.",
  "export async function promote(release: string, keep = 1): Promise<void> {",
  "    const stamp = new Date().toISOString().replace(/[-:]/g, \"\").slice(0, 15);",
  "    await run(\"cp\", [\"-a\", \"/var/www/webapp\", `/var/www/webapp.bak.${stamp}Z`]);",
  "    await run(\"rsync\", [\"-a\", \"--delete\", `${release}/`, \"/var/www/webapp/\"]);",
  "    await pruneBackups(keep);",
  "    console.info(`promoted ${release} (rollback: webapp.bak.${stamp}Z)`);",
  "}",
  "",
  "function run(cmd: string, args: string[]): Promise<void> {",
  "    return new Promise((resolve, reject) =>",
  "        execFile(cmd, args, (err) => (err ? reject(err) : resolve())),",
  "    );",
  "}",
].join("\n");

const NGINX_CONF = [
  "server {",
  "    listen 443 ssl;",
  "    server_name journal.example.test;",
  "",
  "    location /journal/ {",
  "        proxy_pass http://127.0.0.1:9810/;",
  "        proxy_http_version 1.1;",
  "        proxy_set_header Upgrade $http_upgrade;",
  "        proxy_read_timeout 3600s;  # websocket frames",
  "    }",
  "}",
].join("\n");

const base = createFixtureFilesApi();
const api = {
  ...base,
  textContent: async (path: string) =>
    path.endsWith("deploy.ts") ? DEPLOY_TS : path.endsWith(".conf") ? NGINX_CONF : base.textContent(path),
};
const loadingApi = { ...base, textContent: () => new Promise<string>(() => {}) };
const deniedApi = {
  ...base,
  textContent: () => Promise.reject(new Error("This file or folder can't be accessed.")),
};

const meta = (size: number, mime = "text/plain") => ({
  kind: "file" as const,
  size,
  mtime: Date.now() - 3_600_000,
  mime,
  isText: true,
});
const at = (name: string) => `${FIXTURE_FILES_ROOT}/${name}`;
const pane = { maxWidth: 720 } as const;

export const TypeScript = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <CodePreview api={api} path={at("scripts/deploy.ts")} filename="deploy.ts" meta={meta(1_180)} />
  </div>
);

export const NginxConfig = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <CodePreview api={api} path={at("ops/journal.conf")} filename="journal.conf" meta={meta(412)} />
  </div>
);

export const Css = () => (
  <div className="mj_FilesPane_preview" style={pane}>
    <CodePreview api={api} path={at("theme.css")} filename="theme.css" meta={meta(2048, "text/css")} />
  </div>
);

export const LoadingAndDenied = () => (
  <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
    <div className="mj_FilesPane_preview">
      <CodePreview api={loadingApi} path={at("client.ts")} filename="client.ts" meta={meta(10_240)} />
    </div>
    <div className="mj_FilesPane_preview">
      <CodePreview api={deniedApi} path={at(".env.local")} filename=".env.local" meta={meta(640)} />
    </div>
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div className="mj_FilesPane_preview" style={pane}>
      <CodePreview api={api} path={at("scripts/deploy.ts")} filename="deploy.ts" meta={meta(1_180)} />
    </div>
  </MatronThemeProvider>
);
