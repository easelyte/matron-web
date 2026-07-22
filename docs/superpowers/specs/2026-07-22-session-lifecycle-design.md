---
title: "Web session lifecycle — RPC start affordance (#469) + session-controls resilience (#462)"
status: approved
revision: 4
date: 2026-07-22
repo: easelyte/matron-web
worktree: /opt/matron/web-journal-wt-session-lifecycle
branch: feat/session-lifecycle
loops: [469, 462]
approach: "A — one branch, full agent-RPC parity, #462 folded in"
spec_review: "converged at round 3 (2 reviewers × 3 rounds); r3 both reviewers 0 blockers, all ship_blocking:false"
rejected_alternatives:
  - "B (text-command shim): compose /start into a conversation. Rejected — sendMessage structurally needs a selectedConversationId, so the empty-state gap can only be closed with a hack, and the RPC path is already server- + apple-proven."
  - "C (phased, two PRs): land #462 first, then #469. Viable fallback but two passes over the client.ts/components.tsx monoliths against the operator's single-worktree/single-ship setup."
related_principles:
  - "#3 Fail Visible (two independent banners so neither signal masks the other; read AND write provenance; log failed re-reads; RPC errors reach the sheet)"
  - "#7 Verify Third-Party APIs Against Source (both rpc-response AND control-error frame shapes + bridge error-code ordering grep-confirmed)"
  - "#23 Explicit State Machines for Async UI (per-store hydration provenance; full RPC lifecycle incl. failure/uncertain/teardown/late-completion/delayed-retry states)"
  - "#25 Entities Own Their Own Assumptions (storage keys versioned + per-session scoped; recent-folders write-back dropped)"
  - "#32 Idempotency for Mutations (origin-aware retry safety, grounded at the bridge producer boundary)"
  - "#33 Parse, Don't Validate (parse the full RpcReply payload per method — start AND recent_folders)"
  - "#34 Observability Before Automation (structured diagnostics for store degrade/recover)"
  - "#35 Code-Coordinate Citations Grep-Confirmed (web-side AND cross-repo apple/bridge citations verified for caller-liveness, not just symbol existence)"
out_of_scope:
  - "Login QR / device-link parity. Web password login already matches apple's password path; QR is low-value on a desktop browser. Deferred."
  - "Session lifecycle visibility in conversation-list rows (apple gap C). Existing-session display, not session start. Separate follow-up."
  - "Web agent-pairing/provisioning UI. Agents are provisioned server-side (dev-boxer/bridge). Empty-roster copy reflects this."
  - "Restructuring/splitting client.ts or components.tsx (loop #448). All additions are in-place."
accepted_residual_risks:
  - "Uncertain-outcome start (timeout / teardown-after-send / ok:true-without-convo_id / unknown agent error e.g. spawn_failed/unsupported_mode): the client shows a check-your-conversations state and does NOT auto-retry. A genuinely-lost post-delivery response is unrecoverable client-side; the created room (if any) syncs into the list. COMPLETE fix = bridge-side idempotency key on the start RPC → FOLLOW-UP LOOP (easelyte/claude-matrix-bridge, out of scope here)."
  - "Pre-existing composer recent-folders commingling: makeRecentFoldersStore (slash-palette.ts:184) keys by serverUrl:userId only, so it already commingles folders across >1 connected agent independent of this spec. This spec avoids adding a second leaky surface (no RPC write-back) but does not fix the pre-existing one → FOLLOW-UP LOOP."
