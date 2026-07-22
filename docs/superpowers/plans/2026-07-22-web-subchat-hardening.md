# Plan — Subchat client-side hardening (#466)

**Spec:** `docs/superpowers/specs/2026-07-22-web-subchat-hardening-design.md`
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client)
**Branch:** `feat/subchat-hardening` (worktree `/opt/matron/web-journal-wt-subchat-hardening`)
**Risk:** low (three additive client-side guards; no auth/RLS/payments/data-loss/deployment surface change)

## Summary

Three residual findings deferred from the #453 (subagent sub-chats, PR #5) ship review, each an additive guard on an existing path. All changes are inline within `src/journal/{database.ts,client.ts}` — **no file splits, no restructuring** (upstream-alignment constraint, `project_matron_web_stays_dan_upstream_aligned`). Each residual is an independent phase so the phase-boundary Codex review isolates per-fix.

**Architecture / invariants preserved:**
- R1 guards only the `session_state` merge in `backfillParentLinks`; the parent-link merge (the method's primary job) is untouched — `parent_convo_id` is immutable-once-set and freshness-neutral.
- R2 reorders two statements in `handleReady` (notice before purge); the failure-path final state is unchanged.
- R3 adds a proactive abort of in-flight uploads when a convo is observed to become a child, plus a terminal-state correction so aborted/child uploads land in the read-only `send_failed` state, not `upload_failed`.

**Test infra (existing, reuse):** jest + jsdom + `fake-indexeddb/auto`; private-member access via an `internals(client)` cast (see `test/unit-tests/journal/subchat-backfill-test.ts`, `readonly-egress-test.ts`, `upload-timeout-test.ts`). Run a single file: `node_modules/.bin/jest test/unit-tests/journal/<file>`.

## Task dependency graph

- **Phase 1 (R1)**, **Phase 2 (R2)**, **Phase 3 (R3)** are mutually independent — they touch disjoint methods (`backfillParentLinks` / `handleReady` / `uploadPendingAttachment`+`handleJournal`) and could be built in any order or parallelized. Sequenced 1→2→3 here only for review cadence.
- **Phase 4 (verify + deploy + follow-ups)** depends on 1, 2, 3 all complete.

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
| D4 upstream-PR candidacy | T-4.3 (note only) |

---

## Phase 1 — R1: cross-tab session_state freshness guard

### T-1.1: freshness-guard the session_state merge in `backfillParentLinks`

**Files:**
- Modify: `src/journal/database.ts` — `backfillParentLinks`, the `existing.session_state = summary.session_state` line (currently ~128).
- Test: `test/unit-tests/journal/subchat-backfill-test.ts` (extend).

**Interfaces:**
- Consumes: `SnapshotResponse` summaries (`Omit<Conversation,"read_up_to_seq">`, so `summary.last_seq` always present — `types.ts:51-53`), the existing `Conversation.last_seq`.
- Produces: session_state is overwritten from the snapshot **only when `summary.last_seq >= existing.last_seq`**; a stale snapshot (`summary.last_seq < existing.last_seq`) leaves the locally-newer `session_state` intact. Parent-link merge unchanged.

**Acceptance:**
- Stale snapshot (`existing.last_seq=10, session_state="done"`; `summary.last_seq=5, session_state="running"`) → after backfill, `existing.session_state === "done"` (preserved).
- Fresh snapshot (`existing.last_seq=5, session_state="running"`; `summary.last_seq=10, session_state="done"`) → after backfill, `existing.session_state === "done"` (updated).
- Equal seq (`summary.last_seq === existing.last_seq`) → snapshot wins (updated) — snapshot is at least as fresh.
- Parent-link backfill still runs for records regardless of the session_state guard (existing behavior preserved; verify an existing record with null parent still receives the coerced parent link).
- Full `subchat-backfill-test.ts` suite stays green (no regression to the run-once / malformed / atomicity assertions).

- [ ] **Step 1: Write the failing tests**

Extend `subchat-backfill-test.ts`. Reuse the `seedExistingClient` / `conversation()` fixtures. Add cases:
```ts
// stale snapshot does NOT clobber a newer local terminal state:
//   seed existing child { last_seq: 10, session_state: "done" }; snapshot summary same id
//   { last_seq: 5, session_state: "running" } → after backfill existing.session_state === "done".
// fresh snapshot DOES update:
//   seed { last_seq: 5, session_state: "running" }; summary { last_seq: 10, session_state: "done" }
//   → existing.session_state === "done".
// equal seq → snapshot wins (updated).
// parent-link merge still applies under a stale session_state summary
//   (existing.parent_convo_id null → coerced link from summary, even when session_state is preserved).
```
Read the row back via a fresh `JournalDatabase` `conversations()` call (as the existing tests do) to assert the persisted state.

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-backfill-test.ts`
Expected: the stale-no-clobber case FAILS (current code overwrites unconditionally); others may pass.

- [ ] **Step 3: Implement**

In `database.ts` `backfillParentLinks`, replace the unconditional assignment:
```ts
// before:
if (typeof summary.session_state === "string") existing.session_state = summary.session_state;
// after — preserve a locally-newer session_state (cross-tab shared-IndexedDB stale-snapshot guard):
if (typeof summary.session_state === "string" && summary.last_seq >= existing.last_seq) {
    existing.session_state = summary.session_state;
}
```
Leave the `parent_convo_id` coalesce and the self-parent reject exactly as-is.

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

- [ ] **Step 1: Write the failing / guarding tests**

Ordering is not directly assertable in jsdom, so assert both effects plus the failure-path message. In `readonly-egress-test.ts` (or a new `handleready-blocked-purge-test.ts` if the reconnect harness isn't reusable):
```ts
// seed outbox with a blocked child-convo TEXT pending message + a top-level kept message;
// drive handleReady (via the same reconnect/ready harness the existing tests use);
// assert: controlError === "Couldn't send to a read-only subagent transcript."
//         AND db.outbox() no longer contains the blocked localId.
// failure case: stub deleteOutboxRows to reject → controlError ===
//         "Couldn't update blocked messages — device storage is unavailable."
```
If no existing test exercises `handleReady`, model the harness on `subchat-backfill-test.ts`'s `internals(client)` + seeded-DB pattern and invoke the private `handleReady` through the internals cast.

- [ ] **Step 2: Run to verify**

Run: `node_modules/.bin/jest test/unit-tests/journal/readonly-egress-test.ts` (or the new file).
Expected: the new success-case assertion passes today (both effects already occur) — this task is a **guard against re-ordering regression** plus the crash-window close. The failure-case must also pass. If modeling a brand-new harness, expect an initial red until the harness wiring is correct, then green.

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
- Modify: `src/journal/client.ts` — add a `localId → convoId` association written where `inFlightUploads.set(...)` happens (`uploadPendingAttachment` ~629) and cleared alongside the `inFlightUploads.delete(...)` in the `finally` (~668) and every existing `inFlightUploads.clear()` site (`logout` ~298, `startSession` ~924, and the reconnect-purge clear ~297 if distinct); add a private `abortUploadsForChildConvos()`; call it from `handleJournal` after `refreshConversations()` (~1232).
- Test: `test/unit-tests/journal/upload-timeout-test.ts` (extend) or a new `upload-child-abort-test.ts`.

**Interfaces:**
- Consumes: `inFlightUploads: Map<localId, AbortController>`, a new `uploadConvos: Map<localId, convoId>`, `isChildConvo`.
- Produces: when a `convo_meta` journal event establishes a parent link (null→set via `applyJournal`) turning a convo into a child, any in-flight upload for that convo has its `AbortController.abort()` called immediately after conversations refresh — the pending `uploadMedia` fetch rejects and unwinds through the existing catch.

**Design notes (D3):** use an **additive** `uploadConvos` map rather than changing `inFlightUploads`' value type, to keep the diff minimal-divergence from Dan's upstream. Keep the two maps' lifecycles in lockstep: set together, delete together, clear together.

**Acceptance:**
- Upload in-flight on a convo currently top-level; a `convo_meta` event sets its `parent_convo_id` → the upload's `AbortController.signal.aborted === true` after the event is handled.
- `uploadConvos` and `inFlightUploads` stay in lockstep: every set/delete/clear of one mirrors the other (no orphaned entries after `finally`, `logout`, `startSession`).
- A convo that stays top-level → no abort (regression guard).
- Existing `upload-timeout-test.ts` (timeout-driven abort) stays green — the new abort path must not interfere with the timeout controller bookkeeping.

- [ ] **Step 1: Write the failing tests**

In a new `upload-child-abort-test.ts` (upload-timeout harness is the closest model):
```ts
// start an upload on a top-level convo; capture the AbortController (via a stubbed api.uploadMedia
//   that awaits a never-resolving promise racing the signal, mirroring upload-timeout-test's pattern);
// dispatch a convo_meta journal event that sets parent_convo_id for that convo;
// assert: the controller's signal is aborted AND uploadConvos no longer holds a stale entry after unwind.
// control: a convo_meta for a DIFFERENT convo (or with null parent) → the upload's signal is NOT aborted.
```

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/upload-child-abort-test.ts` → FAIL (no abort path today).

- [ ] **Step 3: Implement**

1. Add field near `inFlightUploads`: `private readonly uploadConvos = new Map<string, string>();`
2. In `uploadPendingAttachment`, alongside `this.inFlightUploads.set(message.localId, controller)`: `this.uploadConvos.set(message.localId, message.convoId);`
3. In the `finally`, alongside the guarded `inFlightUploads.delete`: `this.uploadConvos.delete(message.localId);` (guard on the same `=== controller` check so a superseding upload isn't clobbered — mirror the existing delete condition).
4. At every `inFlightUploads.clear()` site (`logout`, `startSession`, reconnect-purge), add `this.uploadConvos.clear();`.
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

### T-3.2: land aborted / child-transition uploads in the read-only terminal state

**Files:**
- Modify: `src/journal/client.ts` — `uploadPendingAttachment` catch block (~647-665).
- Test: `test/unit-tests/journal/upload-child-abort-test.ts` (extend from T-3.1).

**Interfaces:**
- Consumes: `isChildConvo`, `markChildBlocked`, `persistAttachment`, `refreshSelectedConversation`.
- Produces: when the upload catch runs and the convo is now a child (whether aborted by T-3.1 or any error on a now-child convo), the message is set to the read-only blocked state (`markChildBlocked` → `send_failed`, "read-only subagent transcript" copy) instead of the generic `upload_failed` (which offers a retry that would re-hit the read-only guard).

**Acceptance:**
- Upload aborted via T-3.1 (convo became child) → after catch unwinds, the message's `attachState === "error"` and `errorKind === "send_failed"` (not `"upload_failed"`), `errorMessage` = the read-only copy.
- A genuine upload failure on a **top-level** convo → still `errorKind === "upload_failed"` (unchanged, retry offered).
- The child-blocked branch persists the message and refreshes the selected conversation, consistent with the other `markChildBlocked` call sites (e.g. ~634-639).

- [ ] **Step 1: Write the failing test**

Extend `upload-child-abort-test.ts`:
```ts
// after the abort in T-3.1, drive the catch to completion; read the persisted outbox row:
//   assert attachState === "error", errorKind === "send_failed", errorMessage matches the read-only copy.
// control: top-level convo upload rejects with a network error → errorKind === "upload_failed".
```

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/upload-child-abort-test.ts` → FAIL (catch currently sets `upload_failed`).

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

**Acceptance:**
- `node_modules/.bin/jest test/unit-tests/journal/` → all green (full journal suite, not just the touched files).
- Lint/format/typecheck pass per the repo's configured commands (e.g. `pnpm lint`, `pnpm exec tsc --noEmit` / `pnpm typecheck` — use whatever `package.json` defines; do NOT invent).

- [ ] Run the full journal test suite; confirm zero failures.
- [ ] Run the repo lint + typecheck scripts as defined in `package.json`.

### T-4.2: build + deploy to live :8443, operator-verify

**Files:** none (deploy).

**Deploy runbook (atomic, per `CLAUDE.local.md` journal-web runbook — NOT the Matrix-era Docker path in the `matron-web-deploy` memory):**
```
cp -a /opt/matron/web-journal/webapp /opt/matron/web-journal/webapp.bak.<ts>
# build in place from the MERGED fork-main checkout (see Phase 4 ship ordering), corepack pnpm build
corepack pnpm -C /opt/matron/web-journal build
# verify 8443 serves the new bundle
# restore-on-failure = rm -rf webapp && mv webapp.bak.<ts> webapp
```

**Acceptance:**
- Live `https://vmi3096107.taild3d6c4.ts.net:8443` serves the rebuilt bundle.
- Smoke: the three fixed behaviors don't visibly regress the client (subchat list renders, uploads to top-level convos still work, reconnect replay shows the read-only notice).
- Backup `webapp.bak.<ts>` retained until operator-confirmed; prune stale baks when confident.

- [ ] Build from merged fork-main; back up `webapp` first.
- [ ] Verify :8443 loads; smoke-test the three touched paths.

### T-4.3: close loop + follow-up notes

**Files:** son-of-anton `memory/open-loops.json` (via the loop store, from son-of-anton main — NOT from this worktree).

**Acceptance:**
- Loop #466 closed via `chore(loops)` from son-of-anton main after fork-main merge + deploy.
- Note (not a task): all three fixes are upstream-PR candidates to `Matronhq/matron-web` (D4) — Dan PR optional/deferred per the loop brief.
- Worktree `/opt/matron/web-journal-wt-subchat-hardening` removed after close.

- [ ] Close #466 from son-of-anton main via the loop store.
- [ ] Remove the worktree.

---

## Self-review / principles pass

- **No file splits / restructuring** — all edits inline in existing methods (upstream-alignment, `project_matron_web_stays_dan_upstream_aligned`). ✓
- **Minimal-diff divergence** — R3 uses an additive `uploadConvos` map rather than mutating `inFlightUploads`' value type (D3). ✓
- **No new failure surface / no security downgrade** — R1 narrows an overwrite (strictly safer); R2 is a state-neutral reorder; R3 adds an abort + corrects a terminal state (no new egress). ✓
- **Fail-loud preserved** — R1 keeps the malformed-snapshot throw + tx.abort; no silent fallback introduced. ✓
- **Map lifecycle** — R3's two maps kept in lockstep at every set/delete/clear site (explicit in T-3.1 Step 3) to avoid orphaned entries / leaks. ✓
- **No metered AI / no new deps** — none added. ✓
- **Deploy** — atomic backup-then-build-in-place with a restore path (T-4.2). ✓
- **Deliberate exception:** R2 ordering can't be asserted directly in jsdom; the test asserts both effects (notice + deletion) rather than sequence — accepted, the reorder is the fix and both-effects guards regression.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
