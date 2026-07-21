---
title: "Web journal client — rich diff cards (implementation plan)"
spec: docs/superpowers/specs/2026-07-20-web-diff-cards-design.md
date: 2026-07-20
loop: 455
owner: easelyte
risk: low  # render-only component; no auth/RLS/payments/data-loss/deployment surface
base: upstream/main (cf7646f)  # D is the independent leaf; PRs clean to Matronhq:main
constraint: "components.tsx + client.ts NOT split (upstream alignment). New code lands inline."
---

# Web journal client — rich diff cards (implementation plan)

Implements `docs/superpowers/specs/2026-07-20-web-diff-cards-design.md`: port apple's `DiffCard` to render structured `diff` journal events in matron-web (linked filename → `viewer_url`, prefix-colored diff, counts, new-file badge, collapse-to-12). Single component + parse helper, inline in `components.tsx`; styles in `journal.pcss`; one icon in `icons.tsx`; one new test file. All work in the worktree `/opt/matron/web-journal-wt-diff-cards` (branch `feat/diff-cards`, on `upstream/main`).

**Test convention** (memory `reference_matron_web_jest_convention`): `test/unit-tests/journal/<name>-test.ts` — `journal/` subdir + **hyphen** `-test.ts` + `.ts` even for `.tsx`; import depth `../../../src/journal/...`; run `node_modules/.bin/jest <path>` (NOT `pnpm exec jest`). A fresh worktree needs `corepack pnpm install` first (~5s).

**Render-test harness (NO new dependency).** The upstream base has no `@testing-library`, and `@babel/preset-typescript` does NOT parse JSX in a `.ts` file (`<DiffCard/>` would be read as a TS type-assertion and syntax-error). So component render tests use **`React.createElement` (no JSX syntax)** mounted via `createRoot`:
```ts
import React, { act } from "react";
import { createRoot } from "react-dom/client";
// jest.config.cjs already sets testEnvironment:"jsdom" GLOBALLY (+ test/setup.cjs) — no per-file docblock needed.
// In a beforeAll (React requires this flag when no testing-library configures it):
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// mount:
const container = document.createElement("div");
const root = createRoot(container);
await act(async () => { root.render(React.createElement(DiffCard, { data })); });
// query: container.querySelector(...); drive interactions with AWAITED act: await act(async () => el.click());
// teardown (AWAITED): await act(async () => root.unmount());
```
react/react-dom `^19.2`, `@babel/preset-react`, and `jest-environment-jsdom` are already deps on the upstream base. This mirrors the fork's `components-test.ts` verbatim (its proven pattern — same `IS_REACT_ACT_ENVIRONMENT=true` + awaited `act`/`unmount`) — the upstream base's own `test/` has no prior component-render test; this port introduces the first, using that pattern.

## Dependency graph

```
T-1.1 (parseDiffPayload) ─┐
T-1.3 (FileEditIcon) ──────┤
                           ├─→ T-1.2 (DiffCard) ─┐
T-1.4 (styles) ────────────┴────────────────────┼─→ T-1.5 (wire case "diff") ─→ T-2.1 (verify)
                                                 │
```
- **Parallelizable:** T-1.1, T-1.3, T-1.4 (no interdependencies).
- **T-1.2** needs T-1.1 (`DiffCardData`) + T-1.3 (icon).
- **T-1.5** needs T-1.1, T-1.2, T-1.4.
- **T-2.1** needs all of Phase 1.

## Spec-coverage map

