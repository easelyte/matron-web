# Design — Subchat client-side hardening (#466)

**Status:** design (light brainstorm)
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client)
**Loop:** son-of-anton #466
**Origin:** three residual findings from the #453 (subagent sub-chats, matron-web PR #5) ship review that were deferred, not fixed.

## Constraint

Upstream-alignment (see `project_matron_web_stays_dan_upstream_aligned`): **no file splits, no restructuring.** All changes are inline, minimal-diff, within the existing `src/journal/{database.ts,client.ts,types.ts}`. Fixes are additive guards on existing paths.

## The three residuals

### R1 — cross-tab `session_state` regression (stale-snapshot clobber)

**Where:** `src/journal/database.ts` → `backfillParentLinks`, the `existing.session_state = summary.session_state` assignment (currently unconditional).

**Race (real, via shared IndexedDB):** two tabs of the same origin+user share one IndexedDB. Tab A completes a session; a live `session_status:done` event advances the conversation row's `session_state → "done"` and `last_seq` (via `applyJournal`). Tab B, a client that has never run the one-time `subchat_backfill_v1` reconcile, starts and calls `backfillParentLinks(await api.snapshot())`. If B's snapshot was captured before the server reflected `done` (server lag / earlier fetch), its `summary.session_state === "running"` with `summary.last_seq < existing.last_seq`. The unconditional assignment regresses the shared row `done → running`, and every tab re-derives a stale "Running" spinner.

**Fix:** freshness-guard the session_state merge only:
```ts
if (typeof summary.session_state === "string" && summary.last_seq >= existing.last_seq) {
    existing.session_state = summary.session_state;
}
```
- Preserve when `existing.last_seq > summary.last_seq` (local is newer — exactly the scope contract).
- **Implementation revision (Codex plan-review R1-M1):** `SnapshotResponse` summaries are TYPED `Omit<Conversation,"read_up_to_seq">`, so `summary.last_seq` is present at the type level — but the type is not a runtime guarantee (`backfillParentLinks` validates only `conversations` array + each `id`). A malformed server response (`last_seq: null`) would coerce `null >= 0 → true` and clobber a local terminal state. The implemented guard therefore adds a runtime finite-number check (`typeof summary.last_seq === "number" && Number.isFinite(summary.last_seq)`) before the `>=` comparison; on a non-finite `last_seq` the local `session_state` is preserved. See plan T-1.1.
- Parent-link backfill (the method's primary job) is **unchanged** — only the session_state write gets the guard. `parent_convo_id` is immutable-once-set and already existing-first coalesced, so it needs no freshness gate.

### R2 — reconnect-purge crash window (purge-before-notice)

**Where:** `src/journal/client.ts` → `handleReady`, the `blockedTextIds` branch (~1160-1169).

**Window:** blocked child text rows are deleted from IndexedDB (`await db.deleteOutboxRows(blockedTextIds)`) *before* the `controlError` notice is patched. Between the durable purge completing and the in-memory patch, a tab teardown/reload leaves the messages gone from disk with no notice ever shown — silent data loss from the user's POV.

**Fix:** render the notice **before** the purge:
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
- On success: the notice is in-memory-rendered before any durable delete, closing the crash window.
- On failure: the catch overwrites with the storage-unavailable message (unchanged final state vs. today). Reordering is state-neutral on the failure path.

### R3 — in-flight upload not aborted when convo becomes a child

**Where:** `src/journal/client.ts` → `uploadPendingAttachment` (~624-675) + the journal-event handler (`handleJournal` → `refreshConversations`, ~1232).

**Race:** an upload starts on a convo the client currently sees as top-level (`parent_convo_id` null locally). `uploadPendingAttachment` rechecks `isChildConvo` at ~634 *before* `uploadMedia`, but not after the network call begins. A `convo_meta` event then establishes the parent link (`applyJournal:259` sets `parent_convo_id` null→set), turning the convo into a read-only child. The in-flight `uploadMedia` runs to completion — wasting bandwidth and emitting an attachment to a read-only subagent transcript. Guards recheck before `uploadMedia` but nothing aborts an already-pending upload.

**Fix (two parts):**
1. **Proactive abort on transition.** From the journal-event handler, after conversations refresh, abort any in-flight upload whose convo is now a child. `inFlightUploads` is keyed by `localId`; add a parallel `localId → convoId` association (additive `Map`, cheaper diff than changing the existing map's value type) so the sweep can test `isChildConvo(convoId)`. A new private `abortUploadsForChildConvos()` iterates and calls `controller.abort()`.
2. **Correct terminal state.** In the `uploadPendingAttachment` catch, before the generic `upload_failed` branch, if the convo is now a child, route through `markChildBlocked` (→ `send_failed`, "read-only subagent transcript" copy) instead of `upload_failed`. This makes both the abort-due-to-child case and any error where the convo turned out to be a child land in the correct read-only state rather than an offer-to-retry state.

## Decisions

- **D1:** R1 guards only the `session_state` write, not the parent-link merge — parent link is immutable and freshness-neutral.
- **D2:** R3 aborts proactively (driven by the journal handler) rather than only rechecking post-`uploadMedia`, because the scope contract is "abort an already-pending upload," and a completed-but-not-emitted upload still wastes the transfer.
- **D3:** R3 uses an additive `localId→convoId` map rather than mutating `inFlightUploads`' value type, to minimize fork divergence from Dan's upstream.
- **D4:** All three are upstream-PR candidates to Matronhq (deferred/optional per the loop brief), not permanent forks.

## Test surface

- R1: `backfillParentLinks` unit test — stale snapshot (`summary.last_seq < existing.last_seq`, running) does NOT overwrite an existing `done`; fresh snapshot (`>=`) does. Extend `test/unit-tests/journal/subchat-backfill-test.ts`.
- R2: `handleReady` test — assert `controlError` is set and rows deleted; the reorder is behavior-preserving on success, so a test asserting the notice + deletion both occur guards against regression. (Ordering is hard to assert in jsdom; assert both effects.)
- R3: client test — convo transitions to child while upload in-flight → controller aborted; catch lands message in `send_failed`/read-only state, not `upload_failed`.

## Non-goals

- No server-side read-only enforcement (documented #453 follow-up, out of scope).
- No file splits / restructuring.
- No UI-copy changes beyond reusing existing read-only strings.
