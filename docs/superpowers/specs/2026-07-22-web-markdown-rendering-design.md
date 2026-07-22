---
title: "Markdown rendering for message bodies (react-markdown + remark-gfm + rehype-highlight, fenced-code highlight + per-block copy)"
date: 2026-07-22
repo: easelyte/matron-web
loops: [479]
status: draft
approach: "A — react-markdown + remark-gfm + rehype-highlight (curated languages), shared <MarkdownBody> component, per-code-block copy, NO rehype-raw (XSS-safe by construction), Compound-tokenized hljs theme"
rejected_alternatives:
  - "B (slim/literal-mandate): marked + DOMPurify + dangerouslySetInnerHTML + marked-highlight — reintroduces dangerouslySetInnerHTML (React anti-pattern), moves the whole XSS surface into DOMPurify config correctness. Rejected: trades safety-by-construction for config-dependent safety on agent output."
  - "C (shiki): approach A but shiki for VS-Code-accurate highlighting — large JS/WASM engine + async highlight → flicker on every streaming token, for a purely cosmetic gain in a chat that re-renders constantly. Deferred."
related_principles:
  - "P3 Fail Visible — markdown parse must never blank a message; render raw text on failure via an Error Boundary (not try/catch), console.error in prod + distinguishable fallback node."
  - "P19 Checks gate the resulting action — the copy 'Copied' label is gated on copyText's boolean; false → 'Copy failed'."
  - "P20 Sanitize-for-the-sink — the DOM is the sink; react-markdown-no-raw + URL transform + no-auto-img is the escaping discipline for it."
  - "P38 body/impl/acceptance one contract; V3 shared-module — markdown block CSS scoped to a dedicated .mj_Markdown wrapper (not the shared .markdown-body ancestor); copyText moved to shared clipboard.ts to break the components↔markdown cycle."
  - "R702 tested-before-deploy — the suite is a .ts file (matches jest testMatch) with transformIgnorePatterns:[] so it actually runs; R102 — rollback is move-aside, not rm -rf."
unresolved_questions: []
mandate_deviation:
  - "Loop #479 lists '+ DOMPurify'. On the react-markdown-no-raw path DOMPurify is dead plumbing (no HTML string to sanitize). Dropped per right-size-effort; the 'MUST sanitize' requirement is met by construction (see §Security). DOMPurify would only earn its place alongside rehype-raw, which we deliberately omit."
  - "Markdown images (![](...)) render as a plain text link, NOT an auto-loading <img> — untrusted-content decision (no uncontrolled outbound fetch); legit images use the existing authenticated blob_ref path. Operator-vetoable; constrained-<img> fallback documented in §Design."
---

# Markdown rendering for message bodies — matron-web journal client

Loop **#479**. Message bodies in the Matron **journal** web client (`easelyte/matron-web`, deployed at
`/opt/matron/web-journal`, nginx :8082 → Tailscale :8443) render as **raw text** — `**bold**`, fenced
code, links, and lists all show literal source. Matron drives Claude Code, so bodies are saturated with
markdown, code, and diffs; the raw-text rendering makes them near-unreadable. This spec adds a proper
markdown renderer with fenced-code syntax highlighting and a per-code-block copy button.

Client-only. No journal-server or bridge changes. Standalone-shippable; **not** gated on the #480
redesign (dark theme / type scale). Keeps the plain-PostCSS / webpack / Compound-token stack — no
CSS-in-JS, no antd (per `project_matron_web_stays_dan_upstream_aligned`,
`reference_matron_web_styling_foundation`).

## Background / current state (verified against code at `feat/markdown-rendering`, origin/main `1378e95`)

The client has **no markdown parser anywhere** — bodies are dropped into JSX as bare strings:

| Site | `components.tsx` | What it renders | This spec |
|---|---|---|---|
| `EventContent` `case "text"` | L1860 `<div className="mj_MessageText">{asString(event.payload.body)}</div>` | persisted agent + user text events | **markdown** |
| Pending outgoing message | L2321 `<div className="markdown-body mj_MessageText">{message.body}</div>` | operator's just-sent message (optimistic) | **markdown** |
| Text streams (live) | L2340 `<div className="markdown-body mj_MessageText">{text}<span className="mj_Cursor" /></div>` | streaming agent tokens, trailing cursor | **markdown** (cursor preserved) |
| `EventContent` `case "prompt_reply"` | L1882 short choice/label ("Answered") | prompt answer label | plain (unchanged) |
| `ToolStream` / `ToolOutput` / `DiffCard` | L1998 / L1886 / L1888 | already-structured `<pre>` / diff / card renderers | unchanged |

