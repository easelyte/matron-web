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

## Spec-coverage map (every spec part → task)
- api.ts (uploadMedia/binary/signal/Electron guard/messageForCode) → T-1.2, T-1.3
- types.ts (PendingMessage fields, attachState/errorKind, dragActive) → T-1.1
- sendAttachment/attachFiles (convo capture, file.size gate, deadline, send-then-branch, error-code) → T-2.1, T-2.2
- pendingFiles map + lifecycle + logout-abort + sessionGen/session-guard → T-2.3
- database.ts kind-aware reconcile → T-2.4
- boot-time reap → T-3.1
- kind-aware reconnect replay → T-3.2
- retryAttachment (upload_failed only) → T-3.3
- composer UI (button/input/drag-drop+reset/paste/per-item chip/error line) → T-4.1, T-4.2, T-4.3
- Testing section (all bullets) → T-5.1..T-5.4
- Known limitations (documented, no code) → covered by omission; asserted in T-5.4 as accepted

---

## Phase 1 — Types + transport foundation

### T-1.1: `PendingMessage` + `ClientState` attachment types
- [ ] In `src/journal/types.ts`, extend `PendingMessage` with optional attachment fields: `kind?: "text" | "image" | "file"`, `filename?: string`, `size?: number`, `contentType?: string`, `blobRef?: string | null`, `convoId: string` (already implied by outbox; confirm present), `attachState?: "uploading" | "sending" | "error"`, `errorKind?: "upload_failed" | "too_large" | "empty"`. Add `dragActive: boolean` to `ClientState`.
- Backward-compat: text rows have `kind` absent/`"text"` and none of the attachment fields; all new fields optional.
- **Acceptance:** `pnpm lint:types` clean; existing text-send types unchanged; a `PendingMessage` can represent each state in the spec's state machine (`uploading`, `sending`, `error(upload_failed|too_large|empty)`).

### T-1.2: `request()` binary body + `AbortSignal`
- [ ] In `src/journal/api.ts`, extend `request()` options with `rawBody?: ArrayBuffer`, `contentType?: string`, `signal?: AbortSignal`. When `rawBody` set: send it as the `fetch` body with `Content-Type: contentType` (skip JSON branch / JSON header). Pass `signal` to `fetch(..., { signal })`. Electron guard: **before** the Electron branch, `if (electron && options.rawBody) throw new JournalApiError("Attachments aren't supported in the desktop build yet.", 0, "electron_binary_unsupported")`.
- **Acceptance:** a raw-body request sends bytes verbatim with the given content-type and forwards `signal`; aborting the controller rejects the in-flight fetch; with the Electron bridge present + `rawBody`, it throws before any request fires.

### T-1.3: `uploadMedia` + error-code mapping
- [ ] In `src/journal/api.ts`, add `uploadMedia(bytes: ArrayBuffer, contentType: string, signal?: AbortSignal): Promise<{ media_id: string; size: number; content_type: string }>` → `request("/media", { method:"POST", rawBody:bytes, contentType, signal })`, parse JSON. Add `messageForCode` cases: `too_large → "File too large."`, `empty → "That file is empty."`. Do **not** add an `electron_binary_unsupported` case (guard throws the message verbatim; `messageForCode` only fires on server `{error}` bodies).
- **Acceptance:** returns `media_id` on 200; a server 413 `{error:"too_large"}` surfaces "File too large." (not "HTTP 413"); 400 `{error:"empty"}` surfaces "That file is empty."

---

## Phase 2 — Send path + reconcile

