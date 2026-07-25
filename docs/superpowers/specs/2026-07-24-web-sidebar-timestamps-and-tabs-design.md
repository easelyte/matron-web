# Design — matron-web sidebar timestamps (#507) + segmented tabs (#498)

**Status:** reviewed — converged at round 3 (Claude LGTM; Codex final finding = non-ship-blocking test-coverage completeness, applied). r1: 5 blk + 4 maj → r2: 1 blk + 2 maj + 1 min → r3: 0 blk, 1 non-ship-blocking maj. All findings auto-applied; 0 operator-judgment calls across the loop.
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client)
**Loops:** son-of-anton #507 (`matron-web-sidebar-timestamps`) + #498 (`matron-web-sidebar-tabs`) — bundled into one sidebar-region PR
**Branch:** `vps-sidebar` off `origin/main`
**Anchor:** `docs/design/matron-redesign-v3.dc.html` (v3 mock — REFERENCE ONLY: shows per-row time top-right + a 3-segment Active / Favorites / Archived control)
**Approach:** B — full scope as operator-described (bucketed-absolute timestamp formatter + 3-segment tab restructure reusing existing client-local flag Sets). See Rejected Alternatives.

**Parallel-window boundary.** This is 1 of 3 concurrent windows on matron-web. This window OWNS the **sidebar region only**:
- **TSX:** `ConversationList` / `renderConversation` in `src/journal/components.tsx` (~L614-1042), plus the `formatRelativeDay` helper by `formatTime` (L192).
- **CSS — specific selectors only** (NOT blanket line ranges — Mi1): in `shell.pcss`, `.mj_RoomList` / `.mj_RoomListItem*` / `.mj_RoomListText` / `.mj_RoomListName` / `.mj_RoomListPreview` / `.mj_UnreadBadge` / `.mj_RoomListEmpty` + new `.mj_RoomListMeta` / `.mj_RoomListTime`; in `journal.pcss`, `.mj_RoomListTabs` / `.mj_RoomListTab*` (+ new `.mj_RoomListTab_count`), `.mj_RoomList_archived*` (being removed), `.mj_RoomListPinGlyph` / `.mj_RoomListStarGlyph`, `.mj_UnreadDot`. **Explicitly NOT owned:** `.mj_RoomItemMenu*` and `.mj_EventRowMenu` (L544-572) — those are context-menu components a sibling window may touch; do not edit them even though they fall inside the old L454-605 range.
- **Tests:** `test/unit-tests/journal/components-test.ts` is a **shared file** — scope edits to the tab/archived describe blocks + `tabButton` helper (see Test plan); if a sibling window also touched it, rebase and re-merge the describe blocks by hand.