- **`.markdown-body`** (the wrapper `<div>` at L1976 around `EventContent`, and inline at L2321/L2340) is a
  **classname with no matching CSS rule today** — the class name is aspirational, styling comes from
  `.mj_MessageText` (`journal.pcss` L619): `min-width:0; white-space: pre-wrap; overflow-wrap: anywhere`.
  `pre-wrap` is what currently preserves the agent's literal newlines. **This is the load-bearing CSS
  migration** — see §CSS.
- **Stack:** React 19, webpack 5 + babel-loader, plain PostCSS over Element **Compound design tokens**
  (`--cpd-color-*`, `--cpd-space-*`, `--cpd-font-*`; `shell.pcss :root`). `@fontsource/fira-code` already
  bundled and used for `<code>`/`<pre>` (`journal.pcss` L1019/L1043). Webpack CSS rule
  (`webpack.config.mjs` L72) matches **both `.css` and `.pcss`** through css-loader → postcss, so a
  vendored highlight CSS *could* be imported — but we write our own tokenized theme instead (§CSS).
- **`asString(value, fallback="")`** — `types.ts` L283, safe string coercion; reused.
- **`copyText(text): Promise<boolean>`** — `components.tsx` ~L169, `navigator.clipboard.writeText` with an
  `execCommand("copy")` fallback. **Reused verbatim** for the per-code-block copy button.
- **Whole-message copy already exists** (context menu, L2390 `copyText(asString(...payload.body))`) — the
  new copy button is **per fenced-code-block**, complementary, not a duplicate.
- **Tests:** jest, one file per module under `test/unit-tests/journal/` (`components-test.ts`, …).

## Goals / non-goals

**Goals**
- Render CommonMark **+ GFM** (remark-gfm): bold, italic, inline code, links, ordered/unordered lists,
  **headings, tables, blockquotes, task lists, strikethrough, autolinks**, horizontal rules, and
  **fenced code blocks with syntax highlighting** — the full set Claude Code emits.
- A **copy button per fenced code block** (top-right, hover/focus reveal, "Copied" affordance).
- **XSS-safe by construction** for agent-authored bodies (§Security).
- One shared **`<MarkdownBody>`** React component behind all three render sites (DRY; avoids the
  monolith-growth trap of duplicating the renderer three times).
- Live-stream safe: incremental/incomplete markdown renders every token without throwing; trailing
  typing cursor preserved.
- Stay Dan-upstream-aligned: additive component + CSS, no file splits (#448 stays deferred), upstream-PR
  candidate.

**Non-goals**
- Dark theme / type scale / spacing overhaul — that's **#480**. We ship a **light-only** hljs theme now,
  authored with Compound tokens so #480 flips it dark for free.
- Rendering raw/inline HTML embedded in messages (rehype-raw). Deliberately omitted (§Security).
- Math (KaTeX), mermaid diagrams, footnotes, custom directives. Out of scope; revisit if requested.
- Changing `ToolStream` / `DiffCard` / `ToolOutput` — already structured renderers.

## Design

### Dependencies (webpack-bundled, no CDN, no CSS-in-JS)

Add to `dependencies`:
- `react-markdown` (^9) — React-element-tree markdown renderer, no `dangerouslySetInnerHTML`.
- `remark-gfm` (^4) — tables, task lists, strikethrough, autolinks.
- `rehype-highlight` (^7) — synchronous highlight via `lowlight`/`highlight.js`.
- `hast-util-to-string` (^3) — lossless raw-text extraction from a hast node (for the copy button; §CodeBlock).

**Version ranges:** caret ranges match matron-web's existing convention (every current dep in
`package.json` uses `^`) and Dan-upstream alignment; `pnpm-lock.yaml` pins the full transitive graph exactly,
so build reproducibility (the goal of exact-pin) is already guaranteed by the lockfile. The jest ESM handling
below uses `transformIgnorePatterns: []` (transform-all), which is **independent of the exact transitive
package set** — so a permitted patch bump cannot silently break the test transform (removes the caret/ESM
coupling entirely).

**Curated language registration** to keep the bundle lean (default `common` ≈ 37 langs; full ≈ 190). Import
only the grammars Claude Code emits and pass them to `rehype-highlight` via its `languages` option (map keyed
by canonical name AND common aliases so `ts`/`js`/`sh`/`yml` fences highlight):
`bash/sh, javascript/js, typescript/ts, jsx/tsx, python/py, json, diff, yaml/yml, css, xml (html), go, rust,
sql, markdown/md`.

