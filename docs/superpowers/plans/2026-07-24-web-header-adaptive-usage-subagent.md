# Implementation plan — Adaptive header + usage cluster + subagent strip (#500 / #501 / #502)

**Spec:** `docs/superpowers/specs/2026-07-24-web-header-adaptive-usage-subagent-design.md` (converged spec-review round 4, v5)
**Repo:** `easelyte/matron-web` @ `/opt/matron/web-journal` · **Branch:** `vps-header` (off `origin/main`)
**Stack:** React + TypeScript, PostCSS (`--cpd-*` Compound tokens), jest + jsdom (`test/unit-tests/journal/**/*-test.ts`), `corepack pnpm` build.
**Merge only — no live deploy** (batched across the three parallel header/UI windows). **Rebase on `origin/main` before ship.**

## Scope boundary (owner window)

Touch **only** the header region: `src/journal/components.tsx` (ChatHeader ~1254, SubChatHeader ~1351, UsageBars ~1223, RunningSubagentStrip ~3099, SignedInApp wiring ~3126-3223) + `src/journal/journal.pcss` header rules (~77-333, `.mj_HeaderMenu` ~353, `.mj_Subagent*` ~388) + pure helpers in `src/journal/status.ts` + tests. **Do NOT** touch the composer, timeline, client/WS, or `SessionStatus` data flow. No new source files (fork divergence-minimization) — new units land in the existing files. No `journal.pcss` file split (separate loop).

## Task ID legend

Numeric phases (`## Phase N`), tasks `### T-N.X`. Each task: TDD where the unit is logic-testable (test step precedes implementation), concrete steps, per-task acceptance. `[ ]` checkboxes for tracking.

## Dependency graph

```
Phase 1  (pure primitives — no UI wiring)
  T-1.1 normalizePercent + worstLimit (status.ts)      ──┐
  T-1.2 useDismissablePopover (components.tsx)          ──┤
  T-1.3 useAdaptiveHeader (components.tsx)              ──┤
                                                          ▼
Phase 2  (components — depend on Phase 1)
  T-2.1 UsageCluster        (needs T-1.1)              ──┐
  T-2.2 SubagentStrip                                  ──┤
  T-2.3 HeaderShell         (needs T-1.1,1.2,1.3,2.1)  ──┤
                                                          ▼
Phase 3  (wiring + CSS — depend on Phase 2)
  T-3.1 ChatHeader/SubChatHeader thin wrappers (needs T-2.3)
  T-3.2 SignedInApp observer wiring + strip swap (needs T-2.2,2.3,T-1.3)
  T-3.3 journal.pcss header CSS (parallels 3.1/3.2)
                                                          ▼
Phase 4  (integration gate)
  T-4.1 visual gate (harness widths + themes + AA)
  T-4.2 lint + full suite + Codex review + rebase
```

T-1.1/1.2/1.3 are mutually independent (parallelizable). T-2.1/2.2 independent; T-2.3 depends on 1.x + 2.1. Phase 3 after Phase 2. Phase 4 last.

---

## Phase 1 — Pure primitives (status helpers + hooks)

### T-1.1: `normalizePercent` + `worstLimit` in `status.ts` (fail-visible boundary)

**Files:** `src/journal/status.ts`, `test/unit-tests/journal/status-test.ts` (extend) or new `usage-cluster-test.ts`.