revision_history:
  - "r1→r2: added control-error RPC correlation path; P32 outcome classification; decoupled storage-degraded from controlError; not_ready retry; dropped recent-folders write-back; read()-based cross-tab recovery; runtime frame guard; /devices failure state; citation fixes."
  - "r2→r3: origin-aware StartOutcome (relay/agent/timeout/teardown); TWO independent banners; roster-fetch timeout; late-recent_folders single-flight guard; storeHydrated on setArchived/setFlag reads; full RpcReply payload parse; race-trace through loadOlderHistory + 404-suppression; not_ready SAME request_id; empty-roster copy; minors."
  - "r3→r4 (convergence polish): symmetric WRITE provenance (storeWritable) closing the quota-write-masking sub-case; corrected the hub.js:108→ws.js:434-435 quote citation; dropped false apple-parity attributions (backToAgents has zero callers; sameFolderAgent doesn't guard mid-start) — reframed as web-only; delayed not_ready resend guards a settled entry + terminal cancels the backoff; defined client.recentFolders() + its parser; bounded the 404-suppression with a watchdog + explicit scoping flag; grounded bad_workdir safe-retry at bridge journal-rpc.js:83-92; promoted the 2 out-of-scope residuals to follow-up loops."
---

# Web session lifecycle: RPC start affordance (#469) + session-controls resilience (#462)

Two coupled changes shipping on one branch (`feat/session-lifecycle`) because both live in the same two do-not-split monoliths (`client.ts` 1529 LOC, `components.tsx` 2452 LOC) and are thematically one "session lifecycle" unit.

All file:line references confirmed against worktree HEAD `a8357d8` (== `origin/main`); bridge citations against `/opt/matron/bridge-journal` (branch `journal-deploy`).

---

## Part 1 — #469: Session-start affordance (apple NewChatSheet parity)

### Problem

The web client has **no working way to start a new agent session**:

- The header "New conversation" button (`components.tsx:587-597`) is a **decoy** — its `onClick` only toggles `composeHint` (`components.tsx:699-703`). It creates nothing.
- The only real start path is typing `/start …` into a composer, but `client.sendMessage` (`client.ts:464-482`) requires `this.state.selectedConversationId` — so from an empty/first-run state (no conversations) **there is no entry point at all**.

The native apple client solves this without the text command: `NewChatViewModel.start(workdir:)` fires a **JSON-RPC `start`** at a chosen agent and navigates to the returned `convo_id`.

### The RPC protocol (verified against source: server, apple, AND bridge producer)

Grep-confirmed in the journal server (`/opt/matron/journal/src/ws.js`, `hub.js`, `http.js`, spec `docs/superpowers/specs/2026-07-15-agent-rpc-design.md`), the apple client, and the **bridge RPC producer** (`/opt/matron/bridge-journal/lib/journal-rpc.js`). The web client implements **none** of it today.

**Device roster** — `GET /devices` (`http.js:280-291`). Client-gated; web is a `kind:"client"` device, so allowed. Returns `{ devices:[{ device_id, kind, name, last_seen_at, connected, is_self, … }] }` for all kinds. Web filters `kind==="agent"`.

**Request** — WS op `agent_request`: `{ op, request_id, agent_device_id, method, params }`. Validation (`ws.js:421-460`): `request_id` ≤128, `method` ≤64, `agent_device_id` int, frame ≤16 KiB.

**Response — TWO distinct frame shapes, both correlated by `request_id`, with distinct delivery-origin semantics:**

1. **Agent-produced reply** (`hub.sendRpcResponse`, multicast, `ws.js:490-498`) — **request reached the agent**:
   `{ "kind":"rpc", "response":{ "request_id","agent_device_id","ok":true,"result":{…} } }`, or on agent failure `"ok":false,"error":{ "code","detail"? }`. Multicast to all the client's live sockets → **client dedupes by `request_id`**.
2. **Server-side rejection** (`failRpc`, `ws.js:427-428`) — **request never reached an agent** (nothing forwarded):
   `{ "kind":"control","op":"error","code","ref":"agent_request","request_id","detail"? }`. Codes: `not_ready` (mid-hello-replay, `ws.js:437`; the guard comment at `ws.js:434-435` notes a lost response "invit[es] a timeout-retry of a non-idempotent `start`", so it rejects instead — **verbatim re-send after replay is safe**), `bad_request` (`ws.js:438/439/443/448`), `not_found` (`ws.js:452`), `agent_unreachable` (no live agent socket, `ws.js:459`). Apple correlates this as a second path (`WireModels.swift` `case "error"` → `JournalSyncEngine.swift:634-639`). (Relay single-consumer vs multicast dedup rationale: `hub.js:108`.)

