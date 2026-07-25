# Implementation plan — Adaptive header + usage cluster + subagent strip (#500 / #501 / #502)

**Spec:** `docs/superpowers/specs/2026-07-24-web-header-adaptive-usage-subagent-design.md` (converged spec-review round 4, v5)
**Repo:** `easelyte/matron-web` · **Branch:** `vps-header` (off `origin/main`) · **Worktree:** `/opt/matron/web-wt-header` (see Execution prerequisite — NOT the shared `/opt/matron/web-journal` checkout)
**Stack:** React + TypeScript, PostCSS (`--cpd-*` Compound tokens), jest + jsdom (`test/unit-tests/journal/**/*-test.ts`), `corepack pnpm` build.
**Merge only — no live deploy** (batched across the three parallel header/UI windows). **Rebase on `origin/main` before ship.**

## Execution prerequisite (worktree isolation — round-1 B1, already satisfied)

Three sibling windows touch this repo. The header work MUST run in the **isolated worktree** `/opt/matron/web-wt-header` (branch `vps-header`), **not** the shared `/opt/matron/web-journal` checkout — that checkout is the voice/ANSI window's and switching branches there re-collides (round-1 B1: 6 commits initially landed on the sibling's `vps-voice-ansi` before this was corrected). State when this plan was written: `vps-header` = `origin/main` + the spec/plan commits, worktree clean. Executor invariant before T-1.1: `git -C /opt/matron/web-wt-header rev-parse --abbrev-ref HEAD` == `vps-header`, base = `origin/main`. All `git`/`pnpm`/Edit/Read/Write use worktree-absolute paths. (P41 worktree-aware path resolution.)
- **Untracked review artifacts are expected, not blocking (round-2 Codex M3):** `memory/pattern_notes/rounds/<session>/plan-review-*.md` are this chain's transient review telemetry (owned by the planning session, cleaned at `/close`). The "clean status" invariant means **no unintended edits to tracked source**; these untracked artifacts under `memory/` are not implementation state — do not delete, commit, or block on them. (If `memory/` noise is undesirable, the executor may `echo "memory/" >> .git/info/exclude` in the worktree — a local-only ignore, not a committed `.gitignore` change.)
- **Coordinate grounding — confirmed at plan time, re-ground after rebase (round-2/round-3 Codex M4 / P35).** Verified against HEAD (`b528fea`): `status.ts` exports `compactTokens`/`usageBarLabel`/`usageLevel`/`resetDisplay` (`status.ts:10/18/28/34`); `.mx_RoomHeader { position: relative }` (`journal.pcss:65`) — so `.mj_ChatHeader` (co-classed `.mx_RoomHeader`) is a positioned containing block; the TWO `.mj_UsageRow` single-column overrides exist at `@container mj-room (max-width:720px)` → `.mj_UsageRow` (`journal.pcss:308`/`321`) and `@media (max-width:700px)` → `.mj_UsageRow` (`journal.pcss:1734`/`1769`). These line numbers are HEAD-relative and **WILL drift after the T-4.1 rebase** — treat line numbers as hints, selectors/symbols as ground truth, and `grep -n` each cited selector again post-rebase before editing.

## Scope boundary (owner window)

Touch **only** the header region: `src/journal/components.tsx` (ChatHeader ~1254, SubChatHeader ~1351, UsageBars ~1223, RunningSubagentStrip ~3099, SignedInApp wiring ~3126-3223) + `src/journal/journal.pcss` header rules (~77-333, `.mj_HeaderMenu` ~353, `.mj_Subagent*` ~388) + pure helpers in `src/journal/status.ts` + tests. **Do NOT** touch the composer, timeline, client/WS, or `SessionStatus` data flow. No new source files (fork divergence-minimization) — new units land in the existing files. No `journal.pcss` file split (separate loop).

**P18 exception (accepted, round-2 Codex M2).** Adding `useDismissablePopover`/`useAdaptiveHeader`/`UsageCluster`/`SubagentStrip`/`HeaderShell` to a `components.tsx` already >3200 lines grows a monolith (P18 cognitive-budget). This is a **bounded, operator-directed exception**, not an oversight: the spec's fork-divergence-minimization rule (matron-web is Dan's fork; new source files fork his module layout and complicate upstream logic merges) overrides P18 here, the same tradeoff the v3 reskin accepted. The extraction (`components.tsx`/`client.ts`/`journal.pcss` split) is already owned by **loop #448** (P18 debt, filed). Net LOC is near-flat anyway — the shared `HeaderShell` removes ~95 lines of ChatHeader/SubChatHeader duplication while adding the new units.

