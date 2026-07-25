# Plan — matron-web sidebar timestamps (#507) + segmented tabs (#498)

**Spec:** `docs/superpowers/specs/2026-07-24-web-sidebar-timestamps-and-tabs-design.md` (reviewed, converged round 3)
**Repo:** easelyte/matron-web · **Worktree:** `/opt/matron/web-journal-wt-sidebar` · **Branch:** `vps-sidebar` off `origin/main` (isolated — see Preflight)
**Loops:** son-of-anton #507 (timestamps) + #498 (tabs)
**risk:** low — additive presentational TSX + CSS over `--cpd-*` tokens; no server change, no data-flow change, no auth/RLS/payments/data-loss surface.

**Governing constraints (from spec):** #497 divergence-minimization (CSS-heavy / TSX-light, additive presentational markup + one pure helper, no runtime-logic fork, no new `src/` files, no new deps); **WCAG AA small-text 4.5:1 both themes for all text THIS PR introduces or restyles** — the new timestamp, the new tab count, and the tab labels' inactive/hover states all meet AA both themes (P13). **Documented exception:** the active-tab LABEL accent (`.mj_RoomListTab_active`, ≈2.9-3.3:1 light) is **pre-existing #497 debt** (already live for the Active/Favorites tabs); this PR adds one more instance of that same state via the Archived tab but does NOT re-tune the operator-approved v3 accent — tracked in loop #510 (fixes all tabs at once). No dead CSS (P16); keep diff reviewable (P18). No live deploy — merge only; atomic swap batched by operator later.

**Parallel-window boundary:** OWN the sidebar region only — `ConversationList`/`renderConversation` + `formatRelativeDay`, the specific `.mj_RoomList*` / `.mj_RoomListTab*` / `.mj_RoomList_archived*` / glyph selectors, and the tab/archived describe blocks in the shared `components-test.ts`. Do NOT touch `.mj_RoomItemMenu*` / `.mj_EventRowMenu` or anything outside the sidebar. Rebase on `origin/main` before ship if a sibling window merged first.

---

## Preflight (T-0) — isolated worktree — DONE, executor MUST verify

Three concurrent windows share the `/opt/matron/web-journal` checkout; a plain `checkout -b` collides (round-1 both reviewers: at review time the shared checkout was on the sibling `vps-voice-ansi` branch, not `vps-sidebar`). This work is isolated in a dedicated git worktree — the pattern already in use here (`web-journal-wt-diff-cards`).

