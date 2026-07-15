# Plan: web attachment-send (matron-web ← apple parity)

Spec: `docs/superpowers/specs/2026-07-15-web-attachment-send-design.md` (converged, 4 review rounds).
Repo: `easelyte/matron-web` (fork of `Matronhq/matron-web`), branch `feat/web-attachment-send`.
Stack: TypeScript + React, webpack, jest (`pnpm test`), `tsc --noEmit` (`pnpm lint:types`).

Goal: file/image attachment **send** (picker + drag-drop + paste) reaching parity with apple's
`ComposerViewModel.attachFiles()`, round-tripping to Claude via the bridge. Purely client-side — no
server/protocol change.

## Dependency graph
- **Phase 1** (types + transport) blocks everything.
- **Phase 2** (send path + reconcile) depends on Phase 1.
- **Phase 3** (recovery: reap / reconnect replay / retry) depends on Phase 2's state machine + outbox schema.
- **Phase 4** (composer UI) depends on Phase 2 (client API) + Phase 1 (`dragActive`); can start once Phase 2's
  `client` surface is stubbed, but its tests need Phase 2/3 behavior.
- **Phase 5** (tests + verification) depends on all prior phases.
Phases 2 and 4 partially parallelize once Phase 1 lands, but the review-boundary order is 1→2→3→4→5.
Intra-phase ordering that matters: **T-2.1 declares the client fields** (`pendingFiles`/`inFlightUploads`/`sessionGen`) that T-2.3 adds logic over — T-2.1 before T-2.3. **T-2.3's `canRetry` surfacing** blocks T-4.3 (the composer reads `canRetry`, not the private map). **T-1.4** (DB version bump) has no code dependents but must land before any attachment row is persisted. **T-4.4** (CSS) pairs with T-4.2/T-4.3.

## Spec-coverage map (every spec part → task)
- api.ts (uploadMedia/binary/signal/Electron guard/messageForCode) → T-1.2, T-1.3
- types.ts (PendingMessage fields incl. send_failed/canRetry, attachState/errorKind, dragActive, blankState) → T-1.1
- rollback stance (no version bump, documented edge) → T-1.4
- client fields + sendAttachment/attachFiles (convo capture, file.size gate, deadline-aborts-fetch, owner-tuple guard, strict-parse, send-then-branch, error-code) → T-2.1, T-2.2
- lifecycle + logout/startSession ownership + canRetry read-time surfacing → T-2.3
- database.ts kind-aware reconcile (returns id) + ownership-gated cleanup + eventSnippet branch → T-2.4
- durable row deletion + dismissAttachment → T-2.5
- boot-time reap → T-3.1
- kind-aware reconnect replay (sending + send_failed) → T-3.2
- retryAttachment (upload_failed re-upload, send_failed re-emit) → T-3.3
- composer UI (button/input/drag-drop+preventDefault+reset/paste/per-item chip incl. sending/error line) → T-4.1, T-4.2, T-4.3
- CSS overlay + chip styling (.pcss) → T-4.4
- Testing section (all bullets, incl. Phase-4 component tests) → T-5.1..T-5.5
- Known limitations (documented, no code) → asserted in T-5.5 as accepted

---

## Phase 1 — Types + transport foundation

### T-1.1: `PendingMessage` + `ClientState` attachment types (incl. `blankState`)
- [ ] In `src/journal/types.ts`, extend `PendingMessage` with optional attachment fields: `kind?: "text" | "image" | "file"`, `filename?: string`, `size?: number`, `contentType?: string`, `blobRef?: string | null`, `convoId: string` (confirm present on outbox rows), `attachState?: "uploading" | "sending" | "error"`, `errorKind?: "upload_failed" | "send_failed" | "too_large" | "empty"` (**`send_failed` included** — upload OK but WS `send` returned false; blobRef retained), `canRetry?: boolean` (derived, see T-2.3 — surfaced so the composer needn't reach into the client's private map).
- [ ] Add `dragActive: boolean` to `ClientState` **and initialize it (`dragActive: false`) in `blankState()` (`client.ts:51`)** so `pnpm lint:types` stays clean (a required field missing from the constructor is a type error).
- Backward-compat: text rows have `kind` absent/`"text"` and none of the attachment fields; all new fields optional.
- **Acceptance:** `pnpm lint:types` clean; existing text-send types unchanged; a `PendingMessage` can represent every state in the spec's state machine (`uploading`, `sending`, `error(upload_failed|send_failed|too_large|empty)`); `blankState()` compiles.