## Task ID legend

Numeric phases (`## Phase N`), tasks `### T-N.X`. Each task: TDD where the unit is logic-testable (test step precedes implementation), concrete steps, per-task acceptance. `[ ]` checkboxes for tracking.

**Test-seam / export contract (round-2 Codex M1).** Tests that render/invoke a unit directly require that unit to be importable. `components.tsx` today exports only `MatronApp`. Therefore: `normalizePercent`/`worstLimit` (`status.ts`) get named `export`s (already stated); and `useDismissablePopover`, `useAdaptiveHeader`, `UsageCluster`, `SubagentStrip`, **and `HeaderShell`** get **named `export`s from `components.tsx`** so their `*-test.ts` files AND the T-4.2 visual-gate harness can import them (round-3 Codex B2: harness mounts `HeaderShell`; round-4 Codex B2: T-1.2's direct `Probe` test imports `useDismissablePopover`, so it too must be exported — a separate test file cannot import a module-private symbol). Exporting a symbol is not a "new source file" and doesn't fork Dan's layout — it's additive. Every unit with a direct test or harness mount is exported per this contract; nothing stays module-private.

## Dependency graph

```
Phase 1  (pure primitives — no UI wiring; SERIAL — shared files)
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
Phase 4  (integration gate — rebase FIRST so the gate validates the shipped surface)
  T-4.1 rebase on origin/main + re-ground coordinates
  T-4.2 visual gate (real bundled components; widths + themes + AA)
  T-4.3 lint + full suite + Codex review of post-rebase diff
```

**Concurrency + worktree topology (round-3 Codex B1/B3 — SERIAL, single worktree).** Almost every task mutates the **same** `src/journal/components.tsx` (T-1.2, T-1.3, T-2.1, T-2.2, T-2.3, T-3.1, T-3.2) or the same `journal.pcss` (T-3.3) / `status.ts` (T-1.1). Therefore tasks are **NOT parallelizable** — they run **sequentially, one implementer at a time**, each committing to `vps-header` before the next starts (concurrent implementers would overwrite each other's uncommitted edits in the shared file). The dependency arrows show *logical* order (what must exist before what); execution is strictly serial.
**Worktree lane:** this is a **sibling-repo** (matron-web) change driven from a son-of-anton session. Per the cross-repo slim-chain pattern (`cross_repo_slim_chain_workdir_flag` / `sibling_repo_worktree_launch`), the isolation lane is the **matron-web worktree `/opt/matron/web-wt-header`** reached **by path** — `/execute-slim` implementers do NOT spawn their own matron-web worktree (a son-of-anton worktree never contains the sibling repo); they Edit/Read/Write `/opt/matron/web-wt-header/...` by absolute path and run `pnpm`/`git` via `-C /opt/matron/web-wt-header` or `--prefix`. The single `vps-header` worktree is the R100/P41 isolation boundary for this sibling work; sequential commits are the integration mechanism.

---

## Phase 1 — Pure primitives (status helpers + hooks)

### T-1.1: `normalizePercent` + `worstLimit` in `status.ts` (fail-visible boundary)

**Files:** `src/journal/status.ts`, `test/unit-tests/journal/status-test.ts` (extend) or new `usage-cluster-test.ts`.

- [ ] **Test first.** Add cases: `normalizePercent(NaN | Infinity | -Infinity)` → `null`; `normalizePercent(-5)` → `0`; `normalizePercent(150)` → `100`; `normalizePercent(42.4)` → `42.4` (no premature rounding — rounding for display is the caller's job). `worstLimit([])` → `undefined`; `worstLimit([{percent: NaN}])` → `undefined` (all-unknown); `worstLimit([{label:'a',percent:NaN},{label:'b',percent:10}])` → the `b`/10 entry (unknown ignored); ties → first.
- [ ] Implement `export function normalizePercent(p: number): number | null` = `Number.isFinite(p) ? Math.min(Math.max(p, 0), 100) : null`.
- [ ] Implement `export function worstLimit(limits: NonNullable<SessionStatus["limits"]>): NonNullable<SessionStatus["limits"]>[number] | undefined` (return type uses `NonNullable<...>[number]` — `SessionStatus["limits"]` is optional, so indexing the bare union is a TS error; round-1 Codex M3) — max by `normalizePercent(l.percent)` over entries whose normalized value is non-null; `undefined` if none finite.
- [ ] Keep existing `usageLevel`/`usageBarLabel`/`resetDisplay`/`compactTokens` unchanged.

**Acceptance:** new unit cases green; `normalizePercent` maps non-finite → `null` (NOT `0` — P3 fail-visible); `worstLimit` ignores unknowns and returns `undefined` only when no finite entry exists. Spec §4 / AC#1.

### T-1.2: `useDismissablePopover` hook (header-scoped, in `components.tsx`)

**Files:** `src/journal/components.tsx` (new hook near the other header helpers), `test/unit-tests/journal/adaptive-header-test.ts` (its own direct tests — round-3 Codex Major1: the earlier "covered indirectly by T-4.1" reference was stale, T-4.1 is now the rebase task; every close path must have a direct automated test).

- [ ] Signature `useDismissablePopover(open: boolean, close: () => void, refs: { openerRef: RefObject<HTMLElement>; panelRef: RefObject<HTMLElement> })`.
- [ ] When `open`, on `document`: `pointerdown` → close if `!openerRef.current?.contains(t) && !panelRef.current?.contains(t)` (opener-ref guard added vs the room-menu pattern at `components.tsx:706-725`, so a click on the trigger doesn't reopen-then-close); `keydown` Escape → `close()` then `openerRef.current?.focus()`; capture-phase `scroll` → close **only if** `!panelRef.current?.contains(e.target as Node)` (internal-scroll exception — the popover is itself a scroll container; round-2 Codex B1).
- [ ] Cleanup removes all three listeners. Model on `706-725` but **do not modify** the existing room/account/event menus (out-of-window).
- [ ] **Test (this task owns them — round-3 Codex Major1):** a minimal `Probe` mounting a trigger + panel via `useDismissablePopover`, asserting each accepted close path directly: (a) `pointerdown` outside both refs closes; (b) `pointerdown` on the opener does NOT close-then-reopen; (c) Escape closes + focus returns to opener; (d) a `scroll` outside the panel closes, but a `scroll` whose target is inside `panelRef` does NOT; (e) after close/unmount, the three `document` listeners are removed (no leak — spy on `removeEventListener` or assert a post-unmount outside-click is a no-op).

**Acceptance:** hook attaches/detaches by `open`; every close path (outside-click, Escape+focus-return, outside-scroll) directly tested; internal-scroll does NOT close; listeners removed on cleanup. Spec §1.

### T-1.3: `useAdaptiveHeader(bodyEl)` hook (ResizeObserver, callback-ref lifecycle)

**Files:** `src/journal/components.tsx`, `test/unit-tests/journal/adaptive-header-test.ts` (new — see T-4.1 for the render-driven cases; this task owns the hook + its direct tests).

- [ ] Module constants `const USAGE_COLLAPSE_PX = 700; const TITLE_COLLAPSE_PX = 460;` (invariant `TITLE < USAGE`).
- [ ] Signature `useAdaptiveHeader(bodyEl: HTMLElement | null): { usageCollapsed: boolean; titleCollapsed: boolean }`. Takes the **element as a value** (from a state-backed callback ref), NOT a stable `RefObject` — `.mx_RoomView_body` is conditionally mounted (spec §2/§7, B1).
- [ ] `useEffect` **keyed on `bodyEl`**: if `bodyEl == null` or `typeof ResizeObserver === "undefined"` → set `{false,false}`, install nothing (fail-soft). Else attach a `ResizeObserver` on `bodyEl`; callback stashes latest width (`entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width`), schedules one rAF if none pending; the frame computes `width < USAGE_COLLAPSE_PX` / `< TITLE_COLLAPSE_PX` and `setState` **only on flag flip**. Cleanup on every `bodyEl` change + unmount: `observer.disconnect()` + `cancelAnimationFrame`.
- [ ] **Test (jsdom, `adaptive-header-test.ts`, mock `ResizeObserver` on `globalThis`), hook-level only in this phase:** render a **minimal test harness component** (`function Probe({ el }) { return JSON.stringify(useAdaptiveHeader(el)); }`) with a controlled detached `<div>` element as `el`; fire mock RO entries at widths 900 / 560 / 400 → `{false,false}` / `{true,false}` / `{true,true}`; assert rAF-coalescing over-render guard (flag-flip only); assert `el={null}` and `undefined` `ResizeObserver` → `{false,false}` + no throw; assert passing a **new** element re-runs the effect (detach old observer, observe new). The **full-app mount→unmount→remount** lifecycle test is **deferred to T-3.2** (it needs the `ref={setBodyEl}` + `useAdaptiveHeader(bodyEl)` wiring that T-3.2 adds — round-1 B2; authoring it here would fail because the wiring doesn't exist yet).

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

- [ ] **Test first.** Parent mode: all children render (running + non-running), running-first, running → spinner, non-running → `○` + `.mj_SubagentPill_finished`; an unknown `session_state:"queued"` → classified inactive (`○`/muted), NOT running. Child mode: siblings render, current sibling → `✓` + `.mj_SubagentPill_current` + `aria-current="true"` + `disabled`. ARIA: container `role="list"`; each chip a `role="listitem"` wrapper whose child is a real `<button>` (assert NO `role="listitem"` on the button). Empty children → renders `null`. (The "header no longer renders `.mj_SubagentSwitcher`" assertion is **T-3.1's** — the dropdowns still exist in the headers until T-3.1 removes them; round-1 B2.)
- [ ] Implement `SubagentStrip({ client, state, mode }: { client; state; mode: "parent" | "child" })` — **`mode` is a declared prop** (T-3.2 passes it; omitting it from the signature is a TS error, round-1 B2). Derive list — parent mode `childrenOf(conversations, selectedConversationId)`, child mode `childrenOf(conversations, selected.parent_convo_id)`. Partition by `session_state === "running"`; running first (stable `created_at` order within bucket). Render `<div className="mj_SubagentStrip" role="list">` → per child `<div role="listitem" className="mj_SubagentPill_wrapper">` → `<button className="mj_SubagentPill[ _finished][ _current]" aria-label="Open subagent <title>" [aria-current] [disabled]>` spinner-or-glyph + `conversationTitle(child)`.

**Acceptance:** all subagents shown, running-first, correct glyphs/modifiers; unknown state → inactive; ARIA wrapper preserves button role; `null` when empty; `mode` prop typed. (Dropdown removal is verified in T-3.1.) Spec §5, AC#2.

### T-2.3: `HeaderShell` component (#500 + #448) — shared shell with adaptive collapse + popovers

**Files:** `src/journal/components.tsx` (new component).

- [ ] Props: `{ mode: "parent"|"child"; onBack; backLabel; left: ReactNode; title: string; titleMeta: ReactNode; limits?; collapse: { usageCollapsed; titleCollapsed } }`.
- [ ] Render `.mj_ChatHeader` grid (`+ .mj_SubChatHeader` when child): back button; left cluster (`.mj_ModelContextCluster`, hidden inline + folded into title popover when `titleCollapsed`); center title (full `.mj_HeaderTitleCluster` when `!titleCollapsed`, else `.mj_HeaderMiniTitle` disclosure button + `.mj_HeaderMenu.mj_TitlePopover` holding title+titleMeta+left); right usage (full `.mj_UsageCluster`+`<UsageCluster>` when `!usageCollapsed`, else `.mj_HeaderMiniUsage` pill showing the worst-finite metric as `⬤ NN%` where **`const wn = normalizePercent(worst.percent) ?? 0`** (the `?? 0` coalesces `normalizePercent`'s `number | null` to a plain `number` for the `Math.round(wn)` text + `usageLevel(wn)` color — the `null` branch is unreachable since `worstLimit` only returns entries with a finite normalized percent, but the coalesce keeps `tsc` happy without a non-null assertion; round-4 minor). `worstLimit` returns the raw limit object, so the pill MUST re-normalize its `.percent`, else `{percent:150}` renders `150%` on the pill while the row shows `100%` (round-3 Codex Major2); **+ unknown affix** `·—` when any unknown; opening `.mj_HeaderMenu.mj_UsagePopover` with `<UsageCluster>`).
- [ ] State: `usagePopoverOpen`, `titlePopoverOpen` + opener/panel refs; `useDismissablePopover` per popover; opening one closes the other (single-popover invariant).
- [ ] **Focus model — FROZEN after 4 review passes on this surface (round-1 B3, round-2 Codex B2/Claude M2, round-3 Codex Major3/Claude B1). Minimal correct design, no spanning wrapper, single restore target:**
  - **On open:** move focus into the panel — the `.mj_HeaderMenu` popover container is `role="group" tabIndex={-1}` and gets `.focus()` in a `useLayoutEffect` gated on the open flag (standard disclosure pattern; makes focus defined + inside the panel, since `UsageCluster`/title content have no naturally-focusable children).
  - **Ownership tracking — per-element handlers, NOT a spanning wrapper (resolves round-3 Codex Major3 / Claude M1: a wrapper spanning trigger+popover would make the popovers grandchildren and contradict the direct-child anchoring; a Fragment can't host handlers).** A single `focusHeldRef` boolean is set by handlers on the **two individual elements that exist** — `onFocus` on the mini-trigger button (`focusHeldRef.current = true`) and `onFocusCapture` on the panel (`= true`), each with an `onBlur` that sets it false only when `relatedTarget` leaves that element/subtree. No wrapper element; the popovers stay direct children of `.mj_ChatHeader`.
  - **`focusHeldRef` has ONE meaning: "is focus right now on the mini-trigger or in the panel," maintained solely by the onFocus/onBlur handlers above — there is NO separate "reset on user-directed close" step (round-4 Codex B3: that reset contradicted itself, since Escape's `openerRef.focus()` immediately re-fires the trigger's `onFocus` and re-arms the flag).** This single-source-of-truth boolean is correct for every sequence: after Escape, focus legitimately sits on the mini-trigger → flag true; if the header then expands and unmounts that trigger, restoring to `.mj_BackButton` is the *right* graceful outcome (focus was on a now-removed node); if instead the user clicks away (composer etc.), `onBlur` sets the flag false → a later resize does NOT steal focus.
  - **On programmatic auto-close** (collapse flag clears, or usage `limits?.length` → 0; deps `[usageCollapsed, titleCollapsed, limits?.length]`): if `focusHeldRef.current` is true, restore focus to **`.mj_BackButton`** — a single stable, always-present, always-focusable node (do NOT hunt for "the expanded cluster's first focusable," which doesn't exist — the inline clusters render only spans/progressbars/heading; round-3 Claude B1). Never `document.body`. **Test the Escape-then-resize sequence** (open → Escape → focus on trigger → cross expansion threshold → focus lands on `.mj_BackButton`, not body) alongside the direct auto-close-with-focus-in-panel test (round-4 Codex B3).
- [ ] Mini triggers: **disclosure pattern** — `aria-expanded` + `aria-controls="<popover-id>"`, **no `aria-haspopup`** (round-4 M2); popovers `role="group"` + `aria-label` + `tabIndex={-1}` (focus target). **Popover anchoring (both popovers header-relative, no local wrapper — resolves M1/M2/M3 once):** BOTH `.mj_TitlePopover` and `.mj_UsagePopover` are **DOM descendants of `.mj_ChatHeader`** (rendered directly inside it — no intervening *positioned* element, so the header, already `position: relative` via `.mx_RoomHeader` `journal.pcss:65`, is the containing block for both). Title popover: `left/right: var(--cpd-space-2x)` (header-width two-edge clamp, no 390px overflow). Usage popover: `right: var(--cpd-space-2x)` (flush to header right edge). **Neither mini trigger gets a `position: relative` wrapper** (that would become the containing block and reintroduce round-3 B3). The per-element focus handlers above do NOT introduce a positioned wrapper.

**Acceptance:** collapse flags swap full↔mini; click-toggle popovers open/close via the hook; single-popover invariant; **focus moves into the panel on open** (asserted); auto-close on threshold-clear AND empty-limits restores focus to `.mj_BackButton` (never `document.body`), verified for the *populated* usage/title case too (round-3 Claude B1), with ownership captured pre-unmount via per-element handlers (no spanning wrapper); disclosure ARIA; unknown affix visible in collapsed pill; both popovers header-anchored (no 390px overflow). Spec §3, AC#3/#4.

---

## Phase 3 — Wiring + CSS

### T-3.1: `ChatHeader` / `SubChatHeader` → thin wrappers over `HeaderShell`

**Files:** `src/journal/components.tsx`.

- [ ] `ChatHeader`: compute conversation/title, `status`, `limits = status?.limits?.filter(l => l.label.trim())`, `collapse` (prop from SignedInApp). Return `<HeaderShell mode="parent" onBack={() => client.clearSelection()} left={<model+context+compact button>} title titleMeta={email} limits collapse/>` — **`onBack` MUST be the arrow wrapper `() => client.clearSelection()`, NOT the bare `client.clearSelection`** (round-4 Codex B1: `clearSelection` is a `MatronJournalClient` method that dereferences `this` — `client.ts:483`; passing it detached loses the receiver and throws; matches the existing `components.tsx:1266` pattern). Delete the `subagentsOpen` state + `.mj_SubagentSwitcher` dropdown JSX.
- [ ] `SubChatHeader`: same via `HeaderShell mode="child"`, `left` = model+context (no compact button), `titleMeta` = the existing `.mj_SubChatState` (`Running`/`Finished` text unchanged — pre-existing wording, follow-up loop), `onBack` = the existing `goBack`. Delete `siblingsOpen` + sibling dropdown.
- [ ] Net: ~95 lines duplication removed; both wrappers ~20-30 lines.
- [ ] **Test (this task owns it — round-1 B2):** extend `subchat-strip-test.ts`/`components-test.ts` to assert the headers render **no** `.mj_SubagentSwitcher` after the wrapper refactor (the removal happens here, so the assertion lives here, not in T-2.2).

**Acceptance:** both headers render via `HeaderShell`; no `.mj_SubagentSwitcher` anywhere (asserted here); existing back/compact/title/email/state behavior preserved. Spec §6, AC#4.

### T-3.2: `SignedInApp` — observer wiring + strip swap

**Files:** `src/journal/components.tsx` (~3126-3223).

- [ ] Add `const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null)` in `SignedInApp`; `const collapse = useAdaptiveHeader(bodyEl)` (unconditional top-level call).
- [ ] On the `.mx_RoomView_body` div (`3188`): `ref={setBodyEl}` (state-backed callback ref → reactive across the home↔room ternary + back-navigation remounts).
- [ ] Pass `collapse` into `<ChatHeader collapse={collapse}/>` / `<SubChatHeader collapse={collapse}/>`.
- [ ] Replace `<RunningSubagentStrip client={client} state={state}/>` (`3194`) with `<SubagentStrip client={client} state={state} mode={childMode ? "child" : "parent"}/>`.
- [ ] **Test (this task owns the full-app lifecycle test — moved from T-1.3 per round-1 B2, since the wiring above is its prerequisite):** in `adaptive-header-test.ts`, full-app `createRoot` render with mock `ResizeObserver`: render with **no** conversation selected (`.mx_RoomView_body` absent) → select a conversation → fire a below-`USAGE_COLLAPSE_PX` entry → assert usage collapses; then `client.clearSelection()` (back to home, body unmounts) → reselect → fire an entry → assert collapse **still** fires (observer reattached to the new node). Also assert the focus-restoration paths from T-2.3 (open a popover → focus enters the panel; then cross the expansion threshold / set `limits` empty → focus lands on `.mj_BackButton`, never `document.body`; verify for a **populated** usage cluster, not just the empty-limits edge — round-3 Claude B1).

**Acceptance:** one observer drives both header types; reattaches on remount (full-app lifecycle test green); strip swapped; focus restoration verified. Spec §7, AC#3.

### T-3.3: `journal.pcss` header CSS (#500 + #501 + #502)

**Files:** `src/journal/journal.pcss` (header region only).

- [ ] **#501 usage:** restyle `.mj_UsageBars`/`.mj_UsageRow` to compact `[label][track][pct]` grid, micro type, `--cpd-*` spacing, right-aligned pct. Add `.mj_UsageFill_unknown` (hatched/indeterminate, muted `--cpd-*`, neither green nor red). Add **inline** `.mj_UsageBars { max-height: 58px; overflow-y: auto; overscroll-behavior: contain; }` (MA height bound; `58px` = the existing header band — mirrors the pre-existing raw `min-height: 58px` on `.mj_ModelContextCluster`/`.mj_UsageCluster` at `journal.pcss:108`/`253`, so it stays consistent with the current header height; round-1 Codex M3 placeholder resolved). Keep `--cpd-color-usage-{low,medium,high}` + `--cpd-color-bg-usage-track`.
- [ ] **#500 mini + popovers:** `.mj_HeaderMiniUsage` / `.mj_HeaderMiniTitle` (pill-sized disclosure buttons, `:focus-visible` outline `2px var(--cpd-color-icon-accent-primary)`, worst-metric dot colored by level, unknown affix style). **Anchoring — BOTH popovers header-relative (round-1/round-2, single containing block):** both `.mj_TitlePopover` and `.mj_UsagePopover` are DOM children of `.mj_ChatHeader` (already `position: relative` via `.mx_RoomHeader`, `journal.pcss:64-67`), so the header is the containing block for both — NO `position: relative` on either mini trigger or a local wrapper (that reintroduces round-3 B3). `.mj_TitlePopover { left: var(--cpd-space-2x); right: var(--cpd-space-2x); width: auto; max-width: none; top: calc(100% + var(--cpd-space-2x)); }` (header-width two-edge clamp). `.mj_UsagePopover { right: var(--cpd-space-2x); top: calc(100% + var(--cpd-space-2x)); }` (flush to header right edge, under the mini-usage column; on-screen via inherited `width: min(280px, calc(100vw - 32px))`). Both `role="group" tabIndex=-1` (focus target, per T-2.3) and inherit the `.mj_HeaderMenu` card.
- [ ] **#502 chips:** `.mj_SubagentPill_finished` (muted bg/border), `.mj_SubagentPill_current` (accent ring + `cursor:default`), `.mj_SubagentPill_wrapper { display: inline-flex; }` (listitem wrapper — **inline-flex NOT display:contents**, a11y-tree-safe; round-3 minor + verified-claims c2). Keep `.mj_SubagentStrip` overflow-x + scrollbar-thin.
- [ ] **Usage-row override reconciliation — BOTH sites (round-1 Claude M2).** Two independent rules force `.mj_UsageRow` single-column: (a) the `@container mj-room (max-width: 720px)` rule (`journal.pcss:321-324`), and (b) a **viewport** `@media (max-width: 700px)` rule (`journal.pcss:1769-1776`, `grid-template-columns: 1fr` + `.mj_UsageTrack { width: 58px }`). Rule (b) fires on any real phone ≤700px **regardless of container width**, so — because the popover's `UsageCluster` is non-portaled and shares the same `.mj_UsageRow` markup — it would collapse the **popover** rows to single-column on mobile, breaking "popover rows unconditionally full." Fix: **scope BOTH overrides to the inline cluster only** — change their `.mj_UsageRow` selectors to `.mj_UsageCluster .mj_UsageRow` (and `.mj_UsageCluster .mj_UsageTrack`), so `.mj_UsagePopover .mj_UsageRow` (different ancestor) keeps the full `[label][track][pct]`. Remove any label-*drop* in the inline band too (round-4 B2 — the inline cluster only renders ≥700; shorten via `usageBarLabel` + `min-content` label column if tight, don't drop the label). Keep the `.mj_ChatHeader` grid-track collapse in the `@container` rule.
- [ ] All new rules `--cpd-*` only (except the `58px` height band mirroring existing code); verify light + dark; verify popover rows stay full-column at a 390px viewport.

**Acceptance:** compact usage cluster both themes; unknown fill token present; inline height bounded at 58px; title popover header-anchored + usage popover right-anchored (no overflow at 390); popover rows full-column even at ≤700px viewport (both override sites scoped inline-only); chips styled; no label-drop band. Spec §CSS, AC#1/#3.

---

## Phase 4 — Integration gate

**Ordering (round-1/round-2 Codex): rebase FIRST, THEN the visual gate, THEN lint/test/review — so the visual matrix and the adversarial review both validate the *post-rebase* surface that actually ships. A conflict-bearing rebase after the gate would ship an unvalidated layout.**

### T-4.1: Rebase on latest main (FIRST)

- [ ] `git -C /opt/matron/web-wt-header fetch origin && git -C /opt/matron/web-wt-header rebase origin/main` — the sibling header/UI windows may have merged. Resolve any header-region conflicts (`components.tsx`/`journal.pcss`); if a shared JSON (loop store) conflicts, take main + re-apply. Re-verify scope.
- [ ] **Re-ground coordinates post-rebase (round-2 Codex M4 / P35):** `grep -n` each cited `journal.pcss` selector + `components.tsx` anchor; line numbers drift on rebase — selectors are ground truth.

**Acceptance:** branch rebased on latest `origin/main`; header-region conflicts resolved; cited coordinates re-grounded.

### T-4.2: Visual gate (real-DOM harness, post-rebase) + numeric AA

**Files:** build the harness in a **scratch dir OUTSIDE the repo/deploy root** — e.g. `/tmp/header-gate/` (round-1 Claude M1: `docs/design/` holds only the static `matron-redesign-v3.dc.html` import bundle, NOT a component harness; a harness under the deploy/`webapp` root gets shipped publicly or erased by the build). Do NOT check the harness in. Artifacts named `header-<state>-<theme>[-<width>].png`.
- [ ] **Harness must render the REAL bundled components (round-2 Codex B3 — a static DOM snapshot has no React handlers / ResizeObserver / rAF / popover state, so click, internal-scroll, and adaptive-collapse cells would falsely pass while the hooks are broken).** Steps: (1) `corepack pnpm build` in the worktree; (2) a tiny bundled entry mounts the real `HeaderShell`/`UsageCluster`/`SubagentStrip` (via the named exports, test-seam contract) with a mock `MatronJournalClient` + fixture `ClientState` (model, email, N limits incl. one unknown, running+finished subagents), linking the built CSS; before each cell, set `document.documentElement.dataset.theme = "dark"` for dark or remove the `data-theme` attribute for light, then assert the resolved `--cpd-color-bg-canvas-default` is `#1a1c20` for dark (`#fff` for light) before capture so a missing theme application fails the harness; (3) the container `width` is set inline per cell — the real `useAdaptiveHeader` ResizeObserver reads it and drives collapse. Static markup is permitted ONLY for a purely-inert styling reference cell, never for interactive cells. Drive captures with the headless-Chrome tooling the v3 reskin gate used.
- [ ] **Collapse-state axis (harness-forced container width, deterministic):** container sized to `900` (expanded), `710` (expanded tight-label band — labels present, round-4 B2), `560` (usage-collapsed), `400` (title+usage collapsed) px × { light, dark }.
- [ ] **Layout/theme parity axis:** `1440×900` (expanded) + `390×844` (both collapsed) × { light, dark }.
- [ ] **Interactive state cells (real components):** usage-popover-open (click mini-usage; high-count fixture → **scroll to last row** → internal-scroll keeps it open + popover rows show labels + stay full-column at 390px viewport, round-1/2); title-popover-open (no horizontal overflow at 390); focus-into-panel on open (assert `document.activeElement` is the panel); high-limit-count (≥12) at ≥700 → header height unchanged + inner scroll (MA); subagent strip running+finished; mixed `[NaN,10%]` usage → mini pill `10% ·—` affix (B3).
- [ ] Capture + Read every cell. **Numeric AA:** compute contrast ratio from resolved `--cpd-*` values for each new fg/bg pair (percent text on cluster bg; worst-metric dot; unknown-row `—`; inactive-chip text) both themes; assert ≥ 4.5:1 (text) / ≥ 3:1 (non-text UI). Listed pass/fail per pair, not eyeballed.

**Acceptance:** every matrix cell captured + Read against the REAL components; no overflow/clipping at 390; labels present in popover + 710 band; popover rows full-column at ≤700px viewport; focus enters panel on open; height bound holds; unknown affix visible; all AA pairs pass. Spec Testing §4/§5, AC#1/#3.

### T-4.3: Lint, full suite, final adversarial review

- [ ] `corepack pnpm lint` (types + prettier) green.
- [ ] `corepack pnpm test` (jest) green — the new `usage-cluster-test.ts`, `adaptive-header-test.ts` (threshold + full-app mount/remount lifecycle + focus restoration, per T-3.2), and extended `subchat-strip-test.ts`.
- [ ] Codex adversarial review on the **post-rebase** branch diff (`codex_adversarial_exec.sh --kind diff` / `/codex-review`); residuals fixed or filed as follow-up loops.

**Acceptance:** lint + test green; Codex review of the post-rebase diff clean or residuals owned. Spec AC#6/#7.

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

---

## Appendix: Verified Claims (research pass 2026-07-24)

Tavily unavailable in this context (`TAVILY_API_KEY` unset); c1/c2 verified via WebSearch against MDN + a11y sources, c3 grounded in the CSS Containment spec.

✓ **c1 — ResizeObserver width source.** `ResizeObserverEntry.borderBoxSize` is an **array** of `{ inlineSize, blockSize }`; `inlineSize` is width in horizontal writing-mode. `contentRect` is a legacy back-compat property retained for older browsers. The plan's `entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width` (T-1.3) is correct — the `?.[0]?.` chaining also tolerates old Firefox's single-object `contentBoxSize` quirk by falling through to `contentRect.width`. Source: [MDN ResizeObserverEntry](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserverEntry).

✓ **c2 — `display:contents` strips ARIA role (validates the T-3.3 `inline-flex` mandate).** Applying `display:contents` removes the element (and its role) from the accessibility tree in multiple browsers; `<button style="display:contents">` loses button semantics. Chrome fixed the general regression in 89 but **Chrome 113 reportedly re-broke buttons/lists/tables on Windows/Android**, and Safari lagged (< 16). The plan is correct to pin `.mj_SubagentPill_wrapper { display: inline-flex }` (NOT `display:contents`) so the `role="listitem"` wrapper stays in the a11y tree (T-3.3, round-3 fix). Sources: [Adrian Roselli — display:contents is not a CSS reset](https://adrianroselli.com/2018/05/display-contents-is-not-a-css-reset.html), [Adrian Roselli 2022 update](https://adrianroselli.com/2022/07/its-mid-2022-and-browsers-mostly-safari-still-break-accessibility-via-display-properties.html).

✓ **c3 — container queries key off the nearest ancestor container.** `@container` queries resolve against the nearest ancestor establishing a containment context (`.mx_RoomView_body`'s `container: mj-room`), not the queried element's own box. A non-portaled descendant (the popover — no `createPortal` in `components.tsx`) is therefore subject to the ancestor query. This grounds the T-3.3 decision to remove the usage label-drop entirely (a scoped-selector fix alone would still be evaluated in the ancestor's context). Source: CSS Containment Module Level 3 (`@container` resolves against query container ancestor).