- **Worktree:** `/opt/matron/web-journal-wt-sidebar` on branch `vps-sidebar`, based on `origin/main` (e404a2b, post-#497). **Already created + spec/plan migrated into it.**
- **T-0 guard (executor runs before T-1.1)** — check branch + clean tracked tree + **enforce the untracked allowlist** (Codex round-2 B1 + round-3 M2: `git diff` ignores untracked files, so a stale untracked source/test from an interrupted worker would slip through — parse `git status --porcelain` and reject any untracked path outside the exact allowlist):
  ```bash
  cd /opt/matron/web-journal-wt-sidebar
  [ "$(git branch --show-current)" = vps-sidebar ] || { echo "ABORT: wrong branch"; exit 1; }
  git diff --quiet && git diff --cached --quiet || { echo "ABORT: tracked changes present"; exit 1; }
  # Untracked allowlist: only memory/**, the spec, and the plan may be untracked at T-0.
  UNEXPECTED=$(git status --porcelain --untracked-files=all | awk '$1=="??"{print $2}' \
    | grep -vE '^(memory/|docs/superpowers/specs/2026-07-24-web-sidebar-timestamps-and-tabs-design\.md$|docs/superpowers/plans/2026-07-24-web-sidebar-timestamps-and-tabs\.md$)' || true)
  [ -z "$UNEXPECTED" ] || { echo "ABORT: unexpected untracked files:"; echo "$UNEXPECTED"; exit 1; }
  ```
  ABORT on wrong branch, dirty tracked files, or any untracked file outside {`memory/**`, the named spec, the named plan}. Do NOT edit code in the shared `/opt/matron/web-journal` checkout (mutates the sibling branch).
- **Staging contract (Codex round-3 M4, unambiguous):** at ship, stage **exactly** the two named docs — `git add docs/superpowers/specs/2026-07-24-web-sidebar-timestamps-and-tabs-design.md docs/superpowers/plans/2026-07-24-web-sidebar-timestamps-and-tabs.md` — plus the source/test changes from Phases 1-2. **`memory/**` is NEVER staged** (son-of-anton-style review telemetry, not part of matron-web's tree). The spec + plan ARE part of the deliverable and MUST be committed; only the `memory/` artifacts are excluded.
- **All Edit/Read/Write/Bash paths in every task below are relative to `/opt/matron/web-journal-wt-sidebar`.** Use `git -C /opt/matron/web-journal-wt-sidebar` for git; `cd /opt/matron/web-journal-wt-sidebar` before build/test.

**Anchor-drift note (round-1 minor):** the plan's cited line numbers are **pre-edit (current-HEAD) coordinates**. Phase 1 inserts lines before all Phase 2 anchors (new `formatRelativeDay` after L192, new hook in the L623-741 block). The executor MUST re-locate every Phase 2 anchor by **symbol / content search**, not by trusting the literal line numbers — they will have shifted. (Edit is content-matched so `old_string` search is safe; only Read-by-offset navigation is at risk.)

**Rollback (round-1 minor):** merge-only + presentational-only → the fallback for any failed post-merge QA is `git revert` on the PR merge commit (or drop the branch pre-merge). No live deploy happens here, so blast radius is a reviewable PR, not production.

---

## Task dependency graph

```
T-0 worktree preflight ──▶ Phase 1 (#507 timestamps) ──▶ Phase 2 (#498 tabs) ──▶ Phase 3 (verify)
  T-1.1 formatter+import
  T-1.2 midnight effect  (needs useReducer import from T-1.1)
  T-1.3 render meta col  (needs T-1.1 formatter)
  T-1.4 CSS time/meta
  T-1.5 formatter tests  (needs T-1.1 export; own file format-relative-day-test.ts)
  T-1.6 midnight fake-timer test  (needs T-1.2 + T-1.3; in components-test.ts — disjoint file from T-1.5)
        │
        ▼
  T-2.1 ConversationList 3-tab restructure — ALL components.tsx edits, ONE atomic compilable unit
  T-2.2 CSS (count → primary, compact-width fit, remove dead archived rules)
  T-2.3 update existing components-test.ts (needs T-2.1 shipped shape)
        │
        ▼
  T-3.1 build + full test + manual QA (all prior)
```
Phase 1 and Phase 2 both edit `ConversationList`/`renderConversation` but disjoint regions (Phase 1 = the row's right-meta + a hook; Phase 2 = the tab bar + list-render return block + top-of-component state). Sequence Phase 1 → Phase 2 to avoid edit churn on the same function. Within a phase, tasks touching different files (CSS vs TSX vs test) parallelize; TSX tasks in the same file serialize.

---

## Phase 1 — #507 sidebar timestamps

### T-1.1: Export `formatRelativeDay` formatter
- [ ] Directly after `formatTime` (L192-194), add the **exported** `formatRelativeDay` exactly as the spec Feature-1 formatter block specifies: non-finite guard → `""`, invalid-Date guard → `""`, `daysAgo === 0` → `formatTime` (today/same-day-skew), `1..6` → `Intl` `weekday: "short"`, else (older OR future calendar day) → `Intl` month/day (+year when `!sameYear`). `now: number = Date.now()` default param. `export function` (test seam — spec Codex-r2).
- [ ] **Do NOT add the `useReducer` import here** — `tsconfig` has `noUnusedLocals: true`, so an import with no usage until T-1.2 fails the build (execute T-1.1 exit-5 lesson). The `useReducer` import is added in T-1.2 together with its usage.
- **Files:** `src/journal/components.tsx`
- **Acceptance:** TS compiles clean (no unused import); `formatRelativeDay` is a named export; `formatTime` stays private (unchanged); no other formatter behavior touched. `grep -n "export function formatRelativeDay" src/journal/components.tsx` hits once.

### T-1.2: Midnight-invalidation effect in `ConversationList`
- [ ] Inside `ConversationList`, add `const [, forceDayTick] = useReducer((n) => n + 1, 0);` and the self-re-arming `useEffect` (no dep array) that `setTimeout`s `forceDayTick` to `nextLocalMidnight - now + 1000ms`, returning `clearTimeout` for cleanup — exactly as spec Feature-1 "Midnight invalidation" block.
- [ ] Place it among the other top-of-component hooks (after existing `useState`/`useRef` declarations, before the early return paths), so hook order is stable.
- **Files:** `src/journal/components.tsx`
- **Acceptance:** sidebar renders without a render loop (setTimeout defers the state bump); timer clears on unmount; reclassification-at-boundary verified by the T-1.6 fake-timer test. No `setInterval`; single timer.

### T-1.3: Render the timestamp in a right-meta column in `renderConversation`
- [ ] **Capture one `now` per render (Codex round-2 M4, P2):** at the top of `ConversationList`'s render (or just before `renderConversation` is defined), `const renderNow = Date.now();`. Pass it explicitly to every timestamp call: `formatRelativeDay(conversation.last_ts ?? conversation.created_at, renderNow)`. This gives all rows one authoritative temporal snapshot, so a render spanning local midnight classifies every row against the same boundary (the T-1.2 midnight tick then re-renders with a fresh `renderNow`). Do NOT let each callsite fall back to the `Date.now()` default.
- [ ] In `renderConversation` (right side of the row, currently star glyph + unread badge, L863-874), introduce `<span className="mj_RoomListMeta">` containing (top) `<span className="mj_RoomListTime">{formatRelativeDay(conversation.last_ts ?? conversation.created_at, renderNow)}</span>` and (below) the existing unread-badge / unread-dot node moved inside it. Keep the star glyph where it is (before the meta column). Keep the absolutely-positioned kebab trigger unchanged.
- **Files:** `src/journal/components.tsx`
- **Acceptance:** every row shows a timestamp reading `last_ts ?? created_at`; all rows share one `renderNow` (grep: no bare `formatRelativeDay(x)` single-arg callsite in the render); unread badge/dot still renders (now inside meta); no change to click/menu/long-press handlers; TS strict clean.

### T-1.4: CSS for `.mj_RoomListMeta` + `.mj_RoomListTime` (hover-hide, AA)
- [ ] In `src/journal/shell.pcss` near `.mj_UnreadBadge` (L398), add `.mj_RoomListMeta` (column flex, align end, gap `--cpd-space-0-5x`) and `.mj_RoomListTime` (`color: var(--cpd-color-text-secondary)`, `font: var(--cpd-font-body-2xs-regular)`, `white-space: nowrap`, opacity transition) exactly as spec.
- [ ] Add the hover-hide rule: `.mj_RoomListItem_wrapper:hover .mj_RoomListTime { opacity: 0 }` — **`:hover` only, NOT `:focus-within`** (spec Codex-B3: keyboard users keep the timestamp).
- [ ] **Proactive kebab clearance (Codex round-2 M3 — decided at impl time, NOT deferred to QA):** on keyboard focus the kebab appears (`:focus-within`) while the time stays visible, so give the meta column clearance from the absolutely-positioned kebab: `.mj_RoomListItem_wrapper:focus-within .mj_RoomListMeta { padding-right: var(--cpd-space-5x); }` (clears the 28px kebab at `right: var(--cpd-space-3x)`). This settles the overlap in CSS at build time rather than as a conditional QA edit.
- **Files:** `src/journal/shell.pcss`
- **Acceptance:** timestamp uses secondary token (AA ✓ both themes per spec: light ≈5.7:1, dark #9a948b/#1a1c20 ≈5.67:1 — re-confirm token values at build); fades on mouse hover, stays + clears the kebab on keyboard focus; tokens `--cpd-space-0-5x` / `--cpd-space-5x` / `--cpd-font-body-2xs-regular` exist. No layout shift on hover (opacity, not display).

### T-1.5: Unit tests for `formatRelativeDay`
- [ ] Add tests in a **new dedicated file `test/unit-tests/journal/format-relative-day-test.ts`** (mandatory-separate, NOT `components-test.ts` — Codex round-2 M1: T-1.6 also edits `components-test.ts`, and a shared file lets parallel workers conflict/drop each other's tests; the separate file removes the hazard). **`-test.ts` suffix** to match `jest.config.cjs` `testMatch: **/*-test.ts` — NOT `*.test.ts` (spec B2).
- [ ] **Module-load setup (Codex round-3 M1):** importing `formatRelativeDay` from `components.tsx` drags in its static `import matronLogo from "../../res/matron-logo-simple.svg"` (components.tsx:19), which jest can't transform (no global asset mapper; `transform` only matches `[jt]sx?`). Add `jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");` **before** the import — matching every sibling test that imports from `components` (e.g. `diff-card-test.ts:15`). No other global (TextEncoder etc.) is needed at module-eval — `diff-card-test.ts` imports `components` with only the svg mock + `setup.cjs` globals.
- [ ] **Pin `process.env.TZ`** (e.g. `TZ=UTC`) before/around the module use so calendar boundaries are deterministic, **and restore the original TZ in `afterEach`/`afterAll`** (save `const origTZ = process.env.TZ` in `beforeAll`, restore after — Codex round-3 M3, so no TZ leak to other suites). Assert against expected strings **constructed via the same `Intl.DateTimeFormat(undefined, …)` call** (or assert the branch taken), never hardcoded localized literals (spec Codex-M1).
- [ ] Cases (inject `now`, spec Test-plan): same-day → clock; 1-6 days → weekday; **exactly 7 days → dated**; 7+ same-year → "Mon D"; prior-year → "Mon D, YYYY"; same-day future ts → clock; **tomorrow-or-later → dated (not clock)**; **non-finite / NaN → `""`**; **`Number.MAX_VALUE` (invalid Date) → `""` (no throw)**.
- [ ] **DST-boundary case (Codex round-4 M1):** add a case under a non-UTC DST-observing zone (`TZ=America/New_York`) spanning the spring-forward transition (March 2026), asserting the exactly-7-calendar-days boundary still returns the dated label (NOT weekday). The formatter is DST-safe because it uses calendar-day starts (`new Date(y,m,d)` local midnight) and `Math.round` over `dayMs`, so a spring-forward day's 23h span rounds `6.958 → 7` — this test proves it rather than asserting it. (Per-case TZ override + restore, since T-1.5's default is UTC.)
- **Files:** `test/unit-tests/journal/format-relative-day-test.ts` (new)
- **Acceptance:** new tests green under `pnpm test`; every branch (incl. future-date + invalid-Date guards) has an explicit case; no TZ/locale-dependent hardcoded literal; lives in its own file (no overlap with T-1.6's `components-test.ts` edits).

### T-1.6: Component test — midnight-invalidation effect (jest fake timers)
- [ ] Add a `components-test.ts` case using jest fake timers (Codex round-1 M1 — replaces the unsafe "temporarily shorten the production timer / mock now" manual step, which had no injection seam and would mutate T-1.2's source with no rollback): `jest.useFakeTimers()` + `jest.setSystemTime(<just-before-local-midnight>)`, render a conversation whose `last_ts` is "today", assert the row shows a clock string; `jest.advanceTimersByTime(pastMidnight)`; assert the row reclassifies (clock → weekday/date).
- [ ] **Prove the timer RE-ARMS, not one-shot (Codex round-4 M2 + round-5 B3).** Re-arm is proved via TIMER COUNT, not a second text change — a fixed timestamp renders the SAME weekday at daysAgo 1 and 2, so a second midnight produces no observable text delta (that assertion would be unfalsifiable). Steps: (a) after the first midnight tick assert `jest.getTimerCount() >= 1` — a one-shot `[]`-dep effect would leave 0, so this alone distinguishes re-arming from one-shot; (b) `advanceTimersByTime` through a SECOND local midnight and assert `jest.getTimerCount() >= 1` AGAIN (the effect re-scheduled a third timer — proves it keeps re-arming); (c) for the VISIBLE reclassification, use a fixture at a formatter BRANCH boundary — a `last_ts` of "today" so the FIRST midnight flips clock→weekday (observable); (d) unmount and assert `jest.getTimerCount()` returns to baseline (cleanup ran).
- [ ] Pin `process.env.TZ` (as T-1.5) so "local midnight" is deterministic.
- [ ] **Unconditional global-state restoration (Codex round-3 M3):** restore `jest.useRealTimers()` AND the original `process.env.TZ` in `afterEach`/`finally` — even if an assertion throws. This describe block mutates two process-wide controls (fake timers + TZ); without restoration, later cases in the shared `components-test.ts` inherit fake time / UTC → order-dependent failures. Scope timer + TZ setup to this describe only.
- **Files:** `test/unit-tests/journal/components-test.ts`
- **Acceptance:** fake-timer test proves the effect fires at the boundary, re-arms, and clears on unmount; real timers + original TZ restored after the block (later suites unaffected — run the full `pnpm test` to confirm no order-dependent breakage); green under `pnpm test`. No production timing edit needed.

---

## Phase 2 — #498 sidebar segmented tabs

### T-2.1: ConversationList 3-tab restructure — ALL `components.tsx` edits as ONE atomic compilation unit
**Why one task (Codex round-4/5):** the tab state, populations, `visibleActive`→`visibleRows` rename, tab-bar markup, list/empty-state JSX, and disclosure/`archivedExpanded` removal all reference interdependent symbols in the same component — splitting them leaves the tree uncompilable between tasks (e.g. removing the `archivedExpanded` decl before its JSX usages, or renaming `visibleActive` before its consumer). Do ALL of the following in one edit set so the tree compiles at the task boundary. (CSS + tests remain separate tasks — different files, no compile interdependency.)

- [ ] **Tab state:** `useState<"all" | "favorites">("all")` (L624) → `useState<"active" | "favorites" | "archived">("active")`.
- [ ] **Populations** (near existing `hasAnyFavorite`/`hasActiveUnread`, L766-781) — use `state.archivedIds`, NOT bare `archivedIds` (store is on `state`, L744):
  ```tsx
  const hasAnyActive = state.conversations.some(
      (c) => !state.archivedIds.has(c.id) && !parentPresent(c, ids));
  const archivedAll = state.conversations.filter(
      (c) => state.archivedIds.has(c.id) && !parentPresent(c, ids));
  const archivedTotal = archivedAll.length;
  ```
  `hasAnyFavorite` reused unchanged; `ids` (L742) + `parentPresent` (from `./types`) in scope. Keep `active` (L760-763 pinned-first) + `archived` (L772) as-is; verify `archived` derives from `conversations` (filters `!parentPresent`, L747-758) so count/list invariant holds.
- [ ] **`visibleRows` derivation** — REPLACE the existing `visibleActive` definition (L764: `const visibleActive = tab === "favorites" ? … : active;`) with `visibleRows` (Codex round-5 B2 — the JSX consumer below uses `visibleRows`, so its producer must be defined, not left as the old `visibleActive`):
  ```tsx
  const visibleRows =
      tab === "favorites" ? active.filter((c) => state.favoriteIds.has(c.id)) :
      tab === "archived"  ? archived : active;
  ```
- [ ] **Tab-bar markup** (replace the 2-button block L950-973): 3-tab map. **Tuple MUST carry `as const`** (else `key` widens to `string`, `setTab(key)` fails the union, TS2345): `([["active","Active"],["favorites","Favorites"],["archived","Archived"]] as const).map(([key, label]) => …)`. Each button: `data-tab={key}`, `aria-pressed={tab===key}`, class toggling `mj_RoomListTab_active`, `onClick` → `setTab(key)` + `event.currentTarget.focus({preventScroll:true})`; archived button appends `<span className="mj_RoomListTab_count"> ({archivedTotal})</span>` when `archivedTotal > 0`. **ADD `role="group"`** to the container (HEAD L950 has only `aria-label`) + keep `aria-label="Filter conversations"` (per-button `aria-pressed`, NOT `role=tablist`).
- [ ] **List + empty-state JSX** (replace the ENTIRE L1008-1042 region — this contains BOTH the current list block L1008-1017 AND the archived disclosure L1019-1042): map `visibleRows` through `renderConversation` + the empty-state predicates. **Active is 3-way, using ONLY canonical populations `hasAnyActive` + `archivedTotal` — NOT raw `state.conversations.length` (ship-review P2):** `!hasAnyActive && archivedTotal === 0` → first-run copy "Your agent conversations will appear here."; `!hasAnyActive && archivedTotal > 0` → "No active conversations." (all-archived account — don't imply a fresh account); `hasAnyActive && !visibleRows.length` → "No conversations match your search". Favorites: `!hasAnyFavorite` / `hasAnyFavorite && !visibleRows.length`. Archived: `archivedTotal === 0` / `archivedTotal > 0 && !visibleRows.length`. The disclosure (`.mj_RoomList_archivedToggle` / `.mj_RoomList_archivedSection` / `archivedExpanded` usages at L1024/1026/1031) is DELETED here.
- [ ] **Remove `archivedExpanded` declaration** (L627 `const [archivedExpanded, setArchivedExpanded] = useState(false)`) — do this together with the JSX-usage deletion above (Codex round-5 B1: removing the decl while usages remain = TS2304). Decl + all usages die in this one task.
- **Files:** `src/journal/components.tsx`
- **Acceptance:** TS strict compiles (no dangling `visibleActive`/`archivedExpanded`/bare-`archivedIds`; `as const` present); 3 tabs render evenly with `data-tab` + `role="group"`; `Archived (N)` only when N>0; all-archived → Active shows first-run copy (not blank); zero-result search → "No conversations match your search"; archived tab distinguishes none vs none-match-search; no literal `0` rendered; `archivedExpanded`/`.mj_RoomList_archivedToggle`/`.mj_RoomList_archivedSection` grep-clean in src; `archivedTotal >= (archived∩search).length` by construction.

### T-2.2: CSS — count style (AA-safe) + compact-width fit; remove dead archived rules (P16)
- [ ] **Count color — `--cpd-color-text-primary` (Codex round-1 B3 + round-3 B1 + round-4 B1).** History: `opacity: 0.7` → ~3.06:1 (fail); `color: inherit` → active tab inherits accent ~2.9-3.3:1 light (fail); `--cpd-color-text-secondary` → **dark active tab 4.29:1 (fail)** — secondary dark #9a948b over the composited dark active-tab overlay (state-selected `rgb(45 212 191 / 0.14)` over canvas #1a1c20 = ~rgb(29,54,54)) misses 4.5:1. **`--cpd-color-text-primary` passes with large margins in ALL four cases** (computed from live tokens, shell.pcss:40/146/122/16/50/156): dark-active ≈9.9:1, light-active ≈15.9:1, dark-inactive ≈12.5:1, light-inactive ≈18:1.
  ```css
  .mj_RoomListTab_count { color: var(--cpd-color-text-primary); font-weight: 400; }
  ```
  De-emphasis vs the 500-weight label comes from `font-weight: 400` (and the parens), not a lower-contrast color — AA is a hard gate, so the count trades a slightly-higher color emphasis for guaranteed compliance in every state/theme. Fully decoupled from the pre-existing active-tab accent label debt (#510).
- [ ] **Compact-width fit (Codex round-1 B3, P13).** Three `flex: 1 1 0` tabs at the minimum sidebar width overflow because flex items won't shrink below content min-width and each button has `--cpd-space-3x` side padding + the Archived count. Modify the existing `.mj_RoomListTab` rule (owned selector, L460):
  ```css
  .mj_RoomListTab {
      /* …existing props… */
      min-width: 0;              /* allow shrink below content width */
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: var(--cpd-space-1x) var(--cpd-space-2x);  /* was space-3x — reclaim ~8px/side */
  }
  ```
  Full labels show at normal widths; at the narrowest sidebar width they ellipsize rather than overflow the pill row.
- [ ] Remove the now-dead `.mj_RoomList_archivedToggle` (L574-587), `:hover/:focus-visible` (L589-592), `.mj_RoomList_archivedCount` (L594-596), `.mj_RoomList_archivedSection` (L598-605) rules.
- **Files:** `src/journal/journal.pcss`
- **Acceptance:** count uses `--cpd-color-text-primary` (independently AA-safe ≥4.5:1 in both tab states + both themes — verify absolutely at T-3.1 with a contrast check, not "parity"); `.mj_RoomListTab` has `min-width: 0` + ellipsis overflow + reduced padding; three tabs fit without overflow at the minimum sidebar width; no `.mj_RoomList_archived*` selectors remain (grep clean); do NOT touch `.mj_RoomItemMenu*` / `.mj_EventRowMenu` (not owned).

### T-2.3: Update existing `components-test.ts` broken by the restructure
- [ ] `tabButton` helper (L115): **retype to the lowercase tab KEYS `"active" | "favorites" | "archived"`** (NOT capitalized labels — Codex round-4 M3: `data-tab` values are lowercase, so a `[data-tab="${arg}"]` lookup with capitalized args yields `[data-tab="Active"]` which won't match `data-tab="active"` → null deref). The helper looks up `container.querySelector('[data-tab="'+key+'"]')`. Update every callsite to pass the lowercase key (the old `"All"` → `"active"`, `"Favorites"` → `"favorites"`).
- [ ] `describe("conversation list tabs")` (L2101-2159): retarget to 3-tab structure — assert Active/Favorites/Archived selection + per-tab row visibility + `Archived (N)` count + the container carries `role="group"` (Codex round-2 M2).
- [ ] `describe("conversation menu controls")` (L1984-1993): rewrite the archived-row reveal — **select the Archived tab** instead of clicking the removed `.mj_RoomList_archivedToggle` (else null-deref).
- [ ] **Add 4 empty-state unit cases (Codex round-1 M2)** — T-2.1 adds distinct Active/Archived existence-vs-search predicates; HEAD only covers the two Favorites branches (components-test.ts:2134). Cover all four new branches so a future predicate/population regression fails CI instead of only showing in manual QA: (1) no active population → Active shows first-run copy; (2) active population hidden by search → Active shows "No conversations match your search"; (3) no archived population → Archived shows "No archived conversations"; (4) archived population hidden by search → Archived shows "No archived conversations match your search". Assert the specific copy per branch.
- [ ] Grep the test dir for residual refs: `.mj_RoomList_archivedToggle`, `archivedExpanded`, `tabButton(`, `"All"` — fix any stragglers.
- **Files:** `test/unit-tests/journal/components-test.ts`
- **Acceptance:** `pnpm test` green; no reference to removed classes/state; `tabButton` resolves via `data-tab` and works for all three tabs incl. the counted Archived button; all 4 Active/Archived empty-state branches have explicit assertions.

---

## Phase 3 — verify

### T-3.1: Build + full test + manual QA
- [ ] **Commit-then-rebase gate FIRST (Codex round-5 M1 + round-6 B1, P19).** `git rebase` refuses a dirty tree, and Phases 1-2 leave uncommitted tracked changes, so COMMIT before rebasing: (a) stage the deliverable — `git add src/journal/components.tsx src/journal/shell.pcss src/journal/journal.pcss test/unit-tests/journal/format-relative-day-test.ts test/unit-tests/journal/components-test.ts docs/superpowers/specs/2026-07-24-web-sidebar-timestamps-and-tabs-design.md docs/superpowers/plans/2026-07-24-web-sidebar-timestamps-and-tabs.md` (NEVER `git add -A`; `memory/**` stays untracked); `git commit -m "feat(sidebar): per-row timestamps (#507) + segmented tabs (#498)"`. (b) `git fetch origin main`; if `vps-sidebar` is behind `origin/main` (a sibling window merged after T-0), `git rebase origin/main` — now clean, so it succeeds. **Any rebase that moves the base re-runs this entire T-3.1 sequence from step (b)** (the gates must cover the rebased tree). If up-to-date, proceed. (The commit here is the single feature commit `/ship-slim` will push + PR — see Ship.)
- [ ] `corepack pnpm build` clean (TS strict, no new deps).
- [ ] `pnpm test` fully green (new formatter tests + updated tab/menu tests + untouched suite).
- [ ] Manual QA (spec Test-plan, P13) — **verification only, no code edits here**; any defect found is fixed in the owning implementation task (T-1.3/T-1.4/T-2.x) and re-triggers the full T-3.1 build+test+QA sequence (Codex round-2 M3). Desktop + mobile widths, **both themes**: timestamp AA contrast (secondary token both themes); **count contrast measured absolutely, not just "parity"** (see accepted-debt note below); timestamp fades on mouse hover, stays + clears the kebab on keyboard focus (T-1.4 proactive padding); 3 tabs divide evenly at normal widths and ellipsize (no overflow) at the minimum sidebar width; `Archived (N)` correct + stable while typing in search AND equal to archived-row count at empty search; each empty state renders (all-archived, zero-result search, none-favorites, none-archived); favorites/archived rows still open + show context menu (archive/unarchive). (Midnight rollover is covered by the T-1.6 fake-timer test.)
- **Files:** none (verification only — see re-trigger rule above)
- **Acceptance:** build + test green; QA checklist all-pass; no console errors; no regression to non-sidebar UI. Do NOT deploy — leave for the operator's batched atomic swap.

**Accepted pre-existing debt (plan-review — operator-judgment, deferred not fixed here):** the ACTIVE-tab **label** text (`.mj_RoomListTab_active`, `--cpd-color-text-action-accent` #0d9488 over the 10% state-selected overlay) computes ≈2.9-3.3:1 in **light theme** — below AA 4.5:1. This is a **pre-existing #497 reskin decision** (approved v3 active-tab color) already live for the Active/Favorites tabs. **Honest scope note (Codex round-6 B2, P38):** this PR adds a THIRD tab (Archived) whose active label reaches that same failing state — so it does introduce *one more instance* of the pre-existing failure. This is NOT a new failure TYPE and does not regress the shipped baseline (the sidebar already ships 2 such labels), but the plan does not claim blanket AA — the governing constraint above scopes AA to *text this PR introduces/restyles* (timestamp + count, both AA-safe) and lists the active-label accent as an explicit exception. **Decision: do NOT re-tune the operator-approved active-tab accent inside a sidebar-features PR** (that forks the approved v3 palette; fixing it fixes all 3 tabs at once) — tracked in **son-of-anton loop #510** (`matron-web-active-tab-accent-aa-contrast`). The NEW `.mj_RoomListTab_count` is decoupled: it uses `--cpd-color-text-primary` (T-2.2), AA-safe ≥9.9:1 in every state/theme (secondary failed 4.29:1 dark-active). Operator can reprioritize #510 to fold the accent fix into this PR if preferred.

---

## Spec-coverage map

| Spec part | Task(s) |
|---|---|
| Feature 1 formatter (guards, future-date branch, export) | T-1.1 |
| Feature 1 midnight invalidation | T-1.2 |
| Feature 1 render span + meta column | T-1.3 |
| Feature 1 CSS (meta, time, hover-hide, WCAG) | T-1.4 |
| Feature 1 unit tests (all branches, TZ pin) | T-1.5 |
| Feature 1 midnight-effect fake-timer test | T-1.6 |
| Feature 2 tab-state widen + populations + markup + list/empty-states + remove disclosure/archivedExpanded (ALL components.tsx) | T-2.1 |
| Feature 2 CSS tab_count (AA-safe primary) + compact-width + dead-rule removal (P16) | T-2.2 |
| MUST update existing tests (tabButton lowercase, tab describe, menu-controls) | T-2.3 |
| Empty-state branch coverage (4 Active/Archived cases) | T-2.3 |
| Worktree isolation (concurrency) | T-0 (Preflight) |
| Parallel-window CSS-ownership fence | T-1.4, T-2.2 (scope), all TSX tasks |
| Build + manual QA (P13, both themes, mobile) | T-3.1 |

No spec part is left uncovered. No task references symbols/files outside the spec's stated sidebar scope.

---

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
