---
title: "Markdown rendering for message bodies — matron-web journal client"
date: 2026-07-22
repo: easelyte/matron-web
spec: docs/superpowers/specs/2026-07-22-web-markdown-rendering-design.md
loops: [479]
status: draft
risk: normal
branch: feat/markdown-rendering
worktree: /opt/matron/web-journal-wt-markdown
---

# Plan — Markdown rendering for message bodies (matron-web)

Implements `docs/superpowers/specs/2026-07-22-web-markdown-rendering-design.md` (spec converged at
spec-review round 3). Client-only feature for the Matron **journal** web client: render message bodies as
proper CommonMark+GFM with fenced-code syntax highlighting and a per-code-block copy button, XSS-safe by
construction, staying on the plain-PostCSS/webpack/Compound-token stack (no CSS-in-JS, no antd; Dan-upstream
aligned).

**Working dir:** all paths relative to `/opt/matron/web-journal-wt-markdown` (worktree of
`easelyte/matron-web`, branch `feat/markdown-rendering`). Drive tooling with
`--workdir /opt/matron/web-journal-wt-markdown`; never `cd` a son-of-anton session into it.

**Commands:** `pnpm install` · `pnpm lint` (= `tsc --noEmit` + prettier check) · `pnpm test` (jest
`--runInBand`) · `corepack pnpm build`. Node ≥22.18, pnpm 10.29.3.

## Principles pass (applied at write-time)

