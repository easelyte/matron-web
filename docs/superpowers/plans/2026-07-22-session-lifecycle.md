---
title: "Plan — Web session lifecycle: RPC start affordance (#469) + session-controls resilience (#462)"
spec: docs/superpowers/specs/2026-07-22-session-lifecycle-design.md
date: 2026-07-22
revision: 5
repo: easelyte/matron-web
plan_review: "converged at round 4 (3 rounds both reviewers + 1 Codex-only confirm). r4 fixes: connection-availability guard (B1), full error-frame parse (B3), all-invalid-roster throws (M1), folder request-epoch (M2), not_ready server-invariant citation (B2 override). Residual P32 (bridge idempotency key) + composer-commingling promoted to follow-up loops."
repo_note: converged
worktree: /opt/matron/web-journal-wt-session-lifecycle
branch: feat/session-lifecycle
loops: [469, 462]
risk: normal
tier: typical
execution: /execute-slim
phases: 3
tasks: 14
base: "rebased onto origin/main @ 4093ae6 (post loop #466 subchat-hardening); branch HEAD b0984d8 (spec+plan). All anchors below re-grep-confirmed post-rebase."
commands:
  test: "corepack pnpm test"          # jest --runInBand
  lint: "corepack pnpm lint"          # tsc --noEmit + prettier --check
  lint_fix: "corepack pnpm lint:fix"  # prettier --write
  build: "corepack pnpm build"        # rimraf webapp && webpack --mode production
---

# Plan — Web session lifecycle (#469 + #462)

Implements `docs/superpowers/specs/2026-07-22-session-lifecycle-design.md` (rev 4, converged spec-review r3).