**Unknown/unregistered fences (verified against `rehype-highlight@7` source — round-2 finding):** the plugin
has **no `ignoreMissing` option**; its real `Options` are `{aliases, detect, languages, plainText, prefix,
subset}`. An unregistered language (e.g. ` ```notalang `) is **not** relabeled to `plaintext` — the plugin
unshifts the `hljs` class onto the node **before** its internal `try/catch`, and on a missing grammar the
catch returns without removing it — so the `<code>` element ends up `class="hljs language-notalang"` with
**zero `.hljs-*` token `<span>`s** (verified empirically against `rehype-highlight@7.0.2`). No throw, no
`plaintext` rewrite. That is the acceptable P3 behavior (readable, no crash).

**Implementation revision (execute-slim Phase-2 security fix — `detect` DROPPED):** the spec originally
specified `{ languages: CURATED, detect: true }`. During execution the Phase-2 Codex review measured
`highlightAuto("a".repeat(20_000))` at **6.9s** of synchronous main-thread work — a real client-side DoS,
because `detect: true` runs highlight.js auto-detection across all grammars on **untrusted** untyped fences,
and a single global size cap cannot both permit labeled highlighting of large blocks *and* bound autodetect
(rehype-highlight's `detect` is a per-render option, not per-block). **Resolution: `detect` is removed**
(final config `{ languages: CURATED, aliases: ALIASES }`). Consequence: a **labeled** fence (```ts, ```bash,
…) still highlights via its explicit language class; an **untyped** ``` ``` ``` fence renders as
unhighlighted `<code>` (no auto-detection). This is a negligible feature loss for this client — Claude Code
emits labeled fences almost universally — bought against a real P8 DoS on untrusted agent output. The
unknown-language-fence behavior above is unchanged (still `class="hljs language-x"`, zero token spans, no
throw). **Test the *absence of token spans*, not the absence of the `hljs` class** — see §Testing.

No `rehype-raw`, no `DOMPurify` (§Security, §mandate_deviation).

### `<MarkdownBody>` component (new module `src/journal/markdown.tsx`)

Signature: `MarkdownBody({ text, streaming = false, label })` — `label` is a **best-effort per-row
diagnostic label** (`string`) used **only** in the error-boundary's failure log (§Fail-visible); it never
renders and is not a correctness-bearing identity. Persisted/pending rows use genuinely stable ids
(`event.seq` / `message.localId`); the streaming site uses `stream-${index}` — index-based, matching the
existing text-stream keying at `components.tsx` L2328 (this spec does not restructure Dan's index-keyed
streams). Because `label` only labels a diagnostic log line, index-instability across concurrent streams is
tolerable; the state-bleed concern Codex raised (a survivor stream inheriting a removed stream's tripped
boundary) is separately handled by the boundary's **reset-on-`text`-change** (§Fail-visible), which clears
`hasError` as soon as the surviving stream's differing `text` renders. Copy state is local per `CodeBlock`.

- Wraps `react-markdown` with `remarkPlugins={[remarkGfm]}` and, **only when not streaming**,
  `rehypePlugins={[[rehypeHighlight, { languages: CURATED, aliases: ALIASES }]]}` (no `detect` — dropped as
  a DoS mitigation, see the Implementation-revision note above; no `ignoreMissing` — not a real option).
  **During streaming, rehype-highlight is omitted** (§Streaming) — the per-token cost bound.
- `components` overrides:
  - `pre` — **react-markdown v9 removed the `inline` prop on `code`**, so block detection lives here: the
    `pre` override renders a **`<CodeBlock>`** (copy button + language label + the highlighted `<code>`
    child rehype-highlight produced). This is the v9-correct seam (block code is the only thing wrapped in
    `pre`); do not rely on a v8-style `code({inline})` signature.
  - `code` — inline styling only, **guarded by className** (this override also fires for the block
    `<code>` that is the `pre` override's child, so it cannot blindly stamp inline styling): if
    `className` contains `language-`/`hljs` it is block code → pass through untouched
    (`<code className={className}>{children}</code>`); otherwise it is inline → `<code
    className="mj_InlineCode">`. The `pre` override reads the fence language + raw text from that block
    `<code>` child to build the `<CodeBlock>`.
  - `a` — external (`http`/`https`/`mailto`) links get `target="_blank" rel="noopener noreferrer nofollow"`;
    in-page fragment (`#…`) and relative links keep default behavior (no forced new tab). URL scheme is
    already sanitized by react-markdown's `defaultUrlTransform`; this hardens link behavior, not
    sanitization.
  - `img` — **markdown images do NOT auto-load** (untrusted-content decision, §Security). The `img`
    override renders a **plain text link** to the image URL (`<a … rel="noopener noreferrer nofollow"
    target="_blank">{alt || url}</a>`), never a bare `<img src>`. Rationale: a bare `<img>` from an
    agent/tool body fires an uncontrolled, unauthenticated outbound request (tracking-pixel / SSRF-adjacent
    leak) and can break bubble layout; legitimate images already flow through the authenticated
    `blob_ref`/`AuthenticatedMedia` path (`components.tsx` L1891/L1899), not markdown. (Operator-vetoable:
    the alternative is an `<img>` with `referrerpolicy="no-referrer" loading="lazy"` + max-width clamp —
    kept as a documented fallback, not the default.)
- **Streaming — markdown structure yes, syntax-highlight no (per-token cost bound, round-2 finding):** when
  `streaming`, the component renders live markdown **without** rehype-highlight, so per-token re-render pays
  only the cheap remark/rehype parse, **not** the expensive lowlight tokenization + `detect` pass on the
  whole accumulated body every keystroke (which `React.memo` cannot help — `text` changes each token). Fenced
  code streams as a plain `<pre>`; on message finalization the persisted `case "text"` render (non-streaming)
  applies full highlighting. Cost: one reflow from unhighlighted→highlighted at finalize — cheaper and safer
  than unbounded main-thread highlight during a long code-saturated stream. The caller keeps the
  `<span className="mj_Cursor" />` *outside* `MarkdownBody` so the cursor never lands inside a code block;
  incomplete fenced blocks render as an unterminated `<pre>` (expected mid-stream). **Hard size guard:** if
  `text` length exceeds a constant `MARKDOWN_MAX = 200_000` chars, `MarkdownBody` skips markdown entirely and
  renders the raw `mj_MarkdownRaw` fallback — bounds pathological inputs regardless of stream/finalize.
  **On cumulative re-parse cost:** stream updates arrive as **coarse bridge chunks** (the bridge appends
  SDK-emitted text deltas, not per-character), so re-parse frequency is bounded by chunk cadence, not
  character count; each re-parse is a highlight-free remark/rehype pass on a `MARKDOWN_MAX`-capped body — the
  same cost profile every LLM chat UI accepts. If profiling ever shows jank on a long stream, a
  time-debounced stream re-render (coalesce updates to ~60fps) is the documented follow-up (§Risks) — not
  built now (right-size: no measured jank on real chunk cadence).
- **Memoization:** `React.memo` on `(text, streaming, label)` so unrelated re-renders (activity ticks, other
  rows) don't re-parse.
- **Fail-visible (P3) — Error Boundary, NOT try/catch:** react-markdown does not throw on malformed
  markdown, but an unexpected error inside `CodeBlock`/`extractText`/an override executes in React's
  reconciler, *not* in `MarkdownBody`'s own call stack — so a `try/catch` around the JSX cannot intercept
  it and the error would unmount an ancestor (potentially the whole event list). `MarkdownBody` therefore
  **wraps its `react-markdown` render in a small class `MarkdownErrorBoundary`**
  (`getDerivedStateFromError` + `componentDidCatch`), placed **per message row** (inside `MarkdownBody`,
  which is itself rendered once per row at each of the three sites → one boundary instance per message) so a
  failure isolates to the one message. **Reset-on-change (round-3 finding):** the streaming site reuses one
  long-lived boundary instance across every token, so without a reset a single transient token-level error
  would wedge that stream in the fallback for the rest of its life. `MarkdownErrorBoundary` therefore
  implements `componentDidUpdate(prevProps)` (or a `key`/`resetKeys` on `text`) that clears `hasError` when
  `text` changes — so a later valid token self-heals the row mid-stream. On catch it renders the raw fallback
  `<div className="mj_MessageText
  mj_MarkdownRaw" title="markdown render failed — showing raw text">{text}</div>`. **Observability (P3):**
  `componentDidCatch` logs `console.error("[markdown] render failed", { label, err })` **in production too**
  (not dev-gated) — `label` is the per-row id prop, so the log names the exact failing row (round-2 gap: the
  old `{text,streaming}` signature had no id to log). The `mj_MarkdownRaw` class + `title` make the degraded
  state visually identifiable in the DOM. No telemetry backend exists in this client, so a durable
  console.error keyed by `label` + a distinguishable fallback node is the proportionate fail-visible signal.

### `<CodeBlock>` (in `markdown.tsx`)

- Renders `<pre className="mj_CodeBlock"><code className="hljs language-x">…highlighted…</code></pre>` plus:
  - a **language label** (top-left, muted, from the fence info string; hidden when none). **Bounded:**
    the raw fence info-string is truncated to ≤16 chars for display (agent-controlled; React escapes it, so
    this is layout-safety not XSS).
  - a **copy button** (top-right) — `copyText(rawCodeString)` returns `Promise<boolean>`. **The label is
    gated on the result (P19):** `true` → transient "Copied" (~1.5s); `false` → transient "Copy failed"
    (both `setTimeout`-cleared on unmount). Never show success when nothing reached the clipboard. Button is
    `aria-label="Copy code"`, keyboard-focusable, reveal on `:hover`/`:focus-within` (always visible on
    touch/coarse pointers via `@media (hover:none)`).
- **Raw code string for the clipboard is read from the hast `node`, not the rendered React children.**
  react-markdown v9 passes the original hast node to component overrides as `props.node`; the `pre`/`code`
  override derives the exact source via `toString(node)` from **`hast-util-to-string`** (a first-class
  member of the `unified`/`rehype` ecosystem, already transitively present under `rehype-highlight`; add it
  as a direct dep to make the contract explicit). This is a single lossless call — it avoids hand-walking
  the highlighted `<span>` tree (which, after rehype-highlight, is nested elements, not a plain string, and
  a naive `String(children)` yields `"[object Object]"`).

### Shared clipboard module (`src/journal/clipboard.ts`) — new

`copyText` currently lives in and is exported by `components.tsx` (~L169). `markdown.tsx`'s `CodeBlock` also
needs it, and `components.tsx` imports `MarkdownBody` from `markdown.tsx` → importing `copyText` the other
way would create a `components → markdown → components` **import cycle** (V3 shared-behavior). Resolution:
**move `copyText` verbatim into a new `src/journal/clipboard.ts`**, export it there, and repoint **every**
importer. Both `components.tsx` and `markdown.tsx` then depend on the shared leaf module — no cycle, single
owner. This is a pure move (no behavior change). **Complete importer inventory (round-2 finding — the move
breaks these if missed):**
- `components.tsx` production call sites: the context-menu copy (~L2390) **and** the Event-source debug-sheet
  copy (~L2827). A single module-level `import { copyText } from "./clipboard"` covers both.
- `components.tsx` **re-export**: `components-test.ts` imports `copyText` **directly from
  `components.tsx`** (`import { copyText, MatronApp } from "../../../src/journal/components"`) and has 3
  dedicated unit tests (`copyText awaits clipboard…`, `…falls back to execCommand…`, `…returns false when
  both paths fail`). The move must not silently break them or `tsc --noEmit`. Resolution: **relocate those 3
  tests into a new `test/unit-tests/journal/clipboard-test.ts`** importing from `clipboard.ts`, and drop them
  from `components-test.ts` (which no longer imports `copyText`). Do **not** leave a compat re-export in
  `components.tsx` — that re-introduces `components` as a `copyText` owner and muddies the single-owner move.

### Wiring the three sites (`components.tsx`)

A dedicated **text-only wrapper class `mj_Markdown`** is introduced so markdown block styling never leaks
onto the shared `.markdown-body` ancestor (see §CSS / round-1 finding). Each site wraps `MarkdownBody` in
`mj_Markdown`:

- L1860 `case "text"`: `<div className="mj_Markdown"><MarkdownBody text={asString(event.payload.body)} label={String(event.seq)} /></div>`
- L2321 pending: `<div className="mj_Markdown"><MarkdownBody text={message.body} label={message.localId} /></div>` (drop the
  now-misleading inline `markdown-body mj_MessageText` classes here).
- L2340 stream: `<div className="mj_Markdown"><MarkdownBody text={text} streaming label={\`stream-${index}\`} /><span className="mj_Cursor" /></div>` (the map already has `index`).

`prompt_reply` (L1882), `ToolStream`, `DiffCard`, `ToolOutput` unchanged.

### CSS (`journal.pcss`) — the load-bearing migration

The class that carried whitespace was `.mj_MessageText` with `white-space: pre-wrap`. Markdown block
elements own their own spacing, so **the markdown container must NOT be `pre-wrap`** or every block gains
spurious blank lines. Plan:

- **Scope all new markdown block rules under `.mj_Markdown`, NOT `.markdown-body`.** `.markdown-body` is the
  shared ancestor `EventRow` wraps around **every** `EventContent` case (`components.tsx` L1976) and
  `ToolStream` carries it directly (L1998) — keying block selectors (`p`, `a`, `table`, headings…) off it
  would restyle `PromptCard`'s `<p>` (L1481), the `AuthenticatedMedia` file link `<a>` (L1613), and
  `DiffCard`/`ToolOutput`, violating the unchanged-renderer non-goal. Add **no new rules to
  `.markdown-body`**; leave it as the neutral positioning wrapper it is today.
- Add a **`.mj_Markdown`** rule (Compound-tokenized) owning block spacing: `p`, `ul/ol`, `li`, headings
  (`h1–h6` → `--cpd-font-*`), `blockquote`, `table/th/td` (bordered, `--cpd-color-*`), `hr`,
  `a` (`--cpd-color-text-link` / action-accent), task-list checkboxes. `white-space: normal`;
  `overflow-wrap: anywhere`. All descendant selectors are `.mj_Markdown <el>` so nothing matches outside a
  markdown site.
- `.mj_MessageText` stays for the **plain** sites (`prompt_reply`, the raw fallback `mj_MarkdownRaw`) —
  keep its `pre-wrap`. It is **no longer** the styling hook for rendered markdown, and the two markdown
  sites that currently spell `markdown-body mj_MessageText` inline (L2321/L2340) drop those classes.
- `.mj_CodeBlock` — `position: relative` (copy button anchor), `--cpd-color-bg-subtle-secondary`
  background, `--cpd-space-*` padding, `border-radius`, `overflow-x: auto`, Fira Code, reuse the existing
  `.mj_LiveTool pre` sizing conventions (`journal.pcss` L1031-L1043).
- `.mj_CodeBlock_copy` / `_lang` — absolute-positioned chips; reveal on `:hover`/`:focus-within`;
  always-on under `@media (hover: none)`.
- **`.hljs` token theme authored with Compound color vars** (not an imported highlight.js theme): map
  `.hljs-keyword`, `-string`, `-comment`, `-number`, `-title`, `-attr`, `-built_in`, `-literal`, etc. to
  `--cpd-color-*` roles so it themes with the app and #480's dark set flips it automatically. Light values
  now; a `[data-theme="dark"]` block is #480's job (leave a labeled seam).
- Reuse the mobile type-shrink block (`journal.pcss` L1412) for `.mj_CodeBlock` alongside the existing
  `pre` selectors.

## Security

**Threat:** message bodies are agent/tool output — untrusted from an XSS standpoint.

**Mitigation — safe by construction, no DOMPurify:**
1. **No raw HTML path.** We do **not** add `rehype-raw`. react-markdown builds a **React element tree**;
   it never calls `dangerouslySetInnerHTML`. Any literal `<script>`/`<img onerror>` in a body is treated
   as markdown text and rendered as **escaped visible text**, not DOM. This is the categorical XSS defense.
2. **URL sanitization.** react-markdown's `defaultUrlTransform` is a **strict allowlist** (verified against
   `react-markdown@9` source — round-2 correction): only `http`, `https`, `irc`, `ircs`, `mailto`, `xmpp`
   schemes survive; **every other scheme — `javascript:`, `vbscript:`, and ALL `data:` (image or not) — is
   emptied to `""`** before it reaches the tree. We keep it (do not override `urlTransform`). Consequence for
   the `img`-as-link override: an inline base64 `data:` image degrades to a dead `<a href="">alt</a>` — fails
   safe (no fetch), and inline base64 images in agent output are vanishingly rare (legit images use
   `blob_ref`).
3. **Link hardening.** `a` override adds `rel="noopener noreferrer nofollow"` + `target="_blank"` for
   external (`http`/`https`/`mailto`) links.
4. **No auto-loading images.** The `img` override renders markdown images as a plain text link, never a
   bare `<img src>` — an agent-authored body cannot trigger an uncontrolled outbound fetch
   (tracking-pixel / SSRF-adjacent). Legitimate images use the authenticated `blob_ref` path (§Design).
5. **Highlight input is text.** `rehype-highlight` tokenizes the code *string* into spans; it does not
   interpret HTML in code content.

**Why not DOMPurify:** DOMPurify sanitizes an **HTML string** before `innerHTML`. On this route there is
no HTML string and no `innerHTML` — so DOMPurify has nothing to act on. Adding it is dead plumbing that
implies a raw-HTML path we intentionally don't have (right-size-effort; documented in `mandate_deviation`
frontmatter for the spec-review gate). If a future loop wants a curated raw-HTML subset, the correct shape
is `rehype-raw` **plus** DOMPurify together — a separate decision.