Header + composer windows own the rest (#448). Rebase on `origin/main` before ship if another window merges first.

---

## Constraint (inherited from the v3 reskin, #497)

matron-web is Dan's fork; divergence is kept **maintainable** (future upstream logic merges still land) by the CSS-heavy / TSX-light rule from the #497 reskin spec (`2026-07-24-web-redesign-v3-reskin-design.md`):

- Visual change lands in `shell.pcss` + `journal.pcss` over `--cpd-*` tokens. **No new deps, no CSS-in-JS.** Plain PostCSS.
- `components.tsx` changes are **additive presentational markup + presentational-placement conditionals only** — no changes to data flow / business logic, no new **`src/` runtime** source files. Both features here qualify: #507 renders an already-computed field (`last_ts`/`created_at`) in a new `<span>`; #498 re-partitions already-computed client-local Sets (`favoriteIds`/`archivedIds`) across an existing tab-state variable, plus a small midnight-invalidation effect (§1). No server change, no new data path.
- **One helper function** (`formatRelativeDay`, extending the existing `formatTime` at `components.tsx:192`) is permitted — it is a pure presentational formatter, not business logic, and lives alongside `formatTime`/`formatBytes`. It does not constitute a "new source file."
- **Test files are NOT covered by the "no new src source files" rule.** The rule guards against forking Dan's *runtime* logic (which breaks upstream merges). A new `test/unit-tests/journal/*-test.ts` file is normal and does not touch runtime. This spec both **updates existing tests** (`components-test.ts` — required, see Test plan) and may **add** a formatter test file, matching the repo's `*-test.ts` glob (NOT `*.test.ts` — see Test plan for the jest `testMatch` gotcha).
- **P18 file-size debt** on `journal.pcss`/`components.tsx` (already flagged, loop #448/#448-adjacent split loops) is **not addressed here** — same divergence-minimization reason. Net add ~60-80 lines TSX (formatter + guard + midnight effect + tab/render restructure) + ~30 lines CSS + test updates, reviewable.

**Principles in play:** P13 (verify mobile + both themes, not just desktop light), P16 (no dead CSS), P18 (keep diff reviewable — no restructuring beyond the tab re-partition the feature requires), WCAG AA (small text 4.5:1) as a hard gate on the new muted timestamp text.

---

## Feature 1 — #507 Sidebar timestamps (tiny)

### Data (already wired end-to-end — verified)
`last_ts` flows: `journal.js` snapshot correlated subquery → `SnapshotResponse.conversations[].last_ts` → `client.ts`/`database.ts` persist + sort (`database.ts:205,229`) → present on every `Conversation` object (`types.ts:65` `last_ts?: number`, `types.ts:63` `created_at: number`). Timestamps are **epoch ms** (consumed directly by `new Date(ts)` in the existing `formatTime`). **Only `renderConversation()` doesn't render it.** No server/client-data change.

### Formatter (`components.tsx`, beside `formatTime` at L192)

```ts
// EXPORTED (Codex round-2): the render callsite uses it, and the unit tests (Test plan)
// import it directly to inject `now`. A named export of a pure presentational formatter is
// additive — it does not fork Dan's runtime data flow. (formatTime stays private; only this
// helper needs the test seam.)
export function formatRelativeDay(timestamp: number, now: number = Date.now()): string {
    if (!Number.isFinite(timestamp)) return "";                          // P8 guard: non-finite → no throw, empty string
    const then = new Date(timestamp);
    if (Number.isNaN(then.getTime())) return "";                         // invalid Date → Intl.format would throw; bail
    const today = new Date(now);
    const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayMs = 86_400_000;
    const daysAgo = Math.round((startOf(today) - startOf(then)) / dayMs);
    if (daysAgo === 0) return formatTime(timestamp);                     // TODAY (incl. same-day minor-future skew) → "10:06"
    if (daysAgo >= 1 && daysAgo <= 6) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(then); // "Wed"
    // Older than 6 days OR a genuinely FUTURE calendar day (daysAgo < 0 = corrupted/skewed state):
    // fall through to a dated label, never a bare clock — a future date rendered as just "10:06" is misleading.
    const sameYear = then.getFullYear() === today.getFullYear();
    return new Intl.DateTimeFormat(undefined, sameYear
        ? { month: "short", day: "numeric" }                              // "Jul 3"
        : { month: "short", day: "numeric", year: "numeric" }             // "Jul 3, 2025"
    ).format(then);
}
```

- **Future-date fix (Codex-M2 round 2):** the branch is now `daysAgo === 0` for today, `1..6` for weekday, everything else (older OR a future *calendar day*) → dated label. Same-day minor-future clock-skew still lands in `daysAgo === 0` (both stamps share a calendar day → clock), but a ts on tomorrow-or-later renders a date, not a misleading bare clock. Future dates only arise from corrupted/skewed persisted state (a real `last_ts` can't be in the future) — Tier 2, but the code is now internally consistent with its contract.
- **Boundary guard (Codex-M2 round 1, P8):** non-finite or invalid-Date timestamps return `""` instead of letting `Intl.DateTimeFormat.format(new Date(NaN))` throw a `RangeError` mid-sidebar-render. Tier-2 defense against unit drift; a thrown formatter would crash the whole room list. (Epoch-*seconds* drift is NOT auto-detected — renders a 1970 date; reliable detection is impossible, out of scope. The guard only prevents the throw.)
- `daysAgo` uses **calendar-day starts**, not raw `(now - ts) / dayMs` — so 11pm→1am next day reads as "yesterday's weekday", not "today". DST-safe: `Math.round` over `dayMs` absorbs the ±1hr skew a DST-crossing local-midnight pair introduces (verified round 1).
- `now` is a param (default `Date.now()`) so it is **injectable in tests**. Callsite passes no arg. The render is not minute-live-ticking, BUT a **midnight-invalidation effect is required** (Codex-B2) — see below — so a row does not stay classified as "today's clock" after the local day rolls over while the sidebar sits idle.
- Locale-aware via `Intl` with `undefined` locale (matches existing `formatTime`). Test-hermeticity implications (TZ/locale) handled in the Test plan (Codex-M1).

### Midnight invalidation (Codex-B2)
`formatRelativeDay` is bucketed by **local calendar day**, so its output for a given row silently goes stale when the local day rolls over with no other state change (idle sidebar across midnight → a row stuck showing a bare clock that should now read "Wed"). Add a self-re-arming effect in `ConversationList` that forces one re-render at the next local midnight:

```tsx
// NOTE: add `useReducer` to the existing React import (components.tsx L8-17 currently omits it) —
// else ReferenceError on first render (Claude round-2). formatTime/useState/etc are already imported.
const [, forceDayTick] = useReducer((n: number) => n + 1, 0);
useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const timer = setTimeout(forceDayTick, nextMidnight - now.getTime() + 1000); // +1s cushion past the boundary
    return () => clearTimeout(timer);
}); // no dep array: re-arms after every render (incl. the tick itself), always scheduling the *next* midnight
```

This is a single timer (not a per-minute interval) — it fires at most once per day, re-arms on cleanup, and adds no measurable cost. It is NOT the rejected minute-ticking relative-time timer (approach C); it is calendar-boundary invalidation, which the bucketed contract genuinely requires. Cleanup on unmount is handled by the returned `clearTimeout`.

### Render (`renderConversation`, in the right-meta area of the row)
Add one span reading `conversation.last_ts ?? conversation.created_at`:

```tsx
<span className="mj_RoomListTime">{formatRelativeDay(conversation.last_ts ?? conversation.created_at)}</span>
```

Placement: a right-aligned meta column (`.mj_RoomListMeta`) holding the time on top; the existing unread badge / dot moves into the same column beneath it. The existing star glyph stays where it is (between text and meta). Rationale: the row is `[pin] [name+preview flex:1] [star] [meta: time / badge]`; the kebab trigger remains absolutely positioned (`right: space-3x`, appears on hover).

### CSS (`shell.pcss`, near `.mj_UnreadBadge` L398)
```css
.mj_RoomListMeta {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--cpd-space-0-5x);
}
.mj_RoomListTime {
    color: var(--cpd-color-text-secondary);   /* AA: #6b655c on #fff ≈ 5.7:1 — passes small-text 4.5:1 */
    font: var(--cpd-font-body-2xs-regular);
    white-space: nowrap;
    transition: opacity var(--cpd-dur-fast) var(--cpd-ease);
}
/* Hide the time under the kebab trigger on POINTER hover so they never overlap.
   NOT :focus-within (Codex-B3): focus-within matches the main row button too, so a
   keyboard user would lose the timestamp on every row focus. Keyboard focus keeps the
   time visible; the kebab appears via focus-within but does not warrant hiding info. */
.mj_RoomListItem_wrapper:hover .mj_RoomListTime {
    opacity: 0;
}
```

**Kebab/time coexistence (Codex-B3):** hide-on-`:hover` covers the mouse case (kebab appears → time fades). On keyboard `:focus-within` the kebab appears but the timestamp stays readable; any minor visual proximity is acceptable and confirmed during manual QA (the meta column sits at the row's right padding; the kebab is `right: var(--cpd-space-3x)` centered). If QA shows an actual overlap on keyboard focus, add right-padding to `.mj_RoomListMeta` rather than re-hiding the time.

**WCAG decision (verified round 1):** timestamp uses `--cpd-color-text-secondary`, NOT `--cpd-color-text-tertiary`. Tertiary (#9a938a on #fff ≈ 2.8:1) FAILS AA small-text. Secondary passes **both themes**: light #6b655c on #fff ≈ 5.7:1; dark #9a948b on sidebar bg #1a1c20 ≈ 5.67:1 — both clear AA 4.5:1 for small text. Re-confirm the exact token values at execution (P13) in case a sibling window retunes tokens.

---

## Feature 2 — #498 Sidebar segmented tabs (small)

### State (already client-local — verified)
`favoriteIds` / `archivedIds` / `pinnedIds` are `Set<string>` on `ClientState`, backed by `conversation-flags.ts` `makeIdSetStore`. **No server change.** The dead DB `session_state='archived'` is **not touched** (operator constraint).

### Current structure (to be replaced)
Two tabs `"all" | "favorites"` (`tab` state, L624) + a separate inline **archived disclosure** at the bottom (collapsible `archivedExpanded`, L1019-1042). "All" shows active rows AND the archived disclosure appears below it.

### New structure — 3 segmented tabs
`tab` state widens: `"active" | "favorites" | "archived"` (rename `"all"`→`"active"`; `setTab` default `"active"`).

- **Active** — non-archived rows, pinned-first (current `active` partition). Was "All"; now sheds the archived disclosure.
- **Favorites** — `active` filtered to `favoriteIds` (current `visibleActive` favorites path, unchanged).
- **Archived (N)** — the `archived` list (current `conversations.filter(archivedIds)`), rendered as normal rows. **N = total archived count**, unfiltered by search (see decision below), rendered in a `.mj_RoomListTab_count` span inside the tab button.

**Removed:** `archivedExpanded` state, the `.mj_RoomList_archivedToggle` button, the `.mj_RoomList_archivedSection` wrapper, and lines 1019-1042. The archived rows now render in the main `.mj_RoomList` list when `tab === "archived"` (reusing `renderConversation`, which already handles archived rows — they carry the same menu/flags).

### Canonical populations (Codex-B1, M1/Codex-M3 — single source of truth, P2)
Every empty-state predicate and the archived count must key off **search-independent existence**, not the search-filtered `active`/`archived` arrays — otherwise (a) an all-archived account shows a blank Active tab, (b) a zero-result search shows first-run copy, (c) the `Archived (N)` count diverges from the rendered list when `parentPresent` hides an archived sub-chat. Define one canonical unfiltered population per bucket, using the SAME `!parentPresent(c, ids)` exclusion the existing `hasAnyFavorite`/`hasActiveUnread` (L766-781) use (`ids` = active/non-archived id set, L742-746):

```tsx
// Search-independent existence (mirrors hasAnyFavorite/hasActiveUnread precedent):
const hasAnyActive = state.conversations.some(
    (c) => !state.archivedIds.has(c.id) && !parentPresent(c, ids));
const archivedAll = state.conversations.filter(
    (c) => state.archivedIds.has(c.id) && !parentPresent(c, ids));
const archivedTotal = archivedAll.length;   // tab-label count — search-independent
```

`hasAnyFavorite` already exists (L766-771) and already uses this shape — reuse it unchanged.

### List render (replaces L1008-1042)
```tsx
const visibleRows =
    tab === "favorites" ? active.filter((c) => state.favoriteIds.has(c.id)) :
    tab === "archived"  ? archived :   // `archived` (L772) = search-filtered archivedAll; both share parentPresent
    active;
// ...
{visibleRows.map((c) => renderConversation(c))}
{/* Active: 3-way — globally-empty (first-run) vs all-archived vs search-hidden.
   Uses ONLY canonical populations (hasAnyActive + archivedTotal), NOT raw state.conversations.length (P2). (ship-review) */}
{tab === "active"    && !hasAnyActive && archivedTotal === 0 && <p className="mj_RoomListEmpty">Your agent conversations will appear here.</p>}
{tab === "active"    && !hasAnyActive && archivedTotal > 0 && <p className="mj_RoomListEmpty">No active conversations.</p>}
{tab === "active"    && hasAnyActive && !visibleRows.length && <p className="mj_RoomListEmpty">No conversations match your search.</p>}
{tab === "favorites" && !hasAnyFavorite && <p className="mj_RoomListEmpty">No favorite conversations yet.</p>}
{tab === "favorites" &&  hasAnyFavorite && !visibleRows.length && <p className="mj_RoomListEmpty">No favorites match your search.</p>}
{tab === "archived"  && archivedTotal === 0 && <p className="mj_RoomListEmpty">No archived conversations.</p>}
{tab === "archived"  && archivedTotal > 0 && !visibleRows.length && <p className="mj_RoomListEmpty">No archived conversations match your search.</p>}
```
**Consistency invariant:** `archived` (the rendered list, L772, search-filtered) and `archivedTotal` (the count) are both derived from `state.conversations` with the identical `archivedIds.has(c.id) && !parentPresent(c, ids)` predicate — the count only additionally drops the search filter. So `archivedTotal >= visibleRows.length` always, and `archivedTotal` counts exactly the rows the tab CAN render (never a phantom). Verify at execution that the existing `archived` (L772) applies `!parentPresent` via its source `conversations` (L747-758 filters `!parentPresent`) — if it doesn't, align both to `archivedAll` filtered by search.

### Archived count — design decision
`archivedTotal` is **search-independent** (rationale: a tab-label count that flickers as you type reads as "results", not "how many archived exist"). The **list inside** the Archived tab stays search-filtered (search is global, consistent with the other tabs). Empty-state copy distinguishes "none archived" vs "none match search".

### Tabs markup (extends L950-973, keeps the existing `aria-pressed` button pattern)
```tsx
<div className="mj_RoomListTabs" role="group" aria-label="Filter conversations">
  {([["active","Active"],["favorites","Favorites"],["archived","Archived"]] as const).map(([key, label]) => (
    <button key={key} type="button" data-tab={key}
      className={`mj_RoomListTab${tab === key ? " mj_RoomListTab_active" : ""}`}
      aria-pressed={tab === key}
      onClick={(e) => { setTab(key); e.currentTarget.focus({ preventScroll: true }); }}>
      {label}
      {key === "archived" && archivedTotal > 0 && (
        <span className="mj_RoomListTab_count"> ({archivedTotal})</span>
      )}
    </button>
  ))}
</div>
```

**ARIA decision:** keep the existing `aria-pressed` toggle-button pattern (already in the file for 2 tabs), NOT `role="tablist"`/`role="tab"`. Reasons: (1) minimal divergence from Dan's upstream (#448 line) — this is an extension of an existing accessible pattern, not a new interaction model; (2) `role=tab` mandates arrow-key roving-tabindex + `tabpanel` wiring, which the current sidebar doesn't implement and which is a larger, riskier change. `role="group"` on the container + `aria-pressed` on each is a valid accessible segmented-control pattern. Each tab label already carries its state name so the count `(N)` doesn't need a separate `aria-label` (screen reader reads "Archived (3), pressed").

### CSS (`journal.pcss`, at `.mj_RoomListTab*` L454-486)
Existing `.mj_RoomListTabs`/`.mj_RoomListTab`/`_active`/`:hover`/`:focus-visible` already style a flex-1 pill segment set — **3 tabs reuse them unchanged** (each `flex: 1 1 0` divides three ways). Add only:
```css
.mj_RoomListTab_count {
    color: var(--cpd-color-text-primary);  /* AA-safe ALL states/themes (≥9.9:1). NOT opacity (3.06:1), NOT inherit (accent ~3:1 light-active), NOT secondary (4.29:1 dark-active). */
    font-weight: 400;                        /* de-emphasis via weight, not contrast reduction */
}
```
Additionally, the existing `.mj_RoomListTab` rule gains `min-width: 0` + `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` and reduced side padding (`--cpd-space-2x`) so three tabs + the count fit at the minimum sidebar width without overflow (plan-review B3, P13). The `.mj_RoomList_archivedToggle` / `_archivedCount` / `_archivedSection` rules (L574-605) become **dead** and are **removed** (P16 — no dead CSS).

---

## Rejected alternatives
- **A (slim):** timestamp span with no formatter (raw `formatTime` for all rows) + 3 tabs with no per-tab empty states / no year boundary. Rejected: `formatTime` on a week-old row shows a bare clock with no date context (useless); missing empty states leave a blank archived tab reading as broken. The trimmed surface saves ~15 lines for a worse UX.
- **C (over-built):** B + live-ticking relative time ("2m ago" with a re-render timer) + `role=tablist` roving-tabindex keyboard model. Rejected: operator's format is **bucketed-absolute** (today→clock, week→weekday, older→date) — a ticking timer buys zero real-workflow gain and adds a re-render surface + cleanup; `role=tablist` is a larger divergence + interaction-model change for no operator-requested benefit.

## Test plan

**Test runner (verified round 1):** jest via `pnpm test` (`jest --runInBand`); `jest.config.cjs` `testMatch: ["<rootDir>/test/unit-tests/journal/**/*-test.ts"]` — the suffix is **`-test.ts`** (hyphen), NOT `*.test.ts`. A `*.test.ts` file is silently never discovered. All test files use `<name>-test.ts` (e.g. `components-test.ts`).

### MUST — update existing tests broken by the restructure (B1)
`test/unit-tests/journal/components-test.ts` already asserts the current 2-tab + archived-disclosure structure. The restructure breaks these; they must be updated in the same PR or `pnpm test` fails on merge:
- **`tabButton` helper (L115)** typed `"All" | "Favorites"` → widen to `"Active" | "Favorites" | "Archived"` and update label lookups ("All" → "Active"). **Count-safe lookup (Codex round-2 blocker):** the helper currently does exact `textContent` equality, which will NOT match the Archived button's `"Archived (N)"` label (the `.mj_RoomListTab_count` span is a child). Fix the helper to match on the button's leading text — either (a) match a button whose `textContent` **starts with** the label, or (b) better, add a stable `data-tab="active|favorites|archived"` attribute to each `.mj_RoomListTab` in the markup and look up by that (decouples the test from the visible count entirely). Prefer (b) — it also survives future label copy changes. This means the tab markup adds `data-tab={key}` per button.
- **`describe("conversation list tabs")` (L2101-2159)** — retarget to the 3-tab structure; assert Active/Favorites/Archived selection + per-tab row visibility.
- **`describe("conversation menu controls")` (L1984-1993)** — currently clicks `.mj_RoomList_archivedToggle` to reveal an archived row before opening its menu. That element is **removed**; rewrite to select the **Archived tab** to reveal the archived row instead. (Otherwise `querySelector(".mj_RoomList_archivedToggle")!.click()` → null-deref TypeError.)
- Grep `.mj_RoomList_archivedToggle`, `archivedExpanded`, `tabButton(`, `"All"` across the test dir at execution to catch any other refs.

### Unit — `formatRelativeDay` (add to `components-test.ts` or a new `format-relative-day-test.ts`, `-test.ts` suffix)
Inject `now`; assert branch SELECTION per input: same-day → clock; 1-6 days → weekday; **exactly 7 days → dated label (the weekday/dated cutoff boundary)**; 7+ same-year → "Mon D"; prior-year → "Mon D, YYYY"; same-day future ts → clock; **tomorrow-or-later (future calendar day) → dated label, NOT clock (Codex round-3)**; **non-finite / NaN ts → `""`**; **finite-but-out-of-range ts (e.g. `Number.MAX_VALUE`, which yields an invalid Date) → `""` (no `Intl` RangeError throw) (Codex round-3)**. These last three guard against silent regression of the future-date branch and the invalid-Date guard.
- **Hermeticity (Codex-M1):** the formatter uses local-time `Date` + `Intl(undefined, …)`, so fixed epoch fixtures land on different local dates and produce locale-varying strings across CI environments. Control it: **pin `process.env.TZ`** (set before the module import / in a jest setup, e.g. `TZ=UTC`) so calendar-day boundaries are deterministic, AND assert against **expected strings constructed via the same `Intl.DateTimeFormat(undefined, …)` call** (not hardcoded "Wed"/"Jul 3" literals) so a non-en CI locale doesn't false-fail. Alternatively assert the branch taken (clock vs weekday vs date) via structural probes. Do NOT hardcode localized literals.

### Manual (P13)
Desktop + mobile widths, both themes: timestamp AA contrast (secondary token, both themes), timestamp fades on **mouse hover** but stays on **keyboard focus** (Codex-B3), 3 tabs divide evenly + wrap gracefully, `Archived (N)` count correct + stable under search typing AND equal to the archived-row count with an empty search, each empty state renders (incl. all-archived → Active shows first-run copy only when zero active exist; zero-result search → "No conversations match your search"), favorites/archived rows still open + show menu, midnight rollover reclassifies a "today" row (can force by temporarily shortening the timer or mocking).

### Build
`corepack pnpm build` clean (TS strict) + `pnpm test` green. No live deploy — merge only; the atomic swap is batched at the end by the operator.

## Resolved through review (round 1)
1. Archived count = search-independent, derived from the SAME canonical `archivedAll` population (parentPresent-excluded) as the rendered list → count/list can never diverge (Codex-B1/M1 + Claude-M1).
2. Timestamp fades on mouse hover only, stays on keyboard focus (Codex-B3).
3. Formatter guards non-finite timestamps; midnight-invalidation effect added (Codex-B2/M2).
4. Existing `components-test.ts` tab/menu tests updated in-PR; `-test.ts` glob, not `*.test.ts` (B1/B2); tests pin TZ + construct expected via same Intl call (Codex-M1).
5. CSS ownership narrowed to specific selectors; `.mj_RoomItemMenu*` / `.mj_EventRowMenu` explicitly excluded (Mi1).