**One branch (`feat/session-lifecycle`), because both features live in the same two do-not-split monoliths** (`src/journal/client.ts` ~1570 LOC, `src/journal/components.tsx` ~2460 LOC — keep Dan's layout, no splits per `project_matron_web_stays_dan_upstream_aligned`). Additions are in-place.

## ⚠ Baseline & pre-execution anchor guard (plan-review r1 M1)

This branch was **rebased onto `origin/main` @ `4093ae6`** (loop #466 "subchat client-side hardening" landed on fork-main mid-review and edited `client.ts` — +41/-2, incl. an `abortUploadsForChildConvos()` call right after the `replaceSnapshot` `patch()` this plan extends). All `client.ts`/`components.tsx` line anchors below are **re-grep-confirmed at post-rebase HEAD `b0984d8`**.

**Standing guard for `/execute-slim`:** `client.ts`/`components.tsx` are shared edit targets across concurrent loops. Before starting T-1.1 (and again at each phase boundary), do a **read-only divergence check first** — `git -C /opt/matron/web-journal fetch -q && git -C <worktree> rev-list --left-right --count origin/main...HEAD`. If HEAD is behind AND the worktree is clean (`git status --porcelain` empty), rebase (`git rebase origin/main`); **if a rebase would conflict, or the worktree has uncommitted implementation changes, HALT and surface to the operator — do NOT auto-rebase over dirty/conflicting state** (avoids a partially-rewritten branch mid-execution). After any rebase, re-grep the anchors in the task about to execute — the grepped symbol wins over the cited line number (`procedure_reverify_hardcoded_baselines_after_coordination_rebase`).

## Execution order & dependency graph

- **Phase 1 (#462)** self-contained (only `client.ts` + one banner in `components.tsx` + tests) and safety-focused → lands first.
- **Phase 2 (#469 transport)** adds type + WS-RPC foundation (`types.ts`, `connection.ts`, `api.ts`) → blocks Phase 3.
- **Phase 3 (#469 UI)** adds client orchestration + `NewSessionSheet` + wiring → depends on Phase 2.

```
T-1.1 → T-1.2 → {T-1.3, T-1.4} → T-1.5            (Phase 1, #462)
T-2.1 → {T-2.2, T-2.3} → T-2.4                     (Phase 2, #469 transport)
T-2.* → T-3.1 → T-3.2 → T-3.3 → T-3.4 → T-3.5      (Phase 3, #469 UI + final verify)
```
Phase 1 and Phase 2 both edit `client.ts`; execute sequentially. No two tasks edit the same function region concurrently.

**Testing convention** (grep-confirmed): `test/unit-tests/journal/<topic>-test.ts`, React-DOM style (`createRoot`/`act`, import `MatronJournalClient` from `../../../src/journal/client` + `MatronApp` from `../../../src/journal/components`, `jest.mock` the logo svg). `useFakeTimers` is already used in `client-test.ts`/`components-test.ts` (precedent for the retry/watchdog timer tests). Run `corepack pnpm test` + `corepack pnpm lint` after each task.

---

## Phase 1 — Session-controls storage resilience + observability (#462)

### T-1.1: Per-store health provenance state + constants + session reset

**Files:** `src/journal/client.ts`, `src/journal/types.ts`

- Replace the lone `private unreadHydrated = false` (`client.ts:236`) with two per-store records:
  ```ts
  private storeHydrated = { archive: true, pinned: true, favorite: true, unread: true };
  private storeWritable = { archive: true, pinned: true, favorite: true, unread: true };
  ```
- Add `private allStorageHealthy(): boolean` = every `storeHydrated` value AND every `storeWritable` value true.
- Add `export const PREFERENCES_UNAVAILABLE_ERROR = "Couldn't load saved preferences — device storage unavailable.";` in `client.ts` (reuse the bootstrap string at `client.ts:1021-1023`). **`export`ed** so T-1.4 can import it in `components.tsx` (which already imports from `./client` at `components.tsx:20` — add it to that import list; plan-review r2 Codex-B1).
- **Reset provenance per session (plan-review r1 BL-2 / P25):** in `startSession()` (`client.ts:945`, right by `this.sessionGen += 1` at `:946`), reset both records to all-`true`. The `MatronJournalClient` instance survives logout (`logout` resets `state` + bumps `sessionGen` at `:297` but not class fields; login reuses the instance), so without this a write-failure bit leaks into the next login.
- Repoint the `unreadHydrated` read site — `clearUnreadOverride` shortcut (`client.ts:1108`) — at `storeHydrated.unread`; behavior identical.
- In `types.ts`, add `preferencesUnavailable?: boolean;` to `ClientState` (near `controlError` at `types.ts:190`); `blankState()` (`client.ts:94`) leaves it falsy (default).

**Acceptance:** `tsc --noEmit` clean; `unreadHydrated` removed, its read site now `storeHydrated.unread`; provenance reset at `startSession`; `PREFERENCES_UNAVAILABLE_ERROR` defined once; no I/O-site wiring yet (T-1.2).

### T-1.2: Wire read + write provenance at every store I/O site

**Files:** `src/journal/client.ts`

Record provenance and recompute `preferencesUnavailable` at each store I/O site (spec Part 2 §3). **Recompute rule:** `preferencesUnavailable = !allStorageHealthy()`. Where a site builds a fresh state object, put the computed value **into that object** — do NOT pre-`patch()` then let a later `...blankState()` reset it (plan-review r1 BL-3 / P19).

- **Bootstrap** (`client.ts:1000-1024`): set all four `storeHydrated[store] = <read>.ok` from the four bootstrap reads (`archiveRead`/`pinnedRead`/`favoriteRead`/`unreadRead` at `:1000+`, generalizing the old `unreadHydrated = unreadRead.ok`). In the `this.state = { ...blankState(), … }` object (`client.ts:1011-1024`), **replace** the `controlError: bootstrapReadFailed ? … : undefined` field (`:1021-1023`) with `preferencesUnavailable: bootstrapReadFailed` (drop the transient `controlError` bootstrap set — the persistent banner supersedes it). This puts the flag in the constructed state, not a pre-patch (P19).
- **`setArchived`** (`client.ts:1060`): after the read (`:1063`), `storeHydrated.archive = current.ok`; after the write (`:1072` inside try, `:1074` catch = fail, `:1077` success), `storeWritable.archive = <succeeded>`; recompute `preferencesUnavailable` and include it in each `patch()` here. Leave the existing `controlError` set/clear (`:1065/:1074/:1077`) **unchanged**.
- **`setFlag`** (`client.ts:1081`): same at read (`:1090`) and write (`:1099` try / `:1101` catch / `:1104` success). Map `setFlag`'s `stateKey` param to the store name with a **real `switch` + `never`-exhaustiveness check** (plan-review r2 — a ternary with a default fallback does NOT get the compile-time guarantee) — `IdSetStore` exposes no name field, so derive from `stateKey`:
  ```ts
  let store: "pinned" | "favorite" | "unread";
  switch (stateKey) {
      case "pinnedIds": store = "pinned"; break;
      case "favoriteIds": store = "favorite"; break;
      case "unreadOverrideIds": store = "unread"; break;
      default: { const _exhaustive: never = stateKey; throw new Error(`unmapped stateKey: ${_exhaustive}`); }
  }
  ```
  A future `stateKey` variant then fails `tsc`, forcing a provenance-bucket update instead of silently mapping to `unread`.
- **`replaceSnapshot`** (`client.ts:1115`): set `storeHydrated[store] = read.ok` for **each** of the four re-reads (`:1138-1144`, both branches); adopt ids on ok; include recomputed `preferencesUnavailable` in the **FINAL post-reread `patch()` at `client.ts:1151`** (the one setting `conversations`/`archivedIds`/…/`selectedConversationId`) — **NOT** the earlier pre-reread `patch()` at `:1119-1121` that sets `connectionError: undefined` before `replaceWithSnapshot` + the store reads (plan-review r3 Codex-B2: putting it in the early patch computes from stale provenance).
- **Cross-tab `storage` listener** (`client.ts:1027-1045`): replace the per-key `store.parse(event.newValue)` recovery with `const r = store.read(currentSession); storeHydrated[store] = r.ok;` adopt `r.ids` on ok; recompute `preferencesUnavailable`. Remove the blanket `event.newValue === null` early-return on the recovery path (a key removal must still re-read). Keep the archive-selection-clear side effect.

**Acceptance:** every read/write site updates the matching provenance entry; bootstrap sets `preferencesUnavailable` INSIDE the constructed state (not erased by `blankState`); cross-tab recovery uses `store.read()` NOT `parse`; a read OR write failure flips `preferencesUnavailable` true; `tsc --noEmit` clean; existing `client-test.ts`/`archive-test.ts` green.

### T-1.3: Structured observability helper

**Files:** `src/journal/client.ts`

- Add `logStorageDiag(event: "read_fail"|"write_fail"|"degrade"|"recover", store: string, ok: boolean)` emitting a stable-prefixed structured line (`matron:store` + `{event, store, ok}`).
- Emit at each read/write failure (bootstrap / `setArchived` / `setFlag` / `replaceSnapshot` / cross-tab), the degrade transition (`preferencesUnavailable` false→true), and recovery (true→false).
- Code comment: console diagnostics (not a telemetry pipeline) is the deliberate ceiling (spec Part 2 §4; #34).

**Acceptance:** the previously-silent `replaceSnapshot` `ok:false` path now logs; degrade/recover independently greppable; no network sink; `tsc --noEmit` clean.

### T-1.4: Two-banner rendering

**Files:** `src/journal/components.tsx`

- **Import `PREFERENCES_UNAVAILABLE_ERROR` from `./client`** (add to the existing `components.tsx:20` import from `./client`; the constant is `export`ed in T-1.1).
- At the `controlError` render site (`components.tsx:642-644`), render **two independent stacked elements**: a NEW persistent banner shown whenever `state.preferencesUnavailable` (text `PREFERENCES_UNAVAILABLE_ERROR`, `mj_ConnectionError` class, `role="status"`), AND the existing `controlError` slot (unchanged). Neither conditioned on the other.

**Acceptance:** `preferencesUnavailable` + `controlError` both set → BOTH render; only one set → only that one; `tsc --noEmit` + `prettier --check` clean.

### T-1.5: Phase 1 tests

**Files:** `test/unit-tests/journal/conversation-flags-test.ts`, `client-test.ts`, `components-test.ts` (extend)

Mock `localStorage` to throw on read and/or `setItem` selectively:
- `IdSetStore.read` contract `{ids, ok}`, `ok:false` on a `getItem` throw (#26 schema/contract test).
- Persistent banner **persists** when store X failed bootstrap read and store Y's pin/favorite later succeeds.
- **Write** failure (`setItem` throws, reads OK) flips `preferencesUnavailable` and is NOT masked by a later unrelated success.
- **Cross-session reset:** write-fail → logout → login with healthy storage → `preferencesUnavailable` returns false (BL-2 regression).
- `replaceSnapshot` re-read `ok:false` flips `preferencesUnavailable`; later all-ok re-read clears it.
- Cross-tab recovery via `store.read()` only — a `storage` event whose `newValue` parses but whose `read()` still throws does NOT falsely recover.
- Components: both banners render together when degraded + transient error present.

**Acceptance:** `corepack pnpm test` green; `corepack pnpm lint` clean.

---

## Phase 2 — RPC transport foundation (#469)

### T-2.1: Type additions

**Files:** `src/journal/types.ts`

- Add `request_id?: string;` to `JournalControlFrame` (`types.ts:72-79`) — the rejection frame carries it (`ws.js:427-428`).
- Add `JournalRpcFrame` `{ kind:"rpc"; response?: { request_id: string; agent_device_id: number; ok: boolean; result?: unknown; error?: { code: string; detail?: string } } }` to the `ServerFrame` union (`types.ts:108`).
- Add `RpcReply = { ok:true; origin:"agent"; result: unknown } | { ok:false; origin:"agent"|"relay"|"timeout"|"teardown"; code: string; detail?: string }`.
- Add `DeviceDTO`, `DevicesResponse = { devices: DeviceDTO[] }`, `RecentFolder = { path: string; last_used: number | null }`.

**Acceptance:** `tsc --noEmit` clean; no runtime change.

### T-2.2: RPC transport in `connection.ts`

**Files:** `src/journal/connection.ts`

- **Harden `send()` against throw** (plan-review r2 Codex-major-1): `connection.ts:57-60`'s `send()` calls `this.socket.send(JSON.stringify(operation))` with no try/catch — in the close-between-check-and-send race, `socket.send` can THROW rather than return. Wrap the `socket.send` call in try/catch and `return false` on throw. This keeps `agentRequest`'s "send returned false → relay/not_connected" path total (an uncaught throw would otherwise reject `agentRequest` outside the `RpcReply` contract and strand the sheet's `starting` state). Benefits all `send()` callers.
- `private pendingRpc = new Map<string, { resolve: (r: RpcReply) => void; timeoutTimer: number; backoffTimer?: number; retriesLeft: number; method: string; params: unknown; agentDeviceId: number }>()`.
- `public async agentRequest(agentDeviceId, method, params, timeoutMs = 30_000, makeId = () => crypto.randomUUID()): Promise<RpcReply>` — **inject `makeId`** (default `crypto.randomUUID`) for deterministic test ids (see appendix c2 — the toolchain has `randomUUID`, so this is for test control, not a polyfill). `request_id = makeId()`. Call `this.send({ op:"agent_request", request_id, agent_device_id: agentDeviceId, method, params })`. If `send()` returns false → resolve `{ ok:false, origin:"relay", code:"not_connected" }` immediately (never enter the map). Else register + arm `timeoutTimer` (`window.setTimeout`) → resolve `{ ok:false, origin:"timeout", code:"timeout" }`, clear `backoffTimer`, delete entry.
- **`handleFrame`** (`connection.ts:127-155`), BEFORE the `onFrame` fallthrough:
  1. `frame.kind === "rpc"`: parse (P33) — require `frame.response` object, `request_id` string, `ok` boolean, **`agent_device_id` a finite number equal to the pending entry's `agentDeviceId`** (plan-review r3 Codex-M1 — a matching-request_id reply from the wrong/garbled agent must not resolve the pending start and navigate to a foreign convo; mismatch → diagnose + ignore); on `ok:false` require `error.code` string. **Malformed → `logRpcDiag("malformed_rpc", request_id?)` then `return`** (never throw — a throw is caught at `connection.ts:107` and cycles the socket; plan-review r1 Codex-M4 = fail-visible on the otherwise-silent-timeout). Resolve the matched pending as `origin:"agent"`. Unknown/duplicate id → ignore.
  2. `frame.kind === "control" && frame.op === "error" && typeof frame.request_id === "string" && this.pendingRpc.has(frame.request_id)`: resolve `{ ok:false, origin:"relay", code, detail }`. Uncorrelated control-errors fall through to the existing fallback (`client.ts:1229`) unchanged.
  - **Fully parse BOTH error forms (plan-review r4 Codex-B3 / P33):** the socket layer casts JSON to `ServerFrame` (`connection.ts:95`) with no runtime validation, so both the rpc-`ok:false` `error` object AND the control-error frame must be narrowed before building an `RpcReply`: require `code` a non-empty string and `detail` string-or-absent (a non-string `detail`, e.g. an object, is dropped, not passed through — downstream renders `detail` as text). A correlated error frame missing a string `code` → diagnose + resolve with a generic code (don't emit an `RpcReply` that violates its own `{code:string}` type).
- **`not_ready` retry (safety grounded server-side, plan-review r4 Codex-B2 override):** verbatim resend reusing the same `request_id` is safe **because the server only returns `not_ready` when `!conn.registered`, BEFORE forwarding anything to an agent** (`ws.js:437` + the invariant comment at `ws.js:429-436`: "nothing forwarded, so a verbatim re-send after replay is always safe") — so `not_ready` provably cannot coexist with an in-flight/dispatched `start`, and reusing the id creates no duplicate. This is NOT client-side idempotency; it rests on that relay invariant. (The distinct, genuinely-uncertain P32 case — a response lost AFTER real dispatch — is NOT auto-retried here; it routes to `uncertain`, and its complete fix, a bridge-side idempotency key, is the documented `accepted_residual_risks` follow-up loop, out of scope for this plan.) On a correlated relay `not_ready` with `retriesLeft > 0`, **and only if no `backoffTimer` is already scheduled for this entry** (r3 Codex-B3: guard a duplicate `not_ready` frame from scheduling a second timer that leaks the first and double-sends), decrement + schedule `backoffTimer` (1000 ms). The callback **clears the entry's `backoffTimer` field on entry**, then FIRST checks `this.pendingRpc.has(request_id)` (settled by timeout/teardown during backoff → no-op; apple guards this at `JournalSyncEngine.swift:281`). If still pending, re-send verbatim **reusing the same `request_id`**; **if that re-send's `send()` returns false, resolve immediately `{ ok:false, origin:"relay", code:"not_connected" }`, clear timers, delete** (plan-review r1: symmetric with the initial send-false path; don't fall through to the 30 s timeout). Max 2 retries; exhausted → resolve `not_ready`.
- **`stop()`** (`connection.ts:44-55`, logout `client.ts:310`-region / session-replace): clear every `timeoutTimer`/`backoffTimer`, resolve every remaining entry `{ ok:false, origin:"teardown", code:"teardown" }`, clear the map.
- Add `logRpcDiag(event, request_id?)` (stable-prefixed structured console line) reused by the malformed path.

**Acceptance:** RPC frames never reach `client.handleFrame`; malformed rpc frame → diagnostic + ignore (no socket cycle); relay control-errors correlate; `not_ready` re-sends same id ≤2×/1s, no-ops if settled during backoff, and resolves `relay/not_connected` if the retry send fails; teardown → `origin:"teardown"`; send-false → `origin:"relay"`; `tsc --noEmit` clean.

### T-2.3: `api.devices()` with transport-agnostic timeout

**Files:** `src/journal/api.ts`

- Add `public async devices(): Promise<DevicesResponse>`. Wrap the request in a **transport-agnostic timeout** (plan-review r1 BL-1/M4): `Promise.race([ devicesCall, timeoutReject ])` where `timeoutReject` is `new Promise((_, rej) => setTimeout(() => rej(new JournalApiError("timeout", 0)), 10_000))`, clearing the timer on settle. Required because `api.ts`'s `request()` only threads `options.signal` into the browser `fetch()` (`api.ts:240`); the **Electron branch** (`electron.journalRequest({…})`, `api.ts:213-223`) accepts no signal, so an AbortController alone would leave the desktop build able to hang. **Attach a no-op `.catch()` to the losing `devicesCall` branch** (plan-review r2 m2) so a late rejection after the race times out doesn't surface as an unhandled promise rejection. (Optionally ALSO pass an AbortSignal to `fetch` for true browser-side cancel — the `race` is the correctness guarantee.)
- **Parse the payload (P33/P26, plan-review r1 Codex-M5 + r2-B2 + r4-M1):** `parseDevice(raw)` — require `device_id` a finite number, `kind` a string, `connected` a boolean, `name` string-or-undefined, `last_seen_at` number-or-undefined, `is_self` boolean; **drop** individual items failing the shape (partial roster is fine). Fail-loud cases that **THROW a typed `JournalApiError`** (→ `agents-error` + Retry, NOT the empty-roster "No agents connected" false diagnosis): (a) a malformed ENVELOPE (non-object, or `devices` not an array); (b) **a nonempty raw `devices` array where ZERO items parse** (plan-review r4-M1: all-items-schema-drifted must not look like a genuinely empty roster). Only a validly-parsed, genuinely-empty `{ devices: [] }` (or a nonempty array with ≥1 valid item) returns normally. Type the parsed output as `DeviceDTO[]`.

**Acceptance:** `devices()` **rejects on timeout under both browser and Electron** (race, not signal-only; losing branch no-op-caught); malformed device ITEM dropped (partial roster); malformed ENVELOPE **throws**; a **nonempty array with zero valid items throws** (not empty); a genuinely-empty `{devices:[]}` → empty; returns typed `DevicesResponse`; `tsc --noEmit` clean.

### T-2.4: Phase 2 transport tests

**Files:** `test/unit-tests/journal/connection-test.ts` (new), `api-test.ts` (extend). Use `useFakeTimers`.

- connection: rpc-response correlation resolves; malformed rpc frame (missing `response`/`ok`) → diagnostic emitted + ignored, socket NOT cycled; duplicate multicast response ignored; overall timeout → `origin:"timeout"`; teardown → `origin:"teardown"`; correlated control-error → `origin:"relay"` + code; `not_ready` retry same id 2×/1s → surface; resend-during-backoff no-ops when settled; **retry send()→false → immediate `relay/not_connected`**; inject `makeId` for deterministic ids.
- api: `devices()` **race timeout rejects** (fake timers), incl. an Electron-branch mock that never settles (and the losing branch's late rejection does not surface as unhandled); malformed device ITEM dropped (partial roster); malformed ENVELOPE **throws** (→ agents-error, NOT empty roster); a valid `{devices:[]}` returns empty; success → typed.
- connection: `send()` returning false AND `send()` throwing (socket.send raises after the readiness check) both route `agentRequest` → `relay/not_connected` (no reject outside `RpcReply`); a **duplicate `not_ready` frame** does not schedule a second timer / double-send; an rpc-response whose `agent_device_id` mismatches the pending entry is **ignored**; a correlated error frame with a missing/non-string `code` or a non-string `detail` is narrowed (never yields an `RpcReply` violating `{code:string, detail?:string}`).
- api: `devices()` nonempty-array-all-invalid **throws** (distinct from genuinely-empty `{devices:[]}`).

**Acceptance:** `corepack pnpm test` green; `corepack pnpm lint` clean.

---

## Phase 3 — Client orchestration + NewSessionSheet UI (#469)

### T-3.1: Client RPC orchestration helpers + owned sync watchdog

**Files:** `src/journal/client.ts`

- `public async listAgents(): Promise<DeviceDTO[]>` → `api.devices()` (timeout-bounded), filter `kind === "agent"`, sort connected-first then name. Reject propagates to the sheet's `agents-error`.
- **Connection-availability guard (plan-review r4 Codex-B1 / P19):** `this.connection` is optional (`client.ts:211`) and is constructed at `client.ts:1049` — AFTER `startSession` emits `phase:"signed-in"` (`:1013`) and `await`s `selectConversation` (`:1047`). So the New Session sheet is reachable during a brief window when `connection` is `undefined`. `recentFolders`/`startSessionRpc` MUST guard it (`listAgents` needs no guard — it uses `api.devices()` over HTTP). Define a private `agentRpc(...)` that returns `{ ok:false, origin:"relay", code:"not_connected" }` when `this.connection` is undefined, so both helpers get a typed outcome instead of a null-deref throw.
- `public async recentFolders(agentDeviceId): Promise<RecentFolder[]>` → `this.agentRpc(agentDeviceId, "recent_folders", {})` (returns `not_connected` if no transport → treated as `[]`); parse `result.folders` (P33): require array; per item `path` non-empty string + `last_used` number-or-null; drop malformed; non-array / `ok:false` / not-connected → `[]` (free-text fallback).
- `public async startSessionRpc(agentDeviceId, workdir, browser): Promise<StartOutcome>` — build params (omit blank `workdir`; `browser:true` only when on), `this.agentRpc(…, "start", params)` (a `not_connected` reply → `{ kind:"error", message:"Still connecting — try again in a moment." }`, retryable), parse `result.convo_id` non-empty string, map the origin-tagged reply to `StartOutcome` per the spec table (relay + `bad_workdir` = safe `error`; `ok:true`-without-convo_id, unknown agent code, `timeout`, `teardown` = `uncertain`). `StartOutcome = { kind:"created"; convoId } | { kind:"error"; message } | { kind:"uncertain" }`. **No write-back** to `makeRecentFoldersStore` (`slash-palette.ts`).
- Extend `selectConversation` (`client.ts:332`) with `{ fromRpcCreate?: boolean }` (mirrors the existing `opts?: { clearUnread?: boolean }` convention). **Thread the flag into `loadOlderHistory` (plan-review r2 m3):** `loadOlderHistory` (`client.ts:423`) is zero-arg and called from two sites (`selectConversation` at `:354` AND UI pagination at `components.tsx:1809`), so give it a param `loadOlderHistory(opts?: { suppressNotFound?: boolean })` and pass `suppressNotFound: true` only from the `fromRpcCreate` call. When set, a 404 `not_found` (`http.js:397`) — currently thrown inside the try body and caught generically at `client.ts:455` (setting `connectionError`) — is instead swallowed as empty history for THIS call only (flag-scoped; the pagination caller is unaffected).
- **Owned, success-cancellable sync watchdog (plan-review r1 BL-5 + r2 B3/M1 + r3 Codex-M2 + r3 Claude-major — DESIGN LOCKED, do not re-narrow):** store the timer id in an instance field (`private rpcCreateWatchdog?: number`) plus the watched convo id + captured `gen`. **Duration: 10_000 ms** (spec Open-Questions value).
  - **Arm** in `selectConversation` when `fromRpcCreate` is set — **arm SYNCHRONOUSLY at the top, BEFORE the method's existing `await`s** (`refreshSelectedConversation` `~:347`, `loadOlderHistory` `:354`), capturing `const gen = this.sessionGen; const convo = conversationId` (plan-review r3 Codex-M2: if the first journal frame arrives during those awaits, a watchdog armed *after* them would never see the already-processed success signal and would false-fire). **Arming clears any previously-armed watchdog first** (handles rapid sequential creates so a second create can't leak the first timer).
  - **Clear conditions:** (a) **successful sync** — when the created convo first becomes journal-visible (a journal frame for `convo` ingested / it first appears in `state.conversations` via `handleJournal`), clear the timer (authoritative absent-signal-arrived); (b) **full teardown** — add the timer-field clear inside `resetTransientSyncState()` (`client.ts:1523`) so logout (`:310`) and `replaceSnapshot` (`:1118`) clear it. **Do NOT add an unconditional clear at the top of `selectConversation`** (plan-review r3 Claude-major): the r2-M1 concern (never call the Maps-wiping `resetTransientSyncState()` from `selectConversation`) is satisfied by simply *not touching* the watchdog on ordinary reselect — and an unconditional reselect-clear would permanently disarm protection if the user navigates away from a still-syncing created convo and returns to it (the fire-guard already suppresses the notice while away, so the clear adds no value and only removes protection).
  - **Fire callback:** re-check `this.sessionGen === gen && this.state.selectedConversationId === convo` before surfacing the recoverable notice ("Session created but not syncing yet — refresh to retry.") — mirrors `loadOlderHistory`'s guard (`client.ts:455`-region); non-redundant double-guard (closes same-convoId-across-relogin). This guard is what makes navigate-away safe (notice suppressed when not viewing `convo`), so the timer can safely persist across navigation without an explicit reselect-clear. Log via a diag helper when it fires (#55 requires logging watchdog fire).

**Acceptance:** helpers typed + parsed; `recentFolders`/`startSessionRpc` guard an absent `connection` (typed `not_connected` outcome, no null-deref) for the signed-in-before-connection window; `StartOutcome` matches the spec table; 404-suppression threaded via `loadOlderHistory({suppressNotFound})` (pagination caller unaffected); watchdog (10s) armed synchronously before the awaits, arming clears any prior watchdog, cleared on successful sync AND logout/replaceSnapshot (via `resetTransientSyncState`), NOT cleared on ordinary reselect; notice fires ONLY when still same-session-same-convo AND unsynced; navigate-away-and-back to a still-syncing convo retains protection; `tsc --noEmit` clean.

### T-3.2: NewSessionSheet component

**Files:** `src/journal/components.tsx`

- Add `NewSessionSheet` within `components.tsx` (Dan's one-file layout). Explicit `SheetState` union (spec Part 1 §3): `loading-agents | agents-error | agents | folders | starting | uncertain | error`.
- Step 1 agent picker: `client.listAgents()`; loading spinner; **reject/timeout → `agents-error` + working Retry**; rows (name, `Connected`/`Offline · last seen …`, disabled when `!connected`); empty → "No agents connected — start the bridge on your box." (no Settings/pairing reference — none exists in web); **auto-skip to folders when exactly one agent connected**.
- Step 2 folder picker: `client.recentFolders(agent.id)`; apply result ONLY if still `{step:"folders", agent:<same>}` **AND the completing request's epoch matches the current one** (plan-review r4-M2 / P23): step+agent identity is insufficient because re-entering the folder step for the SAME agent (pick A → Back → pick A) creates a new request with identical step+agent, so an out-of-order stale first response could overwrite the newer roster. Carry a monotonic `foldersRequestId` (or a per-mount token) in the `folders` state; capture it when firing `recentFolders`; on completion apply only if it still equals the state's current value. Free-text path + "Browser tools" toggle + "Start"; blank ⇒ agent default; **Back hidden in the auto-skip case**.
- Confirm → `starting` (single-flight). On `StartOutcome`: `created` → if sheet undismissed, close + `client.selectConversation(convoId, { fromRpcCreate: true })`; if dismissed during `starting`, do NOT navigate. `uncertain` → `uncertain` (Close only). `error` → `error` (retry).

**Acceptance:** all transitions reachable + typed; single-flight holds; dismiss-during-starting suppresses nav; empty-roster copy has no "Settings"/"pair" text; `tsc --noEmit` + `prettier --check` clean.

### T-3.3: Wire entry point + delete decoy + overlay exclusivity

**Files:** `src/journal/components.tsx`

- Hoist a `newSessionOpen` state (or reuse the overlay pattern). Change the "New conversation" button `onClick` (`components.tsx:590-593`) to open `NewSessionSheet` instead of toggling `composeHint`.
- **Delete ALL `composeHint` references** (plan-review r1 M3 — 5 sites, not 2): the `useState` decl (`components.tsx:278`), `setComposeHint(false)` in the room-menu opener (`:296`), `setComposeHint(false)` in the Settings button `onClick` (`:581`), the toggle (`:593`), and the render block (`:699-701`). Grep `composeHint`/`ComposeHint` after — zero hits (principle #16; else `tsc` breaks).
- **Overlay mutual-exclusivity (P23):** `accountOpen`/room-menu form a mutual-exclusion set (opening one closes the others via `setAccountOpen(false)`/`openRoomMenuRef`). `NewSessionSheet` open-state **joins it**: opening the sheet closes the account menu + room menu; opening the account menu (`:582`) or the room menu (`:294-296`) closes the sheet. Add the `setNewSessionOpen(false)` calls at those existing close-points.

**Acceptance:** `composeHint` fully removed (grep clean); button opens the sheet; sheet participates in overlay exclusivity (opening account/room menu closes it and vice-versa); reachable with zero conversations; `tsc --noEmit` + `prettier --check` clean.

### T-3.4: Phase 3 UI + integration tests

**Files:** `test/unit-tests/journal/components-test.ts` or new `new-session-sheet-test.ts`; `client-test.ts` (extend). `useFakeTimers` for the watchdog.

- `StartOutcome` per spec-table row (relay codes = safe error; `bad_workdir` = safe error; `ok:true`-missing-convo_id = uncertain; `spawn_failed`/`unsupported_mode` = uncertain; `timeout`/`teardown` = uncertain).
- `recentFolders` parse: `folders:null` and malformed item → `[]` (no throw).
- Sheet flow: agent→folder→start→`selectConversation`; auto-skip single agent; roster reject → `agents-error` → Retry re-runs; late `recent_folders` after Start does not revert `starting`; **same-agent re-entry (pick A → Back → pick A) with out-of-order `recentFolders` resolves — the stale first response does NOT overwrite (epoch guard)**; dismiss-during-starting no nav.
- Connection-absent window: invoking `recentFolders`/`startSessionRpc` while `client.connection` is undefined returns the typed `not_connected` outcome (folders `[]`; start `error`/retryable) — no throw / stuck sheet.
- Overlay exclusivity: opening the account menu closes an open NewSessionSheet (and vice-versa).
- RPC-before-journal / watchdog (fake timers): `selectConversation(id,{fromRpcCreate:true})` with `api.messages` mocked 404 does NOT set global `connectionError`; watchdog fires the notice only if still same-session-same-convo AND unsynced; **cleared (no fire) when the convo syncs** (journal frame arrives) and on logout/replaceSnapshot; **journal frame arriving DURING selectConversation's awaits still cancels** (arm-before-await); **navigate-away-then-back to the still-unsynced convo before expiry still fires** (no unconditional reselect-clear); a second `fromRpcCreate` create clears the first watchdog (no leak); an ordinary reselect does NOT wipe other convos' in-flight streaming state.

**Acceptance:** `corepack pnpm test` green; `corepack pnpm lint` clean.

### T-3.5: Final verification

**Files:** — (verification only)

- Re-check origin/main hasn't advanced again via the **read-only divergence check** in the baseline guard (rebase only if clean+behind; halt-and-surface if a rebase would conflict or the tree is dirty — never auto-rebase over uncommitted work).
- `corepack pnpm lint` clean; `corepack pnpm test` fully green; `corepack pnpm build` (webpack production) succeeds.
- Grep sweep: no `composeHint`, no `unreadHydrated`, no placeholder/TODO from the change.

**Acceptance:** all three commands green; grep sweep clean. (Live `:8443` deploy is a /ship-slim step.)

---

## Spec coverage map

| Spec section | Tasks |
|---|---|
| Part 1 §1 RPC transport (two-path correlation, not_ready incl. retry-send-fail, teardown, parse, malformed diag) | T-2.1, T-2.2, T-2.4 |
| Part 1 §2 roster (transport-agnostic timeout + parser) + recentFolders + startSessionRpc + StartOutcome + 404/owned-watchdog | T-2.3, T-3.1, T-3.4 |
| Part 1 §3 NewSessionSheet state machine + overlay exclusivity | T-3.2, T-3.3, T-3.4 |
| Part 1 §4 wire entry point + delete decoy (all 5 composeHint refs) | T-3.3 |
| Part 1 acceptance | T-2.4, T-3.4, T-3.5 |
| Part 2 §1 provenance state + per-session reset | T-1.1 |
| Part 2 §2 two banners | T-1.4 |
| Part 2 §3 track read+write health at every I/O site (P19 bootstrap ordering) | T-1.2 |
| Part 2 §4 observability | T-1.3 |
| Part 2 acceptance (incl. write-fail-not-masked, cross-session reset) | T-1.5 |
| accepted_residual_risks (bridge idempotency key; composer commingling) | out of scope — follow-up loops |

No spec acceptance criterion is uncovered.

## Principles pass (universal-design-principles.md)

- **#3 Fail Visible** — two banners (T-1.4); malformed-RPC diagnostic (T-2.2); RPC errors in the sheet (T-3.2); watchdog notice + log (T-3.1).
- **#7/#35** — anchors re-grep-confirmed post-rebase; `bad_workdir` pre-spawn grounded at bridge `journal-rpc.js`.
- **#16 Deletion** — `composeHint` (all 5 refs) + `unreadHydrated` removed.
- **#19 Check-Act Ordering** — bootstrap computes `preferencesUnavailable` INTO the constructed state, not a pre-patch erased by `blankState` (T-1.2).
- **#23 Explicit State Machines** — `SheetState` union (T-3.2); overlay exclusivity joined (T-3.3); provenance records (T-1.1).
- **#25 Entities Own Assumptions** — per-session provenance reset (T-1.1); storage keys unchanged (already scoped).
- **#26 Contract test** — `IdSetStore.read` + `/devices` malformed-shape tests.
- **#32 Idempotency** — origin-aware `StartOutcome`, retry-send-fail symmetric (T-2.2/T-3.1); residual = bridge follow-up.
- **#33 Parse, Don't Validate** — frame parse (T-2.2), `start`/`recent_folders`/`devices` payload parse (T-2.3/T-3.1).
- **#34 Observability** — storage diag (T-1.3) + RPC diag (T-2.2), console ceiling documented.
- **#55 Compensate for Absent Signals** — owned, session-scoped, logged sync watchdog (T-3.1); transport-agnostic roster timeout (T-2.3).
- No auth/RLS/payments/data-loss/security-boundary surfaces → typical tier, `/execute-slim`.

## Appendix: Verified Claims (research pass 2026-07-22 — DEGRADED, updated post plan-review r1)

⚠ Research module unavailable (`TAVILY_API_KEY` unset) — claims rest on model knowledge + reviewer empirical probes, not fresh web verification.

✓ c1 — `crypto.randomUUID()` requires a secure context. Not a production risk: matron-web is served over Tailscale HTTPS (`:8443`).
✓ c2 — **CORRECTED (plan-review r1 m2):** the earlier "jsdom may lack `randomUUID`" concern does NOT apply to this repo's pinned toolchain — a probe against `jest ^30` + `jest-environment-jsdom 30.2.0` (jsdom ^26) confirmed `crypto.randomUUID` is present with zero polyfill. The broken `??=` polyfill idea is DROPPED (it's a no-op when `crypto` exists sans `randomUUID` — Codex r1 M1). Determinism in the transport tests comes from the **injectable `makeId` factory** on `agentRequest` (T-2.2), not a polyfill.
✓ c3 — aborting `fetch()` via `AbortController` rejects with `AbortError`. Used only as an optional browser-side cancel; the **correctness guarantee for the roster timeout is the transport-agnostic `Promise.race`** (T-2.3), which also covers the Electron branch.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
