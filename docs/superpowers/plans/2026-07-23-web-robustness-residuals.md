# Plan — matron-web robustness residuals batch

**Spec:** `docs/superpowers/specs/2026-07-23-web-robustness-residuals-design.md`
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client) · branch `feat/web-residuals` off `origin/main`
**Scope:** fix #494, #485, #486 (matron-web code + tests); close #481/#483/#491 + file matron-journal loop + close #484 (son-of-anton loop store, at ship).

## Constraint recap (from spec)
- No new source files, no restructuring of Dan's layout (`project_matron_web_stays_dan_upstream_aligned`). All edits inline in existing `src/journal/{client.ts,composer-drafts.ts,components.tsx}` + `test/unit-tests/journal/`.
- No new deps. Styling stays `--cpd-*` tokens.
- Verify commands: `pnpm lint:types`, `pnpm test`, `pnpm lint`. Build: `corepack pnpm build` (webpack → `webapp/`).

## Principles pass (applied while planning)
- **Fail-loud / no silent loss** (spec #486): the draft badge + refuse-not-evict cap surface non-durability instead of silently dropping — every persist/clear failure path sets `durability`.
- **Right-size-to-gain**: #491 stays closed (no code); #485 keeps the proportionate capture-guard (no client.ts state-machine refactor); #486 accepts documented Tier-2 residuals rather than gold-plating (no atomic cross-tab guard, no origin-wide budget).
- **Canonical source** (spec #486 render contract): the store `durability` flag is authoritative; React state mirrors and re-syncs from it on convo-switch.
- No hardcoded-path / duplicate-logic violations introduced (reuses existing `session`-keyed helpers, existing notice styling, existing `sendPendingMessage(message, connection)` optional-param).

## Task dependency graph
- **Phase 1 (#494)**, **Phase 2 (#485)**, **Phase 3 (#486)** touch disjoint files (`theme-test.ts`; `client.ts` + `client-test.ts`; `composer-drafts.ts` + `components.tsx` + `composer-drafts-test.ts` + `components-test.ts`) — independent, executable in any order / parallel. **Verified disjoint (round-2 Codex M1):** Phase 2's tests land in `client-test.ts`, Phase 3's composer badge tests in `components-test.ts` — no shared test file, so parallel execution is conflict-free.
- **Phase 4** (loop-store reconciliation) runs on son-of-anton at ship, after the matron-web PR merges. Depends on nothing in the code phases except "code is shipping."
- Global gate: `pnpm lint:types && pnpm test && pnpm lint` green before ship (all phases).

## Spec-coverage map
| Spec section | Plan task |
|---|---|
| FIX 1 (#494 drift guard test) | T-1.1 |
| FIX 2 (#485 identity tuple + return-false + captured connection) | T-2.1, T-2.2 |
| FIX 3.A per-key + persist(convoId) + read fallback+ok:false + clear v1-purge | T-3.1, T-3.2 |
| FIX 3.B refuse-not-evict cap | T-3.1 |
| FIX 3.C byte cap | T-3.1 |
| FIX 3.D durability + badge render contract | T-3.1, T-3.3 |
| FIX 3.F gated v2-precedence migration | T-3.1 |
| FIX 3 tests | T-3.4 |
| CLOSE #481/#483/#491, FILE+CLOSE #484 | T-4.1, T-4.2 |

---

## Phase 1 — #494 dark-canvas drift guard (test-only)

### T-1.1: Add a 3-way canvas parity test to `theme-test.ts`
- [ ] In `test/unit-tests/journal/theme-test.ts`, add a `describe("dark-canvas single-source drift guard", ...)` block.
- [ ] Add a helper that reads `src/journal/shell.pcss` (via `readFileSync`, same pattern as the existing `bootstrapScript()` at line 45) and extracts the dark `--cpd-color-bg-canvas-default` value **bounded to the `[data-theme="dark"] { ... }` block, NOT sliced to EOF (round-2 Codex M3):** find the `[data-theme="dark"]` selector, then the substring from its opening `{` to the matching closing `}` (first `}` at brace-depth 0 — the block is single-level non-nested, confirmed line 60-90), and match `--cpd-color-bg-canvas-default:\s*(#[0-9a-fA-F]{3,8})` **within that bounded block only**. This must NOT match the `:root` `#fff` (line 12) nor any later declaration outside the dark block — so removing the token from the dark block fails the test even if another `--cpd-color-bg-canvas-default` appears elsewhere. If the token is absent from the dark block, the helper throws (test fails loud).
- [ ] Extract the dark literal from `theme.ts` source (`readFileSync` of `src/journal/theme.ts`, regex the `resolved === "dark" ? "(#[0-9a-fA-F]{3,8})"`) and from the `index.html` bootstrap (reuse `bootstrapScript()` + regex the same ternary).
- [ ] Assert all three are **equal to each other** (pure parity: `new Set([...]).size === 1`), case-insensitively — **NOT pinned to a specific literal**. A literal pin would have to churn here on every legitimate palette change; parity is the real invariant. The shell.pcss dark token is the reference.
- **Canonical value note (final-review reconciliation):** at spec/plan authoring time the dark canvas was `#16191d`; it became **`#1a1c20`** when origin/main's v2 warm-neutral palette (e81cf44) landed during this session. On rebase, the #494 guard **correctly caught** that shell.pcss changed but the two JS `theme-color` copies did not — so Phase 1 also **updates production `theme.ts` + `index.html`** to `#1a1c20` (the guard's enforced maintenance). This supersedes the "no production code changed" phrasing: the guard's whole point is to force exactly this sync when the palette moves.
- **Acceptance:** `pnpm test` green; the parity test FAILS if any one of the three literals is edited in isolation (proven on the real rebase — it caught the v2 drift); a dark-block *without* the token throws even when a same-named declaration exists elsewhere (round-2 Codex M3); a *commented-out* token also fails (Phase-2 review).
- **Principle:** this delivers *drift detection*, not P2 derivation (spec FIX 1) — a parity guard, not a single source.

---

## Phase 2 — #485 sendMessage full session-identity tuple

### T-2.1: Capture the identity tuple before the durable await + guard dispatch
- [ ] In `src/journal/client.ts` `sendMessage` (602-638), after the `if (!body || !conversationId || !this.database) return false;` and `if (this.isChildConvo(conversationId)) return false;` guards, capture `const db = this.database; const gen = this.sessionGen; const connection = this.connection;` and define `const owns = (): boolean => this.sessionGen === gen && this.database === db && this.connection === connection;`.
- [ ] Build `message` as today, then `await db.addToOutbox(message);` (use captured `db`, not `this.database`).
- [ ] After the await: `if (!owns()) return false;` — skips the post-send work (sendTick patch, refresh, dispatch) and returns `false` so the composer keeps the draft (spec FIX 2 return-value decision).
- [ ] When `owns()`: run the existing `sendTick` patch + `void refresh()` as today, and dispatch via `this.sendPendingMessage(message, connection)` — pass the **captured** `connection` (the method already accepts the optional param, used at line 1513).
- [ ] Happy path returns `true` unchanged.
- **Acceptance:** `pnpm lint:types` green; on the no-swap path, behavior is byte-identical to today (returns `true`, dispatches on the live connection); on `!owns()`, returns `false` and never calls `sendPendingMessage`.
- **Scope note:** do NOT add a connection-ready state-machine signal (spec: out of scope, touches Dan's core). The startSession stopped-connection residual is accepted/documented.
- **Return-value is a SETTLED spec decision — do NOT re-open (spec FIX 2 "Return-value decision", reviewer-oscillation stop):** `return false` on `!owns()` is deliberate. It was argued five ways across spec-review rounds (the opposite, `return true`, reintroduces round-1's silent-loss on the logout-wipe path). The residual — a *manual* resend in the ultra-rare survive-and-replay window producing a fresh-`localId` dup — is documented and tracked via #484's content-dedup stretch (T-4.1). Reviewers re-flagging this (`procedure_codex_review_re_flags_operator_accepted_limitations`) get the documented override, not a re-flip.

### T-2.2: Unit tests for the identity-tuple guard in `client-test.ts`
- [ ] Add tests to the existing `test/unit-tests/journal/client-test.ts` (~3070 lines; it has an `internals()` cast + `FakeDatabase` harness and near-identical session-swap-mid-await tests — `it.each(["logout","startSession"])("guards cross-session egress...")` at ~line 1687 — reuse that exact pattern; do NOT create a new file, do NOT fall back to composer-level coverage). Round-1 confirmed this harness exists.
- [ ] **Three INDEPENDENT negative cases** so a `sessionGen`-only implementation can't pass (round-1 Codex M4): mid-await mutate (a) `sessionGen` only, (b) `database` identity only, (c) `connection` identity only — each asserts `sendMessage` returns `false` and `sendPendingMessage` is NOT called.
- [ ] Happy path: no swap → returns `true`, dispatches on the captured connection exactly once.
- **Acceptance:** `pnpm test` green; all four cases assert the documented behavior; the three negative cases each isolate one tuple field.

---

## Phase 3 — #486 durable, robust draft persistence

### T-3.1: Rewrite `composer-drafts.ts` store internals (per-key v2, cap, migration, durability)
- [ ] Rewrite `makeDraftStore` in `src/journal/composer-drafts.ts` to the spec FIX 3 design. Keep the `DraftStore` interface shape but change `persist` to take `convoId` and add `durability(convoId)`:
  - Per-key: `perKey(convoId) = matron:draft:v2:${encodeURIComponent(session.serverUrl)}:${session.userId}:${encodeURIComponent(convoId)}`, value = raw text.
  - `setDraft(convoId, text)` → update in-memory `mem` only + set internal `lastTouched = convoId` (kept for parity; write is by explicit convoId).
  - `persist(convoId)` → write only `perKey(convoId)`. **Empty/whitespace is a logical deletion (round-3 Codex B2):** `removeItem(perKey)` AND, if a v1 blob is retained (partial migration), purge `convoId` from it too — identical to `clear()`'s v1-purge, so deleting all text can't resurrect a stale v1 entry on reload. (Factor a shared internal `deleteEverywhere(convoId)` used by both empty-persist and `clear`.) For non-empty text: enforce byte cap (C: skip write if `utf8Length(text) > MAX_DRAFT_BYTES`, set durability non-durable); enforce refuse-not-evict count cap (B: prefix-scan this store's keys; if writing a NEW key would exceed `MAX_DRAFT_ENTRIES`, refuse + set durability non-durable; updates to existing keys always allowed); on quota/SecurityError throw → catch, set durability non-durable. On success → durability ok.
  - `read(convoId)` → `{ text, ok }`; text = `mem` ?? v2 value ?? (retained v1 blob entry) ?? `""`; wrap `getItem` in try/catch returning `{ text: "", ok: false }` on throw (preserve current contract).
  - `clear(convoId)` → drop `mem`, `removeItem(perKey)`, and if a v1 blob is retained remove `convoId` from it (rewrite minus entry, or delete v1 key if now empty); all in try/catch; on throw log + set durability non-durable; `mem` cleared regardless.
    - **On SUCCESS, reset `durability(convoId) → "ok"` (round-3 Codex M1):** like successful `persist`, a successful `clear`/empty-persist must clear a prior `non-durable` flag, else a quota failure followed by storage recovery + a successful send leaves a stuck false warning. Test the fail→recover transition.
    - **Clear-failure atomicity is an ACCEPTED spec-level edge, NOT a tombstone (round-2 Codex B2 = spec round-6 Major-2, documented override):** if one localStorage op succeeds and the next throws (`SecurityError`/quota — only possible mid partial-migration when both a v2 key and a retained v1 entry exist), a stale copy can survive and the `read()` fallback could resurrect it on reload. A failure-atomic tombstone is disproportionate for a P5 draft store guarding an ultra-rare (storage-throw ∧ partial-migration) intersection; the `durability → non-durable` flag is the P3 signal, and any resurrect-then-resend is subsumed by #484's idempotency follow-up. Do NOT add a tombstone key. Order the ops so the retained-v1 purge precedes the v2 `removeItem` to minimize the window, but the accepted residual stands.
  - `durability(convoId)` → `"ok" | "non-durable"` from an internal per-convo flag map.
  - **Migration (F):** on construction, if legacy `matron:draft:v1:<server>:<user>` blob present: for each entry write v2 **only if the v2 key is absent** (v2-precedence); respect the byte cap **AND the `MAX_DRAFT_ENTRIES` count cap** (round-1 Codex M2 — a >50-entry v1 blob must NOT create >50 v2 keys: apply the same refuse-not-evict rule using the combined existing-v2 + already-migrated count; entries beyond the cap are refused, not written). Remove the v1 blob only if **every** entry is durable in v2 (each v2 key exists AND no write/refusal occurred); if any entry was refused (over-cap or oversized) or threw, **retain the v1 blob untouched** + set durability non-durable (the refused entries stay readable via the `read()` v1 fallback). Malformed v1 → skip (fail-open). Never delete a v1 entry before its v2 copy is durable.
- [ ] Keep `MAX_DRAFT_BYTES = 64*1024` and `MAX_DRAFT_ENTRIES = 50`. Keep `NOOP` store for no-session.
- **Acceptance:** `pnpm lint:types` green; two store instances on shared localStorage do not clobber each other's per-key values.
- **Principle:** no silent eviction (refuse-not-evict); no whole-map serialization; store flag is canonical for durability.

### T-3.2: Update `components.tsx` composer to pass `convoId` to `persist`
- [ ] In `src/journal/components.tsx`, change the three `drafts.persist()` call sites to pass the convo they persist:
  - `setBodyDraft` debounce (≈2578): capture `cid` at schedule time — `const cid = convoIdRef.current; ... setTimeout(() => { drafts.persist(cid); setNonDurable(drafts.durability(cid) === "non-durable"); ... }, 250)`.
  - `flushDraft` (≈2565): persist the convo it was scheduled for. Since the convo-switch effect calls `flushDraft()` (2601) before updating `prevConvoIdRef` (2607), flush uses `prevConvoIdRef.current`. Keep `flushDraft` correct for the pagehide/unmount case too (where `prevConvoIdRef.current === convoIdRef.current`).
  - `send()` else-branch (≈2635): `drafts.persist(cid)`.
- **Store-identity on session-swap = accepted ultra-rare edge (round-3 Codex B1):** `drafts` is recreated when `state.session` changes (`useMemo([state.session])`). In the normal flow a session change drives `phase → signed-out`, which **unmounts the composer**, so the "flush A through a newly-replaced store" window requires a session swap that keeps the composer mounted — the same ultra-narrow session-transition class as the #485 residual, on unsent-draft data belonging to the departing session. Do NOT build a session-tuple-capture into the draft flush (disproportionate; parallels the #485 out-of-scope call). Defensive minimum: `flushDraft`/the debounce close over the current `drafts` prop (React recreates the callback when `drafts` changes), so a *conversation* switch within a stable session (the common case) always flushes on the correct store. The cross-session-mounted-composer case is documented-accepted, tracked alongside the #485 connection-ready follow-up (T-4.1).
- **Acceptance:** `pnpm lint:types` green; the same-session edit-A → switch-to-B → edit-B sequence writes each convo's own key on the same store (covered by T-3.4).

### T-3.3: Non-durable badge + render-state contract in `components.tsx`
- [ ] Add `const [nonDurable, setNonDurable] = useState(false)` to the composer.
- [ ] After **every** `persist(convoId)` call (debounce, `flushDraft`, `send()` else-branch) **AND after `clear(cid)`** (the `send()` success branch — round-1 Codex B3: a clear-failure sets the store flag but must be mirrored to React), call `setNonDurable(drafts.durability(cid) === "non-durable")` so React re-renders (a sync getter alone won't).
- [ ] **Guard every async setter against a convo switch (round-1 Codex B2):** in the debounce callback and any post-await path (`send()`), only apply the mirror when the persisted/cleared `cid` is still selected — `if (convoIdRef.current === cid) setNonDurable(...)`. Otherwise a late completion for A could overwrite B's badge. (Synchronous paths where `cid === convoIdRef.current` need no guard, but adding it is harmless.)
- [ ] On convo-switch (the convo-change `useLayoutEffect`, ≈2599), **sync from the store** for the new convo: `setNonDurable(drafts.durability(newConvoId) === "non-durable")` — NOT a blind reset to `false` (spec round-6 B2: preserves a still-non-durable warning across switch-away/back). This also surfaces a `clear()`-failure flag on the next selection.
- [ ] `setNonDurable` is a stable state setter — safe to omit from any `useCallback`/`useEffect` deps array (`flushDraft`'s deps stay `[cancelDraftDebounce, drafts]`); if `pnpm lint`'s exhaustive-deps rule is strict, this is a no-op addition, not a logic concern.
- [ ] Render a small inline badge near the composer when `nonDurable` is true: plain text "Draft won't be saved — storage full" using existing notice/`controlError` styling vocabulary (`--cpd-*` tokens), scoped to the selected conversation. No new component, no new CSS file beyond a class in `journal.pcss` if needed (reuse existing notice class if one exists).
- **Acceptance:** `pnpm test` + manual: a forced persist failure flips the badge on with no other interaction; switching away from a non-durable convo and back keeps the badge.

### T-3.4: Reconcile + extend `composer-drafts-test.ts`
- [ ] **FIRST delete/rewrite the ~15 existing tests that encode the deleted v1 single-blob model (round-1 Claude Major-1):** the current file (≈lines 25-160) has tests calling the zero-arg `persist()` and asserting whole-blob writes, eviction-by-recency, and >50-entry hydration-cap — all invalid under T-3.1 (per-key, `persist(convoId)`, refuse-not-evict, no hydration). The signature change alone makes every zero-arg `persist()` call a `tsc` error. Remove or rewrite each to the new model; do NOT treat this task as purely additive. `pnpm lint:types` is the gate that the reconciliation is complete.
- [ ] Then add the new cases:
  - per-key isolation: two instances, write different convos, assert neither clobbers the other.
  - `persist(convoId)` correctness across edit-A → switch-to-B → edit-B (each convo's own key; no stale cross-write).
  - gated v2-precedence migration: seed a 2-entry v1 blob → all-success removes v1; a pre-existing v2 key is NOT overwritten by stale v1; force the 2nd write to throw → v1 retained AND `read()` returns the failed entry via v1 fallback + durability non-durable.
  - `read()` when `getItem` throws → `{ text: "", ok: false }` (no crash).
  - quota-throw on persist → durability flips to non-durable.
  - `clear()` while v1 retained → entry purged from v1 (reload does not resurrect); `clear()` with `removeItem` throwing → mem still cleared, no crash.
  - refuse-not-evict cap: at 50 keys, a 51st NEW convo is refused (durability non-durable) and the existing 50 are untouched; updating an existing key at cap still succeeds.
  - **over-cap migration (round-1 Codex M2):** seed a v1 blob with >50 entries → migration writes up to `MAX_DRAFT_ENTRIES`, refuses the rest, and retains v1 (does NOT create >50 v2 keys, does NOT delete v1).
  - **empty-persist logical-delete while v1 retained (round-3 Codex B2):** partial-migration retains v1; delete-all-text (empty persist) on a migrated convo → reload `read()` returns `""`, NOT the stale v1 text (empty-persist purged v1 too).
  - **durability recovery on successful clear/persist (round-3 Codex M1):** force a persist quota-failure (durability non-durable), then a successful `clear`/`persist` → `durability(convoId)` returns `"ok"` (no stuck false warning).
- [ ] Add composer badge tests to the existing **`test/unit-tests/journal/components-test.ts`** (round-2 Codex M1 — this file already renders/tests the `Composer` component; NOT `client-test.ts`, so Phase 2 and Phase 3 stay on disjoint files and the parallel claim holds) for the **deferred-send/convo-switch badge (round-1 Codex B2)** and the **send-success/clear-failure badge (round-1 Codex B3):** a late persist/clear for A after switching to B must not alter B's badge; a clear-failure after a successful send surfaces the badge on A's next selection.
- **Acceptance:** `pnpm test` green with all cases; `pnpm lint:types` clean (proves the v1-model tests were reconciled); `pnpm lint` clean.
- **Note (byte-stability):** these tests assert on localStorage state + return values, not on regenerated files, so no timestamp-normalization concern applies.

---

## Phase 4 — Loop-store reconciliation (son-of-anton VPS canonical, NOT the matron-web executor)

> **⚠ Execution substrate + R100 lane (round-1 Codex M1 / Claude Major-2 + round-2 Codex B1):** these operate on the **canonical son-of-anton loop store on the VPS** (`/root/.openclaw/workspace/memory/open-loops.json`), NOT the matron-web worktree (which has no `open_loops_store.py`, no `memory/open-loops.json`, no PYTHONPATH into son-of-anton). **`/execute-slim`/`/execute-heavy-codex` running in the matron-web worktree MUST NOT attempt Phase 4** — it will import-fail or mutate nothing; execute-phase workers mark Phase 4 deferred-to-coordinator and do not run it.
>
> **R100/R101/R102-compliant lane (round-2 Codex B1, round-3 Codex B3, final-review blocker):** loop-store mutation is canonical-state mutation — it must NOT be run inline from main chat. **The mandatory lane is an Agent-tool spawn with `isolation: worktree`** that performs the `add_loop`/`close_loop_by_id` mutations and commits them as a `chore(loops): ...` change (`procedure_subagent_followup_filing_via_agent_tool_spawn` — the R100-compliant post-merge closure pattern; matches the repo's `chore(loops): ...` history and CLAUDE.md "Mutations land via `chore(loops): ...` PR commits"). **`/close` is NOT a mutation lane** (final-review blocker): its open-loop step only *summarizes* unfinished work — it does not run `add_loop`/`close_loop_by_id` and obtains no confirmation token for them, so it cannot be relied on to perform Phase 4. **R102 is a BLOCK rule; its confirmation-token requirement is UNCONDITIONAL for these mutations (round-3 Codex B3)** — an explicit precondition, satisfied by the spawned worktree agent's commit lane, not "if it applies". Runs from the son-of-anton workspace root **after the matron-web PR merges** (per `procedure_pr_close_keyword_does_not_sync_loop_store`, `procedure_cross_repo_slim_chain_workdir_flag`, `procedure_canonical_store_mutation_from_worktree`). Verify via `load_active_loops()` from the son-of-anton root that the 7 loops are closed + the 2 follow-ups active.

### T-4.0: R102 confirmation-token + audit gate (pre-mutation, mandatory)
- [ ] Before any `add_loop`/`close_loop_by_id` runs, the coordinator **prints the exact mutation commands + their impact** (2 adds, 7 closes, target `memory/open-loops.json`), **obtains the R102 confirmation token** per son-of-anton's active policy (`RULES.md` R102 + the single-token gate in `procedure_unify_destructive_path_through_single_token_gate`), and **waits for the exact token** before proceeding. On token mismatch/absence, halt — do NOT mutate.
- [ ] Record the ops audit for the mutation (the `chore(loops)` commit is the durable record; append any policy-required audit row). This plan doc does not re-encode son-of-anton's token ceremony verbatim — it **defers to whatever R102 flow is in force at execution time**; the point is that the gate is satisfied *before* mutation, not that a spawn lane implicitly authorizes it (final-review R102 finding).

### T-4.1: File the matron-journal follow-up loop (BEFORE closing #484) — idempotent
- [ ] From the son-of-anton workspace root, **match-by-exact-title first** (`load_active_loops()` → check for `matron-journal-server-side-localid-dedup`); create only if absent (round-1 Codex M3 — retry-idempotent, no duplicate active loops). If present, treat as success.
- [ ] `add_loop` fields: `title: matron-journal-server-side-localid-dedup`, `owner: operator`, `priority: 4`, `status: active`, **`opened: 2026-07-23T00:00:00Z`** (schema-required — round-1 Claude Minor-3; `add_loop()` only auto-fills `id`), `next_action: { action_id: "impl-localid-dedup", type: "implementation", priority: 4 }`. Body per spec (localId dedup in matron-journal; stretch: content-level dedup for the FIX 2 reset-failure fresh-`localId` resend).
- [ ] File a second follow-up (**mandatory** — resolves round-2 Codex B3; same match-by-title-first discipline + `opened`) for #485's full session-lifecycle fix: title `matron-web-sendmessage-connection-ready-guard`, `owner: operator`, `priority: 5`, `next_action: { action_id: "analyze-connection-ready-guard", type: "analysis" }` — the proportionate capture-guard shipped here leaves the benign startSession residual; a proper fix needs a client.ts connection-ready state-machine signal.
- **Acceptance:** **both** loops present in `load_active_loops()` before T-4.2 runs (P19 ordering: #484 closure is gated on the matron-journal loop existing); re-running Phase 4 creates no duplicates. (Both loops are mandatory — the acceptance and the task list now agree.)

### T-4.2: Close the resolved + accepted loops
- [ ] After the matron-web PR merges and T-4.1 loops are verified present: `close_loop_by_id` (match-by-title first per `procedure_close_loop_by_id_match_title_first`) for:
  - #494, #486 (fixed + shipped), #485 (proportionate fix shipped; residual tracked by T-4.1 loop).
  - #481 (accepted-risk), #483 (upstream-PR candidate), #491 (accepted — lazy-load disproportionate).
  - #484 (client half gated-on-upstream; matron-journal loop filed).
- [ ] Commit as a single `chore(loops): ...` on son-of-anton main (closures + T-4.1 add together; #484 close contingent on the add succeeding).
- **Acceptance:** `load_active_loops()` no longer lists #481/#483/#484/#485/#486/#491/#494; the matron-journal loop is active.

---

## Self-review checklist
- [ ] No placeholders / TODOs in task bodies; every code task names concrete file + symbol + line-ballpark.
- [ ] Spec-coverage map has no uncovered spec section.
- [ ] No new source files, no new deps (constraint).
- [ ] Headers use `## Phase N —` / `### T-N.X:` canonical form.
- [ ] Residuals from spec are accepted-and-documented (no hidden fix work smuggled in).
- [ ] **Code-surface grounding (round-2 Codex M2 — a Codex file-budget artifact, not a plan gap):** the Claude reviewer verified every referenced surface against live HEAD across plan-review rounds 1-2 — `theme-test.ts`/`shell.pcss`/`theme.ts`/`index.html` (T-1.1 shapes), `client.ts` sendMessage + handleReady `ownsReplay` + `sendPendingMessage` optional-connection param (T-2.1), `client-test.ts` `internals()`+`FakeDatabase`+`it.each(["logout","startSession"])`@1689 (T-2.2), `composer-drafts.ts` exports + `components.tsx` render timing (T-3.x), and the loop-store schema/enums (Phase 4). Confirmed grounded; no drift.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