**Delivery-origin is load-bearing for retry safety (P32):** a **control-error** frame proves *non-delivery* (safe to retry); an **rpc-response `ok:false`** proves *delivery* (a side effect may have occurred). The transport preserves origin.

**Methods (bridge producer `journal-rpc.js`):**
- `recent_folders` — `{}` → `{ folders:[{ path:string, last_used:number|null }] }` (`journal-rpc.js:53-80`; dirs that no longer exist are dropped, `defaultWorkdir` always included).
- `start` — `{ workdir?, browser? }` → `{ convo_id }` (`journal-rpc.js:83-118`). **Non-idempotent; relay does no dedup.** Agent error codes it can emit: **`bad_workdir`** (`journal-rpc.js:88-92`: `statSync` validation returns this **before** `startSession()` at `:100` — *provably pre-spawn, no session created*); `spawn_failed` (`:101-102`, `startSession` threw); `unsupported_mode` (`:110-115`, spawned then torn down when the id is unknowable). Grounds the StartOutcome safety classification (P7).

### Design — client-side RPC + NewSessionSheet

**1. RPC transport (`connection.ts`).** The `JournalConnection` instance persists across socket reconnects (only the inner socket is recreated in `open()`), so it owns the correlation map.

- `private pendingRpc = new Map<string, { resolve, timeoutTimer, backoffTimer?, retriesLeft, method, params, agentDeviceId }>()` — **distinct `timeoutTimer` and `backoffTimer` ownership**.
- `public async agentRequest(agentDeviceId, method, params, timeoutMs = 30_000): Promise<RpcReply>`. `request_id = crypto.randomUUID()`. `send({op:"agent_request",…})`. **If `send()` false** (nothing left the client) → resolve `{ ok:false, origin:"relay", code:"not_connected" }` immediately; never added to `pendingRpc`. Else register + arm `timeoutTimer` → resolve `{ ok:false, origin:"timeout", code:"timeout" }`, **clear any `backoffTimer`**, and delete the entry.
- **`RpcReply` (parsed, P33):** `{ ok:true; origin:"agent"; result:unknown } | { ok:false; origin:"agent"|"relay"|"timeout"|"teardown"; code:string; detail?:string }`.
- **`handleFrame` (`connection.ts:127-155`) — two correlation branches, both keyed by `request_id`, BEFORE the `onFrame` fallthrough:**
  - `frame.kind === "rpc"`: **parse the payload** (P33) — require `frame.response` object, `request_id` string, `ok` boolean; on `ok:false` require `error.code` string; `result` passed through as `unknown` for method-level parsing at the call site. Malformed → `return` (ignore; never throw — a throw cycles the socket per `connection.ts:107`). Resolve the matched pending as `origin:"agent"`. Unknown/duplicate id (multicast) → ignore.
  - `frame.kind === "control" && frame.op === "error" && typeof frame.request_id === "string" && pendingRpc.has(frame.request_id)`: correlated **relay rejection** → resolve `{ ok:false, origin:"relay", code, detail }`. Uncorrelated control-errors fall through to the existing `revoked` / `client.connectionError` handling (`client.ts:1201-1203`) unchanged.
