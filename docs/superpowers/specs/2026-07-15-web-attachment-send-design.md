---
title: Web attachment-send (matron-web ← apple parity)
date: 2026-07-15
status: draft
author: easelyte (Fantin) + Claude
repo: Matronhq/matron-web (via fork easelyte/matron-web)
approach: A (send-immediately, apple-parity)
rejected_alternatives:
  - "B (staging tray + caption): diverges from apple attachFiles(), adds pending-list state + review surface, wire sends separate events regardless — over-builds past the parity goal."
  - "C (file-picker only, no drag-drop/paste): trims surface but cuts the drag-drop the operator explicitly wanted."
related_principles:
  - fail-loud on upload/size errors (no silent drop)
  - match existing matron-web conventions (outbox pattern, mx_ CSS classes, JournalApi.request helper) for mergeability
non_goals:
  - Voice notes (separate PR; audio/* send + recorder UI)
  - viewer_url / live-terminal rendering (separate PR)
  - Session/device-management UI (separate PR)
  - Caption text bundled with attachment (wire sends separate text + media events; apple does not bundle)
---

# Web attachment-send — design

## Goal
Bring matron-web's composer to parity with matron-apple's `ComposerViewModel.attachFiles()`:
let a user attach files/images (picker + drag-drop + clipboard paste) that upload to the
journal and round-trip to the Claude session via the bridge. First PR of a web-parity effort
upstream (Dan) has agreed to merge.

## Why this is purely a client task (verified)
The wire protocol and server already support client media sends end to end:
- `POST /media` (Bearer, raw bytes as body, `Content-Type` = the file MIME) → `{ media_id, size, content_type, sha256 }` (`journal/src/http.js:264`).
- WS `send` with `type ∈ {text, file, image}`; for `file`/`image` the server requires a non-empty
  top-level `blob_ref` and an object `payload` (`journal/src/ws.js:388-405`). It persists
  `events.blob_ref` and fans out.
- The bridge consumes it: `journal-media.js` fetches the blob back out, saves it per-session, and
  injects it into the Claude turn (audio is transcribed). No bridge or server change needed.

Apple does exactly this: `attachFiles()` → per file, detect MIME → `sendImage`/`sendFile` →
`JournalAPI.uploadMedia(data, contentType)` → send a `file`/`image` event with `blob_ref = media_id`.

## Exact wire shapes this PR must emit
Upload (new):
```
POST {journal}/media   Authorization: Bearer <token>   Content-Type: <file mime>
body: raw bytes
→ 200 { media_id, size, content_type, sha256 }   (413 if > server cap; 50 MB default)
```
Send (extend existing `op:"send"`):
```
{ op: "send", convo_id, type: "image" | "file",
  blob_ref: <media_id>,                              // TOP-LEVEL — server validation + events.blob_ref column
  payload: { blob_ref: <media_id>, name, filename, content_type, size, local_id },
  local_id }                                          // idempotency: client:<deviceId>:<local_id>
```
`type` = `image` iff MIME starts with `image/`, else `file` — mirrors apple. The renderer already
handles both (`components.tsx` `image`/`file` cases via `AuthenticatedMedia`), so sent items render
inline once echoed.

**Field-name split — send BOTH `name` and `filename` (verified, load-bearing):**
- The **bridge inbound router** reads `payload.name` (`bridge journal-input-router.js:212`) to name the
  file it saves and hands Claude. Apple's outbound `sendMedia` (`WireModels.swift:350`) sends `name`.
  Sending `filename` alone hands Claude a **null filename** — the round-trip breaks silently.
- Both **renderers** (web `components.tsx:713`, apple `JournalTimelineMapper:76`) read
  `payload.filename` for display. Sending `name` alone renders the sent file as the "attachment"/"file"
  default (a latent inconsistency apple itself has for its own echoes).
- ∴ send **both** keys set to the same value: `name` satisfies the bridge (→ Claude), `filename`
  satisfies the renderers (correct display on echo). Cheap, backward-compatible, fixes display without
  a renderer change. `blob_ref` also duplicated top-level (validation/column) **and** in payload
  (fanout strips the top-level column via `journal.js` `toEventShape`; only `payload` survives to
  clients). No `caption` on send (display-only, optional).

## Attachment outbox state machine (canonical — the reconcile / replay / retry contract)
A `PendingMessage` for an attachment carries `kind: "image"|"file"`, `filename`, `size`, `contentType`,
`blobRef: string|null`, `attachState`, `errorKind?`. States and the *single* legal transition path:

```
uploading ──upload ok──▶ sending ──WS send returned true──▶ (await echo) ──echo reconcile──▶ removed
    │                        │
    │ upload fail/timeout    │ WS send returned false (dead socket)
    ▼                        ▼
  error(upload_failed,      error(send_failed, blobRef SET)
        blobRef null)
  error(too_large|empty)  ← pre-check, never uploaded
```

`blobRef` is the pivot for every downstream decision: **set** ⇒ the blob is confirmed on the server and
only the WS event is owed; **null** ⇒ no *confirmed* upload (see Known Limitations — an ambiguous
timeout can leave a blob stored server-side with `blobRef` still null; this is the same
no-upload-idempotency gap **apple** shares — the text path has no upload step, so it's exposed only to
apple and this client, accepted here). This single fact drives reconnect-replay and retry so they can't
diverge.

## Design (Approach A — send-immediately)

### 1. `api.ts` — `uploadMedia`, binary body, error mapping
`request()` today only marshals JSON bodies. Extend for a raw binary body:
- Add options `rawBody?: ArrayBuffer`, `contentType?: string`, and **`signal?: AbortSignal`**. When
  `rawBody` is set, send it as the `fetch` body with `Content-Type: contentType` (skip the JSON branch;
  do not set the JSON header). **`signal` must be passed to `fetch(..., { signal })`** so a caller-side
  timeout can actually abort the request (this is the wiring the upload timeout in §2 depends on — the
  signal has no effect unless `request()` forwards it).
- **Electron guard (explicit, fail-loud):** the desktop wrapper routes through `electron.journalRequest`,
  whose bridge marshals `body` as a *string* and cannot carry binary. So **before** the Electron branch:
  `if (electron && options.rawBody) throw new JournalApiError("Attachments aren't supported in the desktop build yet.", 0, "electron_binary_unsupported")`.
  The thrown `message` renders verbatim via `errorMessage()` (`client.ts:625`), so **no `messageForCode`
  case is added for this** (it would be dead code — `messageForCode` only fires on a server `{error}`
  body inside `request()`'s HTTP-error branch, which the guard-throw never reaches). This PR does **not**
  attempt binary through Electron — it's browser-`fetch`-only; desktop support is a separate
  `matron-desktop` bridge change (documented follow-up). Removes the earlier self-contradiction.
- `uploadMedia(bytes, contentType, signal) → { media_id, size, content_type }` via
  `request("/media", { method:"POST", rawBody:bytes, contentType, signal })`.
- **Error mapping (`messageForCode`):** add the two cases that DO fire (server-returned bodies), so
  failures render as prose not "HTTP 413": `too_large → "File too large."`, `empty → "That file is
  empty."` (server 413 body `{error:"too_large"}`, 400 body `{error:"empty"}`, verified `http.js:269,342`).

### 2. `client.ts` — `sendAttachment` / `attachFiles` + kind-aware outbox
**Conversation capture (egress boundary):** `attachFiles(files)` snapshots the current
`selectedConversationId` **once** at entry and passes it as an explicit `convoId` argument to every
`sendAttachment(file, convoId)` call (and stores it on the outbox entry). The text path already
snapshots `convoId` at `sendMessage` entry (`client.ts:293`); attachments MUST too, or a conversation
switch during a multi-file batch's `await` would route later files to the wrong conversation —
wrong-recipient data egress, not a cosmetic bug. `convoId` also travels into `retryAttachment`.

`sendAttachment(file, convoId)`:
1. `kind` = `image` iff `file.type` starts with `image/` else `file`. **`file.size` metadata pre-check
   (free — no read, no materialization):** if `file.size` exceeds `MEDIA_MAX_BYTES` (the known server
   default, 50 MB), skip straight to permanent `error(too_large)` **without** calling
   `File.arrayBuffer()`. This is a *memory-safety* gate, not a policy gate — it prevents a multi-GB
   selection from freezing the tab materializing bytes the server would only reject anyway; it reads free
   metadata, never enforces below the server. (The prior round removed a gate that *materialized then
   hardcoded*; `file.size` is the correct fix — bounded memory **and** the authoritative server 413 still
   governs anything under the ceiling. If a deployment configures a higher cap, bump the constant or
   expose the cap from the server — backlog.) `file.size === 0` → `error(empty)`.
2. **Capture the session generation** (`this.sessionGen`, an integer bumped on every `logout()`/
   `startSession()`) and register this operation's `AbortController` in an in-flight set. **Retain the
   `File` (not the ArrayBuffer)** in `pendingFiles: Map<localId, File>` — a `File` is a lightweight
   disk-backed handle (bytes read per-upload, not kept resident). Create outbox entry
   `attachState:"uploading"` with `convoId`, render optimistically.
3. **One deadline around read + upload** (a stalled `File.arrayBuffer()` must not wedge the sequential
   batch any more than a stalled fetch): `AbortController` + `setTimeout(abort, UPLOAD_TIMEOUT_MS)`;
   race the `File.arrayBuffer()` read against the signal, then `uploadMedia(bytes, contentType, signal)`
   (§1 forwards the signal to `fetch`). Resolves → `blobRef = media_id`, `attachState:"sending"`.
   Rejects/aborts/times-out → `error(upload_failed)` (see Known Limitations re: ambiguous timeout).
   Either way a terminal state is reached.
4. **Session-guard the egress, then send-then-branch.** The gen-check and the `send` must be **one
   synchronous unit — no `await` between them** (else a logout could slip into the microtask gap after
   the check but before the send). If `this.sessionGen !== capturedGen` (logout/relogin happened during
   the upload await), **abort — do not send** (drop the row; the blob, if any, is orphaned per Known
   Limitations). Otherwise:
   `const ok = connection?.send({ op:"send", convo_id: convoId, type: kind, blob_ref: media_id,
   payload:{ blob_ref: media_id, name: filename, filename, content_type, size, local_id }, local_id })`.
   `ok === true` → stay `sending`, await echo. `ok` falsy → `error(send_failed)`, `blobRef` retained.
5. Echo reconciles and removes the entry (reconcile below). On any terminal transition (steps 3–5),
   **deregister this operation's `AbortController` from the in-flight set** so the set stays bounded.

**Error-code preservation + retry classification:** map `JournalApiError.code` into `errorKind`. Only
`upload_failed` is **retryable** (transient). `too_large` and `empty` are **permanent** — the chip shows
the message with **Dismiss only, no Retry** (re-uploading identical bytes against the same cap
deterministically 413s again).

**`pendingFiles` lifecycle (bytes kept only where a retry could use them):** the `File` is retained
**only** while a row could re-upload — i.e. `error(upload_failed)` with the `File` still in memory.
Delete the entry on: (a) echo reconcile, (b) `attachState:"sending"`/`send_failed` (blobRef set ⇒ retry
re-emits the event, needs **no** bytes), (c) permanent `error(too_large|empty)`, (d) dismiss, (e)
`logout()` clears the whole map (mirrors `mediaUrls`, `client.ts:204`). This satisfies "no entry
survives a terminal path" and bounds memory in the long-lived PWA tab.

**`logout()` synchronously aborts every controller in the in-flight set** before returning (in addition
to bumping `sessionGen` and clearing `pendingFiles`). Without this, a straggler upload from the old
session could keep running past a same-tab relogin; the `sessionGen` guard already blocks its WS `send`
(so no cross-session *message* egress — that property holds regardless), but aborting also prevents its
late resolve/reject from racing the next `startSession()`'s boot-time reap on the same `localId` row.

**Boot-time reap (reload/crash recovery):** at `startSession()`, **before** `handleReady()` runs, sweep
every IndexedDB outbox row with `attachState:"uploading"` → `error(upload_failed)`. Sound because
`pendingFiles` is provably empty on a cold page load, so any persisted `uploading` row is orphaned (its
`File` and upload task died with the old JS context). Without this, a reload mid-upload leaves a
spinner-only row with no Retry/Dismiss — a permanent zombie (this is web-unique: text has no `uploading`
state and always resolves via idempotent replay; apple never persists an uploading row). Reaped rows get
the standard `error` chip (Retry disabled — bytes gone — Dismiss available).

`attachFiles(files)`: **sequential** loop, each `sendAttachment(file, convoId)` wrapped in try/catch
(per-file isolation). The per-file upload timeout means a stalled file cannot block the rest. (Chosen
over `Promise.all` — unbounded concurrent uploads on a large drop — and over naive serial-await, which a
hung upload would wedge without the timeout.)

**Kind-aware reconcile (`database.ts` `reconcileOwnMessage`):** today it early-returns unless
`event.type === "text"` && `payload.body` is a string (`database.ts:228`). Extend it to also clear an
outbox row when a `file`/`image` echo matches by `local_id` (the client sets `payload.local_id`; the
server's `idem_key = client:<deviceId>:<local_id>` guarantees the echo is ours). Without this, every
successful attachment leaves a permanent "Sending…" chip **and** a duplicate — the exact
`components.tsx:911` phantom the spec forbids.

**Kind-aware reconnect replay (`handleReady`/`sendPendingMessage`):** today `handleReady` blind-replays
every outbox row through the text-only `sendPendingMessage` (`client.ts:403,545`), which would emit a
bodiless `type:"text"` for an attachment → a stray empty bubble. Make replay `blobRef`-driven, and
**never re-drive an upload on reconnect** — the HTTP upload and the WS are independent connections, so a
WS reconnect is not proof the upload was lost; re-uploading would race the still-in-flight original and
orphan a blob:
- `attachState:"sending"` (blobRef set) → re-emit the **media** event (idempotent via `local_id`;
  server dedupes on `idem_key`). This is the attachment analogue of the text outbox replay.
- `attachState:"uploading"` → **leave untouched** on a *live-session* reconnect: the in-flight upload
  owns its own completion→send, and re-driving it would race the original (orphaning a blob). A
  *reloaded* session never reaches this branch with an `uploading` row, because the boot-time reap (§2)
  already demoted it to `error(upload_failed)` before `handleReady` runs. So: never start a second upload
  here, and never replay an attachment as text.
- `error` rows → leave for explicit retry; do not auto-replay.
- text rows → unchanged.

**`retryAttachment(localId)`** — Retry is offered **only** when `errorKind === "upload_failed"** (the one
transient class). `too_large`/`empty` are permanent (Dismiss-only). Within `upload_failed`:
- `blobRef` **set** — cannot occur for `upload_failed` (a set `blobRef` means the upload succeeded → the
  row is `send_failed`, whose "retry" is the WS re-emit handled by the reconnect/replay path, not
  `retryAttachment`; no bytes needed).
- `blobRef` **null** (`upload_failed`) → needs bytes: if the `File` is still in `pendingFiles`, re-run
  from step 3; if it was lost (page reload — `File` objects don't persist), Retry is **disabled** and the
  only action is **Dismiss**. This asymmetry is intentional and testable.

### 3. `components.tsx` — composer UI
- **Enable the attach button**: remove `aria-disabled`, `onClick` → hidden `<input type="file" multiple>`
  → `client.attachFiles(files)`.
- **Drag-drop**: `onDragOver`/`onDrop` on the conversation pane; add a `dragActive` boolean to
  `ClientState` (all other UI state in this client is schema-explicit) for the drop-overlay highlight.
  `onDrop` → `attachFiles([...dataTransfer.files])`. **Reset `dragActive` on `onDragLeave` and
  `onDragEnd`** (and on drop) so a drag that exits the window without dropping doesn't leave the overlay
  stuck highlighted.
- **Clipboard paste**: `onPaste` → if `clipboardData.files` non-empty, `attachFiles` them.
- **Per-item chip**: uploading → spinner; `error` → the mapped message + a **Retry** button (enabled per
  the `blobRef` rule above) and a **Dismiss** button; resolves to the inline image/file tile on echo.
- **Global error line**: keep the composer-level `sendError` for batch-level failures; per-item errors
  live on the chip.
- Mic (voice) button stays disabled — out of scope.

### 4. Sizes / errors
- **Two gates, non-overlapping in role.** (1) A **`file.size` metadata pre-check** (§2 step 1) is a
  *memory-safety* ceiling at `MEDIA_MAX_BYTES` (the 50 MB default) — it reads free metadata and refuses
  to `File.arrayBuffer()`-materialize an obviously-oversize selection that would freeze the tab. (2) The
  **server 413** is the *policy authority* for anything under that ceiling. The pre-check never enforces
  *below* the server and never reads bytes, so it isn't a canonical-source duplication — it only prevents
  a browser-memory blowup the server couldn't have prevented anyway. Both paths land the same permanent
  `error(too_large)` + mapped "File too large." message. (If a deployment sets a cap above the default,
  bump the constant or have the server expose its cap — backlog.)
- Empty (`file.size === 0`) → `error(empty)`; the server also rejects with `400 empty` as a backstop.

## Known limitations (accepted — not uniquely solvable here; out of scope)
Both reviewers verified these against code. Solving them uniquely for attachments would diverge from the
client's model and hurt mergeability. The real fixes (a `local_id`-reconciliation pass over the
post-`snapshot_required` state; server-side upload idempotency) are **separate, shared improvements**
noted for the backlog.
1. **Ambiguous upload timeout may orphan a blob** *(shared with apple, NOT text — text has no upload
   step)*. `POST /media` has no client idempotency key and returns a fresh `media_id` each call. If the
   server commits the blob but the response is lost past `UPLOAD_TIMEOUT_MS`, the row goes
   `error(upload_failed)` (`blobRef` null) and a retry uploads again — the first blob is orphaned. Apple
   (`JournalAPI.swift:167`) has the identical exposure. Orphans are unreferenced (no event points at
   them) and subject to the server's media retention/offload; no conversation-level incorrectness.
2. **An optimistic row can stay `sending` when the echo never arrives** *(shared with the text path —
   verified type-agnostic in `database.ts:89`)*. Two sub-cases, same root cause and same shared fix:
   (a) **Long-gap reconnect (`snapshot_required`):** if the gap exceeds the server's `maxReplay`, the
   client re-snapshots but `replaceWithSnapshot` doesn't reconcile outbox rows against already-persisted
   events and the idempotent replay returns `duplicate:true` with no re-fan — a row whose echo landed
   inside the gap stays `sending`. (b) **Absent echo without reconnect:** `connection.send()` returning
   `true` is only local socket acceptance, not a server persistence ack; if the server drops/rejects the
   event with the socket still open, no echo arrives and there is no send-side watchdog. **Both apply to
   text outbox rows identically today, and apple has no echo watchdog either** — so this PR deliberately
   does **not** add a web-unique watchdog (it would diverge from the parity target). The correct fix is
   the shared `local_id`-reconciliation pass over persisted events (recover any `sending` row whose event
   already exists), applied to text and attachments alike — **filed for the backlog**, out of scope here.
   Recovery today is a manual resend, same as text. *(This finding was raised across review rounds and is
   accepted as a documented shared limitation, not a defect this PR introduces.)*

## Edge cases
- Upload ok, WS send returns false (reconnect window) → `error(send_failed)`, blobRef retained; Retry
  re-emits the event without re-upload.
- Upload stalls → aborted at `UPLOAD_TIMEOUT_MS` → `error(upload_failed)`; batch continues.
- Reconnect mid-batch → per state-machine replay above; attachments are never replayed as text (they
  either re-emit a media event or are left for their live upload / retry — see Known Limitations for the
  `snapshot_required` corner shared with text).
- Conversation switch during a multi-file batch → later files still go to the captured `convoId`.
- Mixed batch, one oversize → that file `error`, others proceed.
- Page reload with a `blobRef:null` error row → Retry disabled, Dismiss only (bytes gone).
- Desktop/Electron → `uploadMedia` throws `electron_binary_unsupported` (clear message), no empty POST.
- Large image dims: no client downscale this PR (apple sends originals too).

## Testing (jest — `pnpm test`)
- `api.uploadMedia`: raw body + correct `Content-Type`; parses `media_id`; server `too_large`/`empty`
  map to prose; **the passed `signal` reaches `fetch` (abort actually cancels)**; **Electron guard
  throws before any POST** (assert no fetch/journalRequest fires when `electron && rawBody`).
- `sendAttachment` state machine: uploading→sending→removed on echo; **send returns false ⇒
  `error(send_failed)` with blobRef retained** (not "sent"); upload timeout ⇒ `error(upload_failed)`,
  no stuck spinner; pre-check rejects without uploading; **`JournalApiError.code` is preserved into
  `errorKind`** (a server `too_large` isn't collapsed to `upload_failed`).
- **Session ownership (security)**: `logout()`/relogin while an upload is held open ⇒ the post-await
  `send` is dropped (`sessionGen` guard) — assert **no WS `send` is emitted** after the gen bump; and
  `logout()` aborts the in-flight controller. This is the cross-session-egress guard; it must have a
  named test.
- **Conversation boundary**: switching `selectedConversationId` mid-batch (first upload held open) →
  later files still send to the captured `convoId`, never the new selection.
- **`pendingFiles` cleanup**: entry removed on echo reconcile, on dismiss, and on `logout()`; no entry
  survives a terminal path.
- **Reconcile**: a `file`/`image` echo with matching `local_id` clears the outbox row (no phantom, no
  duplicate).
- **Reconnect replay**: `sending` row re-emits a *media* event (not text); `uploading` row is **left
  untouched** (no second upload started); text rows unchanged — assert no bodiless text send is ever
  emitted for an attachment.
- **Retry classification**: `upload_failed` re-uploads when bytes held, disabled (dismiss-only) when bytes
  gone; `too_large`/`empty` are **never retryable** (Dismiss-only chip, Retry not offered); the
  `file.size` pre-check yields permanent `error(too_large)` **without** calling `File.arrayBuffer()`.
- `attachFiles`: later files proceed after one file errors (per-file isolation); sequential. Note:
  apple's `ComposerViewModelTests` asserts single-file dispatch; per-file isolation is apple *code*
  behavior (`ComposerViewModel.swift:369` per-URL do/catch), not a named apple test.

## Files touched
- `src/journal/api.ts` — `uploadMedia`, binary body + `signal` in `request()`, Electron guard,
  `messageForCode` `too_large`/`empty` cases
- `src/journal/client.ts` — `sendAttachment`/`attachFiles` (convo capture, one deadline over read+upload,
  send-then-branch), `pendingFiles` map + lifecycle, `sessionGen` + in-flight `AbortController` set +
  logout-abort + session-guard, boot-time `uploading`-row reap, kind-aware reconnect replay,
  `retryAttachment` (upload_failed only)
- `src/journal/database.ts` — kind-aware `reconcileOwnMessage`
- `src/journal/components.tsx` — enable button, drag-drop + `dragActive` (with `onDragLeave`/`onDragEnd`
  reset), paste, per-item Retry/Dismiss chip
- `src/journal/types.ts` — `PendingMessage` attachment fields (`kind`, `filename`, `size`, `contentType`,
  `blobRef`, `convoId`, `attachState`, `errorKind`) + `dragActive` on `ClientState`
- tests under `test/`

## Mergeability
Follows matron-web's existing patterns (outbox optimistic send, `JournalApi.request`, `mx_`/`mj_` CSS
classes) and mirrors apple's `attachFiles` semantics so upstream review is a pattern-match, not a
re-architecture. One PR, attachments only; voice + viewer_url + session UI follow as separate PRs.
