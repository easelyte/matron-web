# Adaptive header + usage cluster + subagent strip (#500 / #501 / #502)

**Status:** draft — pending spec-review
**Date:** 2026-07-24
**Branch:** `vps-header` (off `origin/main`)
**Loops:** #500 (adaptive header), #501 (usage cluster restyle), #502 (subagent chip strip)
**Owner window:** VPS header window — owns `src/journal/components.tsx` header region (ChatHeader ~1254-1349, SubChatHeader ~1351-1448, UsageBars ~1223-1252, RunningSubagentStrip ~3099-3124) + `src/journal/journal.pcss` header rules (~77-333, `.mj_HeaderMenu` ~353-386, `.mj_SubagentStrip`/`.mj_SubagentPill` ~388-428). One of three parallel windows — stay in the header region.

**Related principles:** V-level project principles (`docs/design-principles.md` not present in this repo — matron-web is Dan's fork; principles live in son-of-anton). Canonical-source, fail-loud, and file-cohesion (#448/P18) heuristics apply by convention.

**Upstream-alignment tension (acknowledged, operator-directed).** matron-web is Dan's fork; `project_matron_web_stays_dan_upstream_aligned` normally argues minimal-diff / no restructuring, and the v3 reskin therefore deferred the shell factor (kept it CSS-heavy / TSX-light). This loop's `HeaderShell` factor is an **operator-directed exception** ("factor a shared header-shell to pay down #448 while you're in there") — the same sanctioned-divergence posture the v3 reskin took for its visual fork. To keep the divergence maintainable: the factor is a **presentational-structure** refactor (grid + collapse plumbing + cluster placement), not a change to client/WS/`SessionStatus` data flow or business logic, so future upstream *logic* merges still land. #500's adaptive behavior is genuinely new (no upstream equivalent), so it does not create a merge-conflict surface with Dan's header.

**Rejected alternatives:**
- **B — pure CSS container-query collapse, JS only for popover open/close.** Extend the existing `@container mj-room` rules; render both mini-trigger and full-cluster always, toggle visibility by breakpoint. Rejected: both subtrees stay mounted (duplicate ARIA / focus targets needing `aria-hidden` bookkeeping), collapse points are container-width breakpoints not content-driven, and it fights the operator's explicit ResizeObserver directive. Container queries reflow *layout* but cannot mount/unmount a popover trigger, which is the actual requirement.
- **C — no shared shell; a `useAdaptiveHeader` hook + small cluster subcomponents, two header components kept.** Lighter touch, but leaves the ~95-line ChatHeader/SubChatHeader duplication that #448 wants paid down. Rejected because the operator explicitly asked to "factor a shared header-shell to pay down #448 while you're in there."

---

## Summary

Three header features, one shared refactor:

1. **#501 usage cluster restyle** — reshape `UsageBars` (3 stacked label+bar rows, capped at `limits.slice(0,3)`) into a compact multi-metric cluster showing **all** limits the bridge sends, each as `label · mini-bar · NN%` in micro type. Adds a numeric percent (removes color-only reliance → WCAG 1.4.1 improvement). No bridge work; `SessionStatus.limits` already carries the data.
2. **#502 subagent chip strip** — the header currently shows a `N subagents ▾` dropdown (ChatHeader: all children; SubChatHeader: all siblings) **and** a separate running-only `RunningSubagentStrip` below the header. Unify both into a single horizontal **all-subagents** chip strip under the header, running-first, with running/finished/current glyphs. Removes the two dropdowns and the running-only strip.
3. **#500 adaptive header** — a rAF-throttled `ResizeObserver` on `.mx_RoomView_body` (the `container: mj-room` element) drives two collapse flags. Below `USAGE_COLLAPSE_PX` the usage cluster collapses to a mini pill + `.mj_HeaderMenu` popover; below `TITLE_COLLAPSE_PX` the title (and its model/context/email meta) collapses to a mini title + popover. Popovers are **click-toggle** (mock says hover; click for touch parity), reusing the existing dismissable-menu pattern.

The refactor that carries all three: a shared **`HeaderShell`** owning the grid, back button, adaptive collapse, and popover plumbing — ChatHeader and SubChatHeader become thin data-computing wrappers. This is the #448 paydown.

**Out of scope (owned by other windows or deferred):**
- Composer dynamic readout (`ctx 72% · auto-idle in 18m`) — the v3 reskin spec deferred it to #500/#501, but it lives in the **composer** region, owned by a different parallel window. Do not touch the composer.
- Splitting `journal.pcss` (1701 lines, P18 debt) — separate loop, unilateral-restructuring concern (mirrors #448's own channel). Factoring the TSX shell *is* in scope; the `.pcss` split is not.
- Bridge/`limits` data changes — data already flows.
- iOS/desktop clients.

---

## Current state (verified)

Layout inside `.mx_RoomView_body` (`components.tsx:3188`, `container: mj-room / inline-size` via `journal.pcss:70`):
```
.mx_RoomView_body
├── SubChatHeader | ChatHeader        (3-col grid: model/ctx | title | usage)
├── RunningSubagentStrip              (running children chips — running-only)
├── Timeline
└── Composer | ReadOnlyHint
```

- **`ChatHeader`** (`1254`): back button · `ModelContextCluster` (model + `Context: X/Y` + compact button) · `HeaderTitleCluster` (title + email + `N subagents ▾` dropdown over **all** children) · `UsageCluster` (`UsageBars`).
- **`SubChatHeader`** (`1351`): back · model+context (no compact button) · title + running/finished state + `N subagents ▾` over **siblings** · usage. ~95 lines duplicate ChatHeader.
- **`UsageBars`** (`1223`): grid of up to 3 `.mj_UsageRow`, each `label:` + `role="progressbar"` track/fill. Color via `usageLevel()` → `.mj_UsageFill_{low,medium,high}`. Reset time in row `title`.
- **`RunningSubagentStrip`** (`3099`): `runningChildrenOf(conversations, selectedConversationId)` → `.mj_SubagentPill` buttons (spinner + title). Renders `null` when none.
- **Responsive today:** `@container mj-room (max-width: 720px)` (`journal.pcss:308`) collapses the side tracks to `minmax(0,1fr)` and reflows usage rows to single-column. No JS, no popover.
- **Dismissable-menu pattern** (`components.tsx:706-725`): the room menu closes on `pointerdown` outside the **panel element** (`roomMenuElementRef.current?.contains(...)`, `709`) + `Escape` + capture-phase `scroll`. It guards containment on the *panel* ref only (no opener-ref guard today). This is the pattern to *model* the new header-popover hook on — not code to refactor (see §1).
- **`.mj_HeaderMenu`** (`journal.pcss:353`): absolute, `z-index:1000`, card with shadow, `width: min(280px, calc(100vw - 32px))`, scroll-capped. Used by AccountMenu, RoomItemMenu, SubagentSwitcherMenu, EventRowMenu.
- **Types:** `SessionStatus.limits?: Array<{label, percent, resets?, resets_at?}>` (`types.ts:159`). Helpers in `status.ts`: `usageBarLabel`, `usageLevel`, `resetDisplay`, `compactTokens`.
- **Tests:** jest + jsdom, `test/unit-tests/journal/**/*-test.ts`. `subchat-strip-test.ts` and `components-test.ts` render the full app via `createRoot` + `act` against a hand-built `ClientState`. **jsdom has no `ResizeObserver`** — an injected mock/polyfill is required.

---

## Design

### Architecture — new/changed units in `components.tsx`

All additive presentational + one behavioral hook; no data-flow or business-logic changes to the client. New source files are avoided (matron-web fork divergence-minimization); everything lands in `components.tsx` + `journal.pcss`, with pure helpers optionally in `status.ts`.

**1. `useDismissablePopover(open, close, { openerRef, panelRef })` (hook) — new, header-scoped.**
A **new** hook, added in-window, **modeled on** the room-menu close pattern (`components.tsx:706-725`) but **not** a refactor of it: the existing room/account/event menus keep their inline handlers untouched (out-of-window; touching them would cross this window's ownership fence and risk Dan-fork merge conflicts). When `open`: attach `pointerdown` (close if the target is outside *both* the opener and panel refs — this hook adds the opener-ref guard the room menu lacks, so a click on the trigger doesn't immediately reopen-then-close), `keydown` Escape (close + return focus to opener), capture-phase `scroll` (close). Cleanup removes all three. Returns nothing. **Consumed only by the two new header popovers** (usage, title); it does not claim to dedupe the existing menus. This keeps all edits inside the header region and honors AC#4's scoped dedup claim.

**2. `useAdaptiveHeader(bodyEl: HTMLElement | null): { usageCollapsed, titleCollapsed }` (hook).**
- **Takes the observed element as a value, not a stable `RefObject`.** `.mx_RoomView_body` is **conditionally mounted** — it only exists while a conversation is selected (`components.tsx:3158` renders `<main.mx_HomePage>` otherwise; the body is at `3188`), and `SignedInApp` persists across selection changes. A stable `useRef` + one-shot `useEffect([])` would (a) observe `null` forever if the app boots on the home screen, or (b) observe the *first* body node and go dead the moment "Back to conversations" (`mj_BackButton` → `client.clearSelection()`, `1266`) unmounts it and a reselect mounts a fresh node — breaking #500 on the routine nav loop (blocker, both reviewers round 1; violates P5 *don't mirror external state in React* / P8). **Fix:** `SignedInApp` passes the element into the hook via a state-backed **callback ref** (`const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null)`; `<div className="mx_RoomView_body" ref={setBodyEl}>`). The hook's `useEffect` **depends on `bodyEl`**, so it re-runs — detaching the old observer, attaching a new one — every time the node mounts/unmounts/remounts. When `bodyEl` is `null`, the effect installs nothing and resets both flags to `false` (expanded).
- **rAF throttle + change-guard:** observer callback stashes the latest inline width and, if no frame is pending, schedules one `requestAnimationFrame`. The frame reads the stashed width, computes `nextUsage = width < USAGE_COLLAPSE_PX` / `nextTitle = width < TITLE_COLLAPSE_PX`, and calls `setState` **only when a flag actually flips** (avoids a render per resize event during a sidebar drag).
- Width source: `entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width` (borderBoxSize is the modern path; contentRect is the fallback).
- **Cleanup:** on every `bodyEl` change (and unmount) disconnect the observer and `cancelAnimationFrame` the pending frame before re-attaching.
- **Test seam / no-ResizeObserver fallback (fail-soft):** if `typeof ResizeObserver === "undefined"` (jsdom, ancient browsers), the hook returns `{ usageCollapsed: false, titleCollapsed: false }` and installs no observer — the header renders fully expanded (never worse than today's non-adaptive header). Tests inject a mock `ResizeObserver` on `globalThis` and fire entries via `act()`.
- **Thresholds (module constants, tunable in visual QA):**
  - `USAGE_COLLAPSE_PX = 700` — near the existing 720 breakpoint; below this the 3-col grid can't seat the full multi-metric usage cluster without crowding, so it becomes a mini pill.
  - `TITLE_COLLAPSE_PX = 460` — true-mobile width; below this the center title + its meta collapse to a mini title + popover.
  - Invariant `TITLE_COLLAPSE_PX < USAGE_COLLAPSE_PX` (title is the last thing to collapse — it's the primary orientation cue).

**3. `HeaderShell` (shared component) — the #448 paydown.**
Props:
```
mode: "parent" | "child"
onBack: () => void
backLabel: string
left: React.ReactNode          // model/context cluster contents (incl. compact button in parent mode)
title: string
titleMeta: React.ReactNode     // email (parent) OR running/finished state (child)
limits?: NonNullable<SessionStatus["limits"]>
collapse: { usageCollapsed: boolean; titleCollapsed: boolean }
```
Renders the `.mj_ChatHeader` grid (`+ .mj_SubChatHeader` class when `mode==="child"`):
- **Back button** (unchanged markup).
- **Left cluster** — renders `left` as today (`.mj_ModelContextCluster`). When `titleCollapsed`, the left cluster is folded into the title popover (see below) and hidden inline, so the mini header is just `[back] [mini-title ▾] [mini-usage ▾]`.
- **Center title cluster** — when `!titleCollapsed`: `.mj_HeaderTitleCluster` with heading + `titleMeta`. When `titleCollapsed`: a `.mj_HeaderMiniTitle` button (`aria-haspopup`, `aria-expanded`) showing the truncated title + chevron; click toggles a `.mj_HeaderMenu.mj_TitlePopover` containing the full title, `titleMeta`, and the `left` (model/context) content.
- **Right usage cluster** — when `!usageCollapsed`: `.mj_UsageCluster` wrapping `<UsageCluster limits=… />`. When `usageCollapsed`: a `.mj_HeaderMiniUsage` button showing the **worst** metric (`⬤ NN%`, colored by its `usageLevel`, `aria-label="Usage — worst limit NN%, resets …"`); click toggles a `.mj_HeaderMenu.mj_UsagePopover` containing the full `<UsageCluster>`.
- Owns two `useState` open-flags (`usagePopoverOpen`, `titlePopoverOpen`) + opener/panel refs + `useDismissablePopover` for each. Opening one closes the other (single-popover invariant). Both auto-close when their collapse flag turns false (e.g. sidebar widened while popover open) — a `useEffect` on the collapse flags.
- **The subagent strip is NOT part of HeaderShell** — it stays a sibling row below the header (existing slot), so it spans full width and scrolls independently.

**4. `UsageCluster` ({ limits }) — #501.**
Extract + restyle from `UsageBars`. Renders **all** trimmed limits (drop the `slice(0,3)` cap; an inline height cap + the collapse popover absorb overflow — see CSS + Open Decisions #2). Each limit is a compact row:
```
[label]  [mini-track/fill (role=progressbar, aria-valuenow…)]  [NN%]
```
- **Boundary normalization (P8 — one function, used before ranking AND rendering).** `SessionStatus.limits[].percent` is typed as bare `number` (`types.ts:159`) with no finite/0–100 invariant; the current `UsageBars` clamps per-render (`Math.min(Math.max(percent,0),100)`, `1228`). Define a single pure `normalizePercent(p) = Number.isFinite(p) ? Math.min(Math.max(p, 0), 100) : 0`. **Every** consumer — the bar width, the visible `NN%`, `aria-valuenow`/`aria-valuetext`, `usageLevel(...)`, **and** `worstLimit` ranking — uses the normalized value, so the collapsed mini pill can never disagree with its expanded row or emit invalid ARIA. Unit-tested against `NaN`, `Infinity`, `-5`, `150`.
- Keeps the `role="progressbar"` + `aria-valuemin/max/now` + `aria-valuetext` (resets included) — accessibility parity with today.
- Adds a visible numeric `NN%` (micro type, `usageLevel` color) so status is not color-only.
- `label` via `usageBarLabel`; reset via `resetDisplay` in the row `title` (unchanged).
- `worstLimit(limits)` helper (pure, in `status.ts`): returns the limit with the highest **normalized** `percent` (ties → first) — drives the collapsed mini pill. Empty/all-non-finite → the empty-usage path (no mini shown). Unit-testable.
- Same component renders inline (`.mj_UsageCluster`) and inside `.mj_UsagePopover`; a `variant` prop or a wrapper class handles the slightly denser inline vs roomier popover layout.

**5. `SubagentStrip` ({ client, state }) — #502.**
Generalize `RunningSubagentStrip` → renders **all** relevant subagents:
- **Parent mode** (top-level convo selected): `childrenOf(conversations, selectedConversationId)` — all children.
- **Child mode** (subagent selected): `childrenOf(conversations, selected.parent_convo_id)` — all siblings.
- **State classification (two buckets, binary on the one grounded value).** `Conversation.session_state` is an unrestricted `string` (`types.ts:59`); only the exact literal `"running"` has grounded helper semantics (`runningChildrenOf`, `267`; the SubChatHeader glyph logic `session_state === "running" ? "●" : "○"`, `1419`). This spec matches that existing binary: **`session_state === "running"` → running bucket** (spinner, ordered first); **any other value** (finished, and defensively any future/unknown string — `queued`, `starting`, `error`, …) → **inactive bucket** (`○` glyph, muted). The `○`/muted treatment asserts only *"not currently running,"* not *"succeeded,"* so an unknown state is never mislabeled as success — it's correctly shown as not-running, consistent with today's behavior. If a future state needs distinct styling, that's a follow-up, not a silent misclassification here.
- Ordering: running first (stable within bucket by existing `childrenOf` `created_at` order), then inactive.
- **Markup / ARIA (B2 fix — preserve button semantics).** The strip is `role="list"`. Each entry is a `role="listitem"` **wrapper** (`<div role="listitem">`) containing a native `<button>` — the `listitem` role goes on the wrapper, **not** on the button (putting `role="listitem"` directly on a `<button>`, as the current `RunningSubagentStrip` does at `3111-3116`, overrides the implicit button role and hides the control from AT → WCAG break). Running/inactive buttons carry `aria-label="Open subagent <title>"`; the current chip (child mode) is `aria-current="true"`, `disabled`, non-navigating. Spinner `aria-hidden`.
- Chips are `.mj_SubagentPill` (existing), extended with `.mj_SubagentPill_finished` / `.mj_SubagentPill_current` modifiers; the `.mj_SubagentStrip` becomes the `role="list"` container. Horizontal `overflow-x:auto` (already present) handles accumulation; inactive chips are de-emphasized so running ones read first.
- Renders `null` when the list is empty (no subagents ever).
- **Replaces** `RunningSubagentStrip` at the render slot (`3194`) and **removes** the `.mj_SubagentSwitcher` dropdowns from both headers.
- Mode is derived the same way the headers derive it (`childMode` at the call site, `3189`), passed as a prop or recomputed from `selected.parent_convo_id`.

**6. `ChatHeader` / `SubChatHeader` — thin wrappers.**
Each computes its data (conversation/title, status, trimmed limits) and the adaptive `collapse` flags (received as props from `SignedInApp`, which owns the observer — see below), then returns `<HeaderShell … />`. The subagent dropdown JSX and the `subagentsOpen`/`siblingsOpen` state are deleted (moved to the strip). Net: the two components shrink to ~20-30 lines each; ~95 lines of duplication removed.

**7. `SignedInApp` wiring.**
- Add a state-backed **callback ref** on the `.mx_RoomView_body` div (`3188`): `ref={setBodyEl}` where `[bodyEl, setBodyEl] = useState<HTMLElement | null>(null)`. This makes node mount/unmount reactive (§2 B1 fix) — a plain `useRef` would not re-fire the effect on remount.
- Call `useAdaptiveHeader(bodyEl)` unconditionally at the top of `SignedInApp` (Rules of Hooks — the hook call is unconditional; the *element* it receives is what varies), pass `collapse` down into whichever header renders (parent/child) — **one** observer regardless of header type, exactly matching "observe `.mx_RoomView_body`," and it reattaches across the home↔room and back-navigation transitions.
- Replace `<RunningSubagentStrip …/>` (`3194`) with `<SubagentStrip …/>`.

### Data flow

No changes to `MatronJournalClient`, WS handling, or `SessionStatus`. All new logic is presentational: measure container width → collapse flags → conditional render; read existing `state.conversations` / `state.sessionStatus`. `mergeSessionStatus` untouched.

### CSS (`journal.pcss`, header region)

- **`.mj_UsageCluster` / `.mj_UsageBars` / `.mj_UsageRow`** (#501): refit to the compact multi-metric layout — a dense grid `[label] [track] [pct]`, micro type, `--cpd-*` spacing. Percent cell right-aligned, `--cpd-color-text-secondary`, color-coded to match fill. Keep `--cpd-color-usage-{low,medium,high}` + `--cpd-color-bg-usage-track`. Verify light + dark.
  - **Inline height bound (MA fix — required, not aspirational).** Because `limits` is unbounded/bridge-controlled and `.mj_ChatHeader` is a grid with `align-items: center` + sibling clusters pinned at `min-height: 58px`, an uncapped growing usage cluster would stretch the whole header row to the bridge's row count and crowd the timeline/composer. The **inline** `.mj_UsageBars` (uncollapsed, width ≥ `USAGE_COLLAPSE_PX`) therefore gets an explicit `max-height` (≈ the 58px header band) + `overflow-y: auto` + `overscroll-behavior: contain`, so the header row height is fixed regardless of limit count; the popover variant keeps its own `.mj_HeaderMenu` cap for the roomier full list. This is a committed CSS requirement + a high-count test (see Testing), not the "as the popover does" hand-wave the earlier draft assumed.
  - **720px override reconciliation (m1 fix).** The existing `@container mj-room (max-width: 720px)` rule (`journal.pcss:321-324`) collapses `.mj_UsageRow` to a single column, sized for today's 2-cell `[label][track]` row. Under the 3-cell restyle, update that override explicitly: in the 460–720 band drop the **label** cell (least information — the track+pct carry the signal) to `[track] [pct]`, keeping the row single-line; do not wrap the percent to its own line. The label returns in the collapsed popover (width < 700) where there's room.
- **`.mj_HeaderMiniUsage` / `.mj_HeaderMiniTitle`** (#500): mini trigger buttons — pill/chip sized, `aria`-driven, `:focus-visible` outline (reuse the existing `outline: 2px solid var(--cpd-color-icon-accent-primary)` idiom). Worst-metric dot colored by level.
- **`.mj_UsagePopover` / `.mj_TitlePopover`** (#500): `.mj_HeaderMenu` variants — position under their trigger (`top: calc(100% + space-2x)`, right-anchored for usage, appropriate anchor for title), inherit the card treatment.
- **`.mj_SubagentPill_finished` / `.mj_SubagentPill_current`** (#502): muted background/border for inactive/finished; accent ring / `aria-current` treatment + `cursor:default` for current. Keep `.mj_SubagentStrip` overflow-x + scrollbar-thin. The `role="listitem"` wrappers are display-contents / inline-flex so they don't disturb the existing flex strip layout (styling stays on the inner `.mj_SubagentPill` button).
- **Adaptive layering:** keep the `@container mj-room (max-width: 720px)` rule for the still-inline (non-collapsed) squeeze in the 700–720 band and for the strip. The JS collapse handles the mini+popover swap below the thresholds. No conflict — each JS threshold sits below the CSS breakpoint.
- All new rules use `--cpd-*` tokens only; both themes; AA contrast on new text/backgrounds.

### Accessibility (WCAG AA)

- Mini triggers: `<button aria-haspopup="true" aria-expanded={open} aria-label=…>`; visible focus-visible outline; Escape closes and returns focus to the trigger (via `useDismissablePopover`).
- Popovers: `role="group"` + `aria-label`; contain the full cluster; a click outside / Escape / scroll dismisses. Single-popover-open invariant prevents overlap.
- Usage progressbars retain `aria-valuenow` / `aria-valuetext` (with resets). Numeric percent added → status not conveyed by color alone (1.4.1).
- Subagent chips: the strip is `role="list"`; each chip is a `role="listitem"` **wrapper** containing a native `<button>` (the button's implicit role is preserved — `role="listitem"` is NOT placed on the button itself, correcting the current `RunningSubagentStrip` markup). Current chip `aria-current="true"` + `disabled`; other chips keep an accessible name (`aria-label="Open subagent <title>"`). Spinner `aria-hidden`.
- Both themes token-driven; verify contrast of the new percent text + worst-metric dot + finished-chip muted text at AA in light and dark.

### Error handling / edge cases

- **No ResizeObserver** → expanded header, no observer (fail-soft, never worse than today).
- **Popover open, then width grows past threshold** → `useEffect` closes the popover when its collapse flag clears (no orphaned floating menu).
- **Rapid sidebar drag** → rAF + change-guard bounds re-renders to flag flips only.
- **Zero limits** → usage cluster hidden (existing `.mj_HeaderCluster_empty` path preserved via the collapse/empty logic); mini usage not shown.
- **Many finished children** → horizontal scroll + muted styling; running chips ordered first stay visible.
- **Empty title / missing model/email** → existing guards preserved; mini-title still renders the fallback ("Conversation" / "Subagent").
- **Popover unmount during animation frame** → cleanup cancels the frame; guard against setState-after-unmount.

---

## Testing

`test/unit-tests/journal/` (jest + jsdom, `*-test.ts`, full-app `createRoot` + `act` idiom).

1. **`subchat-strip-test.ts`** (extend/rename): assert the unified strip renders **all** children (running + inactive) with correct glyph/modifier classes, running-first order, current-marker + `aria-current` + disabled-nav in child mode, `null` when empty, **and the ARIA shape** — `role="list"` container, each chip a `role="listitem"` wrapper whose child is a real `<button>` (no `role="listitem"` on the button). Assert an **unknown `session_state`** (e.g. `"queued"`) classifies as inactive (`○`/muted), not running. Assert the header no longer renders a `mj_SubagentSwitcher` dropdown.
2. **New `usage-cluster-test.ts`** (or extend `status-test.ts` + `components-test.ts`): `worstLimit` picks the highest **normalized** percent; `normalizePercent` maps `NaN`/`Infinity`/`-5`/`150` → `0/0/0/100`; the mini pill's worst matches the expanded rows for out-of-range inputs; `UsageCluster` renders **all** limits (not capped at 3) with numeric percent + progressbar ARIA intact.
3. **New `adaptive-header-test.ts`:** inject a mock `ResizeObserver` on `globalThis`; render the app; fire entries at widths above `USAGE_COLLAPSE_PX`, between the two thresholds, and below `TITLE_COLLAPSE_PX`; assert the DOM swaps between full cluster / mini-usage+popover / mini-title+popover. Assert click-toggle opens the `.mj_HeaderMenu` popover and Escape/outside-click closes it. Assert widening past a threshold with a popover open closes it. Assert no observer is installed and the header is expanded when `ResizeObserver` is undefined. **B1 regression test (required):** exercise the conditional-mount lifecycle — render with **no** conversation selected (no `.mx_RoomView_body`), then select one, fire a below-threshold entry, assert collapse fires; then `clearSelection()` (back to home), reselect, fire another entry, assert collapse **still** fires (observer reattached to the new node).
4. **New/extended `usage-cluster-test.ts` — inline height bound (MA):** render with a large `limits` array (e.g. 12 entries) at a width above `USAGE_COLLAPSE_PX`; assert the `.mj_UsageBars` inline container has the capped `max-height` + `overflow-y:auto` (i.e. the header row height does not grow with limit count). (jsdom has no layout, so assert the applied class/inline-style contract, not computed pixels; pixel behavior is covered by the visual gate.)
5. **Visual gate (CSS-visual, real-DOM — matches the v3 reskin discipline).** Two axes, because the collapse states are **not** natively reachable at every viewport (390px is below both thresholds; a 1440px room may reach neither collapse) — the earlier single viewport×state cross-product was non-reproducible (Codex round-1 ME):
   - **Layout/theme parity axis:** the naturally-reachable state per viewport × { light, dark } × { desktop 1440×900 → expanded; mobile 390×844 → title+usage both collapsed } — captures real production geometry.
   - **Collapse-state axis (width-forced):** at a fixed desktop viewport, **force the room container width** to each band by dragging the resizable left sidebar (`useLeftPanelResize`) so `.mx_RoomView_body` inline width lands >700 (expanded), 460–700 (usage-collapsed), and <460 (title+usage collapsed); capture each, light + dark. State the forcing mechanism = sidebar drag to a target room width (not viewport shrink), so each cell is reproducible.
   - Every cell captured + Read; AA contrast on the new percent text / worst-metric dot / inactive-chip text. Popover-open cells: click the mini trigger before capture. Include a high-limit-count cell to visually confirm the inline `max-height`+scroll bound.
6. `pnpm lint` (types + prettier) and `pnpm test` green.
7. Codex adversarial review on the branch diff (multi-file feature).

---

## Acceptance criteria

1. **#501:** the usage cluster renders **all** bridge-sent limits (no `slice(0,3)` cap) in the compact `label · mini-bar · NN%` form; numeric percent visible; progressbar ARIA (`aria-valuenow`/`aria-valuetext` incl. resets) retained; a single `normalizePercent` (finite-clamped 0–100) feeds bar/pct/ARIA/`usageLevel`/`worstLimit` so the mini pill and rows agree on `NaN`/`Infinity`/out-of-range; the **inline** cluster has a committed `max-height`+`overflow-y` so header row height is bounded regardless of limit count; light + dark, desktop + mobile, AA.
2. **#502:** a single horizontal chip strip under the header shows all children (parent mode) / siblings (child mode), running-first (`session_state === "running"`; any other value → inactive `○`/muted, incl. unknown/future states), with running/inactive/current glyphs; strip is `role="list"`, each chip a `role="listitem"` **wrapper** around a real `<button>` (button role preserved); current chip `aria-current` + disabled; the two header `N subagents ▾` dropdowns and the running-only `RunningSubagentStrip` are removed; finished subagents remain reachable via the strip; empty (no children ever) → nothing rendered.
3. **#500:** a single rAF-throttled `ResizeObserver` driven off the `.mx_RoomView_body` element **via a state-backed callback ref** (reattaches across home↔room and back-navigation remounts — not a stale `RefObject`) drives two collapse flags; below `USAGE_COLLAPSE_PX` the usage cluster becomes a worst-metric mini pill + click-toggle `.mj_HeaderMenu` popover; below `TITLE_COLLAPSE_PX` the title + model/context/email collapse to a mini title + popover; popovers dismiss on outside-click / Escape / scroll and auto-close when their threshold clears; no observer + expanded header when `ResizeObserver` is absent; the mount→unmount→remount path is tested.
4. **#448 paydown:** ChatHeader and SubChatHeader share a `HeaderShell`; the ~95-line duplication is removed; a **new, header-scoped** `useDismissablePopover` (modeled on the room-menu close pattern, consumed only by the two header popovers) factors the header-popover close logic without modifying the out-of-window room/account/event menus.
5. **Scope discipline:** no changes to the client / WS / `SessionStatus` data flow; no composer changes; no `journal.pcss` file split; no new source files; all styling `--cpd-*`, both themes.
6. `pnpm lint` + `pnpm test` green; new tests for strip, usage cluster, adaptive collapse; visual matrix captured + Read; Codex review clean or residuals owned by follow-up loops.
7. **Merge only** — no live deploy this session (batched at end across the three windows). Rebase on `origin/main` before ship.

---

## Open decisions recorded (made by author, not blocking)

- **Subagent strip unifies dropdown + running-strip** rather than only swapping the dropdown — **operator-directed** ("swap to a horizontal chip strip under the header per the mock"). Rationale: two overlapping affordances (running-only strip + all-children dropdown) is redundant; one all-children strip matches the mock and keeps finished children reachable (the dropdown was the only path to finished ones; a running-only strip would strand them).
  - **Acknowledged regression (round-1 Claude M1): the strip's *presence* becomes persistent, not ephemeral.** Today `RunningSubagentStrip` returns `null` once nothing is running, reclaiming the row; the unified strip renders whenever the conversation has *ever* spawned a subagent. This is inherent to the requested "persistent chip strip" design, so it's an **accepted, operator-directed tradeoff**, not an oversight — mitigated by compact 28px chips, horizontal scroll, muted inactive styling, and running-first order. Reachability parity with the old dropdown is preserved (both surfaced children whenever children existed); the delta is a full-width row vs a compact trigger. **Veto point:** if the persistent row proves costly, the fallback is a running-first strip that collapses the inactive tail behind a `+N` chip opening the popover — a follow-up loop, not this one.
- **#501 shows all limits** (drops the 3-cap). Rationale: the compact form is space-efficient and capping would hide limits the bridge deliberately sends. Overflow is bounded by a **committed** inline `max-height`+`overflow-y` on `.mj_UsageBars` (see CSS §, MA fix) — corrected from the earlier draft, which wrongly asserted the current CSS already caps the inline cluster (it does not; only the popover did).
- **Thresholds 700 / 460 px** are initial values, tunable during the visual gate; the invariant `TITLE_COLLAPSE_PX < USAGE_COLLAPSE_PX` holds.
