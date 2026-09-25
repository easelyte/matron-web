import { MarkdownBody, MatronThemeProvider } from "matron-web";

const REPORT = [
  "Restarted nginx. Error rate steady at **0.02%** over the last 10 minutes; dashboards clean.",
  "",
  "### What changed",
  "",
  "- `proxy_read_timeout` raised to **3600s** for websocket frames",
  "- Backups rotated: oldest three pruned, latest verified with a test restore",
  "- Rollback point kept: [webapp.bak.20260724T100212Z](https://example.test/bak)",
  "",
  "```nginx",
  "location /journal/ {",
  "    proxy_pass http://127.0.0.1:9810/;",
  "    proxy_read_timeout 3600s;  # websocket frames",
  "}",
  "```",
].join("\n");

const TABLE = [
  "| Check | Result | Time |",
  "| --- | --- | --- |",
  "| Unit tests | 412 passed | 38s |",
  "| Type check | clean | 11s |",
  "| Visual diff | 2 changed | 54s |",
  "",
  "- [x] Deploy to staging",
  "- [ ] Promote to production",
  "",
  "> Follow-up tracked as [#14](matron://item/14) in [mission 5](matron://mission/5).",
].join("\n");

export const AgentReport = () => (
  <div className="mj_Markdown" style={{ maxWidth: 620 }}>
    <MarkdownBody text={REPORT} label="report" />
  </div>
);

export const TablesAndTasks = () => (
  <div className="mj_Markdown" style={{ maxWidth: 620 }}>
    <MarkdownBody text={TABLE} label="table" onTrackerLink={() => {}} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark" surface="default">
    <div className="mj_Markdown" style={{ maxWidth: 620 }}>
      <MarkdownBody text={REPORT} label="report-dark" />
    </div>
  </MatronThemeProvider>
);
