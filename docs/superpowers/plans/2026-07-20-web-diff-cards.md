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
  - `diff` = `asString(payload.diff)` → else `asString(payload.patch)` → else `JSON.stringify(payload, null, 2)` (preserves the current `diff ?? patch ?? JSON.stringify` chain at `components.tsx:687`; P3 fail-visible — never a silent blank).
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
- **Header** (`mj_DiffCard_header`): chevron `<button aria-expanded>` **only when `expandable`**; `<FileEditIcon aria-hidden />`; filename = last component of `data.displayPath ?? data.filePath ?? "file"` — as `<a href={data.viewerUrl} target="_blank" rel="noopener noreferrer">` when `data.viewerUrl` set, else `<span>` (no `stopPropagation` — no ancestor handler); dimmed `data.label`; "new file" badge when `data.newFile`; `+{added}`/`−{removed}` each when its value is a number; "…" (`title="diff truncated"`) when `data.truncated`.
- **Body** (`mj_DiffCard_body`): render `expanded ? lines : lines.slice(0,12)`, each `<div>` classed by first char (`+`→`mj_DiffLine_add`, `-`→`_del`, `@`→`_hunk`, else `_ctx`). When `expandable` and not `expanded`, a `mj_DiffCard_more` `<button>` "+{lineCount-12} more lines" toggling `expanded`. When `data.truncated`, final `mj_DiffCard_truncated` row "… diff truncated".

Render tests (jsdom, in the same test file) per §6:
- filename = last component of `display_path`; falls back `file_path` then `"file"`; `display_path:""`+`file_path:"a/b.ts"` → `b.ts`;
- link present iff `viewerUrl` set, with `target="_blank"` + `rel="noopener noreferrer"`; `viewer_url:null` → plain `<span>`, no `<a>`;
- counts hidden when undefined, shown when numbers; new-file badge iff `new_file`;
- ≤12 lines → no chevron, no "more" row; >12 → chevron + "more" `<button>`; clicking chevron OR the "more" button expands to all lines;
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

Add the classes from §5.3, reusing existing palette tokens (mirror `mj_ToolCard`):
- `mj_DiffCard` (code-bg surface, rounded 8), `mj_DiffCard_header` (flex row, gap, wrap), `mj_DiffCard_filename` + `mj_DiffCard_link` (accent color, hover underline, `:focus-visible` ring), `mj_DiffCard_label` (dimmed), `mj_DiffCard_badge` (pill), `mj_DiffCard_added` (green) / `_removed` (red), `mj_DiffCard_body` (**`white-space: pre`** + monospace + horizontal scroll — required so indentation/tabs survive; P3), `mj_DiffLine_add`/`_del`/`_hunk`/`_ctx` (prefix tints), `mj_DiffCard_more` (dimmed button) / `_truncated` (dimmed).
Remove the bare `.mj_Diff` rule (`journal.pcss:402`) and its dark override (`:634`).

**Acceptance:** `corepack pnpm build` (postcss) clean; `grep -rn "mj_Diff\b" src/` returns no orphan refs to the removed `.mj_Diff`; classes resolve in both light and `.mj_theme-dark` (or the repo's dark selector).
**Deps:** none (parallel).

### T-1.5: wire `case "diff"` → `DiffCard`

In `EventContent` (`components.tsx:687`), replace the bare `case "diff"` body with:
```tsx
case "diff":
    return <DiffCard data={parseDiffPayload(event.payload)} />;
```

**Acceptance:** `EventContent` renders `DiffCard` for `type:"diff"` events; the existing `components-test.ts` (if present on this base) is unaffected; `tsc --noEmit` clean.
**Deps:** T-1.1, T-1.2, T-1.4.

---

## Phase 2 — Verify

### T-2.1: full green + §9 acceptance checklist

- `corepack pnpm install` (if not already); `node_modules/.bin/jest` (whole suite — `diff-card-test.ts` green, any pre-existing tests unaffected); `corepack pnpm exec tsc --noEmit`; `corepack pnpm build`.
- Walk §9 acceptance 1-7 and confirm each: rich card renders (linked filename/counts/badge/collapse/truncated); `viewer_url:null` → plain filename; legacy `{diff}`/`{patch}`/diagnostic-JSON render; non-https/relative viewer_url → plain filename; whitespace preserved + no phantom "+1 more"; suite green; `components.tsx`/`client.ts` not split.

**Acceptance:** jest + tsc + build all green; §9 items 1-7 satisfied; `git diff --stat` shows only `components.tsx`, `journal.pcss`, `icons.tsx`, `diff-card-test.ts` (+ this plan/spec) touched — no split of the monoliths.
**Deps:** all Phase 1.

---

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