### T-2.1: `sendAttachment(file, convoId)` — pre-check, upload, send-then-branch
- [ ] In `src/journal/client.ts`, add `sendAttachment(file: File, convoId: string)`: derive `kind` from `file.type`; **`file.size` metadata pre-check** against `MEDIA_MAX_BYTES` (50 MB const) → `error(too_large)` **without** `File.arrayBuffer()`; `file.size === 0` → `error(empty)`. Create outbox entry `attachState:"uploading"` with `convoId`, optimistic render. One `AbortController` + `setTimeout(abort, UPLOAD_TIMEOUT_MS)` wrapping **both** `File.arrayBuffer()` read and `uploadMedia(bytes, contentType, signal)`. Resolve → `blobRef=media_id`, `attachState:"sending"`. Reject/abort/timeout → `error(upload_failed)`.
- **Send-then-branch with session-guard (one synchronous unit, no `await` between check and send):** if `sessionGen` changed during the await, drop the row (no send). Else `const ok = connection?.send({ op:"send", convo_id: convoId, type: kind, blob_ref: media_id, payload:{ blob_ref: media_id, name: filename, filename, content_type, size, local_id }, local_id })`; `ok===true` → stay `sending`; falsy → `error(send_failed)` (blobRef retained). Map `JournalApiError.code` → `errorKind`.
- **Acceptance:** wire shape matches spec (top-level + payload `blob_ref`; both `name` and `filename`); oversize file never calls `File.arrayBuffer()`; `ok` falsy leaves `error(send_failed)` with blobRef set (not `"sent"`); server `too_large` preserved into `errorKind` (not collapsed to `upload_failed`).

### T-2.2: `attachFiles(files)` — capture convo, sequential, per-file isolation
- [ ] In `src/journal/client.ts`, add `attachFiles(files: File[])`: snapshot `selectedConversationId` **once**; loop `sendAttachment(file, convoId)` **sequentially**, each in try/catch (one file's error doesn't block the rest). Wire from `components.tsx` (Phase 4).
- **Acceptance:** switching conversation mid-batch routes later files to the captured `convoId`; one file erroring lets the rest proceed; one buffer resident at a time.

### T-2.3: `pendingFiles` map, lifecycle cleanup, `sessionGen` + logout ownership
- [ ] In `src/journal/client.ts`: `pendingFiles: Map<string, File>` (localId → File). Register each op's `AbortController` in an in-flight `Set`; deregister on any terminal transition. Add `sessionGen` integer bumped on every `logout()`/`startSession()`. **`logout()`** synchronously `.abort()`s every controller in the in-flight set, clears `pendingFiles`, bumps `sessionGen`. Cleanup `pendingFiles` entry on: echo reconcile, `sending`/`send_failed`, permanent `error(too_large|empty)`, dismiss, logout. Keep the `File` **only** for retryable `error(upload_failed)`.
- **Acceptance:** no entry survives a terminal path; `logout()` mid-upload aborts the fetch and blocks any post-await send; the in-flight set is bounded (deregistration verified).

### T-2.4: kind-aware `reconcileOwnMessage`
- [ ] In `src/journal/database.ts`, extend `reconcileOwnMessage` so a `file`/`image` echo matching by `payload.local_id` clears its outbox row (today it early-returns unless `type==="text"` && `payload.body`). Delete the paired `pendingFiles` entry (via a client callback or by having the client observe reconcile).
- **Acceptance:** a `file`/`image` echo with matching `local_id` removes the outbox row — no permanent "Sending…" chip, no duplicate alongside the rendered inline tile.

---

## Phase 3 — Recovery: reap / reconnect replay / retry

### T-3.1: boot-time reap of orphaned `uploading` rows
- [ ] In `src/journal/client.ts` `startSession()`, **before** `handleReady()` runs, sweep every IndexedDB outbox row with `attachState:"uploading"` → `error(upload_failed)` (Retry disabled — bytes gone — Dismiss available). Sound because `pendingFiles` is provably empty at cold boot.
- **Acceptance:** a persisted `uploading` row after reload becomes a dismissable error (never a permanent spinner); a live-session reconnect (row still has a live upload) is untouched by the reap.

### T-3.2: kind-aware reconnect replay
- [ ] In `src/journal/client.ts` `handleReady()`/`sendPendingMessage()`: make replay kind-aware. `sending` (blobRef set) → re-emit the **media** event (idempotent via `local_id`); `uploading` → leave untouched (never start a second upload — reload case already reaped in T-3.1); `error` → leave for explicit retry; `text` → unchanged. Never emit a bodiless `type:"text"` for an attachment.
- **Acceptance:** assert no bodiless text send is ever emitted for an attachment; `sending` rows re-emit a media event on reconnect; no second upload is started for any row.