| Spec part | Task(s) |
|---|---|
| §5.1 `parseDiffPayload` (diff/patch/JSON fallback, optional-string presence check, viewerUrl try/catch+https, number coercion, strict booleans) | T-1.1 |
| §5.2 `DiffCard` (header, filename link/span, badge, counts, chevron+more-button, trimmed split, prefix coloring, collapse/expand, truncated tail) | T-1.2 |
| §5.3 `mj_DiffCard*` styles (white-space:pre, replace `.mj_Diff`) | T-1.4 |
| §5.4 `FileEditIcon` | T-1.3 |
| §5.2 wire `case "diff"` | T-1.5 |
| §6 tests (parse + render matrix) | T-1.1 (parse), T-1.2 (render) |
| §8 accepted limitations L1/L2/L3 | no code (documented; L2/L3 are follow-up loops #472/#473) |
| §9 acceptance 1-7 | T-2.1 (checklist) |

---

## Phase 1 — Parse + render core (TDD)

### T-1.1: `parseDiffPayload` + `DiffCardData` (exported) + parse unit tests

Add, in `components.tsx` beside `EventContent` (upstream base `components.tsx:663`):
- `interface DiffCardData` per spec §5.1 (`diff: string`; optional `displayPath`/`filePath`/`viewerUrl`/`tool`/`label`; optional `added`/`removed`; `truncated`/`newFile` booleans).
- `export function parseDiffPayload(payload: EventPayload): DiffCardData` with the exact coercion from §5.1:
  - `diff` = the **nested** form `asString(payload.diff, asString(payload.patch, JSON.stringify(payload, null, 2)))` — byte-identical to the current renderer (`components.tsx:687`). NOT an OR-chain: a present-but-empty `payload.diff === ""` is preserved as `""` (matching current code + the `??` interface comment), never falling through to patch/JSON. P3 fail-visible — never a silent blank.
  - Optional strings (`displayPath`/`filePath`/`tool`/`label`): `typeof payload.x === "string" && payload.x ? payload.x : undefined` (NOT `asString`; must yield `undefined`, not `""`, or `?? filePath` breaks — P8).
  - `viewerUrl`: `try { const u = new URL(str); return u.protocol === "https:" ? str : undefined } catch { return undefined }` — only when `payload.viewer_url` is a non-empty string; blocks `javascript:`/`data:`/relative and the `new URL()` throw (P1/P15).
  - `added`/`removed`: set only when `typeof payload.x === "number"`.
  - `truncated`/`newFile`: strict `payload.x === true`.

Write `test/unit-tests/journal/diff-card-test.ts` (parseDiffPayload block) covering §6:
- rich payload → full `DiffCardData`;
- bare `{diff:"…"}` → diff set, `displayPath`/`filePath`/`tool`/`label` all `undefined`, `truncated`/`newFile` false;
- patch fallback: `{patch:"@@…"}` no diff → `diff` = patch content;
- diagnostic fallback: `{type:"diff", foo:1}` (no diff/patch) → `diff` = `JSON.stringify(payload,null,2)`;
- `viewer_url` `null`, `""`, `"javascript:alert(1)"`, `"data:text/html,x"`, relative `"/view?token=x"` → `viewerUrl` undefined **and `parseDiffPayload` does not throw**; valid `https://…` → set;
- `display_path:""` + `file_path:"a/b.ts"` → (filename resolution asserted at component level; here assert `displayPath === undefined`);
- non-number `added`/`removed` (string) → undefined; numeric → set;
- non-boolean `truncated`/`new_file` (e.g. `"true"`) → `false`.

**Acceptance:** `node_modules/.bin/jest test/unit-tests/journal/diff-card-test.ts` parseDiffPayload cases green; `parseDiffPayload` + `DiffCardData` exported; `tsc --noEmit` clean.
**Deps:** none.

### T-1.2: `DiffCard` component (exported) + render tests

Add `export function DiffCard({ data }: { data: DiffCardData }): React.ReactElement` per §5.2:
- `const [expanded, setExpanded] = useState(false)`; `lines = data.diff.replace(/\n+$/, "").split("\n")`; `lineCount = lines.length`; `expandable = lineCount > 12`.
- **Header** (`mj_DiffCard_header`): chevron `<button aria-expanded={expanded} aria-label={expanded ? "Collapse diff" : "Expand diff"}>` **only when `expandable`** (the SVG chevron is `aria-hidden`, so the button needs its own accessible name); `<FileEditIcon aria-hidden />`; filename = last component of `data.displayPath ?? data.filePath ?? "file"` — as `<a href={data.viewerUrl} target="_blank" rel="noopener noreferrer">` when `data.viewerUrl` set, else `<span>` (no `stopPropagation` — no ancestor handler); dimmed `data.label`; "new file" badge when `data.newFile`; `+{added}`/`−{removed}` each when its value is a number; "…" (`title="diff truncated"`) when `data.truncated`.
- **Body** (`mj_DiffCard_body`): render `expanded ? lines : lines.slice(0,12)`, each `<div>` classed by first char (`+`→`mj_DiffLine_add`, `-`→`_del`, `@`→`_hunk`, else `_ctx`). When `expandable` and not `expanded`, a `mj_DiffCard_more` `<button>` "+{lineCount-12} more lines" toggling `expanded`. When `data.truncated`, final `mj_DiffCard_truncated` row "… diff truncated".

Render tests (jsdom, via the `React.createElement`+`createRoot`+`act`+`querySelector` harness above — no JSX in the `.ts` file) per §6:
- filename = last component of `display_path`; falls back `file_path` then `"file"`; `display_path:""`+`file_path:"a/b.ts"` → `b.ts`;
- link present iff `viewerUrl` set, with `target="_blank"` + `rel="noopener noreferrer"`; `viewer_url:null` → plain `<span>`, no `<a>`;
- counts hidden when undefined, shown when numbers; new-file badge iff `new_file`;
- **prefix classification:** a fixture with a `+added`, a `-removed`, a `@@ hunk @@`, and a ` context` line asserts those rows carry `mj_DiffLine_add` / `_del` / `_hunk` / `_ctx` respectively (this is the ONLY signal for prefix coloring — build/tsc/jsdom don't validate it);
- ≤12 lines → no chevron, no "more" row; >12 → chevron + "more" `<button>`; clicking chevron OR the "more" button expands to all lines;
- **collapse is bidirectional:** clicking the chevron a SECOND time collapses back to 12 rows, restores the "more" row, and sets `aria-expanded="false"` (guards against a `setExpanded(true)` impl that never toggles);
- **accessibility:** when `expandable`, the chevron button's accessible name is "Expand diff" (collapsed) / "Collapse diff" (expanded), and `aria-expanded` tracks state;
- terminal newline: 12-line diff ending `"\n"` and `"\n\n"` → `expandable` false;
- whitespace: an indented line renders inside `mj_DiffCard_body` with leading spaces preserved in `textContent`;
- `truncated:true` → "… diff truncated" tail.

**Acceptance:** render cases green; `DiffCard` exported; chevron + "more" both `<button>` (keyboard-operable); no dead toggle when ≤12.
**Deps:** T-1.1 (`DiffCardData`), T-1.3 (`FileEditIcon`).

### T-1.3: `FileEditIcon` in `icons.tsx`

Add an inline-SVG `FileEditIcon(props: IconProps)` (16px, matching the `IconProps` signature at `icons.tsx:10`, style of `AttachmentIcon`/`ComposeIcon`). Document-with-pencil glyph.

**Acceptance:** imported + rendered by `DiffCard`; `tsc --noEmit` clean.
**Deps:** none (parallel with T-1.1/T-1.4).

### T-1.4: `mj_DiffCard*` styles in `journal.pcss` (replace `.mj_Diff`)

Add the classes from §5.3, reusing the existing CSS-var tokens (`--cpd-color-*` / `--cpd-space-*`; the repo has **no separate dark selector** — Compound tokens theme themselves, so there is NO light/dark work here):
- `mj_DiffCard` (code-bg surface, rounded, **`min-width: 0`** so it can shrink inside the flex timeline), `mj_DiffCard_header` (flex row, gap, wrap), `mj_DiffCard_filename` + `mj_DiffCard_link` (accent color, hover underline, `:focus-visible` ring), `mj_DiffCard_label` (dimmed), `mj_DiffCard_badge` (pill), `mj_DiffCard_added` (green) / `_removed` (red), `mj_DiffCard_body` (**`white-space: pre;`** + monospace + **`max-width: min(720px, 62vw)`** + **`overflow-x: auto`** — reproduces the desktop bound the old `.mj_Diff` gave, so a long unbroken line SCROLLS rather than overflowing the card; P3/P13), `mj_DiffLine_add`/`_del`/`_hunk`/`_ctx` (**distinct** prefix `color:` tints — add≠del≠hunk), `mj_DiffCard_more` (dimmed button) / `_truncated` (dimmed).

**Do NOT delete the `.mj_Diff` rules** — `.mj_Diff` is one selector in two SHARED comma-groups; deleting the blocks would strip styling from unrelated components. Splice out only the `.mj_Diff,` line:
- **Light group** (`journal.pcss:399-403`, `.mj_Diff,` at :402, shared with `.mj_ToolCommand`, `.mj_ToolCard pre`, `.mj_LiveTool pre`, `.mj_Unknown pre`): remove the `.mj_Diff,` selector line, leave the other four + the whole rule body intact.
- **Mobile `@media (max-width:700px)` group** (`journal.pcss:~632-638`, shared with `.mj_PromptCard`, `.mj_ToolCard`, `.mj_ToolCard pre`, `.mj_LiveTool pre`, `.mj_Unknown pre`, `.mj_Image`): **replace** `.mj_Diff` with `.mj_DiffCard` so the new card keeps the mobile `max-width: 76vw`. (This is a mobile-width rule, NOT a dark override.)

**Acceptance:** `corepack pnpm build` (postcss) clean; `grep -A12 'mj_DiffCard_body' src/journal/journal.pcss | grep -qE 'white-space:\s*pre;'` — semicolon-anchored + block-scoped so it does NOT match the file's pre-existing `white-space: pre-wrap;` (B2 is a CSS behavior jsdom can't render, so the pcss rule is the testable surface); `mj_DiffLine_add` and `mj_DiffLine_del` carry DISTINCT `color:` declarations (prefix tints are real, not empty/identical); the light group at :399 still lists `.mj_ToolCommand`/`.mj_ToolCard pre`/`.mj_LiveTool pre`/`.mj_Unknown pre`, and the mobile group still lists its other selectors + now `.mj_DiffCard` (splice, not delete). (Global orphan-ref check for `.mj_Diff` runs in T-2.1, after T-1.5 drops the last `className="mj_Diff"`.)
**Deps:** none (parallel).

### T-1.5: wire `case "diff"` → `DiffCard`

In `EventContent` (`components.tsx:687`), replace the bare `case "diff"` body with:
```tsx
case "diff":
    return <DiffCard data={parseDiffPayload(event.payload)} />;
```
Also add `export` to `EventContent` (a named export, no behavior change) so the integration test below can drive the real wiring.

**Integration test** (in `diff-card-test.ts`, via the createElement harness): `EventContent` requires `client` + `event` + `answeredPrompts` props (`components.tsx:663`) and a fully-shaped `JournalEvent` (`seq`/`convo_id`/`ts`/`sender`/`type`/`payload`). Render with:
```ts
React.createElement(EventContent, {
  client: new MatronJournalClient(),                 // no-arg ctor, client.ts:115
  answeredPrompts: new Set<number>(),
  event: { seq: 1, convo_id: "c", ts: 0, sender: "assistant", type: "diff",
           payload: { display_path: "a/b.ts", viewer_url: "https://x/view?t=1", diff: "@@…", added: 1, removed: 0 } },
})
```
→ assert a linked filename + counts render; then a legacy `{ …, type:"diff", payload:{ patch:"@@…" } }` → assert the patch renders. This proves the `case "diff"` branch actually pipes `event.payload` through `parseDiffPayload` into `DiffCard` — a wiring regression (wrong prop, forgot the parse) would otherwise pass every direct-component/parser unit gate while journal events render wrong.

**Acceptance:** `EventContent` exported + renders `DiffCard` for `type:"diff"` events; the integration test (event → EventContent → parseDiffPayload → DiffCard) is green; `tsc --noEmit` clean.
**Deps:** T-1.1, T-1.2, T-1.4.

---

## Phase 2 — Verify

### T-2.1: full green + §9 acceptance checklist

- `corepack pnpm install` (if not already); `node_modules/.bin/jest` (whole suite — `diff-card-test.ts` green, any pre-existing tests unaffected); `corepack pnpm exec tsc --noEmit`; `corepack pnpm build`.
- Walk §9 acceptance 1-7 and confirm each: rich card renders (linked filename/counts/badge/collapse/truncated); `viewer_url:null` → plain filename; legacy `{diff}`/`{patch}`/diagnostic-JSON render; non-https/relative viewer_url → plain filename; whitespace preserved + no phantom "+1 more"; suite green; `components.tsx`/`client.ts` not split.

**Acceptance:** jest + tsc + build all green; §9 items 1-7 satisfied; `grep -rn "mj_Diff\b" src/` returns zero matches (the old bare `.mj_Diff` / `className="mj_Diff"` fully removed after T-1.5); `git diff --stat` shows only `components.tsx`, `journal.pcss`, `icons.tsx`, `diff-card-test.ts` (+ this plan/spec) touched — no split of the monoliths.
**Deps:** all Phase 1.

---

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

## Appendix: Verified Claims (research pass 2026-07-20)

No unresolved external claims — the plan commits only to textbook JS/DOM semantics:

✓ `new URL(str)` with no base throws `TypeError` on a relative/invalid string (e.g. `new URL("/view?token=x")`). Verified in spec-review round 2 (Node 20 direct test) — this is why T-1.1's `viewerUrl` parse is try/catch-wrapped. (MDN URL() constructor.)
✓ `String.prototype.replace(/\n+$/, "")` strips all trailing newlines (non-global anchored `$` with `+`). Standard regex semantics.
✓ Component render tests run in a `.ts` file via `React.createElement` (NO JSX — `@babel/preset-typescript` won't parse JSX in `.ts`) + `createRoot` + `act` + `container.querySelector`. react/react-dom `^19.2`, `@babel/preset-react`, and `jest-environment-jsdom` are already deps on the upstream base — **no new dependency needed**. Verified against the fork's `test/unit-tests/journal/components-test.ts`, which uses exactly this harness (`import React, { act } from "react"` + `createRoot`). CORRECTION to the earlier draft: the upstream base's own `test/` has NO prior component-render test — this port introduces the first, using the fork-proven no-dep pattern (not "the suite already renders components this way").