### T-1.2: `request()` binary body + `AbortSignal`
- [ ] In `src/journal/api.ts`, extend `request()` options with `rawBody?: ArrayBuffer`, `contentType?: string`, `signal?: AbortSignal`. When `rawBody` set: send it as the `fetch` body with `Content-Type: contentType` (skip JSON branch / JSON header). Pass `signal` to `fetch(..., { signal })`. Electron guard: **before** the Electron branch, `if (electron && options.rawBody) throw new JournalApiError("Attachments aren't supported in the desktop build yet.", 0, "electron_binary_unsupported")`.
- **Acceptance:** a raw-body request sends bytes verbatim with the given content-type and forwards `signal`; aborting the controller rejects the in-flight fetch; with the Electron bridge present + `rawBody`, it throws before any request fires.

### T-1.3: `uploadMedia` + error-code mapping
- [ ] In `src/journal/api.ts`, add `uploadMedia(bytes: ArrayBuffer, contentType: string, signal?: AbortSignal): Promise<{ media_id: string; size: number; content_type: string }>` → `request("/media", { method:"POST", rawBody:bytes, contentType, signal })`, parse JSON. Add `messageForCode` cases: `too_large → "File too large."`, `empty → "That file is empty."`. Do **not** add an `electron_binary_unsupported` case (guard throws the message verbatim; `messageForCode` only fires on server `{error}` bodies).
- **Acceptance:** returns `media_id` on 200; a server 413 `{error:"too_large"}` surfaces "File too large." (not "HTTP 413"); 400 `{error:"empty"}` surfaces "That file is empty."

### T-1.4: rollback stance — do NOT bump `DATABASE_VERSION` (documented limitation)
- [ ] **Deliberately do not bump `DATABASE_VERSION`.** A bump would make a post-rollback old bundle unable to open the DB at all (`indexedDB.open` at a lower version than stored throws `VersionError` on *every* `open()`, including each re-login → an unrecoverable sign-in loop until site data is cleared; plus a multi-tab `versionchange`/`onblocked` failure). That cure is worse than the disease. New attachment fields are all optional additions to the same `PendingMessage` shape — no schema migration needed.
- [ ] **Accepted limitation (documented, T-5.5):** if the web bundle is rolled back *while an unsent attachment outbox row exists*, the old bundle's text-only `sendPendingMessage` would replay that row as a bodiless text event. This is a **narrow deployment-time window** (only outbox rows not yet sent/echoed at the exact rollback moment; outbox rows clear on send). Out of scope to fully solve in a client-only first PR; documented, not silently shipped.
- **Acceptance:** `DATABASE_VERSION` unchanged; no new IndexedDB migration; the rollback edge is documented in T-5.5's accepted-limitations list.

---

## Phase 2 — Send path + reconcile