### T-3.3: `retryAttachment(localId)` — upload_failed only
- [ ] In `src/journal/client.ts`, add `retryAttachment(localId)`: offered **only** when `errorKind === "upload_failed"`. If the `File` is in `pendingFiles` → re-run T-2.1 from the read step (with the captured `convoId`); if gone (reload) → Retry disabled, Dismiss only. `too_large`/`empty` never retryable.
- **Acceptance:** `upload_failed` with bytes held re-uploads; bytes gone → dismiss-only; `too_large`/`empty` never expose Retry.

---

## Phase 4 — Composer UI

### T-4.1: enable attach button + file picker
- [ ] In `src/journal/components.tsx`, remove `aria-disabled` from the attach button; `onClick` opens a hidden `<input type="file" multiple>`; `onChange` → `client.attachFiles([...files])`. Leave the mic (voice) button disabled (out of scope).
- **Acceptance:** clicking the paperclip opens the OS picker; selecting files dispatches `attachFiles`; voice button stays disabled.

### T-4.2: drag-drop (with reset) + clipboard paste
- [ ] In `src/journal/components.tsx`, add `onDragOver`/`onDrop` on the conversation pane driving the `dragActive` overlay; `onDrop` → `attachFiles([...dataTransfer.files])`. **Reset `dragActive` on `onDragLeave` and `onDragEnd`** (and on drop). Add `onPaste` on the composer textarea → if `clipboardData.files` non-empty, `attachFiles` them.
- **Acceptance:** dragging a file over the pane highlights the overlay; dropping uploads it; dragging out without dropping clears the overlay; pasting a screenshot uploads it.

### T-4.3: per-item chip (spinner / inline tile / Retry+Dismiss) + error line
- [ ] In `src/journal/components.tsx`, render the outbox attachment chip by `attachState`: `uploading` → spinner; resolves to the existing inline `AuthenticatedMedia` image/file tile on echo; `error` → mapped message + **Retry** (enabled only when `errorKind==="upload_failed"` and bytes held) + **Dismiss**. Keep the composer-level `sendError` line for batch-level failures.
- **Acceptance:** each state renders correctly; Retry is absent for `too_large`/`empty`; Dismiss removes the row and its `pendingFiles` bytes.

---

## Phase 5 — Tests + verification

### T-5.1: transport + state-machine unit tests
- [ ] `api.uploadMedia`: raw body + correct `Content-Type`; parses `media_id`; server `too_large`/`empty` → prose; **`signal` reaches `fetch`** (abort cancels); **Electron guard throws before any POST**. `sendAttachment`: uploading→sending→removed-on-echo; **send returns false ⇒ `error(send_failed)` blobRef retained**; upload timeout ⇒ `error(upload_failed)` no stuck spinner; `file.size` pre-check ⇒ `error(too_large)` without `File.arrayBuffer()`; `JournalApiError.code` preserved into `errorKind`.
- **Acceptance:** all pass under `pnpm test`.

### T-5.2: security + boundary tests
- [ ] **Session ownership:** `logout()`/relogin while an upload is held open ⇒ **no WS `send` emitted** after the `sessionGen` bump, and `logout()` aborts the controller. **Conversation boundary:** switching `selectedConversationId` mid-batch (first upload held) ⇒ later files send to the captured `convoId`. **`pendingFiles` cleanup:** entry removed on reconcile/dismiss/logout; none survives a terminal path.
- **Acceptance:** the cross-session-egress guard has a named passing test; convo-boundary asserted; no map leak.

### T-5.3: recovery tests
- [ ] **Reconcile:** `file`/`image` echo with matching `local_id` clears the outbox row. **Reconnect replay:** `sending` re-emits a *media* event; `uploading` untouched; assert no bodiless text send for an attachment. **Boot-time reap:** persisted `uploading` → `error(upload_failed)` before `handleReady`. **Retry:** `upload_failed` re-uploads when bytes held / dismiss-only when gone; `too_large`/`empty` not retryable.
- **Acceptance:** all pass; the reload-wedge scenario yields a dismissable error, not a spinner.

### T-5.4: batch isolation + full verification
- [ ] `attachFiles`: later files proceed after one errors; sequential. Document (test comment / assertion) that the absent-echo/`snapshot_required` and upload-orphan-on-timeout limitations are accepted (shared with text/apple), not regressions. Run `pnpm lint`, `pnpm lint:types`, `pnpm test`, `pnpm build` — all green.
- **Acceptance:** clean lint/types/test/build; per-file isolation asserted.

---

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
