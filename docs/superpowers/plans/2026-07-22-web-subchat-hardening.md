# Plan — Subchat client-side hardening (#466)

**Spec:** `docs/superpowers/specs/2026-07-22-web-subchat-hardening-design.md`
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client)
**Branch:** `feat/subchat-hardening` (worktree `/opt/matron/web-journal-wt-subchat-hardening`)
**Risk:** low (three additive client-side guards; no auth/RLS/payments/data-loss/deployment surface change) <!-- heavy-signal:docs -->

## Summary

Three residual findings deferred from the #453 (subagent sub-chats, PR #5) ship review, each an additive guard on an existing path. All changes are inline within `src/journal/{database.ts,client.ts}` — **no file splits, no restructuring** (upstream-alignment constraint, `project_matron_web_stays_dan_upstream_aligned`). Each residual is an independent phase so the phase-boundary Codex review isolates per-fix.

**Architecture / invariants preserved:**
- R1 guards only the `session_state` merge in `backfillParentLinks`; the parent-link merge (the method's primary job) is untouched — `parent_convo_id` is immutable-once-set and freshness-neutral.
- R2 reorders two statements in `handleReady` (notice before purge); the failure-path final state is unchanged.
- R3 adds a proactive abort of in-flight uploads when a convo is observed to become a child, plus a terminal-state correction so aborted/child uploads land in the read-only `send_failed` state, not `upload_failed`.

**Test infra (existing, reuse):** jest + jsdom + `fake-indexeddb/auto`; private-member access via an `internals(client)` cast (see `test/unit-tests/journal/subchat-backfill-test.ts`, `readonly-egress-test.ts`, `upload-timeout-test.ts`). Run a single file: `node_modules/.bin/jest test/unit-tests/journal/<file>`.

## Task dependency graph

- **Phase 1 (R1)**, **Phase 2 (R2)**, **Phase 3 (R3)** are mutually independent — they touch disjoint methods (`backfillParentLinks` / `handleReady` / `uploadPendingAttachment`+`handleJournal`) and could be built in any order or parallelized. Sequenced 1→2→3 here only for review cadence.
- **Phase 4** depends on 1, 2, 3 all complete, and is itself strictly ordered: T-4.1 (verify) → T-4.2 (ship/merge to fork-main via ship-slim) → T-4.3 (deploy the merged SHA) → T-4.4 (close loop + remove merge-verified worktree). Deploy/close must not run before the merge.

## Spec coverage map

| Spec part | Plan task |
|---|---|
| R1 freshness-guard `session_state` (D1) | T-1.1 |
| R1 test surface (stale no-clobber / fresh clobbers) | T-1.1 Step 1 |
| R2 notice-before-purge reorder | T-2.1 |
| R2 test surface (notice + deletion both occur) | T-2.1 Step 1 |
| R3 proactive abort on child transition (D2, D3) | T-3.1 |
| R3 terminal-state correction (markChildBlocked in catch) | T-3.2 |
| R3 test surface (abort + read-only terminal state) | T-3.1 Step 1, T-3.2 Step 1 |
| Non-goals (server-side enforce, file splits) | honored — no task |
| D4 upstream-PR candidacy | T-4.4 (note only) |

---

## Phase 1 — R1: cross-tab session_state freshness guard

### T-1.1: freshness-guard the session_state merge in `backfillParentLinks`

**Files:**
- Modify: `src/journal/database.ts` — `backfillParentLinks`, the `existing.session_state = summary.session_state` line (currently ~128).
- Test: `test/unit-tests/journal/subchat-backfill-test.ts` (extend).

**Interfaces:**
- Consumes: `SnapshotResponse` summaries. NOTE (Codex R1-M1): `summary.last_seq` is a *TypeScript* annotation, not a runtime guarantee — `backfillParentLinks` currently validates only that `conversations` is an array (`database.ts:111`) and each summary's `id` (`database.ts:113-115`). A malformed server response (`last_seq: null`) would coerce `null >= 0 → true` and wrongly clobber a local terminal state. The guard MUST therefore be runtime-validated, not type-trusted. Consumes the existing `Conversation.last_seq` (always a finite number for local records — `types.ts:42`, seeded via `emptyConversation` `database.ts:44`).
- Produces: session_state is overwritten from the snapshot **only when `summary.last_seq` is a finite number AND `summary.last_seq >= existing.last_seq`**; a stale snapshot (`summary.last_seq < existing.last_seq`) OR a malformed `last_seq` (null/NaN/non-number) leaves the locally-newer `session_state` intact (safe default: never regress on unverifiable freshness). Parent-link merge unchanged.

**Acceptance:**
- Stale snapshot (`existing.last_seq=10, session_state="done"`; `summary.last_seq=5, session_state="running"`) → after backfill, `existing.session_state === "done"` (preserved).
- Fresh snapshot (`existing.last_seq=5, session_state="running"`; `summary.last_seq=10, session_state="done"`) → after backfill, `existing.session_state === "done"` (updated).
- Equal seq (`summary.last_seq === existing.last_seq`) → snapshot wins (updated) — snapshot is at least as fresh.
- **Malformed `last_seq` (`null` / non-finite) with `session_state="running"` against an existing `done` → preserved** (`done`), never clobbered by coercion (`null >= 0` must not overwrite). Add explicit `null` + `NaN`-equivalent coverage.
- Parent-link backfill still runs for records regardless of the session_state guard (existing behavior preserved; verify an existing record with null parent still receives the coerced parent link even when the session_state summary is stale/malformed).
- Full `subchat-backfill-test.ts` suite stays green (no regression to the run-once / malformed / atomicity assertions). NOTE: existing fixtures use the `conversation()` helper's default `last_seq: 5` on BOTH sides, so the `>=` guard is satisfied there and they don't regress; the new cases MUST override `last_seq` explicitly per side.

- [ ] **Step 1: Write the failing tests**

Extend `subchat-backfill-test.ts`. Reuse the `seedExistingClient` / `conversation()` fixtures; **override `last_seq` explicitly per side** (defaults are equal, which would mask the guard). Add cases:
```ts
// stale snapshot does NOT clobber a newer local terminal state:
//   seed existing child { last_seq: 10, session_state: "done" }; snapshot summary same id
//   { last_seq: 5, session_state: "running" } → after backfill existing.session_state === "done".
// fresh snapshot DOES update:
//   seed { last_seq: 5, session_state: "running" }; summary { last_seq: 10, session_state: "done" }
//   → existing.session_state === "done".
// equal seq → snapshot wins (updated).
// malformed last_seq (null) does NOT clobber via coercion:
//   seed { last_seq: 10, session_state: "done" }; summary { last_seq: null as any, session_state: "running" }
//   → existing.session_state === "done" (guard rejects non-finite; null >= 0 must not win).
// parent-link merge still applies under a stale/malformed session_state summary
//   (existing.parent_convo_id null → coerced link from summary, even when session_state is preserved).
```
Read the row back via a fresh `JournalDatabase` `conversations()` call (as the existing tests do) to assert the persisted state.

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-backfill-test.ts`
Expected: the stale-no-clobber case FAILS (current code overwrites unconditionally); others may pass.

- [ ] **Step 3: Implement**

In `database.ts` `backfillParentLinks`, replace the unconditional assignment. Guard both the string type AND runtime-finite freshness (Codex R1-M1 — `last_seq` is not runtime-validated by the method's preamble, so guard the *value*, not the TS type):
```ts
// before:
if (typeof summary.session_state === "string") existing.session_state = summary.session_state;
// after — preserve a locally-newer session_state (cross-tab shared-IndexedDB stale-snapshot guard);
// require a finite numeric summary.last_seq so a malformed null/NaN can't win via coercion:
if (
    typeof summary.session_state === "string" &&
    typeof summary.last_seq === "number" &&
    Number.isFinite(summary.last_seq) &&
    summary.last_seq >= existing.last_seq
) {
    existing.session_state = summary.session_state;
}
```
Leave the `parent_convo_id` coalesce and the self-parent reject exactly as-is.

**Implementation revision (execute-slim phase-1 Codex review):** the guard-at-use approach above was superseded during execution. Guarding only at-use skipped the session_state update on a malformed `last_seq` but STILL sealed `BACKFILL_KEY` — permanently sealing a stale state with no retry (a fail-visible violation; the "unassessable freshness" case is undecidable per-row). Final implementation instead validates `last_seq` finiteness in the **pre-transaction validation loop** (alongside the malformed-`id` check): a non-finite `last_seq` rejects the whole snapshot atomically (throw → `BACKFILL_KEY` unset → retried next startup, or corrected by the live `session_status` journal stream). The guard-at-use then simplifies to `typeof summary.session_state === "string" && summary.last_seq >= existing.last_seq` (finiteness guaranteed upstream). The malformed run defers its parent-link backfill to the retry — acceptable, since a non-finite `last_seq` is a server contract violation that shouldn't occur, and this matches the method's existing malformed-element contract.

- [ ] **Step 4: Verify pass**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-backfill-test.ts` → all green.

---

## Phase 2 — R2: reconnect-purge crash window (notice before purge)

### T-2.1: patch `controlError` before `deleteOutboxRows` in `handleReady`

**Files:**
- Modify: `src/journal/client.ts` — `handleReady`, the `blockedTextIds.length > 0` branch (~1160-1169).
- Test: `test/unit-tests/journal/readonly-egress-test.ts` (extend) — or the nearest existing `handleReady`/reconnect coverage; create a focused case if none exists.

**Interfaces:**
- Consumes: `db.deleteOutboxRows`, `this.patch`, `ownsReplay()`.
- Produces: on a reconnect replay that finds blocked child text rows, the read-only `controlError` notice is patched into in-memory state **before** the durable IndexedDB delete, closing the window where a teardown between purge and notice would drop the rows with no user-visible explanation. Failure path unchanged (catch overwrites with the storage-unavailable message).

**Acceptance:**
- After `handleReady` with blocked child text rows present: `state.controlError === "Couldn't send to a read-only subagent transcript."` AND the rows are deleted from the outbox.
- Delete-throws path: `state.controlError === "Couldn't update blocked messages — device storage is unavailable."` (unchanged).
- `ownsReplay()` false after the (now-first) patch guard → no patch, matching existing session-change semantics.
- No regression in existing readonly-egress / handleReady coverage.

- [ ] **Step 1: Write the regression-guard tests** (NOT red-green — see note)

**This is a regression guard, not a failing-test-first cycle.** The reorder is state-neutral on both success and failure paths, so the assertions below pass against the *current* (pre-fix) code too — `readonly-egress-test.ts` already has `handleReady` tests ("purges blocked texts atomically…" / "preserves every blocked text… when the atomic purge fails") that assert these exact final states and pass today. The value here is (a) locking the both-effects contract against a future re-ordering regression and (b) the code change closing the crash window (unassertable in jsdom directly). Do not spend time forcing a red state — none is coming. Confirm the existing tests still cover the final states; add a focused case only if a gap exists.

`readonly-egress-test.ts` ALREADY has a `handleReady` harness with a mockable `deleteOutboxRows` (jest fn, ~line 76) and a driveable `handleReady()` (~line 311) — reuse it; no new file needed. Assert both effects, the failure-path message, AND ordering:
```ts
// seed outbox with a blocked child-convo TEXT pending message + a top-level kept message;
// drive handleReady via the existing harness.
// (a) both-effects: controlError === "Couldn't send to a read-only subagent transcript."
//     AND deleteOutboxRows was called with the blocked localId(s).
// (b) ORDER-OBSERVING (Codex round-2 M1 — makes R2 mechanically detectable, not review-only):
//     stub deleteOutboxRows with mockImplementationOnce(async () => {
//        expect(<client>.state.controlError).toBe("Couldn't send to a read-only subagent transcript.");
//     })
//     so the assertion fires AT delete-time. With the pre-fix (delete-before-patch) order this FAILS
//     (controlError still undefined when delete runs) → genuine red→green for R2. With the fix it passes.
// (c) failure case: deleteOutboxRows.mockRejectedValueOnce(...) → controlError ===
//     "Couldn't update blocked messages — device storage is unavailable."
```
This upgrades T-2.1 from a state-only regression guard to a real red→green test: case (b) is red against the current delete-before-patch code and green after the reorder.

**Override (execute-slim phase-2 Codex review, ship_blocking — documented, deferred):** the review correctly notes the reorder *narrows* but does not *eliminate* the crash window — `patch()` is volatile while `deleteOutboxRows` is durable, so a tab killed between the delete-commit and the notice paint still loses both the (undeliverable) draft text and its explanation on reload. This exceeds the R2 scope, which is precisely a **reorder** (loop brief: "blocked child text deleted from IndexedDB before the controlError notice renders"). Full crash-durability requires either a tombstone persisted in the deletion's IndexedDB transaction + startup restore, or mark-don't-delete for blocked text (consistent with the blocked-attachment path, but needs render-path support for errored *text* pending messages — `attachState` is attachment-semantic today). Given the residual is a pre-existing deletion behavior over undeliverable draft text in a sub-second window, and the reorder covers the normal (non-crash) case, this is deferred to a follow-up loop (filed at /close), not fixed in this narrow R2 residual. Matches how #453 deferred these residuals.

- [ ] **Step 2: Run to verify fail (order-observing case)**

Run: `node_modules/.bin/jest test/unit-tests/journal/readonly-egress-test.ts`.
Expected: cases (a)/(c) pass against current code (state-neutral); case (b) — the order-observing assertion — **FAILS** against the current delete-before-patch order (`controlError` is still `undefined` when `deleteOutboxRows` runs). That red is the R2 fix's target. (Cases (a)/(c) are the regression guards; (b) is the red→green driver.)

- [ ] **Step 3: Implement**

In `handleReady`, reorder the `blockedTextIds` branch:
```ts
if (blockedTextIds.length > 0) {
    if (ownsReplay()) this.patch({ controlError: "Couldn't send to a read-only subagent transcript." });
    try {
        await db.deleteOutboxRows(blockedTextIds);
    } catch {
        if (ownsReplay()) {
            this.patch({ controlError: "Couldn't update blocked messages — device storage is unavailable." });
        }
    }
}
```

- [ ] **Step 4: Verify pass**

Run the file → green. Also run `readonly-egress-test.ts` + `client-test.ts` to confirm no reconnect-path regression.

---

## Phase 3 — R3: abort in-flight upload when convo becomes a child

### T-3.1: proactively abort in-flight uploads for convos that become children

**Files:**
- Modify: `src/journal/client.ts` — add a `localId → convoId` association written where `inFlightUploads.set(...)` happens (`uploadPendingAttachment` ~629) and cleared alongside the `inFlightUploads.delete(...)` in the `finally` (~668). There are **exactly two** `inFlightUploads.clear()` sites (Claude round-1 minor 3 — verified): `logout()` (~298) and `startSession()` (~925); mirror both with `uploadConvos.clear()`. (Line 297 is the abort-loop inside `logout`, not a separate clear site — do not hunt for a third.) Add a private `abortUploadsForChildConvos()`; call it from `handleJournal` after `refreshConversations()` (~1232).
- Test: **extend `test/unit-tests/journal/client-test.ts`** (Claude round-2 major — it already has the full harness; a new file would duplicate it, larger diff, against the minimal-diff constraint).

**Interfaces:**
- Consumes: `inFlightUploads: Map<localId, AbortController>`, a new `uploadConvos: Map<localId, convoId>`, `isChildConvo`.
- Produces: when a `convo_meta` journal event establishes a parent link (null→set via `applyJournal`) turning a convo into a child, any in-flight upload for that convo has its `AbortController.abort()` called immediately after conversations refresh — the pending `uploadMedia` fetch rejects and unwinds through the existing catch.

**Design notes (D3):** use an **additive** `uploadConvos` map rather than changing `inFlightUploads`' value type, to keep the diff minimal-divergence from Dan's upstream. Keep the two maps' lifecycles in lockstep: set together, delete together, clear together.

**Acceptance:**
- Upload in-flight on a convo currently top-level; a `convo_meta` event sets its `parent_convo_id` → the upload's `AbortController.signal.aborted === true` after the event is handled.
- `uploadConvos` and `inFlightUploads` stay in lockstep: every set/delete/clear of one mirrors the other (no orphaned entries after `finally`, `logout`, `startSession`).
- A convo that stays top-level → no abort (regression guard).
- Existing `upload-timeout-test.ts` (timeout-driven abort) stays green — the new abort path must not interfere with the timeout controller bookkeeping.

- [ ] **Step 1: Write the failing tests** — extend `client-test.ts`, reuse its existing harness (Claude round-2 major)

`client-test.ts` already provides everything but the parent-mutation sequencing — REUSE, do not rebuild:
- `FakeDatabase` interface with `applyJournal`/`conversations`/`reconcileOwnMessage` (lines ~59-73); `attachmentDatabase()` DB fake (~145) + `fileFixture()` (~174).
- `ClientInternals` exposing `handleJournal`/`uploadPendingAttachment`/`refreshSelectedConversation`/`handleReady` (~77-108).
- The controllable-pending `uploadMedia` release-promise pattern (`let releaseUpload; uploadMedia = jest.fn().mockImplementation(() => new Promise(resolve => { releaseUpload = () => resolve({media_id:"media-1"}); }))`, ~934-940) — this is exactly the "genuinely in-flight" stub the abort needs; hold at `uploadMedia`, `arrayBuffer()` resolves fast.
- Existing precedent test "does not upload bytes when the conversation becomes a child during file reading" (~957-995) — model on it, but it exercises the PRE-`uploadMedia` recheck (`client.ts:634`); the new test must let control reach `uploadMedia` (release/await past `arrayBuffer`) THEN flip the parent.

**Only genuinely new piece:** sequence the `conversations()` mock so the second `refreshConversations()` (inside `handleJournal`, after the `convo_meta` applies) returns the row WITH the child parent link — e.g. `database.conversations.mockResolvedValueOnce(topLevelRows).mockResolvedValue(childRows)`, or have the `applyJournal` stub mutate the backing array. ~10-20 lines.

Assertions:
```ts
// in-flight upload on a top-level convo (released past arrayBuffer, hung at uploadMedia);
// drive handleJournal(convo_meta setting parent for that convo) →
//   assert the captured controller.signal.aborted === true, AND after unwind through the finally,
//   uploadConvos has no stale entry for that localId.
// control: convo_meta for a DIFFERENT convo (or null/self parent) → the upload's signal NOT aborted.
```

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/client-test.ts` → FAIL (no abort path today).

- [ ] **Step 3: Implement**

1. Add field near `inFlightUploads`: `private readonly uploadConvos = new Map<string, string>();`
2. In `uploadPendingAttachment`, alongside `this.inFlightUploads.set(message.localId, controller)`: `this.uploadConvos.set(message.localId, message.convoId);`
3. In the `finally`, alongside the guarded `inFlightUploads.delete`: `this.uploadConvos.delete(message.localId);` (guard on the same `=== controller` check so a superseding upload isn't clobbered — mirror the existing delete condition).
4. At both `inFlightUploads.clear()` sites — `logout()` (~298) and `startSession()` (~925) — add `this.uploadConvos.clear();` immediately after. (Two sites only; no third.)
5. Add:
```ts
private abortUploadsForChildConvos(): void {
    for (const [localId, convoId] of this.uploadConvos) {
        if (this.isChildConvo(convoId)) this.inFlightUploads.get(localId)?.abort();
    }
}
```
6. In `handleJournal`, immediately after `await this.refreshConversations();`, call `this.abortUploadsForChildConvos();`.

- [ ] **Step 4: Verify pass**

Run the new file + `upload-timeout-test.ts` → green.

### T-3.2: land aborted / child-transition uploads in the read-only blocked state (correct error copy)

**Files:**
- Modify: `src/journal/client.ts` — `uploadPendingAttachment` catch block (~647-665).
- Test: `test/unit-tests/journal/client-test.ts` (extend the T-3.1 cases).

**Interfaces:**
- Consumes: `isChildConvo`, `markChildBlocked`, `persistAttachment`, `refreshSelectedConversation`.
- Produces: when the upload catch runs and the convo is now a child (whether aborted by T-3.1 or any error on a now-child convo), the message is set to the read-only blocked state via `markChildBlocked` → `errorKind = "send_failed"`, `errorMessage = "Can't send to a read-only subagent transcript."` — **the same terminal state every other child-blocked attachment already uses** (`~634-639`, `~584-589`, `handleReady ~1171-1172`), instead of the generic `upload_failed` whose "upload failed" copy misleadingly implies a transient network fault the user could productively retry against.

**Correction (Codex round-1 B2 — do NOT overclaim "non-retryable"):** `send_failed` messages ARE still projected `canRetry: true` by `refreshSelectedConversation` (`client.ts:1353`), so a Retry affordance still renders. That is the **existing, intended** behavior for all child-blocked attachments — retrying a child attachment is a harmless no-op re-block (`retryAttachment` `~584-589` re-marks it blocked without re-uploading; and even the `upload_failed` retry path re-enters the `isChildConvo` guard at `~634` and lands blocked anyway). The value of T-3.2 is **correct read-only messaging + consistency with the existing child-blocked state**, NOT suppressing the retry button.
- **Deliberate exception (right-size + upstream-alignment):** we do NOT change the shared `canRetry` projection at `client.ts:1351-1356` to suppress retry for child convos. That would touch a cross-cutting projection affecting every child-blocked attachment (broader blast radius than this loop's scope) and diverge from Dan's upstream for a cosmetic gain (the retry is already a harmless no-op). Dropped capability: the Retry button still shows on a blocked child upload — accepted.

**Acceptance:**
- Upload aborted via T-3.1 (convo became child) → after catch unwinds, the persisted row has `attachState === "error"`, `errorKind === "send_failed"` (NOT `"upload_failed"`), `errorMessage` = the read-only copy.
- A genuine upload failure on a **top-level** convo → still `errorKind === "upload_failed"` (unchanged, productive retry offered).
- The child-blocked branch persists the message and refreshes the selected conversation, consistent with the other `markChildBlocked` call sites (e.g. `~634-639`).
- Do NOT assert `canRetry === false` for the child case — it is `true` by existing projection; assert `errorKind`/`errorMessage` instead (the load-bearing behavior).

- [ ] **Step 1: Write the failing test**

Extend the T-3.1 cases in `client-test.ts`:
```ts
// after the abort in T-3.1, drive the catch to completion; read the persisted outbox row:
//   assert attachState === "error", errorKind === "send_failed", errorMessage matches the read-only copy.
// control: top-level convo upload rejects with a network error → errorKind === "upload_failed".
```

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/client-test.ts` → FAIL (catch currently sets `upload_failed`).

- [ ] **Step 3: Implement**

At the top of the `uploadPendingAttachment` catch (after the `ownsAttachment` early-return, before the `message.attachState = "error"; errorKind = ... upload_failed` block):
```ts
if (this.isChildConvo(message.convoId)) {
    this.markChildBlocked(message);
    if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
    if (!this.ownsAttachment(owner, message.localId)) return;
    await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
    return;
}
```
The existing `finally` still runs (clears the timer + the two maps). Leave the generic `upload_failed` path below unchanged for top-level convos.

- [ ] **Step 4: Verify pass**

Run the file → green.

---

## Phase 4 — Verify, deploy, follow-ups

### T-4.1: full suite + lint + typecheck

**Files:** none (verification only).

**Acceptance (script names grounded against `package.json` — Codex round-2 M2):**
- `pnpm test` (= `jest --runInBand`) → all green; for a focused run use `node_modules/.bin/jest test/unit-tests/journal/<file>`.
- `pnpm lint` (= `pnpm lint:types && prettier --check …`, where `lint:types` = `tsc --noEmit`) → clean. Auto-fix formatting with `pnpm lint:fix` (= `prettier --write …`) if needed, then re-run `pnpm lint`.
- (Deploy `pnpm build` = `rimraf webapp && webpack --config webpack.config.mjs --mode production` — see T-4.3; not part of the verify gate.)

- [ ] Run `pnpm test`; confirm zero failures across the journal suite.
- [ ] Run `pnpm lint` (types + prettier); clean.

### T-4.2: ship — final review + PR + merge to fork-main (explicit ship ordering)

> **Ship ordering (both reviewers round-1 blocker: Codex B1 + Claude M1).** Phases 1-3 land only on `feat/subchat-hardening` in the worktree. Nothing is deployable until this branch is **merged to fork-main (`easelyte/matron-web` `origin/main`)**. `/execute-slim` auto-invokes `/ship-slim` at end-of-plan; `/ship-slim` does the final adversarial (Codex-on-diff) review, opens the PR, and auto-merges when clean. T-4.3 (deploy) and T-4.4 (close) run **only after** this merge and must build the merged SHA — never the worktree branch, never the pre-fix `main`.

**Files:** none (PR/merge via ship-slim; no source edits).

**Acceptance:**
- `/ship-slim` completes: PR against `easelyte/matron-web` base `main` opened and **merged** (rebased onto current `origin/main` first per the loop brief).
- Capture the merged commit SHA on `origin/main`. `git -C /opt/matron/web-journal fetch origin && git log origin/main --oneline | head` shows the merge.
- **Record the merged SHA** for the T-4.3 exact-match gate: `MERGED_SHA=$(git -C /opt/matron/web-journal rev-parse origin/main)` after the fetch. Note it in the loop/session state so T-4.3 can assert against it.
- **Verify the merged SHA actually contains all three diffs** before any deploy: `git -C /opt/matron/web-journal show "$MERGED_SHA" --stat` (or `git log origin/main -- src/journal/database.ts src/journal/client.ts`) confirms edits to `database.ts` (R1) + `client.ts` (R2, R3). A merge that doesn't touch both files is a red flag — halt, do not deploy.

- [ ] Rebase `feat/subchat-hardening` onto current `origin/main`; ship via `/ship-slim`; confirm PR merged.
- [ ] Fetch `origin/main`; record `MERGED_SHA`; verify it touches `database.ts` + `client.ts`.

### T-4.3: deploy the merged fork-main to live :8443, operator-verify

**Files:** none (deploy).

**Deploy runbook (atomic, per `CLAUDE.local.md` journal-web runbook — NOT the Matrix-era Docker path in the `matron-web-deploy` memory). Fail-closed (`set -euo pipefail`), absolute paths, executable timestamp, and an EXACT `HEAD == MERGED_SHA` gate — a path-history `git log` alone does NOT prove HEAD advanced (Codex round-2 B1/B2):**
```bash
set -euo pipefail
WEB=/opt/matron/web-journal
TS="$(date -u +%Y%m%dT%H%M%SZ)"
MERGED_SHA="<the SHA recorded in T-4.2>"   # exact commit that ship-slim merged to origin/main
# 1. PULL THE MERGED FIX INTO THE LIVE CHECKOUT FIRST (Claude M1 / Codex B1 — the live checkout
#    sits on pre-fix main until this runs; skipping it silently deploys stale code). Fail-closed:
git -C "$WEB" fetch origin
git -C "$WEB" checkout main
git -C "$WEB" pull --ff-only origin main
# 2. EXACT gate: HEAD must equal the merged SHA (not merely "some history touches these files"):
test "$(git -C "$WEB" rev-parse HEAD)" = "$MERGED_SHA" \
  || { echo "live checkout HEAD != merged SHA — refuse to build stale"; exit 1; }
# 3. Atomic backup of the current live bundle (validated), then build in place:
test -d "$WEB/webapp" && cp -a "$WEB/webapp" "$WEB/webapp.bak.$TS"
test -d "$WEB/webapp.bak.$TS" || { echo "backup missing — abort before build"; exit 1; }
corepack pnpm -C "$WEB" build   # = rimraf webapp && webpack --mode production
# 4. Verify :8443 serves the new bundle (curl + operator smoke).
# RESTORE-ON-FAILURE (only if build/verify fails): validate the backup exists, then swap by RENAME
#   (mv the stale build aside, not rm -rf the live dir blind):
#   test -d "$WEB/webapp.bak.$TS" && mv "$WEB/webapp" "$WEB/webapp.failed.$TS" && mv "$WEB/webapp.bak.$TS" "$WEB/webapp"
```

> **R102 disposition (Codex re-flagged rounds 1 + 2 — recorded override, not a silent skip).** R102 (no destructive command without a confirmation token) is a son-of-anton `RULES.md` BLOCK rule governing the **autonomous Codex agent runtime**; `RULES.md` does not exist in `matron-web`, and these Phase 4 steps are **operator-in-the-loop coordinator actions** run in this Matron bridge session (the operator sees each step), NOT autonomous-cron commands. The matron-web-appropriate safety equivalent is applied instead of the token ceremony: fail-closed chaining, an exact SHA gate before the only bundle-destroying step (`rimraf webapp`), a validated backup before that step, a reversible rename (not `rm -rf`) on rollback, and (T-4.4) a merge-gated non-`--force` `git worktree remove`. Adding the autonomous-runtime token flow to an operator-run fork deploy would be ceremony without a matching threat model. Per `procedure_codex_review_re_flags_operator_accepted_limitations`: override with documented rationale, do not loop further.

**Acceptance:**
- The live checkout's HEAD **exactly equals** `MERGED_SHA` (step-2 gate passes) **before** the build runs.
- Live `https://vmi3096107.taild3d6c4.ts.net:8443` serves the rebuilt bundle.
- Smoke: the three touched paths don't visibly regress (subchat list renders, uploads to top-level convos still work, reconnect replay shows the read-only notice). NOTE: the three races are timing-dependent and won't be *proven* by manual smoke — smoke only confirms no gross regression; the unit tests (Phases 1-3) are the correctness evidence.
- Restore path validates the backup exists and uses rename (not blind `rm -rf`); backup `webapp.bak.<ts>` retained until operator-confirmed, then pruned.

- [ ] Pull merged main into the live checkout; confirm fix commits present.
- [ ] Backup (validated) → build → verify :8443 → smoke-test.

### T-4.4: close loop + follow-up notes

**Files:** son-of-anton `memory/open-loops.json` (via the loop store, from son-of-anton main — NOT from this worktree).

**Acceptance:**
- Loop #466 closed via `chore(loops)` from son-of-anton main **only after** the fork-main merge (T-4.2) + deploy (T-4.3) are confirmed.
- Note (not a task): all three fixes are upstream-PR candidates to `Matronhq/matron-web` (D4) — Dan PR optional/deferred per the loop brief.
- Worktree removed **only after** confirming the branch is merged (Codex B3 — don't destroy the only copy of unmerged work): `git -C /opt/matron/web-journal branch --merged origin/main | grep feat/subchat-hardening` must succeed, then `git -C /opt/matron/web-journal worktree remove /opt/matron/web-journal-wt-subchat-hardening` (plain `worktree remove`, which refuses on a dirty/unmerged tree — do NOT `--force` unless merge-verified, and never `rm -rf` the worktree).

- [ ] Close #466 from son-of-anton main via the loop store (post-merge, post-deploy).
- [ ] Confirm branch merged into `origin/main`, then `git worktree remove` the worktree.

---

## Self-review / principles pass

- **No file splits / restructuring** — all edits inline in existing methods (upstream-alignment, `project_matron_web_stays_dan_upstream_aligned`). ✓
- **Minimal-diff divergence** — R3 uses an additive `uploadConvos` map rather than mutating `inFlightUploads`' value type (D3). ✓
- **No new failure surface / no security downgrade** — R1 narrows an overwrite (strictly safer); R2 is a state-neutral reorder; R3 adds an abort + corrects a terminal state (no new egress). ✓
- **Fail-loud preserved** — R1 keeps the malformed-snapshot throw + tx.abort; no silent fallback introduced. ✓
- **Map lifecycle** — R3's two maps kept in lockstep at every set/delete/clear site (explicit in T-3.1 Step 3) to avoid orphaned entries / leaks. ✓
- **No metered AI / no new deps** — none added. ✓
- **Ship ordering explicit** (Codex B1 / Claude M1) — T-4.2 ships/merges to fork-main via ship-slim; T-4.3 pulls the merged SHA into the live checkout before building + verifies the SHA touches both files; deploy/close never run against the worktree branch or pre-fix main. ✓
- **Destructive steps target-validated** (Codex B3) — deploy restore validates the backup exists and uses rename not blind `rm -rf`; worktree teardown is merge-gated `git worktree remove` (refuses dirty), never `rm -rf`. (R102's confirmation-token ceremony is a son-of-anton BLOCK rule that does not exist in matron-web; adopted the substantive hardening, not the token flow.) ✓
- **last_seq guarded at runtime** (Codex R1-M1) — R1 uses `typeof/Number.isFinite` before the `>=` comparison so a malformed `null`/`NaN` can't clobber via coercion; guarded at-use (not in the pre-tx validation loop) so a bad `last_seq` still doesn't drop a valid parent link. ✓
- **Deliberate exceptions:**
  - R2 ordering can't be asserted directly in jsdom; the test asserts both effects (notice + deletion) rather than sequence — accepted, the reorder is the fix and both-effects guards regression. T-2.1 is a regression guard, not red-green (state-neutral reorder).
  - R3/T-3.2 does NOT suppress the Retry button on blocked child uploads (would touch the cross-cutting `canRetry` projection at `client.ts:1351-1356`, broad blast radius + upstream divergence for a cosmetic gain — the retry is a harmless no-op re-block). The fix corrects the error *copy* (send_failed/read-only vs misleading upload_failed) and matches existing child-blocked semantics. Dropped capability: Retry still renders on a blocked child upload — accepted.
  - T-3.1/T-3.2 tests EXTEND `client-test.ts` (which already has the FakeDatabase + `attachmentDatabase()`/`fileFixture()` + `releaseUpload` pending-promise harness + a near-identical becomes-a-child test) — reuse, not a new file; only the `conversations()` mock parent-mutation sequencing is new (~10-20 lines). Keeps the diff minimal (upstream-alignment). (Corrected via Claude round-2 — round-1's "new harness" scoping had surveyed only readonly-egress/upload-timeout, missing client-test.ts.)
  - T-2.1 includes an order-observing case (stub `deleteOutboxRows` to assert `controlError` is already set at delete-time) — genuinely red against the pre-fix delete-before-patch order, so R2 is mechanically tested, not review-only (Codex round-2 M1).
  - Deploy runbook is fail-closed (`set -euo pipefail`), uses an executable timestamp, and gates on an exact `HEAD == MERGED_SHA` match before the bundle-destroying build (Codex round-2 B1/B2). package.json script names (`pnpm test`/`pnpm lint`/`pnpm build`) grounded, not guessed (Codex round-2 M2).

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end. <!-- heavy-signal:docs -->
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan. <!-- heavy-signal:docs -->
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

## Appendix: Verified Claims (research pass 2026-07-22)

> Automated research tooling (Tavily) was unavailable this pass (no API key). The two load-bearing browser-platform claims below are established, MDN-documented web semantics recorded from platform knowledge; adversarial reviewers should still challenge them.

✓ Claim (R1 premise): IndexedDB databases are per-origin and shared across same-origin browser tabs — a write committed in one tab is visible to another tab's later read of the same DB. Established (MDN IndexedDB API / same-origin storage model). This is what makes the cross-tab `session_state` clobber real: two tabs mutate one shared `conversations` store.

✓ Claim (R3 premise): passing an `AbortSignal` to `fetch()` and calling `AbortController.abort()` mid-request rejects the fetch promise with an `AbortError`. Established (WHATWG Fetch / MDN AbortController). Verified in-repo: `api.uploadMedia(bytes, type, signal)` → `request({signal})` → `fetch(url, { signal })` (`src/journal/api.ts:130,136,240`), so `controller.abort()` unwinds an in-flight upload into the `uploadPendingAttachment` catch.
