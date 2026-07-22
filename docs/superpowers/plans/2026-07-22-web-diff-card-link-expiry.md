---
title: "Web journal client — diff-card viewer-link expiry detection (execution plan)"
spec: docs/superpowers/specs/2026-07-22-web-diff-card-link-expiry-design.md
loop: 472
date: 2026-07-22
owner: easelyte
risk: low
workdir: /opt/matron/web-journal-wt-diffcard-followups
---

# Web journal client — diff-card viewer-link expiry detection (execution plan)

Client-only detect-and-degrade for expired DiffCard viewer links (loop #472). All changes are inline additions to `src/journal/components.tsx` (no file split — upstream-alignment constraint), one CSS rule in `src/journal/journal.pcss`, and new cases in `test/unit-tests/journal/diff-card-test.ts`. **No bridge or journal-server change.** Reference: the design spec (frontmatter `spec:`), which every task below cites by section.

**Repo note:** this is the `easelyte/matron-web` fork checked out at the worktree in `workdir` — a **pre-created cross-repo worktree** (`git -C /opt/matron/web-journal worktree add … origin/main`), which IS the isolation for this work. Execution and verification happen **in this worktree** (it's the `--workdir` target passed to `/execute-slim`). Do NOT spawn a nested son-of-anton worktree for the code changes — a son-of-anton worktree does not contain the matron-web tree (separate `.git`), and this matron-web worktree already provides branch isolation (R100 satisfied by the sibling repo's own worktree, per `cross_repo_slim_chain_workdir_flag`). <!-- heavy-signal:docs --> Never `cd` the son-of-anton *session* into it; the Verification subshell `cd` is scoped to those commands only.

**Scope map (spec → tasks):**
- §3.1 parse/decode (`viewerUrlExp`, `decodeViewerExp`, `MAX_VIEWER_TOKEN_LEN`, throttled warn) → **T-1.1**, tests **T-1.2**
- §3.2 render (three-way filename, skew grace, clamped self-re-arming timer) → **T-2.1**
- §3.3 style (`.mj_DiffCard_expiredNote`) → **T-2.2**
- §4 tests (all mandatory cases incl. live-flip + order-aware warn + existing-fixture assertion) → **T-1.2**, **T-2.3**
- §6 acceptance #1-6 → mapped per task acceptance below

## Phase 1 — Parse & decode layer

### T-1.1: Add `viewerUrlExp` + `decodeViewerExp` to the parse boundary

**Files:** `src/journal/components.tsx`

**Steps:**
- [ ] Add `viewerUrlExp?: number;` to the `DiffCardData` interface (`components.tsx:1288`), documented `// unix seconds from token payload; undefined if unreadable`.
- [ ] Add module-level `let _viewerExpDecodeWarned = false;` and `const MAX_VIEWER_TOKEN_LEN = 16384;` above `parseDiffPayload`, with the spec §3.1 comments (guard-boundary rationale: PATH_MAX worst case ~11KB, bound raw string before parse, residual note about the pre-existing `new URL()` at `components.tsx:1305`).
- [ ] Add the `decodeViewerExp(viewerUrl: string): number | undefined` helper verbatim to the §3.1 contract:
  - Bound `viewerUrl.length > MAX_VIEWER_TOKEN_LEN` → `undefined` **first**, before any parse (silent).
  - `new URL(viewerUrl).searchParams.get("token")` in a try/catch (defensive; unreachable via the real caller — add the clarifying comment); malformed URL → `undefined` silent.
  - No token param → `undefined` silent.
  - Inner try: `payload = token.split(".")[0]`; empty → throw; `b64 = payload.replace(/-/g,"+").replace(/_/g,"/")`; `JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)))`; require **`Number.isSafeInteger(json.exp) && json.exp > 0 && json.exp <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)`** (integer is load-bearing — a fractional `exp` wedges the floored-clock timer; the `*1000`-safe ceiling bars a huge "integer" like `1e308`/`9e15` whose `exp*1000` overflows to `Infinity`/loses precision → forever-live link; the bridge always mints a small floored-seconds `exp` at `index.js:343`) else throw; return `json.exp`.
  - Catch: throttled `console.warn` (guard on `_viewerExpDecodeWarned`, set-once) + return `undefined`.
- [ ] **Bound decode only, not the link:** keep the `MAX_VIEWER_TOKEN_LEN` check ONLY inside `decodeViewerExp`. Do NOT gate `parseDiffPayload`'s existing https block on length — that would drop a valid-but-oversized link entirely (regression). An oversized `viewer_url` must still render as a live link (`viewerUrl` set), skipping only expiry decode (`viewerUrlExp === undefined`). Per spec §3.1 "Bound the decode work only — NOT the link render."
- [ ] In `parseDiffPayload` (`components.tsx:1301`), after the existing `viewerUrl` https-bound block, set `viewerUrlExp: viewerUrl ? decodeViewerExp(viewerUrl) : undefined` in the returned object.

**Acceptance:**
- `parseDiffPayload` compiles; `DiffCardData` carries `viewerUrlExp`.
- A non-integer (`1000.5`), non-finite, ≤0, or over-ceiling (> `floor(MAX_SAFE_INTEGER/1000)`, e.g. `MAX_SAFE_INTEGER`) `exp` → `viewerUrlExp === undefined`.
- Oversized `viewer_url` (> `MAX_VIEWER_TOKEN_LEN`) → `viewerUrl` still set (live link), `viewerUrlExp` `undefined`, no warn (bound is decode-only; link not dropped).
- Present-but-undecodable in-bounds token → `undefined` + exactly one `console.warn` per module load. (spec §6 #5)
- No bridge/journal file touched. (spec §6 #6)

### T-1.2: Decode unit tests

**Files:** `test/unit-tests/journal/diff-card-test.ts`

**Steps:**
- [ ] Add a test helper `makeToken(payloadObj)` = `` `https://x.test/view?token=${Buffer.from(JSON.stringify(payloadObj)).toString("base64url")}.sig` `` (dummy sig; client never verifies it). `Buffer...toString("base64url")` (Node ≥15, available in the jsdom test env) round-trips the client's `atob` + `-/_→+//` normalization.
- [ ] **Amend BOTH existing exact-shape `toEqual` fixtures** (not just the rich one — T-1.1 adds `viewerUrlExp` to *every* `parseDiffPayload` return, so any un-amended `toEqual` fails with an unexpected `viewerUrlExp: undefined`):
  - "parses a rich diff payload" (`diff-card-test.ts:77-88`): add `viewerUrlExp: undefined` (the `token=secret` fixture is undecodable → `undefined`).
  - "leaves optional metadata undefined for a bare diff" (`diff-card-test.ts:92-103`): add `viewerUrlExp: undefined`.
  - (The `it.each` / `toMatchObject` / `.diff`-only assertions at :106-153 are partial-match or field-scoped and need no change — but grep the file for every `.toEqual(` on a `parseDiffPayload(...)` result and confirm each is covered.)
- [ ] In `describe("parseDiffPayload")`, add **decode-value** cases (these assert `.viewerUrlExp` only; they do NOT assert on `console.warn`, so they're order-independent):
  - future integer `exp` token ⇒ `viewerUrlExp === <future>`.
  - past integer `exp` token ⇒ `viewerUrlExp === <past>` (decode is time-agnostic; expiry is a render concern).
  - out-of-range `exp` (`-1`, `0`, a **fractional** `1000.5`, and an **over-ceiling** `Number.MAX_SAFE_INTEGER`) ⇒ `viewerUrlExp === undefined` (fractional guards the integer-exp fix; MAX_SAFE_INTEGER guards the `*1000`-safe ceiling — `exp*1000` would overflow).
  - oversized `viewer_url` (length > `MAX_VIEWER_TOKEN_LEN`, e.g. `"https://x.test/view?token=" + "A".repeat(20000)`) ⇒ `viewerUrl` STILL SET (live link preserved) but `viewerUrlExp === undefined` (the bound lives in `decodeViewerExp`, skipping expiry decode without dropping the link).
- [ ] **Warn-throttle test in an isolated module** (deterministic, order-independent — supersedes the spec §4 "fold into the existing fixture" approach, which is file-order-fragile because the range-sanity failure shares the same throttle budget). Add a dedicated test using `jest.isolateModules(() => { ... })` to get a fresh `_viewerExpDecodeWarned`:
  ```ts
  it("warns exactly once across undecodable tokens, silent for non-token rejects", () => {
    jest.isolateModules(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parseDiffPayload: pdp } = require("../../../src/journal/components");
      pdp({ diff: "x" });                                              // no viewer_url → silent
      pdp({ diff: "x", viewer_url: "https://x.test/view?token=" + "A".repeat(20000) }); // oversized → silent (guard-order)
      expect(warn).not.toHaveBeenCalled();
      pdp({ diff: "x", viewer_url: "https://x.test/view?token=secret" }); // undecodable → warn #1
      pdp({ diff: "x", viewer_url: makeToken({ exp: -1 }) });             // out-of-range → throttled, no 2nd warn
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });
  ```

**Acceptance:**
- All new `parseDiffPayload` assertions green; both amended `toEqual` fixtures green; the isolated-module warn test asserts exactly-one-warn deterministically regardless of file/run order.
- No decode-value test depends on wall-clock or on `console.warn` state (decode is time-agnostic; warn state is isolated to the one dedicated test).

## Phase 2 — Render, style & render-layer tests

### T-2.1: Three-way filename render + skew grace + live-degradation timer

**Files:** `src/journal/components.tsx` (`DiffCard`, `components.tsx:1329`)

**Steps:**
- [ ] Add `const CLOCK_SKEW_GRACE_SEC = 30;` and `const MAX_TIMEOUT_MS = 2_147_483_647;` (module scope or in-component const per spec §3.2).
- [ ] In `DiffCard`: `const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));`; `const expiresAt = data.viewerUrlExp;`; `const expired = expiresAt !== undefined && nowSec >= expiresAt + CLOCK_SKEW_GRACE_SEC;`.
- [ ] Add the `useEffect` (deps `[expiresAt, expired, nowSec]`) exactly per §3.2: early-return when `expiresAt === undefined || expired`; compute `msLeft = (expiresAt + CLOCK_SKEW_GRACE_SEC) * 1000 - Date.now()`; `msLeft <= 0` → bump `nowSec` and return; else `setTimeout(bump, Math.min(msLeft + 500, MAX_TIMEOUT_MS))` with cleanup `clearTimeout`.
- [ ] Replace the two-way filename render (`components.tsx:1373`, `data.viewerUrl ? <a> : <span>`) with three-way:
  - `viewerUrl && !expired` → the existing `<a className="mj_DiffCard_filename mj_DiffCard_link" href target=_blank rel="noopener noreferrer">`.
  - `viewerUrl && expired` → `<span className="mj_DiffCard_filename mj_DiffCard_expired" title="Viewer link expired — re-open the file from a fresh edit">{filename}</span>` immediately followed by `<span className="mj_DiffCard_expiredNote">link expired</span>`.
  - `!viewerUrl` → existing plain `<span className="mj_DiffCard_filename">`.

**Acceptance:**
- Live card (future exp, or past-but-within-grace) → renders `<a>`. (spec §6 #2)
- Expired card (past exp + grace) → no `<a>`, `mj_DiffCard_expired` span + `link expired` note. (spec §6 #1)
- No-link card → plain span, no `<a>`, no expired note. (spec §6 #3)
- No new lint/TS errors; `components.tsx` not split. (spec §6 #6)

### T-2.2: Style rule

**Files:** `src/journal/journal.pcss`

**Steps:**
- [ ] Add beside `.mj_DiffCard_link` (`journal.pcss:1023`):
  ```css
  .mj_DiffCard_expiredNote {
      color: var(--cpd-color-text-secondary);
      font: var(--cpd-font-body-xs-regular);
  }
  ```
- [ ] Confirm no rule is needed for `.mj_DiffCard_expired` (inherits `.mj_DiffCard_filename`; intentionally not accent-colored — not actionable).

**Acceptance:** both custom properties already exist in `journal.pcss` (verified in review, defined 27×); no undefined-token warnings; the expired note renders in secondary color.

### T-2.3: Render-layer tests (states, skew, mandatory live-flip, order-aware warn)

**Files:** `test/unit-tests/journal/diff-card-test.ts`

All clock-sensitive cases live in **one dedicated `describe` with an explicit fake-timer lifecycle** — `beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(FIXED_MS); })` and `afterEach(() => jest.useRealTimers())` (diff-card-test.ts has no existing timer reset). **`setSystemTime` MUST follow `useFakeTimers()` in the same lifecycle** — Jest 30's `setSystemTime` no-ops AND emits a stray `console.warn` if fake timers aren't active (that stray warn would also corrupt any warn-count assertion). Keeping the warn-throttle test (T-1.2) in its own `jest.isolateModules` block keeps it fully decoupled from this timer state.

Declare **test-local constants** at the top of this describe (the impl constants live inside `components.tsx` and are NOT exported — do not export them just for a test):
```ts
const FIXED_MS = 1_700_000_000_000; // multiple of 1000; fake-clock epoch
const nowSec = Math.floor(FIXED_MS / 1000);
const CLOCK_SKEW_GRACE_SEC = 30;    // mirrors components.tsx
const MAX_TIMEOUT_MS = 2_147_483_647; // mirrors components.tsx
```
Comment that these mirror the (unexported) `components.tsx` values; if the impl values change, update both. All `exp` fixtures below are computed from `nowSec`.

**Steps:**
- [ ] **Live vs expired render** (fake-timer describe): `makeToken({ exp: nowSec + 3600 })` ⇒ `a.mj_DiffCard_filename` present; `makeToken({ exp: nowSec - 3600 })` (well beyond grace) ⇒ no `<a>`, `.mj_DiffCard_expired` + `.mj_DiffCard_expiredNote` present. (§6 #1/#2)
- [ ] **Skew grace** (fake-timer describe): `exp = nowSec - 5` (past but within `CLOCK_SKEW_GRACE_SEC=30`) ⇒ still renders `<a>` (grace not crossed). (§6 #2, guards the B1/skew fix)
- [ ] **No-link regression:** no `viewer_url` ⇒ plain span, NO `<a>`, NO `.mj_DiffCard_expiredNote` (can live outside the fake-timer describe — no time dependence). (§6 #3)
- [ ] **Mandatory live-flip** (fake-timer describe, §6 #4): mount a card with `exp = nowSec + 60`; assert live `<a>` at mount; then flip via the file's async-`act` precedent (`components-test.ts:1035-1054`):
  ```ts
  await act(async () => {
    jest.advanceTimersByTime((60 + CLOCK_SKEW_GRACE_SEC) * 1000 + 500 + 50);
  });
  ```
  then re-query and assert `.mj_DiffCard_expired` present and no `<a>`. Use `await act(async () => …)` (not the sync form) so the effect-scheduled `setNowSec` flushes under React 19 + Jest 30.
- [ ] **Clamp self-re-arm** (fake-timer describe, Tier 2 — covers the >24.85-day path in T-2.1; §6 #4 pathological arm): mount with `exp = nowSec + 30 * 86400` (~30 days, beyond the `MAX_TIMEOUT_MS` ~24.85-day ceiling). **First assert the clamp itself** (Jest fake timers do NOT reproduce the browser's signed-32-bit coercion, so advancing alone would pass even if `Math.min(…, MAX_TIMEOUT_MS)` were omitted — the assertion must check the delay directly): `const setTimeoutSpy = jest.spyOn(global, "setTimeout")`, mount, then `expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMEOUT_MS)` (the first arm is clamped to the ceiling, not the full 30-day delay). Then assert live `<a>` at mount; `await act(async () => jest.advanceTimersByTime(MAX_TIMEOUT_MS))` ⇒ still live (one clamped wait fired and re-armed via the `nowSec` dep); then `await act(async () => jest.advanceTimersByTime(30 * 86400 * 1000 - MAX_TIMEOUT_MS + CLOCK_SKEW_GRACE_SEC * 1000 + 1000))` ⇒ flipped to `.mj_DiffCard_expired`, no `<a>`. `setTimeoutSpy.mockRestore()` after.

**Acceptance:**
- Full `diff-card-test.ts` green including the mandatory live-flip and clamp-rearm cases; fake timers restored in `afterEach` (no leak to later tests); no stray `setSystemTime` warn (fake timers active first).
- Every spec §6 acceptance criterion maps to at least one green test (§4 contract; P14/P38): #1 expired-render, #2 live+skew, #3 no-link, #4 live-flip (+clamp), #5 T-1.2 decode/warn, #6 diff --stat + no split.

## Verification (end of plan)

Run from **inside** the worktree (`cd /opt/matron/web-journal-wt-diffcard-followups` in a subshell for these commands only — never `cd` the son-of-anton session itself; a subshell is fine). Exact commands are the journal fork's own `package.json` scripts — this repo has **no `nx`, no `@element-hq/web-shared-components`, no `eslint`** (those belong to the *legacy* Element client at `/opt/matron/web`, a different repo — do NOT use `reference_matron_web_deploy`'s nx/Docker commands here). Convention source: `reference_matron_web_jest_convention`.

- [ ] **Install deps first** — a `git worktree add` checkout has NO `node_modules`: `cd /opt/matron/web-journal-wt-diffcard-followups && corepack pnpm install` (cached, ~5s). Every command below fails "command/module not found" without this.
- [ ] **Tests:** `node_modules/.bin/jest test/unit-tests/journal/diff-card-test.ts` — all green. (NOT `corepack pnpm exec jest` — that fails "jest not found" in a worktree; `pnpm test` runs the whole `jest --runInBand` suite if you want the full run.)
- [ ] **Types + format:** `corepack pnpm run lint` (= `pnpm lint:types` [`tsc --noEmit`] `&& prettier --check src test ...`) — clean. If prettier flags the edited files, `corepack pnpm run lint:fix` then re-verify.
- [ ] `git -C /opt/matron/web-journal-wt-diffcard-followups diff --stat` shows only `src/journal/components.tsx`, `src/journal/journal.pcss`, `test/unit-tests/journal/diff-card-test.ts`, plus the spec/plan docs — no bridge/journal, no file split.
- [ ] Live deploy + operator smoke-test is a **ship-slim** concern (rebuild `webapp/` via the atomic runbook in `reference_matron_web_deploy` → `corepack pnpm build` in place → verify `:8443`), NOT a plan-execution step. Note the journal fork builds with **webpack** (`pnpm build` = `webpack --mode production`), not nx.

## Dependency graph

- T-1.1 → T-1.2 (tests need the helper) and → T-2.1 (render reads `viewerUrlExp`).
- T-2.1 → T-2.2 (style for the render) and → T-2.3 (render tests).
- **T-1.2 solely owns the warn-throttle test** (self-contained `jest.isolateModules` block, no ordering dependency on any other task). T-2.3 has NO warn step — it only references `#5 T-1.2 decode/warn` in its acceptance map. Do not relocate or duplicate a warn assertion into T-2.3's fake-timer describe (that would recreate the `console.warn`↔clock state coupling the isolated test avoids).
- Single-file core (components.tsx) → tasks are sequential within the file, not parallelizable across windows (upstream-alignment constraint keeps one writer).

## Deliberate exceptions (right-sized, not gaps)

- **No re-fetch of a fresh viewer link** — bridge-gated, out of scope (spec rejected_alternatives); not planned.
- **No mid-session wall-clock-correction handling** (either direction) — accepted limitation (spec §3.2). Forward correction self-heals via the armed timer; backward correction (a >30s-fast clock wrongly-expires a valid link, then corrects) stays wrongly-expired until remount (does NOT self-heal on plain re-render — `nowSec` is timer-updated state). Both require a grossly-wrong OS clock that breaks TLS/etc. long before a diff-card link matters; viewer stays authoritative. A Page-Visibility/periodic-resync listener is disproportionate machinery. Not planned. (Codex phase-2 review, ship_blocking:false.)
- **No cross-repo producer/consumer schema test for the token envelope** (P26) — CONSCIOUSLY OVERRIDDEN, re-flagged 3× across spec-review r2/r3 + plan-review r3. Rationale (unchanged each round): this is a best-effort UX affordance, not a correctness/security boundary (the viewer re-validates authoritatively), so token-format drift degrades to today's dead-link behavior + a `console.warn` breadcrumb, never data loss or a false capability. A shared producer/consumer fixture would introduce exactly the cross-repo coupling this matron-web-only spec avoids. The **canonical fix is bridge-side** — publish `expires_at` on the diff payload (`generateFileLink` already computes `exp` at `bridge-journal/index.js:343`, grep-confirmed this session), deleting `decodeViewerExp` and the coupling entirely — and is deferred to the **#473 bridge-enablement loop** (which opens the same `buildEditDiffPayload` surface). The runtime `console.warn` is the proportionate client-only drift signal until then. Not planned here.
- **No `useMemo` on `parseDiffPayload`** — the per-render re-parse matches the existing #455 inline pattern; memoizing one field would diverge from upstream structure. Not planned.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

## Appendix: Verified Claims (research pass 2026-07-22)

Automated research tooling (Tavily) is not configured in this environment; claims below are verified by established knowledge + in-repo precedent rather than fresh web search. All three are stable, non-controversial platform facts and were partially grounded by the spec-review reviewers.

✓ Claim: `Buffer.from(str).toString("base64url")` yields URL-safe base64 without padding. Verified: standard Node API since 15.7.0 (2021); matron-web's own bridge uses `.toString('base64url')` at `bridge-journal/index.js:344`, and the spec-review Claude reviewer confirmed the client's `atob` + `-/_→+//` normalization round-trips against it.

✓ Claim: `setTimeout` delay clamps to signed 32-bit max `2147483647` ms (~24.85 days); larger fires ~immediately. Verified: HTML timers spec / MDN — the `MAX_TIMEOUT_MS` clamp in T-2.1 is exactly this value.

✓ Claim: `jest.useFakeTimers()` + `advanceTimersByTime()` inside React `act()` flushes pending `setTimeout` callbacks and applies the resulting state updates. Verified: standard jest+RTL pattern; the repo already uses it at `test/unit-tests/journal/components-test.ts:1035-1054` (long-press menu test), which the spec-review Claude reviewer cited as the live-flip test's precedent.