## Testing

**Two harness facts the plan MUST honor (both were live round-1 blockers, resolved here — not left open):**

1. **Test-file extension/discovery.** `jest.config.cjs` `testMatch` is
   `["<rootDir>/test/unit-tests/journal/**/*-test.ts"]` — it matches **`.ts` only**; all 29 existing suites
   are `.ts`. The new suite is therefore **`test/unit-tests/journal/markdown-test.ts`** (not `.tsx`) and
   renders React via **`React.createElement`** (the existing repo convention for component tests — no JSX in
   `.ts`). This keeps the suite discoverable with **zero `jest.config.cjs` `testMatch` change** and matches
   house style. (Do not introduce a `.tsx` file + widen `testMatch` — that diverges from Dan's config for no
   benefit.)
2. **Pure-ESM transform.** react-markdown v9 / remark-gfm / rehype-highlight and their
   `micromark`/`unified`/`lowlight`/`hast-*` transitive deps are **pure ESM**; jest does not transform
   `node_modules` by default, so importing `MarkdownBody` in a test throws `SyntaxError: Cannot use import
   statement outside a module`. Resolve with **`transformIgnorePatterns: []`** in `jest.config.cjs`
   (transform *all* `node_modules` via the existing babel-jest — empirically verified working end-to-end in
   round-2: deps installed, a test `require`d them and rendered highlighted HTML). It needs no knowledge of
   the exact transitive package list (robust to dependency patch bumps; §Dependencies). **Cost acceptance
   criterion (round-2 finding — asserted→established):** babel-jest caches transformed modules
   (`node_modules/.cache` / `$TMPDIR/jest_*`), so `[]` is a one-time cold-run cost. Measure `pnpm test`
   wall-time on a cold cache; if it regresses by >~2× vs the pre-change baseline (or exhausts memory on the
   dev box), fall back to the **surgical unified/rehype allowlist** —
   `["/node_modules/(?!(.pnpm/)?(react-markdown|remark-.*|rehype-.*|mdast-.*|micromark.*|unist-.*|unified|vfile.*|hast-.*|hastscript|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities.*|bail|is-plain-obj|trough|devlop|zwitch|html-void-elements|ccount|escape-string-regexp|markdown-table|trim-lines|web-namespaces|lowlight|highlight.js|fault|estree-.*)/)"]`
   — enumerated here so the fallback is executable, not a `...` placeholder. Confirm the full existing suite
   still passes and completes within the cost criterion under whichever pattern is chosen.