- **`not_ready` auto-retry (safe; non-delivery).** On a correlated relay reply with `code==="not_ready"` and `retriesLeft>0`: schedule a `backoffTimer` (1 s) that, **before re-sending, checks `pendingRpc.has(id)`** (the entry may have been settled by the overall timeout/teardown during the backoff — apple guards this at `JournalSyncEngine.swift:281` `guard rpcPending[requestID] != nil`); if still pending, re-send **verbatim reusing the SAME `request_id`** (apple reuses the id via `resendRPC(requestID:)`, `JournalSyncEngine.swift:262-278`), up to **2×**. Exhausted → resolve `not_ready` to the caller. This is web's own lifecycle, matched to apple's retry semantics (not a claim that apple's Phase enum models it — it does not).
- **`stop()` (`connection.ts:44-55`, logout `client.ts:302` / session-replace `client.ts:930`)** clears all `timeoutTimer`/`backoffTimer` and resolves every *remaining* pending entry as `{ ok:false, origin:"teardown", code:"teardown" }` — **not** `not_connected` (an entry in the map was already `send()`-accepted, so delivery is uncertain → routes to uncertain UX).
- `types.ts`: add `request_id?: string` to `JournalControlFrame` (`types.ts:72-79`); add `JournalRpcFrame` `{ kind:"rpc"; response?:{…} }` to `ServerFrame` (`types.ts:108`); add `RpcReply`, `DevicesResponse`, `DeviceDTO`, `RecentFolder`.

**2. Device roster + RPC helpers (`api.ts` + `client.ts`).**
- `api.devices(): Promise<DevicesResponse>` → `GET /devices` via `json<T>()` (`api.ts:167`), **AbortController timeout (~10 s)** so a stalled HTTP connection can't wedge the sheet.
- `client.listAgents()` → `api.devices()`, filter `kind==="agent"`, sort connected-first then name. Reject/timeout → sheet `agents-error`.
- `client.recentFolders(agentDeviceId): Promise<RecentFolder[]>` — **the RPC boundary §4 needs** (r3: was called as an undefined `agentRpc`). Calls `connection.agentRequest(agentDeviceId,"recent_folders",{})`, **parses `result.folders`** (P33): require an array; per item require `path` non-empty string, `last_used` number-or-null; drop malformed items; on non-array/`ok:false` return `[]` and let the sheet show the free-text fallback.
- `client.startSessionRpc(agentDeviceId, workdir, browser): Promise<StartOutcome>` — build params (omit blank workdir; `browser` only when true), call `connection.agentRequest(…,"start",params)`, **parse `result.convo_id` as a non-empty string** (P33), map the origin-tagged reply to `StartOutcome`. **No write-back** to the composer's localStorage store (`slash-palette.ts:184`; surfaces stay independent).

  **`StartOutcome` classification (P32, origin-aware, grounded):**
  | Reply | Proves | Outcome | UX |
  |---|---|---|---|
  | `ok:true` + non-empty `convo_id` | delivered + created | `created` | close, `selectConversation(convoId,{fromRpcCreate:true})` |
  | `ok:true` + missing/empty `convo_id` | delivered, maybe created | **`uncertain`** | check-your-conversations; no blind retry |
  | `origin:"relay"` (`agent_unreachable`/`not_found`/`bad_request`/`not_connected`; `not_ready` after retries) | **non-delivery** | `error` (**safe retry**) | apple-equivalent copy |
  | `origin:"agent"` `bad_workdir` | delivered, **pre-spawn reject** (bridge `journal-rpc.js:88-92` before `startSession` `:100`) | `error` (**safe retry** after fixing path) | "That folder doesn't exist on the box." |
  | `origin:"agent"` other/unknown (`spawn_failed`/`unsupported_mode`/…) | delivered, side effect uncertain | **`uncertain`** | check-your-conversations; no blind retry |
  | `origin:"timeout"` / `origin:"teardown"` | uncertain | **`uncertain`** | check-your-conversations; no blind retry |

  Only provable non-delivery (relay) or a grounded pre-spawn agent reject (`bad_workdir`) is safe-retry. The complete fix (auto-retry uncertain outcomes) needs the bridge idempotency key (`accepted_residual_risks`).

**3. NewSessionSheet component (in `components.tsx`).** One explicit state union (P23):
```
type SheetState =
  | { step:"loading-agents" } | { step:"agents-error" }
  | { step:"agents"; agents } | { step:"folders"; agent; folders?; foldersError? }
  | { step:"starting"; agent } | { step:"uncertain" } | { step:"error"; agent; message }
```
- **Step 1 — agent picker.** `client.listAgents()`; loading → spinner; **reject/timeout → `agents-error` + working Retry**. Rows: name, `Connected`/`Offline · last seen …`, disabled when `!connected`. Empty roster → **"No agents connected — start the bridge on your box."** (web has no in-app pairing UI; do NOT copy apple's "pair one in Settings → Manage Devices"). **Auto-skip to step 2 when exactly one agent is connected.**
- **Step 2 — folder picker.** `client.recentFolders(agent.id)` populates the list (tap → start). **Guard late completion:** apply a `recent_folders` result ONLY if the sheet is still `{step:"folders", agent:<same>}` — the web's own `folders→starting` step transition is the guard (once `starting`, a late result is dropped; this is a web-only mechanism, not an apple parity claim). Free-text path + "Browser tools" toggle + "Start" (blank ⇒ agent default). **Back** shown only when the roster step was actually rendered (hidden in auto-skip — web-only choice).
- **Confirm** → `starting` (single-flight). On `StartOutcome`: `created` → **if the sheet is still undismissed**, close + `selectConversation`; if dismissed during `starting`, do NOT navigate (the room still syncs into the list). `uncertain` → `uncertain` (Close only). `error` → `error` (retry allowed).
- **RPC-before-journal race** (bounded): `selectConversation` (`client.ts:330-352`) continues into `loadOlderHistory` (`client.ts:352`) → `api.messages(convoId)` (`client.ts:429`), and the server returns **404 `not_found`** for a not-yet-journal-visible convo (`http.js:397`), which currently becomes a global `connectionError` (`client.ts:451`). Fix: `selectConversation` gains an explicit `{ fromRpcCreate?: boolean }` option (passed ONLY from the start-success path — NOT blanket-swallowing for other callers); when set, the initial `loadOlderHistory` treats a 404 as empty history AND **arms a watchdog**: if the convo has not become journal-visible within ~10 s, surface a recoverable notice ("Session created but not syncing yet — refresh to retry.") rather than an indefinite silent empty room (P55 Compensate for Absent Signals / P3). The room normally populates via journal frames well within the window.

**4. Wire the entry point.** Replace the decoy button `onClick` (`components.tsx:587-597`) to open NewSessionSheet; delete `composeHint` (`components.tsx:699-703`) + its state (#16). Reachable in the signed-in empty state.

### Part 1 acceptance

- From a signed-in state with **zero conversations**, the button opens NewSessionSheet and a session starts end-to-end into the new room.
- With exactly one connected agent, the sheet skips to the folder step; Back hidden.
- Blank path ⇒ agent default; typed/recent path ⇒ `workdir`; browser toggle ⇒ `browser:true` only when on.
- **Server-side rejections render in the SHEET** (correlated control-error frame), never swallowed into the empty-state-invisible global `connectionError`.
- **`not_ready` auto-retried** verbatim (same request_id) ≤2×/1s; **a resend scheduled during backoff no-ops if the entry was already settled by timeout/teardown** (no post-terminal re-send).
- **P32 retry safety, origin-aware + grounded:** relay rejections + `bad_workdir` safe-retry; `ok:true`-without-`convo_id`, unknown agent codes (`spawn_failed`/`unsupported_mode`), `timeout`, `teardown` all yield `uncertain` with no client-originated re-send.
- `GET /devices` reject **or hang** → `agents-error` with a working Retry (timeout-bounded).
- Malformed `{kind:"rpc"}` (missing `response`/`ok`, non-string/empty `convo_id`) handled without cycling the connection or mis-navigating; malformed `recent_folders` (`folders:null`/bad item) degrades to free-text, no throw; duplicate multicast response ignored.
- A stale `recent_folders` completion after Start does not revert `starting`→`folders`; dismissing during `starting` does not navigate on a late `created`.
- Successful start does not raise a spurious global error from the initial `loadOlderHistory` 404; if the convo never syncs, the bounded watchdog surfaces a recoverable notice.
- Decoy `composeHint` removed; no agent-scoped folder leak into the composer store.
- Jest: rpc-response correlation (resolve/malformed-ignore/duplicate-ignore/timeout/teardown-uncertain); control-error correlation → code; `not_ready` retry (same id, 2×/1s, settled-during-backoff no-op); origin-aware `StartOutcome` per row incl. `bad_workdir` safe vs `spawn_failed` uncertain; malformed `recent_folders`; late-`recent_folders` guard; roster-error→retry; dismiss-during-starting; RPC-before-journal 404-suppression + watchdog.

---

## Part 2 — #462: Session-controls storage resilience + observability

### Problem (confirmed at HEAD)

Four `IdSetStore`s (`conversation-flags.ts:10-55`): archive/pinned/favorite/unread, keyed `matron_journal_<name>_v1:<serverUrl>:<userId>` (versioned + per-session scoped — #25 satisfied). `store.read()` → `{ ids, ok }`; `ok:false` only on a storage-access throw (`conversation-flags.ts:39-48`).

Three defects around the single shared `controlError` string (`types.ts:190`):
1. **Banner cleared on unrelated success.** `setArchived` (`client.ts:1053`) / `setFlag` (`client.ts:1080`) clear `controlError` unconditionally on success; a bootstrap failure on a *different* store gets cleared by a later pin/favorite while that store stays stale-empty.
2. **`replaceSnapshot` silent on failed re-read** (`client.ts:1111-1134`).
3. **No per-store hydration provenance** — only `unreadHydrated` (`client.ts:235`); `bootstrapReadFailed` (`client.ts:981`) is one-shot.

### Design — decouple storage health from controlError; two banners; READ + WRITE provenance

`controlError` is a shared transient slot (carries `MARK_ALL_READ_ERROR` `client.ts:397-418`, blocked-message `client.ts:1160-1166`, per-store write failures `client.ts:1050/1077`). Overwriting it — or a single render slot showing storage-degraded XOR controlError — masks whichever loses. Resolution: **two independent banners**, and a persistent storage-health signal derived from BOTH read and write outcomes.

**1. Per-store health provenance.** Replace `unreadHydrated` with two per-store records:
```ts
private storeHydrated = { archive:true, pinned:true, favorite:true, unread:true }; // last read() ok
private storeWritable = { archive:true, pinned:true, favorite:true, unread:true }; // last write ok
```
Point the existing `unreadHydrated` read site (`clearUnreadOverride`, `client.ts:1084-1089`) at `storeHydrated.unread` (identical behavior). Add `private storageHealthy()` = all `storeHydrated` AND all `storeWritable` true.

**2. Two banners (P3 Fail Visible).** `ClientState` gains `preferencesUnavailable: boolean` (= `!storageHealthy()`, recomputed at every health-changing site). The left panel renders **two stacked elements**: a NEW persistent banner (shown whenever `preferencesUnavailable`) with `PREFERENCES_UNAVAILABLE_ERROR` (constant reusing the bootstrap copy `client.ts:997-999`), and the EXISTING transient `controlError` slot (`components.tsx:642-646`, semantics unchanged). They coexist; neither masks the other.

**3. Track health at EVERY store I/O site** (reads AND writes — r3 closed the write sub-case both reviewers flagged):
- **Bootstrap** (`client.ts:976-1001`): set all `storeHydrated` from reads; set `preferencesUnavailable`. Drop the redundant `controlError` bootstrap assignment (persistent banner supersedes it).
- **`setArchived`** (read `client.ts:1039`, write `:1050`) and **`setFlag`** (read `client.ts:1066`, write `:1077`): set `storeHydrated[store]=read.ok` on the read and `storeWritable[store]=writeOk` on the write (both already branch on outcome to set a transient `controlError` — now they also update the persistent provenance, so a quota-`setItem` throw with reads still working raises the persistent banner and cannot be masked by an unrelated later success). Recompute `preferencesUnavailable`.
- **`replaceSnapshot`** (`client.ts:1111-1134`, defect 2): set `storeHydrated[store]=read.ok` per store (both branches); adopt on ok; include `preferencesUnavailable` in the final `patch()`; diagnostic on `ok:false`.
- **Cross-tab `storage` listener** (`client.ts:1002-1021`, r1 M2): currently calls `store.parse(event.newValue)` and sets `unreadHydrated=true` via parse (false-recovery). **Change recovery to call `store.read(currentSession)`** (exercises the access boundary): set `storeHydrated[store]=read.ok`, adopt on ok, recompute. Drop the blanket `event.newValue===null` early-return on the recovery path (a key removal still triggers a re-read).

**4. Observability (#34, right-sized).** No telemetry sink; a pipeline is disproportionate. Ceiling: one structured console helper (`{event, store, ok}` + stable prefix) on read/write failure (bootstrap/replaceSnapshot/cross-tab/action-site), degrade transition (false→true), recovery (true→false). Documented in a code comment as the chosen ceiling.

### Part 2 acceptance

- Bootstrap read failure on store X + later success on store Y **keeps** the persistent banner (derived from provenance).
- A transient `controlError` (markAllRead/blocked/write) **remains visible in its own slot even while storage is degraded** — banners stack; neither overwrites the other.
- A **read** failure via `setArchived`/`setFlag` updates `storeHydrated`; a **write** failure (quota, reads OK) updates `storeWritable` — both raise the persistent banner and **cannot be masked by an unrelated later success** (closes the r3 write sub-case).
- `replaceSnapshot` `ok:false` flips `preferencesUnavailable` true + logs; recovery flips it back.
- Cross-tab recovery marks hydrated **only via `store.read()`**; a parseable-but-unreadable key does NOT falsely recover.
- `clearUnreadOverride`'s `unreadHydrated` shortcut behavior unchanged (backed by `storeHydrated.unread`).
- Jest: (a) persistent banner persists under unrelated success; (b) both banners render together; (c) storeHydrated updates on setArchived/setFlag read-fail; (d) **storeWritable updates on write-fail, banner not masked by unrelated success**; (e) replaceSnapshot ok:false flips the flag; (f) cross-tab recovery via read() only (parseable-but-unreadable ≠ recovery); (g) `IdSetStore.read` `{ids,ok}` contract (ok:false on throw) — schema/contract test (#26).

---

## Shared risks / notes

- **P32 ceiling + follow-up.** Web-side origin-aware classification eliminates client-originated duplicates for every provable-non-delivery case and routes all uncertain cases to no-blind-retry. It cannot recover a genuinely-lost post-delivery response — complete fix = bridge idempotency key (`accepted_residual_risks`; follow-up loop).
- **Pre-existing composer folder commingling (follow-up loop).** `slash-palette.ts:184` keys by `serverUrl:userId`, commingling folders across >1 connected agent today, independent of this spec. Not fixed here.
- **16 KiB frame cap / multicast dedupe** — documented; params tiny; correlation ignores unknown ids.
- **Do-not-split constraint.** NewSessionSheet + both banners go **into** `components.tsx`; RPC transport extends `connection.ts`/`api.ts`/`client.ts` in place (loop #448 tracks the upstream split proposal).
- **Upstream.** All deltas are upstream-PR candidates to Matronhq per `project_matron_web_stays_dan_upstream_aligned`; Dan PR optional/deferred.

## Open questions

- None blocking. `start` timeout 30 s, `/devices` timeout ~10 s, RPC-create sync watchdog ~10 s — all adjustable in plan.
