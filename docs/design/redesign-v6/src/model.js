/* Matron redesign v6 — fixtures + the activity-grouping algorithm.
   Pure data/functions, no DOM. Loaded by the artifact AND by the static exporter.
   Fixture text is design-side mock data; in the app the live line and step sentences
   come from client templates (below) + the agent's own narration. */
(function (W) {
  const M = (W.MV6 = W.MV6 || {});

  /* ---------- fixture helpers ---------- */
  const S = (id, tool, input, o = {}) => ({ kind: "step", id, tool, input, status: "ok", ms: 3000, ...o });
  const N = (text) => ({ kind: "narration", text });
  const B = (type, data) => ({ kind: "break", type, ...data });

  const DIFF_SHEET = [
    ["hunk", "@@ -212,14 +212,26 @@ function NewSessionSheet"],
    ["ctx", '  <div className="mj_NewSessionSheet_field">'],
    ["del", '    <input type="text" value={folder} onChange={setFolder} />'],
    ["del", "    <label>Folder path</label>"],
    ["add", '    <label htmlFor="ns-folder">Folder</label>'],
    ["add", '    <FolderPicker id="ns-folder" recent={recentFolders}'],
    ["add", "      defaultPath={box.defaultFolder} value={folder} onChange={setFolder} />"],
    ["ctx", "  </div>"],
    ["ctx", '  <div className="mj_NewSessionSheet_field">'],
    ["del", '    <input type="text" placeholder="Agent default" value={model} />'],
    ["add", '    <label htmlFor="ns-model">Model</label>'],
    ["add", '    <select id="ns-model" value={model ?? box.defaultModel}'],
    ["add", "      disabled={agent === \"codex\"} onChange={setModel}>"],
    ["add", "      {box.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}"],
    ["add", "    </select>"],
    ["add", '    {agent === "codex" && <p className="mj_Muted">Codex picks its own model</p>}'],
    ["ctx", "  </div>"],
    ["del", "  <label>Model</label>"],
    ["del", "  <label>Agent</label>"],
    ["add", "  <AgentToggle value={agent} onChange={setAgent} available={box.agents} />"],
    ["ctx", "  <label className=\"mj_NewSessionSheet_check\">"],
  ];
  const DIFF_CLIENT = [
    ["hunk", "@@ -1180,7 +1180,13 @@ async startSession(opts)"],
    ["del", '    const model = opts.model ?? "claude-opus";'],
    ["add", "    const model = opts.model ?? this.box?.default_model;"],
    ["add", "    if (!model) throw new StartError(\"no_default_model\");"],
    ["ctx", "    return this.rpc.startSessionRpc({ ...opts, model });"],
  ];
  const DIFF_RPC = [
    ["hunk", "@@ -64,6 +64,9 @@ hello()"],
    ["ctx", "    agents: availableAgents(),"],
    ["add", "    default_model: config.defaultModel,"],
    ["add", "    default_folder: config.workspace,"],
    ["del", "    // TODO: model"],
  ];

  const OUT_TSC_FAIL =
    "src/journal/components.tsx(231,17): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\n  Type 'undefined' is not assignable to type 'string'.\n\nFound 1 error in src/journal/components.tsx:231";
  const OUT_TSC_OK = "(no output — 0 errors)";
  const OUT_TEST_OK =
    " ✓ src/journal/__tests__/new-session-sheet.test.tsx (6 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Duration  2.31s";
  const OUT_GITLOG =
    "a41c2e9 new-session sheet: themed inputs (§10.4)\n7d03b11 sheet: recent folders newest-first\n2f9e8c0 journal: startSessionRpc takes agent kind\n0b6a4d2 sheet: first cut";
  const OUT_TEST_MAIN_FAIL =
    " ✗ src/journal/__tests__/conversation-order.test.ts (4 failed)\n ✗ src/journal/__tests__/work-view-pane.test.tsx (3 failed)\n\n Test Files  2 failed | 26 passed (28)\n      Tests  7 failed | 412 passed (419)";

  /* ---------- turns ---------- */
  const T1 = {
    id: "t1", time: "10:06",
    user: "why is the new-session sheet cryptic?",
    durationMs: 192000,
    items: [
      N("Let me read the sheet component first."),
      S("t1s1", "Read", { path: "src/journal/components.tsx" }, { ms: 900 }),
      S("t1s2", "Read", { path: "src/journal/client.ts" }, { ms: 700 }),
      S("t1s3", "Grep", { pattern: "startSessionRpc" }, { ms: 400 }),
      S("t1s4", "Read", { path: "src/bridge/journal-rpc.js" }, { ms: 600 }),
      S("t1s5", "Grep", { pattern: "default_model" }, { ms: 300 }),
      S("t1s6", "Bash", { command: "git log --oneline -8 -- src/journal/components.tsx" }, { ms: 200, exit: 0, output: OUT_GITLOG }),
      S("t1s7", "Read", { path: "src/journal/components.tsx", note: "lines 200–260" }, { ms: 500 }),
      S("t1s8", "Edit", { path: "src/journal/components.tsx" }, { ms: 1800, added: 18, removed: 6, diff: DIFF_SHEET }),
      S("t1s9", "Bash", { command: "pnpm vitest run src/journal/__tests__/new-session-sheet.test.tsx" }, { ms: 5200, exit: 0, output: OUT_TEST_OK }),
      S("t1s10", "Bash", { command: "pnpm tsc --noEmit" }, { ms: 4100, status: "failed", exit: 2, output: OUT_TSC_FAIL, fullBytes: 18432 }),
      S("t1s11", "Bash", { command: "pnpm tsc --noEmit" }, { ms: 3900, exit: 0, output: OUT_TSC_OK }),
    ],
    answer: [
      "The sheet reads as cryptic for two reasons. Each label sits closer to the field above it than to the one it names, so “Folder path” looks like it belongs to the workspace box. And the model field shows a raw placeholder, “Agent default”, instead of the model the box will actually use.",
      'I moved every label onto the field below it, replaced the placeholder with the box’s real default, and marked the default folder in the recent list. The change is in <a class="mj_FileLink" href="#">src/journal/components.tsx</a>.',
      "Tests pass and the type check is clean. I didn’t touch the Codex path, which still ignores the model field; that is a separate fix.",
    ],
  };

  const T2_STEPS = [
    N("Checking where the default model is decided."),
    S("t2s1", "Read", { path: "src/journal/client.ts" }, { ms: 800 }),
    S("t2s2", "Read", { path: "src/bridge/journal-rpc.js" }, { ms: 700 }),
    S("t2s3", "Grep", { pattern: "default_model" }, { ms: 300 }),
    S("t2s4", "Read", { path: "src/bridge/config.ts" }, { ms: 500 }),
    S("t2s5", "Edit", { path: "src/journal/client.ts" }, { ms: 1400, added: 9, removed: 3, diff: DIFF_CLIENT }),
    S("t2s6", "Edit", { path: "src/bridge/journal-rpc.js" }, { ms: 900, added: 4, removed: 1, diff: DIFF_RPC }),
  ];
  const T2_TEST = S("t2s7", "Bash", { command: "pnpm vitest run src/journal" }, { ms: 44000, exit: 0, output: OUT_TEST_OK });
  const T2 = {
    id: "t2", time: "10:14",
    user: "Can the model default come from the box instead of being hard-coded?",
    durationMs: 66000,
    items: [...T2_STEPS, T2_TEST],
    runningItems: T2_STEPS,
    runningStep: { ...T2_TEST, status: "running" },
    /* live line script: [doneCount, step] — the client derives text from the step */
    liveScript: [
      { done: 1, step: T2_STEPS[2] },
      { done: 2, step: T2_STEPS[3] },
      { done: 6, step: T2_TEST, elapsedFrom: 30 },
    ],
    answer: [
      "Yes. The box now reports its default model and folder when the client connects, and the sheet preselects both. Nothing in the client is hard-coded any more; if the box doesn’t report a default, starting a session fails with a clear message instead of silently picking Opus.",
    ],
  };

  const T3 = {
    id: "t3", time: "10:19",
    user: "Looks good. Push it when the tests are green.",
    durationMs: 48000,
    items: [
      S("t3s1", "Bash", { command: "pnpm vitest run src/journal" }, { ms: 21000, exit: 0, output: OUT_TEST_OK }),
      S("t3s2", "Bash", { command: "git switch -c fix/new-session-sheet && git commit -am 'sheet: labels bind below, real defaults'" }, { ms: 400, exit: 0, output: "[fix/new-session-sheet 9c1e7a2] sheet: labels bind below, real defaults\n 3 files changed, 31 insertions(+), 10 deletions(-)" }),
      B("permission", { id: "p1", time: "10:20", question: "Allow: push the fix branch?", detail: "git push -u origin fix/new-session-sheet", options: ["Allow", "Deny"], answered: "Allowed" }),
      S("t3s3", "Bash", { command: "git push -u origin fix/new-session-sheet" }, { ms: 2100, exit: 0, output: "To github.com:easelyte/matron-web.git\n * [new branch]      fix/new-session-sheet -> fix/new-session-sheet" }),
      B("question", { id: "q1", time: "10:21", question: "Open a pull request against main as well?", options: ["Open PR", "Not yet"], answered: "Open PR" }),
    ],
    waitingUntil: 2, /* index of the break-through the turn is blocked on */
    answer: ["Pushed <code>fix/new-session-sheet</code> and opened PR #311 against main."],
  };

  const T4 = {
    id: "t4", time: "10:24",
    user: "Show me what it looks like now.",
    durationMs: 74000,
    items: [
      N("Starting the dev server and taking a screenshot."),
      S("t4s1", "Bash", { command: "pnpm dev --port 5173 &" }, { ms: 3000, exit: 0, output: "  VITE v6.3.1  ready in 812 ms\n  ➜  Local:   http://localhost:5173/" }),
      S("t4s2", "Browser", { action: "screenshot", url: "http://localhost:5173/#/new" }, { ms: 2600 }),
      S("t4s3", "Bash", { command: "pnpm print:pdf --theme both --out new-session-sheet.pdf" }, { ms: 9000, exit: 0, output: "wrote new-session-sheet.pdf (184 KB)" }),
      B("image", { id: "i1", name: "new-session-sheet.png", w: 1280, h: 800 }),
      B("file", { id: "f1", name: "new-session-sheet.pdf", size: "184 KB" }),
      B("item", { id: "k1", num: 302, kind: "question", title: "Which design session first?", status: "Needs you" }),
    ],
    answer: [
      "Here is the sheet as it renders now, plus a PDF with both themes. I also filed #302 so we can decide which design session to run first.",
    ],
  };

  const PEER = { id: "pm1", time: "10:27", from: "test-triage", kind: "codex", body: "3 flaky tests on main are quarantined; the other 7 fail for real. Details in #298." };

  const T5 = {
    id: "t5", time: "10:31",
    user: "The tests on main are failing. Can you look?",
    durationMs: 38000,
    items: [
      S("t5s1", "Bash", { command: "pnpm vitest run" }, { ms: 19000, status: "failed", exit: 1, output: OUT_TEST_MAIN_FAIL }),
      S("t5s2", "Task", { description: "triage failing tests", agent: "codex" }, { ms: 1200, helper: { name: "test triage", kind: "codex", summary: "Triage the 7 failing tests in src/journal/__tests__: separate real regressions from flakes, and propose a fix for each regression.", status: "Working · 7 tests · started 10:32" } }),
      B("helper", { id: "h1", name: "test triage", kind: "codex" }),
    ],
    endError: "The session couldn’t resume. Send a message to start fresh.",
    answer: [],
  };

  const NOTICES = {
    compacted: "Compacted, context now 3.7k/1m",
    idle: "Session was idle, resuming",
    queued: "Sending 1 queued message",
    restarting: "Restarting with browser tools…",
  };

  const T6 = {
    id: "t6", time: "10:44",
    user: "What’s the practical difference between Opus and Sonnet for this repo?",
    durationMs: 0,
    items: [],
    answer: [
      "For this repo, Opus is better at the long, cross-file changes: the client, the bridge and the journal components move together, and Opus keeps more of that in view at once.",
      "Sonnet is faster and cheaper, and it is plenty for single-file fixes, copy changes and test updates. A reasonable default is Sonnet for quick asks and Opus when a change touches more than one layer.",
    ],
  };

  /* ---------- 210-step stress turn (deterministic) ---------- */
  function make210() {
    const files = [];
    const dirs = ["src/journal", "src/journal/files", "src/journal/tracker", "src/bridge", "src/contracts", "test/unit-tests"];
    for (let i = 0; i < 96; i++) files.push(`${dirs[i % dirs.length]}/module-${String(i + 1).padStart(2, "0")}.ts`);
    const items = [N("I’ll map every caller of the RPC layer before changing anything.")];
    let n = 0;
    const id = () => `x${++n}`;
    for (let i = 0; i < 140; i++) items.push(S(id(), "Read", { path: files[i % 96] }, { ms: 600 }));
    for (let i = 0; i < 30; i++) items.push(S(id(), "Grep", { pattern: ["startSessionRpc", "rpc.call(", "journalRpc", "sendFrame", "hello_ok"][i % 5] }, { ms: 300 }));
    items.push(N("Now moving the calls onto the new client."));
    for (let i = 0; i < 12; i++) items.push(S(id(), "Edit", { path: files[(i * 7) % 96] }, { ms: 1200, added: 6 + (i % 5) * 3, removed: 2 + (i % 3), diff: DIFF_CLIENT }));
    items.push(N("Running everything to be sure."));
    for (let i = 0; i < 8; i++) items.push(S(id(), "Bash", { command: "pnpm vitest run" }, { ms: 20000, exit: i === 1 || i === 4 ? 1 : 0, status: i === 1 || i === 4 ? "failed" : "ok", output: i === 1 || i === 4 ? OUT_TEST_MAIN_FAIL : OUT_TEST_OK }));
    for (let i = 0; i < 6; i++) items.push(S(id(), "Bash", { command: "pnpm tsc --noEmit" }, { ms: 4000, exit: i === 0 ? 2 : 0, status: i === 0 ? "failed" : "ok", output: i === 0 ? OUT_TSC_FAIL : OUT_TSC_OK }));
    for (let i = 0; i < 6; i++) items.push(S(id(), "Bash", { command: ["pnpm build", "pnpm format", "node scripts/gen-contracts.mjs", "pnpm build", "ls dist", "du -sh dist"][i] }, { ms: 5000, exit: 0, output: "done" }));
    for (let i = 0; i < 6; i++) items.push(S(id(), "Bash", { command: ["git status", "git diff --stat", "git log --oneline -3", "git add -A", "git commit -m 'rpc: move callers to JournalClient'", "git push"][i] }, { ms: 300, exit: 0, output: "ok" }));
    for (let i = 0; i < 2; i++) items.push(S(id(), "Task", { description: ["review the RPC migration", "update the contract docs"][i] }, { ms: 60000, helper: { name: ["rpc review", "contract docs"][i], kind: "claude", summary: "Review the migration diff for missed callers.", status: "Finished · 4m" } }));
    return { id: "t210", time: "11:02", user: "Move every caller onto the new JournalClient and delete the old RPC helpers.", durationMs: 2890000, items, answer: ["Done. All 38 callers now go through <code>JournalClient</code>, the old helpers are deleted, and the full suite passes. Two helpers reviewed the migration and updated the contract docs."] };
  }

  M.fixtures = { T1, T2, T3, T4, T5, T6, PEER, NOTICES, T210: make210() };

  /* ---------- the grouping algorithm ---------- */
  const cmd = (s) => (s.tool === "Bash" ? String(s.input.command || "").trim() : "");
  const base = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "file";
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };

  /* Activity classes, first match wins. `test` receives the step. */
  const CLASSES = [
    { key: "look", icon: "file", test: (s) => ["Read", "NotebookRead"].includes(s.tool) || /^(cat|head|tail|sed -n|less|wc)\b/.test(cmd(s)) },
    { key: "search", icon: "search", test: (s) => ["Grep", "Glob", "Search"].includes(s.tool) || /^(rg|grep|find|fd|ls)\b/.test(cmd(s)) },
    { key: "change", icon: "pencil", test: (s) => ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(s.tool) },
    { key: "test", icon: "flask", test: (s) => /\b(vitest|jest|pytest|playwright|go test|cargo test|(pnpm|npm|yarn) (run )?test)\b/.test(cmd(s)) },
    { key: "check", icon: "shield", test: (s) => /\b(tsc|typecheck|eslint|oxlint|mypy|ruff|lint)\b/.test(cmd(s)) },
    { key: "history", icon: "history", test: (s) => /^git (log|show|blame|diff|status)\b/.test(cmd(s)) },
    { key: "git", icon: "branch", test: (s) => /^git (push|commit|switch|checkout|merge|rebase|pull|add)\b/.test(cmd(s)) },
    { key: "helper", icon: "helper", test: (s) => ["Task", "Agent"].includes(s.tool) },
    { key: "web", icon: "globe", test: (s) => ["WebFetch", "WebSearch", "Browser"].includes(s.tool) },
    { key: "run", icon: "terminal", test: (s) => s.tool === "Bash" },
    { key: "other", icon: "dot", test: () => true },
  ];
  M.CLASSES = CLASSES;
  const classify = (s) => CLASSES.find((c) => c.test(s));

  /* Step sentence (past tense) and live line (present progressive). Client templates. */
  function stepSentence(s) {
    const c = classify(s).key, i = s.input || {};
    if (s.tool === "Read") return `Read ${base(i.path)}`;
    if (s.tool === "Grep") return `Searched for ${i.pattern}`;
    if (s.tool === "Glob") return `Looked for files named ${i.pattern}`;
    if (s.tool === "Write") return `Created ${base(i.path)}`;
    if (c === "change") return `Changed ${base(i.path)}`;
    if (c === "test") return "Ran the tests";
    if (c === "check") return /lint/.test(cmd(s)) ? "Checked the code style" : "Checked the types";
    if (c === "history") return /log/.test(cmd(s)) ? "Checked the history" : "Looked at what changed";
    if (c === "git") return /push/.test(cmd(s)) ? "Pushed the branch" : /commit/.test(cmd(s)) ? "Saved a commit" : "Updated the branch";
    if (c === "helper") return `Asked a helper to ${i.description}`;
    if (s.tool === "Browser") return `Took a screenshot of ${host(i.url)}`;
    if (c === "web") return `Opened ${host(i.url)}`;
    if (c === "run") return "Ran a command";
    return "Did a step";
  }
  function liveLine(s) {
    const c = classify(s).key, i = s.input || {};
    if (s.tool === "Read") return `Reading ${base(i.path)}…`;
    if (s.tool === "Grep") return `Searching for ${i.pattern}…`;
    if (s.tool === "Glob") return "Looking for files…";
    if (c === "search") return "Searching the code…";
    if (c === "change") return `Changing ${base(i.path)}…`;
    if (c === "test") return "Running the tests…";
    if (c === "check") return "Checking the types…";
    if (c === "history") return "Checking the history…";
    if (c === "git") return "Updating the branch…";
    if (c === "helper") return `Asking a helper to ${i.description}…`;
    if (c === "web") return "Looking at a web page…";
    return "Working…";
  }
  M.stepSentence = stepSentence;
  M.liveLine = liveLine;

  const plural = (n, one, many) => (n === 1 ? one : many);
  function outcome(steps) {
    const failed = steps.filter((s) => s.status === "failed").length;
    const last = steps[steps.length - 1];
    if (last.status === "running") return { status: "running", text: "" };
    if (!failed) return { status: "ok", text: "passed" };
    if (last.status === "ok") return { status: "recovered", text: failed === 1 ? "failed once, then passed" : `failed ${failed}×, then passed` };
    return { status: "failed", text: "failed" };
  }
  function groupSentence(key, steps) {
    const k = steps.length;
    const paths = [...new Set(steps.map((s) => s.input.path).filter(Boolean))];
    switch (key) {
      case "look": return paths.length === 1 ? `Read ${base(paths[0])}` : `Looked through ${paths.length} files`;
      case "search": return k === 1 ? "Searched the code" : `Searched the code ${k}×`;
      case "change": return `Changed ${paths.length} ${plural(paths.length, "file", "files")}`;
      case "test": return "Ran the tests";
      case "check": return "Checked the types";
      case "history": return k === 1 ? "Checked the history" : `Checked the history ${k}×`;
      case "git": return k === 1 ? stepSentence(steps[0]) : `Updated the branch ${k}×`;
      case "helper": return k === 1 ? `Asked a helper: ${steps[0].input.description}` : `Asked ${k} helpers`;
      case "web": return k === 1 ? stepSentence(steps[0]) : `Looked at ${k} web pages`;
      case "run": return k === 1 ? "Ran a command" : `Ran ${k} commands`;
      default: return `Did ${k} other ${plural(k, "step", "steps")}`;
    }
  }

  /* groupTurn(items) → sequence of { type:'narration', text } | { type:'group', … }.
     Rules: narration closes a segment; inside a segment steps merge by activity class,
     groups ordered by first occurrence; break-throughs are NOT part of the card. */
  M.groupTurn = function groupTurn(items, running) {
    const seq = [];
    let seg = null;
    const flush = () => { if (seg) { seq.push(...seg.order.map((k) => seg.map[k])); seg = null; } };
    const all = running ? [...items, running] : items;
    all.forEach((it) => {
      if (it.kind === "narration") { flush(); seq.push({ type: "narration", text: it.text }); return; }
      if (it.kind !== "step") return;
      const c = classify(it);
      if (!seg) seg = { map: {}, order: [] };
      if (!seg.map[c.key]) { seg.map[c.key] = { type: "group", key: c.key, icon: c.icon, steps: [], id: `${c.key}-${seq.length}-${seg.order.length}` }; seg.order.push(c.key); }
      seg.map[c.key].steps.push(it);
    });
    flush();
    seq.forEach((g) => {
      if (g.type !== "group") return;
      const o = outcome(g.steps);
      g.status = o.status;
      g.sentence = groupSentence(g.key, g.steps);
      g.outcomeText = ["test", "check"].includes(g.key) && o.status !== "running" ? o.text : o.status === "recovered" ? "one step failed, then worked" : o.status === "failed" ? "failed" : "";
      if (o.status === "running") g.sentence = liveLine(g.steps[g.steps.length - 1]).replace(/…$/, "");
    });
    return seq;
  };

  M.stepsOf = (items) => items.filter((i) => i.kind === "step");
  M.changedFiles = (items) => {
    const map = new Map();
    M.stepsOf(items).filter((s) => classify(s).key === "change").forEach((s) => {
      const f = map.get(s.input.path) || { path: s.input.path, name: base(s.input.path), added: 0, removed: 0, stepId: s.id };
      f.added += s.added || 0; f.removed += s.removed || 0; f.stepId = s.id; map.set(s.input.path, f);
    });
    return [...map.values()];
  };
  M.turnIssues = (items) => M.stepsOf(items).some((s) => s.status === "failed");
  M.fmtDur = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  };
  M.base = base;
  M.classify = classify;
  M.cmd = cmd;
})(typeof window !== "undefined" ? window : globalThis);