### T-2.1: client lifecycle fields + `sendAttachment(file, convoId)`
- [ ] **Declare the class fields first (prerequisite for the guard/ownership — T-2.3 only adds the *logic* over these):** on `MatronJournalClient` add `private pendingFiles = new Map<string, File>()`, `private inFlightUploads = new Set<AbortController>()`, `private sessionGen = 0`, and constants `MEDIA_MAX_BYTES` (50 MB, mirrors server default), `UPLOAD_TIMEOUT_MS`. This closes the ordering gap (T-2.1's guard reads `this.sessionGen`/`this.pendingFiles`).
- [ ] Add `sendAttachment(file: File, convoId: string)`. **Capture the owner tuple at entry:** `const gen = this.sessionGen; const api = this.api; const db = this.database;`. **Re-check `this.sessionGen === gen` immediately after every `await`, before any side effect** (before the upload uses `api`, before any `db` write, before the `connection.send`) — if it changed, abort and bail (do not upload with another session's `api`, do not write another session's outbox). This is the full egress/ownership guard, not just a pre-send check.
- [ ] Body: derive `kind` from `file.type`; **`file.size` pre-check** against `MEDIA_MAX_BYTES` → `error(too_large)` **without** `File.arrayBuffer()`; `file.size === 0` → `error(empty)`. Outbox entry `attachState:"uploading"` with `convoId`, optimistic render. **One deadline timer that aborts the controller:** `const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)`; register in `inFlightUploads`. The read: `Promise.race([file.arrayBuffer(), abortPromise(controller.signal)])` (`arrayBuffer()` takes **no signal** — parameterless per the File API spec — so the race settles the await even though the underlying read isn't truly cancelled). The upload: `uploadMedia(bytes, contentType, controller.signal)` — the **same `controller.abort()` at the deadline kills the fetch too**, so a never-settling fetch is bounded (not just the read). `clearTimeout(timer)` + deregister controller in `finally`. Resolve → `blobRef=media_id`, `attachState:"sending"`. Reject/abort/timeout → `error(upload_failed)`.
- [ ] **Strict-parse the upload response** (Parse-Don't-Validate): reject if `media_id` is absent/non-string rather than casting a malformed 200 into a bad send.
- **Send-then-branch (one synchronous unit, no `await` between the final gen-check and send):** `const ok = connection?.send({ op:"send", convo_id: convoId, type: kind, blob_ref: media_id, payload:{ blob_ref: media_id, name: filename, filename, content_type, size, local_id }, local_id })`; `ok===true` → stay `sending`; falsy → `error(send_failed)` (blobRef retained). Map `JournalApiError.code` → `errorKind`. DB writes for terminal error states are `db?.`-guarded (logout may have closed the store).
- **Acceptance:** class compiles; wire shape matches spec (top-level + payload `blob_ref`; both `name`+`filename`); malformed 200 (no `media_id`) → `error(upload_failed)`, no send; oversize never calls `arrayBuffer()`; a **held read** AND a **never-settling fetch** both settle to `error(upload_failed)` at the deadline and the batch advances; a session switch mid-upload produces **no HTTP through the new session's api and no write to the new/closed DB** (not merely "no WS send"); `ok` falsy → `error(send_failed)` blobRef retained; `too_large` preserved into `errorKind`.

### T-2.2: `attachFiles(files)` — capture convo, sequential, per-file isolation
- [ ] In `src/journal/client.ts`, add `attachFiles(files: File[])`: snapshot `selectedConversationId` **once**; loop `sendAttachment(file, convoId)` **sequentially**, each in try/catch (one file's error doesn't block the rest). Wire from `components.tsx` (Phase 4).
- **Acceptance:** switching conversation mid-batch routes later files to the captured `convoId`; one file erroring lets the rest proceed; one buffer resident at a time.

### T-2.3: lifecycle cleanup, session ownership (logout + startSession), `canRetry` surfacing
(Fields declared in T-2.1; this task adds the *logic* over them.)
- [ ] `sessionGen` is bumped on every `logout()` **and `startSession()`**. **Both `logout()` and `startSession()` synchronously `.abort()` every controller in `inFlightUploads` and clear `pendingFiles` before installing the new session** (`startSession()` replaces `api`/`database` at `client.ts:338` — without aborting priors, an in-flight upload from the old session survives the switch). Cleanup a `pendingFiles` entry on: echo reconcile, `sending`/`send_failed` (blobRef set ⇒ retry re-emits, no bytes), permanent `error(too_large|empty)`, dismiss, logout/startSession. Keep the `File` **only** for retryable `error(upload_failed)`.
- [ ] **Surface `canRetry` to React at read time — concrete site:** compute it inline in `refreshSelectedConversation` (`client.ts:537-542`, the one place `database.outbox()` becomes `state.pendingMessages`) by mapping each row: `canRetry = (errorKind==="upload_failed" && this.pendingFiles.has(localId)) || errorKind==="send_failed"`. **Never persist `canRetry`** on the IndexedDB row — it's map-presence-dependent, and rows survive reload while `pendingFiles` doesn't (a persisted flag would wrongly show Retry on a cold-boot bytes-gone row).
- **Acceptance:** no entry survives a terminal path; `logout()` **and a session switch** mid-upload abort the fetch and block post-await side effects; `inFlightUploads` bounded; `canRetry` recomputed in `refreshSelectedConversation` (not persisted) — cold-boot `upload_failed` → `false`, live → `true`, `send_failed` → `true`.

### T-2.4: kind-aware `reconcileOwnMessage` + conversation-list snippet
- [ ] In `src/journal/database.ts`, extend `reconcileOwnMessage` so a `file`/`image` echo matching by `payload.local_id` **and own-sender** clears its outbox row (today it early-returns unless `type==="text"` && `payload.body`). **Return the reconciled `localId` (or `null`)** so the caller can gate byte-cleanup on an actual own-row removal.
- [ ] **`pendingFiles` cleanup — ownership-gated, concrete site:** at `handleJournal()`'s `const removed = await this.database.reconcileOwnMessage(event)` (`client.ts:437`), `if (removed) this.pendingFiles.delete(removed)`. Gating on the **return value** (not on raw `event.payload.local_id`) prevents a foreign/malformed `file`/`image` event with a colliding `local_id` from deleting our still-needed retry bytes. No callback/observer plumbing.
- [ ] **`eventSnippet()` (`types.ts:182`) `file`/`image` branch:** add so the *live* conversation-list snippet shows the `filename` (📎/🖼) not `[file]`/`[image]`. **Known limitation (accepted):** the **snapshot path** (`replaceWithSnapshot`, `database.ts:89`) writes the server-computed snippet from `snippetOf()` (`journal.js:7`, no file/image branch) — which is server-side, **out of this client-only PR's scope**. So a fresh login / post-`snapshot_required` resync shows `[file]`/`[image]` until a new live event nudges the snippet. Filed as a `matron-journal` server follow-up; documented in T-5.5 alongside the other accepted limitations.
- **Acceptance:** a `file`/`image` echo with matching `local_id` **from own sender** removes the outbox row (no phantom "Sending…", no duplicate) and drops its `pendingFiles` entry via the returned id; a foreign event with a colliding `local_id` does **not** delete bytes; live snippet shows the filename (snapshot-path placeholder accepted + documented).

### T-2.5: durable outbox row deletion + `dismissAttachment(localId)`
- [ ] `JournalDatabase` today only upserts (`addToOutbox`, `database.ts:212`) and echo-deletes via `reconcileOwnMessage` — there is **no arbitrary row-removal primitive**. Add `deleteOutboxRow(localId): Promise<void>` (durable IndexedDB delete on the outbox store).
- [ ] Add `client.dismissAttachment(localId)`: `deleteOutboxRow(localId)` + `pendingFiles.delete(localId)` (bytes) + `refreshSelectedConversation` so the chip disappears; guard by owner tuple/`db?.`. This is the prerequisite T-4.3's Dismiss button wires to.
- **Acceptance:** `dismissAttachment` durably removes the error outbox row (not just from in-memory state — survives reload) and its retry bytes; the chip disappears; no orphaned row/bytes.

---

## Phase 3 — Recovery: reap / reconnect replay / retry

### T-3.1: boot-time reap of orphaned `uploading` rows
- [ ] In `src/journal/client.ts` `startSession()`, run the reap **synchronously within `startSession()` before `this.connection.start()`** (not inside `handleReady()`, which only fires later via the connection's `onReady` after `hello_ok`): sweep every IndexedDB outbox row with `attachState:"uploading"` → `error(upload_failed)` (Retry disabled — bytes gone — Dismiss available). Sound because `pendingFiles` is provably empty at cold boot.
- **Acceptance:** a persisted `uploading` row after reload becomes a dismissable error (never a permanent spinner); a live-session reconnect (row still has a live upload) is untouched by the reap.

### T-3.2: kind-aware reconnect replay (incl. `send_failed`)
- [ ] In `src/journal/client.ts` `handleReady()`/`sendPendingMessage()`: make replay kind-aware and `blobRef`-driven. **Any row with `blobRef` set — `sending` OR `error(send_failed)` — re-emits the media event** on reconnect (idempotent via `local_id`; the server dedupes). This is the automatic recovery path for `send_failed` (upload succeeded, socket was dead → now reconnected). `uploading` → leave untouched (never start a second upload — reload case already reaped in T-3.1); `error(upload_failed|too_large|empty)` → leave for explicit retry/dismiss; `text` → unchanged. Never emit a bodiless `type:"text"` for an attachment.
- **Acceptance:** assert no bodiless text send is ever emitted for an attachment; both `sending` and `send_failed` rows re-emit a media event on reconnect; no second upload is started for any row.

### T-3.3: `retryAttachment(localId)` — identity-preserving
- [ ] **Identity preservation (do not mint a new send):** retry must reuse the **original `localId`, `createdAt`, outbox row, and `convoId`** — not call `sendAttachment(file, convoId)` (which creates a *new* row/`localId`, leaving a phantom error chip + a duplicate and defeating `idem_key` idempotency). Factor the read→upload→send core of T-2.1 into a shared helper `uploadPendingAttachment(row, file, owner)` that operates **in place** on the existing row; both `sendAttachment` (fresh row) and `retryAttachment` (existing row) call it.
- [ ] `retryAttachment(localId)`:
  - `errorKind === "upload_failed"` + `File` in `pendingFiles` → transition the existing row back to `uploading` and run `uploadPendingAttachment` with the original `localId`/`convoId`; bytes gone (reload) → Retry disabled, Dismiss only.
  - `errorKind === "send_failed"` → **re-emit the media event using the retained `blobRef`** on the existing row (no re-upload — manual analogue of the T-3.2 reconnect path).
  - `too_large`/`empty` → never retryable.
- **Acceptance:** retry reuses the original `localId`/row (no duplicate row, no phantom chip); `upload_failed` with bytes re-uploads / bytes-gone dismiss-only; `send_failed` re-emits without re-upload and clears on echo; `too_large`/`empty` never expose Retry.

---

## Phase 4 — Composer UI

### T-4.1: enable attach button + file picker (with input reset)
- [ ] In `src/journal/components.tsx`, remove `aria-disabled` from the attach button; `onClick` opens a hidden `<input type="file" multiple>`; `onChange` → `client.attachFiles([...files])` **then set `input.value = ""`** (production, not just the test) so re-selecting the *same* file fires `onChange` again (browsers suppress a change event for an unchanged value). Leave the mic (voice) button disabled (out of scope).
- **Acceptance:** clicking the paperclip opens the OS picker; selecting files dispatches `attachFiles`; re-selecting the same file re-fires `attachFiles` (input reset); voice button stays disabled.

### T-4.2: drag-drop (with reset) + clipboard paste
- [ ] In `src/journal/components.tsx`, add `onDragOver`/`onDrop` on the conversation pane. **Both handlers MUST `preventDefault()`** — without it on `dragover` the pane isn't a valid drop target, and without it on `drop` the browser opens the file itself. **Only activate for file drags** (`dataTransfer.types` includes `"Files"`). `onDrop` → `preventDefault()` → `attachFiles([...dataTransfer.files])` + clear `dragActive`. Drive the `dragActive` overlay from `onDragOver`; reset on `onDragLeave`/`onDragEnd`/drop. **Guard `dragleave` against child-element transitions** (fires spuriously when moving over children — use a counter or `relatedTarget`-containment check so the overlay doesn't flicker). Add `onPaste` on the composer textarea → if `clipboardData.files` non-empty, `attachFiles` them.
- **Acceptance:** `dragover`/`drop` call `preventDefault`; only file drags activate the overlay; dropping uploads + clears the overlay; dragging over child elements doesn't flicker the overlay; dragging out clears it; pasting a screenshot uploads it.

### T-4.3: per-item chip (spinner / sending / inline tile / Retry+Dismiss)
- [ ] In `src/journal/components.tsx`, render the outbox attachment chip by `attachState`: `uploading` → spinner ("Uploading…"); **`sending` → a distinct chip ("Sending…") — must NOT fall through to the text-only pending renderer (`components.tsx:911`), which would show an empty/`body`-less bubble**; resolves to the existing inline `AuthenticatedMedia` image/file tile on echo; `error` → mapped `errorKind` message + **Retry** (rendered iff `message.canRetry`, from T-2.3; calls `retryAttachment`) + **Dismiss** (calls `client.dismissAttachment`, from T-2.5). Keep the composer-level `sendError` line for batch-level failures.
- **Acceptance:** all four states (`uploading`/`sending`/echo-tile/`error`) render distinctly; no attachment row renders as a text bubble; Retry shows only when `canRetry`; Dismiss (via `dismissAttachment`) durably removes the row and its `pendingFiles` bytes.

### T-4.4: CSS for overlay + attachment chip
- [ ] Add styles to `src/journal/journal.pcss` (and/or `shell.pcss`) in the existing `mx_`/`mj_` visual language: the drag drop-target overlay (`dragActive`), the attachment chip variants (uploading spinner, sending, error + Retry/Dismiss buttons), consistent with existing composer/message styling. This is net-new styling, not wiring an existing overlay.
- **Acceptance:** overlay + chips are visually styled matching the existing design language (not unstyled defaults); `pnpm build` compiles the `.pcss`.

---

## Phase 5 — Tests + verification

### T-5.1: transport + state-machine unit tests
- [ ] **Test-harness setup:** jsdom has `AbortController`/`Blob`/`File` but **no `fetch`** (`test/setup.cjs` only polyfills `structuredClone`) — add `global.fetch = jest.fn()` in the new `test/unit-tests/journal/api-test.ts` (no existing `api-test.ts` precedent; follow `client-test.ts` structure). Provide a `File`/`Blob` fixture for the read path.
- [ ] `api.uploadMedia`: raw body + correct `Content-Type`; parses `media_id`; **malformed 200 without `media_id` ⇒ rejects** (strict parse); server `too_large`/`empty` → prose; **`signal` reaches `fetch`** (mock records the `signal`; abort rejects); **Electron guard throws before any POST**. `sendAttachment`: uploading→sending→removed-on-echo; **send returns false ⇒ `error(send_failed)` blobRef retained**; **held (never-resolving) `arrayBuffer()` read** AND **never-settling `fetch`** both settle to `error(upload_failed)` at the deadline (the timer `controller.abort()` bounds the fetch) and the batch advances; `file.size` pre-check ⇒ `error(too_large)` without `File.arrayBuffer()`; `JournalApiError.code` preserved into `errorKind`.
- **Acceptance:** all pass under `pnpm test`; both the held-read and never-settling-fetch tests prove the deadline bounds the whole operation.
- **Contract note (media round-trip):** the upload→send→echo→dedup wire contract was code-verified during review (`journal/src/http.js` `/media`, `ws.js` `send` validation + `journal.js` `idem_key` dedup, `bridge-journal/lib/journal-input-router.js` `payload.name`). A CI integration test needs a live journal+bridge harness (out of scope for a client-only PR); end-to-end is validated against the running self-hosted journal (manual smoke). Strict response parsing (T-2.1) is the client-side guard against a contract drift.

### T-5.2: security + boundary tests
- [ ] **Session ownership (full):** `logout()` OR `startSession(B)` while an upload is held open ⇒ **no HTTP upload through the new session's `api`**, **no write to the new/closed `database`**, and **no WS `send`** after the `sessionGen` bump; both paths abort the in-flight controller. (Assert all three effect classes, not just "no WS send.") **Conversation boundary:** switching `selectedConversationId` mid-batch (first upload held) ⇒ later files send to the captured `convoId`. **`pendingFiles` cleanup:** entry removed on reconcile/dismiss/logout/startSession; none survives a terminal path.
- **Acceptance:** the cross-session-egress guard has a named passing test asserting no post-switch HTTP + no wrong/closed-DB write + no WS send; convo-boundary asserted; no map leak.

### T-5.3: recovery tests (incl. `send_failed` + rollback)
- [ ] **Reconcile:** own-sender `file`/`image` echo with matching `local_id` clears the outbox row + drops the `pendingFiles` entry (via the returned id); **a foreign event with a colliding `local_id` does NOT delete bytes**. **Reconnect replay:** both `sending` and **`send_failed`** re-emit a *media* event; `uploading` untouched; assert no bodiless text send for an attachment. **Boot-time reap:** persisted `uploading` → `error(upload_failed)` (reap runs before `connection.start()`). **Retry:** `upload_failed` re-uploads when bytes held / dismiss-only when gone; **`send_failed` re-emits without re-upload and clears on echo**; `too_large`/`empty` not retryable. **Retry identity:** retry reuses the original `localId`/outbox row (no duplicate row, no phantom chip). **Dismiss (T-2.5):** `dismissAttachment` durably deletes the row (survives reload) + bytes.
- **Acceptance:** all pass; foreign-collision doesn't nuke retry bytes; reload-wedge yields a dismissable error not a spinner; `send_failed` recoverable both automatically (reconnect) and manually (retry); retry preserves identity; dismiss durably removes the row.

### T-5.4: composer component tests (Phase 4)
- [ ] Component tests exercising every T-4 acceptance path: file-picker dispatches `attachFiles` + **hidden-input value reset** (so re-selecting the same file re-fires `onChange`); drop calls `preventDefault` + dispatches; overlay activates only on file drags and doesn't flicker over children; paste; the **`sending` chip renders (not a text bubble)**; Retry visible iff `canRetry`; Dismiss removes the row + bytes. (Without these, `pnpm test` can be green while the whole composer integration is unwired.)
- **Acceptance:** each T-4 behavior has a passing component test.

### T-5.5: batch isolation + full verification
- [ ] `attachFiles`: later files proceed after one errors; sequential. Document (test comment / assertion) the accepted limitations, not regressions: (a) absent-echo/`snapshot_required` stuck-`sending` and upload-orphan-on-timeout (shared with text/apple); (b) **conversation-list snippet on the snapshot path** shows `[file]`/`[image]` until a live event nudges it — server-side `snippetOf()` fix filed as a `matron-journal` follow-up; (c) **bundle rollback while an unsent attachment row exists** (T-1.4) — narrow deployment-window edge, no `DATABASE_VERSION` bump (a bump would wedge login on rollback). Run `pnpm lint`, `pnpm lint:types`, `pnpm test`, `pnpm build` — all green.
- **Acceptance:** clean lint/types/test/build; per-file isolation asserted; accepted limitations documented (not silently shipped).

---

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