- [ ] **Test first.** Add cases: `normalizePercent(NaN | Infinity | -Infinity)` → `null`; `normalizePercent(-5)` → `0`; `normalizePercent(150)` → `100`; `normalizePercent(42.4)` → `42.4` (no premature rounding — rounding for display is the caller's job). `worstLimit([])` → `undefined`; `worstLimit([{percent: NaN}])` → `undefined` (all-unknown); `worstLimit([{label:'a',percent:NaN},{label:'b',percent:10}])` → the `b`/10 entry (unknown ignored); ties → first.
- [ ] Implement `export function normalizePercent(p: number): number | null` = `Number.isFinite(p) ? Math.min(Math.max(p, 0), 100) : null`.
- [ ] Implement `export function worstLimit(limits: NonNullable<SessionStatus["limits"]>): SessionStatus["limits"][number] | undefined` — max by `normalizePercent(l.percent)` over entries whose normalized value is non-null; `undefined` if none finite.
- [ ] Keep existing `usageLevel`/`usageBarLabel`/`resetDisplay`/`compactTokens` unchanged.

**Acceptance:** new unit cases green; `normalizePercent` maps non-finite → `null` (NOT `0` — P3 fail-visible); `worstLimit` ignores unknowns and returns `undefined` only when no finite entry exists. Spec §4 / AC#1.

### T-1.2: `useDismissablePopover` hook (header-scoped, in `components.tsx`)

**Files:** `src/journal/components.tsx` (new hook near the other header helpers), covered indirectly by T-4.1's adaptive-header-test.

- [ ] Signature `useDismissablePopover(open: boolean, close: () => void, refs: { openerRef: RefObject<HTMLElement>; panelRef: RefObject<HTMLElement> })`.
- [ ] When `open`, on `document`: `pointerdown` → close if `!openerRef.current?.contains(t) && !panelRef.current?.contains(t)` (opener-ref guard added vs the room-menu pattern at `components.tsx:706-725`, so a click on the trigger doesn't reopen-then-close); `keydown` Escape → `close()` then `openerRef.current?.focus()`; capture-phase `scroll` → close **only if** `!panelRef.current?.contains(e.target as Node)` (internal-scroll exception — the popover is itself a scroll container; round-2 Codex B1).
- [ ] Cleanup removes all three listeners. Model on `706-725` but **do not modify** the existing room/account/event menus (out-of-window).

**Acceptance:** hook attaches/detaches by `open`; outside-click, Escape (+focus return), and outside-scroll close; a scroll whose target is inside `panelRef` does NOT close. Spec §1.

### T-1.3: `useAdaptiveHeader(bodyEl)` hook (ResizeObserver, callback-ref lifecycle)

**Files:** `src/journal/components.tsx`, `test/unit-tests/journal/adaptive-header-test.ts` (new — see T-4.1 for the render-driven cases; this task owns the hook + its direct tests).

- [ ] Module constants `const USAGE_COLLAPSE_PX = 700; const TITLE_COLLAPSE_PX = 460;` (invariant `TITLE < USAGE`).
- [ ] Signature `useAdaptiveHeader(bodyEl: HTMLElement | null): { usageCollapsed: boolean; titleCollapsed: boolean }`. Takes the **element as a value** (from a state-backed callback ref), NOT a stable `RefObject` — `.mx_RoomView_body` is conditionally mounted (spec §2/§7, B1).
- [ ] `useEffect` **keyed on `bodyEl`**: if `bodyEl == null` or `typeof ResizeObserver === "undefined"` → set `{false,false}`, install nothing (fail-soft). Else attach a `ResizeObserver` on `bodyEl`; callback stashes latest width (`entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width`), schedules one rAF if none pending; the frame computes `width < USAGE_COLLAPSE_PX` / `< TITLE_COLLAPSE_PX` and `setState` **only on flag flip**. Cleanup on every `bodyEl` change + unmount: `observer.disconnect()` + `cancelAnimationFrame`.
- [ ] **Test (jsdom, mock `ResizeObserver` on `globalThis`):** fire widths 900 / 560 / 400 → `{false,false}` / `{true,false}` / `{true,true}`; assert rAF-coalescing doesn't over-render (flag-flip only); assert `undefined` `ResizeObserver` → `{false,false}` + no throw. (The mount→unmount→remount reattachment is asserted through the full-app render in T-4.1, which is where `bodyEl` actually toggles.)

**Acceptance:** thresholds map correctly; reattaches when `bodyEl` identity changes; fail-soft when `ResizeObserver` absent. Spec §2, AC#3.

---

## Phase 2 — Components

### T-2.1: `UsageCluster` component (#501) — extract + restyle from `UsageBars`

**Files:** `src/journal/components.tsx` (replace `UsageBars` with `UsageCluster`), `test/unit-tests/journal/usage-cluster-test.ts` (new).

- [ ] **Test first.** Render with: 12 limits (all render — no `slice(0,3)`); a `{label:'5h', percent: NaN}` entry → neutral `—` row with `.mj_UsageFill_unknown`, `aria-valuetext="usage unknown"`, no `aria-valuenow`, excluded from any "worst" summary; two limits sharing a label → two distinct rows, no React key warning; a blank-label limit → filtered out (pre-existing `.filter(l => l.label.trim())`).
- [ ] Implement `UsageCluster({ limits }: { limits: NonNullable<SessionStatus["limits"]> })`: map filtered limits (retain the blank-label trim) to compact `[label][track][pct]` rows; **key by array index** (dup-label safe; round-4 M5). For each: `const norm = normalizePercent(limit.percent)`. Finite → track width `norm%`, `.mj_UsageFill_${usageLevel(norm)}`, visible `${Math.round(norm)}%`, full progressbar ARIA (`aria-valuenow={norm}`, `aria-valuetext` incl. `resetDisplay`). Null → `.mj_UsageFill_unknown` hatched, visible `—`, `aria-valuetext="usage unknown"`, omit `aria-valuenow`. `useMinuteClock()` retained for reset display.
- [ ] Same component used inline and inside the popover (T-2.3) — no variant-specific label logic (labels always shown; T-3.3 removes the old label-drop).

**Acceptance:** all non-blank limits render; non-finite → unknown row not healthy `0%`; index keys (no dup-label collision); progressbar ARIA intact for finite. Spec §4, AC#1.

### T-2.2: `SubagentStrip` component (#502) — generalize `RunningSubagentStrip`

**Files:** `src/journal/components.tsx` (replace `RunningSubagentStrip`), `test/unit-tests/journal/subchat-strip-test.ts` (extend).

- [ ] **Test first.** Parent mode: all children render (running + non-running), running-first, running → spinner, non-running → `○` + `.mj_SubagentPill_finished`; an unknown `session_state:"queued"` → classified inactive (`○`/muted), NOT running. Child mode: siblings render, current sibling → `✓` + `.mj_SubagentPill_current` + `aria-current="true"` + `disabled`. ARIA: container `role="list"`; each chip a `role="listitem"` wrapper whose child is a real `<button>` (assert NO `role="listitem"` on the button). Empty children → renders `null`. Header no longer renders `.mj_SubagentSwitcher`.
- [ ] Implement `SubagentStrip({ client, state })`: derive list — parent mode `childrenOf(conversations, selectedConversationId)`, child mode `childrenOf(conversations, selected.parent_convo_id)`. Partition by `session_state === "running"`; running first (stable `created_at` order within bucket). Render `<div className="mj_SubagentStrip" role="list">` → per child `<div role="listitem" className="mj_SubagentPill_wrapper">` → `<button className="mj_SubagentPill[ _finished][ _current]" aria-label="Open subagent <title>" [aria-current] [disabled]>` spinner-or-glyph + `conversationTitle(child)`.
- [ ] Mode from the call site (`childMode`, `components.tsx:3189`) passed as prop.

**Acceptance:** all subagents shown, running-first, correct glyphs/modifiers; unknown state → inactive; ARIA wrapper preserves button role; `null` when empty; dropdowns removed. Spec §5, AC#2.

### T-2.3: `HeaderShell` component (#500 + #448) — shared shell with adaptive collapse + popovers

**Files:** `src/journal/components.tsx` (new component).

- [ ] Props: `{ mode: "parent"|"child"; onBack; backLabel; left: ReactNode; title: string; titleMeta: ReactNode; limits?; collapse: { usageCollapsed; titleCollapsed } }`.
- [ ] Render `.mj_ChatHeader` grid (`+ .mj_SubChatHeader` when child): back button; left cluster (`.mj_ModelContextCluster`, hidden inline + folded into title popover when `titleCollapsed`); center title (full `.mj_HeaderTitleCluster` when `!titleCollapsed`, else `.mj_HeaderMiniTitle` disclosure button + `.mj_HeaderMenu.mj_TitlePopover` holding title+titleMeta+left); right usage (full `.mj_UsageCluster`+`<UsageCluster>` when `!usageCollapsed`, else `.mj_HeaderMiniUsage` pill showing worst-finite `⬤ NN%` **+ unknown affix** `·—` when any unknown, opening `.mj_HeaderMenu.mj_UsagePopover` with `<UsageCluster>`).
- [ ] State: `usagePopoverOpen`, `titlePopoverOpen` + opener/panel refs; `useDismissablePopover` per popover; opening one closes the other (single-popover invariant).
- [ ] `useEffect` auto-close: close a popover when its collapse flag turns false **or** (usage) when `limits?.length` becomes 0; deps `[usageCollapsed, titleCollapsed, limits?.length]`. On programmatic close, if the closing panel contains `document.activeElement`, move focus to the now-expanded cluster's first focusable, **falling back to `.mj_BackButton`** when the cluster itself is gone (empty-limits path; round-4 M1).
- [ ] Mini triggers: **disclosure pattern** — `aria-expanded` + `aria-controls="<popover-id>"`, **no `aria-haspopup`** (round-4 M2); popovers `role="group"` + `aria-label`. Mini-title/mini-usage each need a `position: relative` anchor wrapper for the popover (T-3.3).

**Acceptance:** collapse flags swap full↔mini; click-toggle popovers open/close via the hook; single-popover invariant; auto-close on threshold-clear AND empty-limits with safe focus; disclosure ARIA (no haspopup mismatch); unknown affix visible in collapsed pill. Spec §3, AC#3/#4.

---

## Phase 3 — Wiring + CSS

### T-3.1: `ChatHeader` / `SubChatHeader` → thin wrappers over `HeaderShell`

**Files:** `src/journal/components.tsx`.

- [ ] `ChatHeader`: compute conversation/title, `status`, `limits = status?.limits?.filter(l => l.label.trim())`, `collapse` (prop from SignedInApp). Return `<HeaderShell mode="parent" onBack={client.clearSelection} left={<model+context+compact button>} title titleMeta={email} limits collapse/>`. Delete the `subagentsOpen` state + `.mj_SubagentSwitcher` dropdown JSX.
- [ ] `SubChatHeader`: same via `HeaderShell mode="child"`, `left` = model+context (no compact button), `titleMeta` = the existing `.mj_SubChatState` (`Running`/`Finished` text unchanged — pre-existing wording, follow-up loop), `onBack` = the existing `goBack`. Delete `siblingsOpen` + sibling dropdown.
- [ ] Net: ~95 lines duplication removed; both wrappers ~20-30 lines.

**Acceptance:** both headers render via `HeaderShell`; no `.mj_SubagentSwitcher` anywhere; existing back/compact/title/email/state behavior preserved. Spec §6, AC#4.

### T-3.2: `SignedInApp` — observer wiring + strip swap

**Files:** `src/journal/components.tsx` (~3126-3223).

- [ ] Add `const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null)` in `SignedInApp`; `const collapse = useAdaptiveHeader(bodyEl)` (unconditional top-level call).
- [ ] On the `.mx_RoomView_body` div (`3188`): `ref={setBodyEl}` (state-backed callback ref → reactive across the home↔room ternary + back-navigation remounts).
- [ ] Pass `collapse` into `<ChatHeader collapse={collapse}/>` / `<SubChatHeader collapse={collapse}/>`.
- [ ] Replace `<RunningSubagentStrip client={client} state={state}/>` (`3194`) with `<SubagentStrip client={client} state={state} mode={childMode ? "child" : "parent"}/>`.

**Acceptance:** one observer drives both header types; reattaches on remount; strip swapped. Spec §7, AC#3.

### T-3.3: `journal.pcss` header CSS (#500 + #501 + #502)

**Files:** `src/journal/journal.pcss` (header region only).

- [ ] **#501 usage:** restyle `.mj_UsageBars`/`.mj_UsageRow` to compact `[label][track][pct]` grid, micro type, `--cpd-*` spacing, right-aligned pct. Add `.mj_UsageFill_unknown` (hatched/indeterminate, muted `--cpd-*`, neither green nor red). Add **inline** `.mj_UsageBars { max-height: <~58px header band>; overflow-y: auto; overscroll-behavior: contain; }` (MA height bound). Keep `--cpd-color-usage-{low,medium,high}` + `--cpd-color-bg-usage-track`.
- [ ] **#500 mini + popovers:** `.mj_HeaderMiniUsage` / `.mj_HeaderMiniTitle` (pill-sized disclosure buttons, `:focus-visible` outline `2px var(--cpd-color-icon-accent-primary)`, worst-metric dot colored by level, unknown affix style). `.mj_UsagePopover { right: var(--cpd-space-2x); }`, `.mj_TitlePopover { left: var(--cpd-space-2x); right: var(--cpd-space-2x); width: auto; max-width: none; }` (real two-edge position clamp — B3) both `top: calc(100% + var(--cpd-space-2x))`; require the mini-trigger wrapper `position: relative` (or header-relative) anchor. Inherit `.mj_HeaderMenu` card.
- [ ] **#502 chips:** `.mj_SubagentPill_finished` (muted bg/border), `.mj_SubagentPill_current` (accent ring + `cursor:default`), `.mj_SubagentPill_wrapper { display: inline-flex; }` (listitem wrapper — **inline-flex NOT display:contents**, a11y-tree-safe; round-3 minor). Keep `.mj_SubagentStrip` overflow-x + scrollbar-thin.
- [ ] **Container-query reconciliation:** in `@container mj-room (max-width: 720px)` keep the `.mj_ChatHeader` grid-track collapse; **remove any `.mj_UsageRow` label-drop** (inline cluster only renders ≥700 where labels fit; below 700 it's the popover — round-4 B2). If the labelled 3-cell row is tight in 700–720, shorten via `usageBarLabel` + `min-content` label column, not by dropping the label.
- [ ] All new rules `--cpd-*` only; verify light + dark.

**Acceptance:** compact usage cluster both themes; unknown fill token present; inline height bounded; popovers position-clamped (no overflow at 390); chips styled; no label-drop band. Spec §CSS, AC#1/#3.

---

## Phase 4 — Integration gate

### T-4.1: Visual gate (real-DOM harness) + numeric AA

**Files:** extend the v3 reskin screenshot harness under `docs/design/` (hand-authored page); artifacts named `header-<state>-<theme>[-<width>].png`.

- [ ] **Collapse-state axis (harness-forced container width, deterministic):** wrap the header/`.mx_RoomView_body` in a harness container sized explicitly to `900` (expanded), `710` (expanded tight-label band — confirm labels present, round-4 B2), `560` (usage-collapsed), `400` (title+usage collapsed) px × { light, dark }. NOT sidebar-drag / viewport-shrink (unreachable — round-2 B3).
- [ ] **Layout/theme parity axis:** `1440×900` (expanded) + `390×844` (both collapsed) × { light, dark }.
- [ ] **State cells:** usage-popover-open (click mini-usage; in a high-count fixture **scroll to the last row** → confirm internal-scroll keeps it open + popover rows show labels); title-popover-open (confirm no horizontal overflow at 390); high-limit-count (≥12) at ≥700 → header row height unchanged + inner scroll (MA); subagent strip with running+finished chips; mixed `[NaN,10%]` usage → mini pill shows `10% ·—` unknown affix (B3).
- [ ] Capture + Read every cell. **Numeric AA:** compute contrast ratio from resolved `--cpd-*` values for each new fg/bg pair (percent text on cluster bg; worst-metric dot; unknown-row `—`; inactive-chip text) in both themes; assert ≥ 4.5:1 (text) / ≥ 3:1 (non-text UI). Listed pass/fail per pair, not eyeballed.

**Acceptance:** every matrix cell captured + Read; no overflow/clipping at 390; labels present in popover + 710 band; height bound holds; unknown affix visible; all AA pairs pass. Spec Testing §4/§5, AC#1/#3.

### T-4.2: Lint, full suite, Codex review, rebase

- [ ] `corepack pnpm lint` (types + prettier) green.
- [ ] `corepack pnpm test` (jest) green — including the new `usage-cluster-test.ts`, `adaptive-header-test.ts`, extended `subchat-strip-test.ts`, and B1 lifecycle test (render with no conversation → select → below-threshold entry collapses → `clearSelection()` → reselect → entry still collapses; observer reattached).
- [ ] Codex adversarial review on the branch diff (`/codex-review` or `codex_adversarial_exec.sh --kind diff`); residuals either fixed or filed as follow-up loops.
- [ ] **Rebase `vps-header` on `origin/main`** (the two sibling windows may have merged); re-verify no header-region conflicts; re-run lint + test.

**Acceptance:** lint + test green post-rebase; Codex review clean or residuals owned; branch rebased on latest main. Spec AC#6/#7.

---

## Spec-coverage map

| Spec part | Task(s) |
|---|---|
| §1 useDismissablePopover (+internal-scroll) | T-1.2 |
| §2 useAdaptiveHeader (callback-ref, rAF, fail-soft) | T-1.3, T-3.2 |
| §3 HeaderShell (collapse, popovers, auto-close, focus, unknown affix) | T-2.3 |
| §4 UsageCluster + normalizePercent/worstLimit + index keys + blank filter | T-1.1, T-2.1 |
| §5 SubagentStrip (all children, classification, listitem ARIA) | T-2.2 |
| §6 thin wrappers (dedup, dropdowns removed) | T-3.1 |
| §7 SignedInApp wiring (ref, observer, strip swap) | T-3.2 |
| §CSS (usage restyle, mini/popover clamps, chip modifiers, no label-drop) | T-3.3 |
| Accessibility (disclosure ARIA, progressbar, list/listitem, AA) | T-2.1, T-2.2, T-2.3, T-3.3, T-4.1 |
| Testing §1-§5 | T-1.x tests, T-2.x tests, T-4.1, T-4.2 |
| AC#1-#7 | mapped across all phases; #7 (merge-only, rebase) T-4.2 |
| Follow-ups (Finished wording; content-fit) | filed at /close, NOT in this plan |

No uncovered spec part. No new auth/RLS/payments/deployment/data-loss surface (pure presentational; `SessionStatus` read-only) — no material scope creep.

## Principles pass (matron-web fork)

`docs/universal-design-principles.md` / `design-principles.md` are son-of-anton-only (absent here). Applied by convention: fail-visible (T-1.1 non-finite → unknown, not healthy 0%), guard-boundary-inputs (T-1.1 clamp, T-2.1 blank-label/dup-label), single-contract (spec↔plan↔test kept consistent through review), no-new-files + read-only-data-flow (fork divergence-minimization). Deliberate exception: fixed collapse thresholds (not content-fit) — operator-directed simplification, one-line noted in spec §2.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