`test/unit-tests/journal/markdown-test.ts` (jsdom, `React.createElement`, Testing-Library-style render):
- bold/italic/inline-code/link/list → correct tags (`<strong>`, `<em>`, `<code>`, `<a>`, `<ul><li>`).
- GFM table + task list + strikethrough render.
- fenced ```ts block (non-streaming) → `<pre class="mj_CodeBlock">` containing `<code>` with the
  `hljs` class and highlight `<span>`s (assert **highlighting occurred** — presence of `hljs` + ≥1 token
  span — **not** a normalized `language-typescript` class name, which the plugin does not guarantee for the
  `ts` alias).
- **unknown-language fence** ` ```notalang ` → `<code>` keeps `class="hljs language-notalang"` but has
  **zero `.hljs-*` token `<span>`s** and does **not throw** (assert absence of token spans, NOT absence of
  the `hljs` class — it's always present; NOT relabeled to `plaintext`; per §Dependencies).
- **streaming skips highlight:** a ```ts fence rendered with `streaming` → plain `<pre>` with **no `hljs`
  class / no token spans**; the same fence non-streaming → highlighted (asserts the streaming cost-bound).
- **size guard:** `text` longer than `MARKDOWN_MAX` → `mj_MarkdownRaw` raw fallback, no markdown parse.
- **copy button** present per code block; click invokes `copyText` (mock) with the exact raw source from the
  hast node (verify newline/indentation fidelity); `copyText`→`true` shows "Copied", **`copyText`→`false`
  shows "Copy failed"** (both branches asserted).
- **images:** `![alt](https://e.tld/x.png)` renders a text link (`<a>`), **no `<img>` node in the DOM**.
- **security:** `<img src=x onerror=alert(1)>` in a body → rendered as escaped text, `document` has no
  injected `<img>`; `[x](javascript:alert(1))` → anchor `href` is sanitized (no `javascript:`);
  external `[x](https://e.tld)` anchor has `rel` containing `noopener`+`noreferrer` and `target=_blank`.
- **streaming/partial:** an unterminated ```` ```ts ```` prefix renders without throwing.
- **fail-visible / error boundary:** a `MarkdownBody` whose render throws (mock an override to throw) →
  `MarkdownErrorBoundary` catches it, raw `mj_MarkdownRaw` fallback text appears, `console.error` fires with
  the `label`, and a sibling `MarkdownBody` in the same list still renders normally (isolation).
- **boundary reset-on-change:** after a boundary trips, re-render the *same* instance with a new valid `text`
  → `hasError` clears and markdown renders again (same-row self-heal, the streaming recovery path).
- **clipboard move:** the existing context-menu copy path still works after `copyText` moves to
  `clipboard.ts` (regression guard on the pure move).
- **three-site wiring (integration — round-3 finding):** assert each caller actually routes through
  `MarkdownBody`, so a regressed wiring site fails a test rather than silently rendering raw. Render (a) an
  `EventRow` with a `text` event, (b) the pending-message path, (c) the text-stream path → each yields a
  markdown-rendered element (e.g. a `**bold**` body produces `<strong>`), and the stream case keeps the
  `<span class="mj_Cursor">` as a **sibling outside** the `MarkdownBody`/`.mj_Markdown` container. `prompt_reply`
  stays plain (no `<strong>` from a `**x**` body) — guards against over-applying markdown.

Manual smoke on live :8443 **as the deploy's verify gate** (§Rollout step 4 — failure triggers rollback):
send a Claude Code reply with headings/table/task-list/fenced-diff → verify render + per-block copy + link
behavior; watch a streaming reply finalize (unhighlighted→highlighted); confirm a plain non-markdown message
is unaffected.

## Rollout / deploy

Operator-run, following the existing matron-web deploy runbook (CLAUDE.local.md / `reference_matron_web_deploy`).
The one change this spec makes to that runbook: **build off to the side on the same filesystem and swap a
complete tree**, so nginx never serves the mid-build partial that the plain in-place `pnpm build`
(`rimraf webapp && webpack`) would expose.

1. `pnpm install` (new deps) in the deploy checkout (`/opt/matron/web-journal`).
2. Build into a **same-filesystem staging dir** (NOT `/tmp` — a cross-filesystem `mv` degrades to copy+delete
   and reopens the partial-tree window): stage under `/opt/matron/web-journal/` itself, e.g. clone/copy to
   `/opt/matron/web-journal/.build-<ts>`, `pnpm install`, `corepack pnpm build` → complete
   `.build-<ts>/webapp`. (Building from a clone also sidesteps the worktree-`.git`-file Dockerfile gotcha in
   `reference_matron_web_deploy`.)
3. **Swap** (same-filesystem `mv` = rename(2); the two-rename gap is sub-millisecond and same-fs, negligible
   for this single-operator tailnet-only client): `mv webapp webapp.prev.<ts> && mv .build-<ts>/webapp webapp`.
4. **Verify** on `https://…:8443`: HTTP 200 on `/` AND the hashed JS/CSS bundle loads AND the manual
   behavioral smoke below passes. **Verify gates the deploy** — if any check fails, **execute rollback**.
5. **Rollback** (reverse rename, non-destructive — failed build retained): `mv webapp webapp.failed.<ts> &&
   mv webapp.prev.<ts> webapp`.

The deploy is an operator-run manual runbook (renames retain both prior and failed trees under timestamped
names; nothing is deleted). Prune `webapp.prev.*` / `webapp.failed.*` manually once the deploy is confirmed
good. Ship: rebase onto current origin/main, merge to fork-main, rebuild + verify. Upstream Dan PR
optional/deferred.

## Risks

- **Bundle growth** (highlight.js grammars). Mitigated by curated language set; measure `webapp` asset
  size delta at build, note in PR. If large, drop rarely-used grammars.
- **Streaming re-parse cost.** Bounded by **skipping rehype-highlight during streaming** (the expensive
  path) + the `MARKDOWN_MAX` size guard + coarse bridge-chunk cadence (§Streaming) — not just `React.memo`.
  Full highlight applies only to finalized messages. Documented follow-up if profiling shows jank on a long
  stream: time-debounce the stream re-render (~60fps coalesce). Not built now — no measured jank.
- **CSS regression** from `.mj_MessageText` no longer styling markdown + removing `pre-wrap` on the markdown
  container: risk of collapsed intended whitespace in edge messages. Mitigated by `.mj_Markdown` block
  spacing rules + the raw fallback keeping `pre-wrap`. Covered by manual verify.
- **P17 exact-pin deviation (accepted).** New deps use caret ranges to match Dan's `package.json` convention
  (Dan-alignment; every existing dep is `^`); `pnpm-lock.yaml` pins the transitive graph, and
  `transformIgnorePatterns: []` removes the ESM-graph coupling. Codex re-flagged P17 twice; overridden as a
  documented accepted-limitation (Dan-alignment + lockfile > uniform exact-pin here).
- **`.mj_Markdown` is a new class** — scoped entirely under its own selector; new rules can only match inside
  a markdown site, and are kept token-based + seam-labeled so #480's dark set converges, not fights.