- **P3 Fail Visible** — T-2.3 error boundary + prod `console.error(label)` + distinguishable `mj_MarkdownRaw`
  fallback node. Not a try/catch (can't catch React descendant errors).
- **P19 Check-Act** — T-2.3 copy label gated on `copyText`'s boolean (`true`→"Copied", `false`→"Copy failed").
- **P20 Sanitize-for-the-sink** — T-2.2 no `rehype-raw`, keep `defaultUrlTransform`, `img`→link (no auto-fetch).
- **P38 / V3 shared-module** — T-1.2 `copyText`→`clipboard.ts` breaks the `components↔markdown` cycle; T-3.1/T-3.2
  scope markdown CSS to `.mj_Markdown` (not the shared `.markdown-body` ancestor).
- **R702 tested-before-deploy** — T-2.1 makes the new suite actually run (`.ts` file + `transformIgnorePatterns: []`).
- **P17 exact-pin — deliberate exception** (documented in spec §Risks): caret ranges match Dan's
  `package.json` convention + `pnpm-lock.yaml` pins transitively. Not re-litigated here.
- **R102 destructive-command — deliberate exception** (spec §Rollout): deploy is an operator-run manual
  runbook using non-destructive renames (both prior + failed trees retained); not an agent-executed command.

## Dependency graph

```
Phase 1 (foundation) ──► Phase 2 (renderer) ──► Phase 3 (wiring + CSS + integration) ──► Phase 4 (verify + deploy)
 T-1.1 deps                T-2.1 jest ESM         T-3.1 wire 3 sites (needs T-2.2)          T-4.1 full verify
 T-1.2 clipboard.ts        T-2.2 markdown.tsx     T-3.2 CSS (indep; needs T-2.2 classes)    T-4.2 deploy + smoke
   (needs T-1.1 none)        (needs T-1.1,T-2.1)  T-3.3 3-site integration test (T-3.1)
```
**Serialize within a phase (same workdir).** T-1.1 (`pnpm install`) mutates `node_modules`/lockfile; T-1.2's
acceptance runs `pnpm lint`/`pnpm test` against that tree — so **T-1.1 fully completes before T-1.2's checks**
(round-3: don't run them concurrently in the shared workdir). execute-slim runs one implementer per task
sequentially, so this is the natural order; the graph shows logical dependency, not a parallelism license.
T-3.1/T-3.2 both follow T-2.2 (T-3.2 needs T-2.2's class names); Phase 4 after all of Phase 3.

## Spec-coverage map

| Spec section | Task(s) |
|---|---|
| §Dependencies (4 deps, caret, CURATED langs, unknown-fence contract) | T-1.1, T-2.2 |
| §MarkdownBody (signature, plugins, overrides, streaming, memo, size guard) | T-2.2 |
| §MarkdownBody Fail-visible (Error Boundary + reset + observability) | T-2.3 |
| §CodeBlock (copy gated, label truncated, hast-node extraction) | T-2.3 |
| §Shared clipboard module | T-1.2 |
| §Wiring the three sites | T-3.1 |
| §CSS (.mj_Markdown scoped, .mj_CodeBlock, hljs theme, mj_MarkdownRaw) | T-3.2 |
| §Security (all 5 mitigations) | T-2.2 (impl) + T-2.3 tests |
| §Testing (jest ESM, full matrix, three-site integration) | T-2.1, T-2.3, T-3.3 |
| §Rollout (staging swap, verify-gate, rollback) | T-4.2 |
| §Risks (bundle size note, streaming bound, CSS regression) | T-2.2 (impl), T-4.1 (size note), T-4.2 (smoke) |

---

## Phase 1 — Foundation: dependencies + shared clipboard module

Pure-plumbing phase, no user-visible behavior change. Establishes the deps and breaks the future import
cycle before the renderer lands.

### T-1.1: Add markdown dependencies

> **R300 (external-entity evidence) — satisfied by operator mandate + empirical verification.** Loop #479
> explicitly directs these libraries ("react-markdown + rehype-highlight or shiki + DOMPurify") — an operator
> waiver by definition. They are also the ubiquitous, canonical React markdown stack, and were **installed and
> run live** during spec-review (rendered highlighted HTML; see the Verified Claims appendix) — evidence
> stronger than a documentation search. `highlight.js` is added transitively-made-direct per the round-1
> pnpm-linking blocker. No unattested external-entity recommendation is being introduced.


- [ ] In `package.json` `dependencies`, add: `react-markdown` `^9`, `remark-gfm` `^4`, `rehype-highlight` `^7`,
  `hast-util-to-string` `^3` (caret, matching repo convention), **and `highlight.js` `~11.11.0`** — a **direct
  dep** is REQUIRED (round-1 blocker): T-2.2 imports individual grammars via `highlight.js/lib/languages/*`,
  and under pnpm's strict (non-hoisted) `node_modules` a transitive-only package (highlight.js is only pulled
  in via `lowlight`←`rehype-highlight`) has no top-level symlink → `Cannot find module`. Pin `~11.11.0` to
  match `lowlight`'s own range so pnpm dedupes to one physical copy.
- [ ] `pnpm install` → updates `pnpm-lock.yaml` (commit the lockfile).
- [ ] Confirm no peer-dep warnings against React 19 (`react-markdown@9` supports React 18/19).

**Acceptance:** `pnpm install` clean; `pnpm-lock.yaml` contains the 5 packages + their transitive ESM tree;
`package.json` diff is exactly the 5 dep lines; `pnpm lint` (tsc) still green (no imports yet); a throwaway
`import ts from "highlight.js/lib/languages/typescript"` resolves (subpath is a first-class `exports` entry).

### T-1.2: Extract `copyText` to `src/journal/clipboard.ts` + repoint all importers

- [ ] Create `src/journal/clipboard.ts`; move `copyText(text: string): Promise<boolean>` **verbatim** from
  `components.tsx` (~L169) — same clipboard-then-`execCommand` fallback, no behavior change. Export it.
- [ ] Delete the `copyText` definition + its `export` from `components.tsx`.
- [ ] Add `import { copyText } from "./clipboard";` to `components.tsx`; confirm both production call sites
  resolve to it: context-menu copy (~L2390) and Event-source debug-sheet copy (~L2827).
- [ ] Relocate the 3 `copyText` unit tests (`copyText awaits clipboard…`, `…falls back to execCommand…`,
  `…returns false when both paths fail`) from `test/unit-tests/journal/components-test.ts` into a new
  `test/unit-tests/journal/clipboard-test.ts` importing `copyText` from `../../../src/journal/clipboard`.
  Remove the `copyText` symbol from `components-test.ts`'s import of `components` (keep `MatronApp` etc.).
- [ ] Do **not** leave a compat re-export in `components.tsx` (single-owner move).

**Acceptance:** `pnpm lint` green (no `tsc` "has no exported member 'copyText'"); `pnpm test` green —
`clipboard-test.ts` runs the 3 relocated tests, `components-test.ts` no longer imports `copyText`; grep
confirms `copyText` is defined only in `clipboard.ts` and imported (not defined) in `components.tsx`.

---

## Phase 2 — Renderer: jest ESM config + `markdown.tsx`

### T-2.1: jest ESM transform

- [ ] **Baseline first (before any config edit):** run `pnpm test` on the current `jest.config.cjs` and
  record its cold-cache wall-time — this is the comparison point for the cost criterion (round-1: without a
  captured baseline the regression check is unfalsifiable).
- [ ] Set `transformIgnorePatterns: []` in `jest.config.cjs` (transform all `node_modules` via existing
  babel-jest — required because react-markdown/remark/rehype/hast are pure ESM).
- [ ] Run `pnpm test` again on a **cold** babel-jest cache; record wall-time. **Cost criterion:** if it
  regresses >~2× vs the captured baseline or exhausts memory, switch to the surgical unified/rehype allowlist
  enumerated in spec §Testing.2 and note the switch in the PR.

**Acceptance:** full existing suite (29 files) passes under the chosen pattern; a throwaway test that
`import`s `react-markdown` no longer throws `SyntaxError: Cannot use import statement outside a module`;
cold-run time within the criterion (documented in commit/PR).

### T-2.2: `src/journal/markdown.tsx` — `MarkdownBody` + overrides (TDD)

Write `test/unit-tests/journal/markdown-test.ts` (jsdom, `React.createElement` — **`.ts` not `.tsx`**, per
`jest.config.cjs` `testMatch: **/*-test.ts`) test-first for each behavior, then implement.

- [ ] `MARKDOWN_MAX = 200_000` constant. Grammars imported individually from `highlight.js/lib/languages/*`
  (`bash, javascript, typescript, python, json, diff, yaml, css, xml, go, rust, sql, markdown` — **no separate
  `jsx.js`/`tsx.js` files exist**, so jsx/tsx map to the js/ts grammar objects). Register them **once under
  their canonical names** via rehype-highlight's `languages` option, and register aliases via its first-class
  **`aliases` option** — `ALIASES = { typescript: ["ts", "tsx"], javascript: ["js", "jsx"], bash: ["sh"],
  yaml: ["yml"], python: ["py"], markdown: ["md"] }`. **One array per canonical key** (round-2: an object with
  the same key twice — e.g. `typescript: ["ts"]` and `typescript: ["tsx"]` — silently keeps only the last,
  dropping `ts`; merge multi-alias grammars into a single array). This is **not** duplicating grammar functions
  under alias keys in `languages` (round-1: duplicate-key registration works but doubles `detect`'s candidate
  subset; `aliases` is idiomatic and resolves the appendix `?` claim). Final config: `{ languages: CURATED,
  aliases: ALIASES, detect: true }` (no `ignoreMissing`).
- [ ] `MarkdownBody({ text, streaming = false, label })`, wrapped in `React.memo` on `(text, streaming, label)`:
  - `remarkPlugins={[remarkGfm]}`; `rehypePlugins` = `[[rehypeHighlight, { languages: CURATED, aliases: ALIASES,
    detect: true }]]` **only when `!streaming`** (omit during streaming — the per-token cost bound). **No
    `ignoreMissing`** (not a real v7 option). `CURATED`/`ALIASES` per the bullet above.
  - Size guard: if `text.length > MARKDOWN_MAX` → render `<div className="mj_MessageText mj_MarkdownRaw">{text}</div>`,
    skip markdown entirely.
  - `components` overrides:
    - `pre` → `<CodeBlock node={node} …>` (block-code seam; v9 has no `code({inline})`).
    - `code` → guard on `className`: contains `language-`/`hljs` ⇒ block, pass through
      `<code className={className}>{children}</code>`; else inline ⇒ `<code className="mj_InlineCode">`.
    - `a` → external (`http`/`https`/`mailto`) get `target="_blank" rel="noopener noreferrer nofollow"`;
      fragment/relative unchanged.
    - `img` → render a plain link `<a href={src} target="_blank" rel="noopener noreferrer nofollow">{alt||src}</a>`,
      never `<img>`.
- [ ] Unit tests (spec §Testing): inline formatting → correct tags; GFM table/task-list/strikethrough;
  fenced ```ts non-streaming → `hljs` + ≥1 `.hljs-*` token span (assert highlighting occurred, NOT a
  `language-typescript` classname); unknown ` ```notalang ` → `class="hljs language-notalang"` with **zero**
  `.hljs-*` spans, no throw; streaming ```ts → no `hljs`/no token spans; size guard → `mj_MarkdownRaw`;
  images → `<a>` not `<img>`; security (`<img onerror>` escaped, `javascript:` href stripped, external `rel`
  hardening); unterminated ```ts prefix streams without throwing.

**Acceptance:** every §Testing unit bullet (excluding copy/boundary in T-2.3 and three-site in T-3.3) passes;
`pnpm lint` green; grep confirms no `dangerouslySetInnerHTML`, no `rehype-raw`, no `ignoreMissing` in the module.

### T-2.3: `CodeBlock` + `MarkdownErrorBoundary` (TDD, in `markdown.tsx`)

- [ ] `CodeBlock` (rendered by the `pre` override):
  - Reads raw source from the hast **`node`** via `toString(node)` from `hast-util-to-string` (lossless;
    NOT walking rendered children — `String(children)` yields `[object Object]`).
  - Renders `<pre className="mj_CodeBlock">` + the highlighted `<code>` child + a language label
    (`.mj_CodeBlock_lang`, top-left, from the fence info string **truncated to ≤16 chars**, hidden when none)
    + a copy button (`.mj_CodeBlock_copy`, top-right, `aria-label="Copy code"`, keyboard-focusable).
  - Copy handler: `await copyText(raw)` (imported from `./clipboard`) → **gate label on result**: `true`
    ⇒ transient "Copied" (~1.5s), `false` ⇒ transient "Copy failed". **Single timeout ref (round-1 race
    fix):** hold the timer in one `useRef`; on each click **clear the existing timeout before scheduling the
    new one**, and clear it in the effect-cleanup on unmount — so a rapid second click can't have the first
    timer prematurely wipe its label, and no callback survives unmount.
- [ ] `MarkdownErrorBoundary` (class component wrapping `MarkdownBody`'s `react-markdown` render, one instance
  per row):
  - `getDerivedStateFromError` + `componentDidCatch`; on catch render
    `<div className="mj_MessageText mj_MarkdownRaw" title="markdown render failed — showing raw text">{text}</div>`.
  - `componentDidCatch` logs `console.error("[markdown] render failed", { label, err })` (production too).
  - **Reset-on-change:** `componentDidUpdate(prevProps)` clears `hasError` when `text` changes (streaming
    self-heal) — or equivalently a `resetKeys=[text]` pattern.
- [ ] Tests: copy-button present per block, click calls `copyText` mock with **exact raw** (newline/indent
  fidelity), `true`→"Copied" / `false`→"Copy failed" both asserted; error boundary catches a thrown override,
  shows `mj_MarkdownRaw`, `console.error` fires with `label`, sibling `MarkdownBody` still renders (isolation);
  boundary reset — re-render same instance with new valid `text` → `hasError` clears and markdown renders.
- [ ] Tests for the round-1/2 hygiene fixes (else they're unfalsifiable — round-2 finding): with `jest.useFakeTimers()`,
  **two clicks within 1.5s** → the first timer does not prematurely wipe the second label (single-ref
  clear-before-schedule); **unmount before expiry** → no timer callback fires post-unmount (cleanup); a fence
  with a **>16-char info string** → label truncated to ≤16 chars; a fence with **no language** → no
  `.mj_CodeBlock_lang` node rendered.

**Acceptance:** all T-2.3 tests green; `pnpm test` full suite green; `pnpm lint` green.

---

## Phase 3 — Wiring, CSS, integration

### T-3.1: Wire the three render sites (`components.tsx`)

- [ ] `EventContent` `case "text"` (~L1860): `return <div className="mj_Markdown"><MarkdownBody text={asString(event.payload.body)} label={String(event.seq)} /></div>;`
- [ ] Pending outgoing (~L2321): `<div className="mj_Markdown"><MarkdownBody text={message.body} label={message.localId} /></div>` — drop the old inline `markdown-body mj_MessageText` classes.
- [ ] Text stream (~L2340): `<div className="mj_Markdown"><MarkdownBody text={text} streaming label={\`stream-${index}\`} /><span className="mj_Cursor" /></div>` — cursor stays a **sibling outside** `MarkdownBody`.
- [ ] `import { MarkdownBody } from "./markdown";`. Leave `prompt_reply` (L1882), `ToolStream`, `DiffCard`,
  `ToolOutput` untouched.

**Acceptance:** `pnpm lint` green; grep confirms all three sites render `MarkdownBody`; `prompt_reply`/tool
renderers unchanged in the diff.

### T-3.2: CSS (`journal.pcss`) — scoped markdown styling + hljs theme

- [ ] Add **no** new rules to `.markdown-body` (shared ancestor — keep neutral).
- [ ] `.mj_Markdown` block rules (Compound-tokenized), all as `.mj_Markdown <el>` descendant selectors:
  `p`, `ul/ol/li`, `h1–h6` (→ `--cpd-font-*`), `blockquote`, `table/th/td` (bordered, `--cpd-color-*`), `hr`,
  `a` (`--cpd-color-text-link`/action-accent), task-list checkboxes; `white-space: normal`;
  `overflow-wrap: anywhere`.
- [ ] `.mj_InlineCode` (Fira Code, subtle bg). `.mj_MarkdownRaw` keeps `white-space: pre-wrap` (raw fallback).
- [ ] `.mj_CodeBlock` (`position: relative`, `--cpd-color-bg-subtle-secondary`, `--cpd-space-*` padding,
  `border-radius`, `overflow-x: auto`, Fira Code — reuse `.mj_LiveTool pre` conventions ~L1031-L1043).
- [ ] `.mj_CodeBlock_copy` / `.mj_CodeBlock_lang` — absolute-positioned chips, reveal on
  `:hover`/`:focus-within`, always-on under `@media (hover: none)`.
- [ ] `.hljs` token theme in Compound vars (`.hljs-keyword/-string/-comment/-number/-title/-attr/-built_in/-literal`
  → `--cpd-color-*`), **light values now**; leave a labeled `[data-theme="dark"]` seam for #480 (do not author
  dark values). Reuse the mobile type-shrink block (~L1412) for `.mj_CodeBlock`.

**Acceptance:** `pnpm build` succeeds (postcss compiles); no new rules under `.markdown-body` in the diff;
markdown block selectors are all `.mj_Markdown`-scoped; hljs colors reference `--cpd-*` (no raw hex except
where a token genuinely lacks one).

### T-3.3: Three-site integration test

- [ ] Assert each caller routes through `MarkdownBody`, **using exported seams only** (round-3: `EventRow` and
  `Timeline` are private at HEAD — do not add export seams unilaterally, per Dan-alignment):
  - text path: render the **exported `EventContent`** with a `text` event → a `**bold**` body yields
    `<strong>` inside `.mj_Markdown`; a `prompt_reply` event renders **plain** (no `<strong>`) — guards against
    over-applying markdown.
  - pending + stream paths: use the **`MatronApp` harness** (already the fixture pattern in
    `components-test.ts`) with a minimal client-state containing a pending message and a text stream → each
    yields a markdown-rendered `<strong>`, and the stream keeps `<span class="mj_Cursor">` as a **sibling of
    `MarkdownBody` inside the `.mj_Markdown` div** (outside the react-markdown subtree, exactly as T-3.1
    renders it). If the `MatronApp` fixture proves impractical for the stream case, cover the stream wiring by
    asserting the L2340 render shape in a focused DOM test — do not leave it uncovered silently.

**Acceptance:** integration test green; a deliberately-reverted wiring site (spot check) makes the test fail.

---

## Phase 4 — Verify + deploy

### T-4.1: Full verification

- [ ] `pnpm lint` (tsc + prettier) green; `pnpm test` (all suites incl. new markdown/clipboard) green.
- [ ] **Capture the baseline the delta needs (round-2: no task produced it):** build the **base** tree once in
  a throwaway checkout — `git fetch origin && git worktree add /tmp/mw-base origin/main && (cd /tmp/mw-base &&
  pnpm install && corepack pnpm build) && du -sk /tmp/mw-base/webapp` — record that byte total; then
  `git worktree remove --force /tmp/mw-base` (**`--force` required** — `pnpm install`/`build` leave untracked
  `node_modules/`+`webapp/`, both gitignored, so a plain `worktree remove` refuses; round-3, verified).
- [ ] `corepack pnpm build` on the feature branch; `du -sk webapp` → **delta = feature − base**, recorded in
  the PR (bundle-size risk, spec §Risks), with the highlight.js/lowlight chunk called out (the delta driver).
  If large, note candidate grammars to drop. (This step runs at ship time **after the feature is rebased onto
  current `origin/main`** — spec §Rollout — so `origin/main` is the feature's true parent and the delta is
  attributable to this feature, not an intervening upstream commit. If run pre-rebase, use `git merge-base
  origin/main HEAD` as the base instead — round-3.)

**Acceptance:** lint + full test suite green; build produces a complete `webapp/`; a **reproducible** size delta
(base build vs feature build, same `du -sk webapp` command) is recorded in the PR.

### T-4.2: Deploy to live :8443 + smoke (operator-run) — spec §Rollout

Runs **after `/ship-slim` has merged `feat/markdown-rendering` into fork-main (origin/main)**. The live checkout
`/opt/matron/web-journal` is a **separate** checkout (branch `main`) from this feature worktree, so the merged
code must be pulled into it before building (round-1: no prior task synced the feature into the live checkout —
building it as-is would ship old assets).

- [ ] **Promote merged code into the live checkout (SHA-verified):** first `git -C /opt/matron/web-journal
  status --short` — the **tracked** tree must be clean (only untracked `webapp*`/`memory/` artifacts expected;
  `reset --hard` won't touch untracked files, but abort if any tracked file is dirty — guards a stray direct
  edit). Then `git -C /opt/matron/web-journal fetch origin && git -C /opt/matron/web-journal checkout main &&
  git -C /opt/matron/web-journal reset --hard origin/main`; confirm `git -C /opt/matron/web-journal rev-parse
  HEAD` equals the merged ship-slim commit SHA before building.
- [ ] **Materialize a clean, same-filesystem staging checkout of the merged SHA** (round-3: the staging dir
  must actually be populated + have its own deps before building; keep it same-fs as the live `webapp` so the
  swap is an atomic rename). Use `git archive` (no `.git`, no live `node_modules`, sidesteps the
  worktree-`.git`-file gotcha): `S=/opt/matron/.mw-build-<ts>; mkdir -p "$S"; git -C /opt/matron/web-journal
  archive HEAD | tar -x -C "$S"` → clean tree of the merged commit under `/opt/matron/` (same mount as the
  live checkout).
- [ ] Build in the staging checkout: `cd "$S" && pnpm install && corepack pnpm build` → complete `$S/webapp`.
- [ ] Swap as **one compound guarded command** (round-2/3: encode the restore inline, not as prose, so an
  interruption can't strand an absent `webapp`): `cd /opt/matron/web-journal && mv webapp webapp.prev.<ts> &&
  { mv "$S/webapp" webapp || { mv webapp.prev.<ts> webapp; echo "swap failed, restored prior"; exit 1; }; }`.
  Both are same-fs renames = sub-ms; the `||` restore covers a second-rename failure.
- [ ] **Verify (gates the deploy):** HTTP 200 on `/`, hashed JS/CSS bundle loads, and the manual behavioral
  smoke — send a Claude Code reply with headings/table/task-list/fenced-diff → render + per-block copy + link
  behavior correct; watch a streaming reply finalize (unhighlighted→highlighted); a plain non-markdown message
  unaffected. **If any check fails → rollback** (`mv webapp webapp.failed.<ts> && mv webapp.prev.<ts> webapp`).
- [ ] Housekeeping (operator discretion, after confirmed-good): `rm -rf "$S"` (the staging tree); remove the
  specific timestamped backups `webapp.prev.<ts>` / `webapp.failed.<ts>` by exact name (not a wildcard sweep).

> **On R102 (re-flagged in spec + plan review):** T-4.2 is an **operator-run manual runbook** on a separate
> static-site checkout, not an agent-executed command. The deploy/rollback are non-destructive renames (prior
> and failed trees retained under timestamped names); backup removal is discretionary operator housekeeping by
> exact name. The one genuinely-destructive step (`reset --hard origin/main`) is **guarded by the preceding
> `git status --short` clean-tree abort** — it cannot clobber tracked local state (and the deploy checkout has
> no local edits by convention). R102 governs agent-executed destructive commands in the son-of-anton
> workspace; it does not gate a human `mv`/guarded-`reset` in an ops runbook. Documented accepted override
> (spec §Rollout).

**Acceptance:** live :8443 serves the merged-SHA build and renders markdown correctly with working copy buttons
+ safe links; streaming works; no regression on plain messages / tool cards / diffs; rollback path verified
available (retained timestamped trees).

---

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

## Appendix: Verified Claims (research pass 2026-07-22)

Tavily/WebSearch batch was unavailable this session (no `TAVILY_API_KEY`). The load-bearing library claims
were instead **empirically verified during spec-review** — a reviewer subagent installed the exact packages
(`react-markdown@9.1.0`, `remark-gfm@4`, `rehype-highlight@7.0.2`, `hast-util-to-string@3`) and executed them
under this repo's real babel/jest config. Empirical execution is stronger evidence than documentation search;
these are treated as verified:

✓ **react-markdown@9 builds a React element tree, no `dangerouslySetInnerHTML`; passes the hast `node` to
  component overrides unconditionally** (`passNode` hardcoded). Verified: `props.node.type === "element"`
  observed at runtime.
✓ **`react-markdown@9` `defaultUrlTransform` is a strict allowlist** `/^(https?|ircs?|mailto|xmpp)$/i` —
  `javascript:`, `vbscript:`, and ALL `data:` schemes are emptied. Verified against `react-markdown@9.1.0`
  source + runtime (`![](data:image/png;…)` → `src=""`).
✓ **`rehype-highlight@7` has NO `ignoreMissing` option**; real `Options` = `{aliases, detect, languages,
  plainText, prefix, subset}`. An unknown-language fence keeps `class="hljs language-x"` with zero `.hljs-*`
  token spans and does not throw. Verified against `rehype-highlight@7.0.2` source + live render of a
  ` ```notalang ` fence.
✓ **`hast-util-to-string@3` exports the named `toString`**; `toString(node)` on a post-highlight hast code
  node losslessly reconstructs the original source (spans add/remove no characters). Verified via `.d.ts` +
  live render — backs the copy-button fidelity claim.
✓ **`transformIgnorePatterns: []` transforms all `node_modules` (not "none") and works end-to-end** with this
  repo's `babel.config.cjs`/`jest.config.cjs`. Verified: deps installed, a test `require`d them and rendered
  highlighted HTML.
✓ **`rehype-highlight@7` `languages` accepts a curated subset; aliases register via the `aliases` option;
  `detect: true` detects among the registered set.** Verified in plan-review round 1 (traced
  `rehype-highlight@7` → `lowlight` `register()`/`registerAlias()`): registering grammars once under canonical
  name via `languages` + declaring aliases via the first-class `aliases` option is the idiomatic path (T-2.2
  uses it). Confirmed no separate `jsx.js`/`tsx.js` grammar files — jsx/tsx alias the js/ts grammar objects.
  T-2.2 tests assert highlighting-occurred behaviorally rather than a specific class name.
