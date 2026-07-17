---
title: Upload confirmation modal with caption (file + caption as one message)
date: 2026-07-17
status: draft
revision: 4
review_rounds: 3
author: claude (brainstorm-slim)
target_repo: easelyte/matron-web (journal client), PR base main
related_repos:
  - easelyte/claude-matrix-bridge @ journal-deploy (consumer — folds caption into the media blocks Claude sees)
approach: B — end-to-end caption (web modal + bridge consumer)
rejected_alternatives:
  - "A (web-only): caption stored + rendered in the timeline but never reaches Claude — guts the primary use (caption = instruction about the file). Saves only a ~3-file bridge PR."
  - "C (B + gallery modal, image downscaling/EXIF strip, composer-text prefill): no asked-for gain; multi-file uses sequential per-file paging instead."
related_specs:
  - 2026-07-15-web-attachment-send-design.md (PR #1 — the send pipeline this extends; its rejected option B 'staging tray + caption' is this feature, now deliberately in scope)
  - son-of-anton docs/superpowers/specs/2026-07-11-matron-web-send-media-captions-design.md (Matrix-era caption spec, loop #445 — UX decisions carried over: trim→omit, 4096 cap, caption autofocus, IME-safe Enter)
---

# Upload confirmation modal with caption — design

## Problem

Today, picking / dragging / pasting a file into the matron-web journal client
sends it immediately as a bare attachment: `attachFiles()` → `sendAttachment()`
→ a pending chip row, no confirmation, no way to say what the file is *for*.
The operator's actual workflow is "here's a screenshot, and here's what I want
you to do with it" — which currently takes two messages (file, then text) and
reaches Claude as two separate inputs.

## Goal

When the user picks, drags, or pastes a file, show a **confirmation modal** with
a **preview** (image thumbnail, or icon + name + size for other files) and a
**caption text field**. On Send, the file and the typed caption ship as **one
journal event** (one timeline bubble), and the bridge delivers file + caption to
Claude in **one turn** — in both bridge session modes (see Part 2).

### Non-goals (v1)

- **Multi-file gallery modal.** Multiple files page through the modal one at a
  time (Element `UploadConfirmDialog` precedent), each with its own caption.
- **Rich-text / markdown captions.** Plain text only.
- **Image downscaling / EXIF stripping.** Bytes upload as-is (unchanged).
- **Apple-client send parity.** The apple journal client renders `payload.caption`
  on images already; authoring a caption there is a separate (Swift) effort.
- **Electron desktop attachments.** Still unsupported upstream
  (`electron_binary_unsupported`); the modal shows, send fails into the existing
  error chip exactly as today.
- **Upstream PR to Matronhq.** This ships to the easelyte fork's `main` (the
  deployed client). Upstreaming is a separate operator decision.
- **Voice notes.** No web recording UI exists; bridge transcription path untouched.
- **Resumable uploads across refresh.** A refresh that interrupts an in-flight
  upload still loses the `File` bytes (PR #1 known limitation, unchanged — see
  Edge cases).

## Verified grounding (2026-07-17, re-verified after review round 1)

- **Wire format already half-exists.** The web renderer displays
  `payload.caption` on images (`components.tsx` `EventContent` case `"image"` →
  `AuthenticatedMedia caption=` → `<figcaption>`). The `file` tile does not
  render a caption yet (gap closed by this spec).
- **Journal server needs zero change.** The `send` op passes `msg.payload`
  through opaquely (`/opt/matron/journal/src/ws.js` ~388–402: validates
  `payload` is an object and `blob_ref` present for media, stores payload as-is).
- **Bridge has caption plumbing in ONE of two branches.** In
  `/opt/matron/bridge-journal` (repo `easelyte/claude-matrix-bridge`, branch
  `journal-deploy`), `buildSavedMediaBlocks` (`index.js` ~4365) returns
  `{ blocks, ivHandled }` and folds `ivCaption` into the annotation **only in
  the `session.iv` branch** (via `ivUploadAnnotation`, `lib/iv-uploads.js`).
  The non-iv (SDK) image/file branches never reference caption; the Matrix-era
  caller that tail-appended the caption for SDK mode was removed with the
  Matrix code on `journal-deploy`. The **live deployment default is non-iv**
  (`MATRON_INTERACTIVE_MODE=0` in `.env`), so the journal wiring must do the
  SDK-mode tail-append itself (Part 2 §3) — passing `ivCaption` alone would be
  inert in the deployed configuration.
- **The web client has TWO attachment payload builders.**
  `emitPendingAttachment` (`client.ts` ~575, normal send + retry) and
  `sendPendingMessage` (`client.ts` ~1047, reconnect-replay from `handleReady`
  for outbox rows with `blobRef` set) construct the same payload literal
  independently. Both must carry the caption (Part 1 unifies them).
- **PR #1 pipeline is the substrate.** `sendAttachment(file, convoId)` in
  `client.ts` owns validation (512MB browser cap / empty), the outbox
  `PendingMessage`, upload (`api.uploadMedia`), and the WS `send` emit. This
  spec threads one optional field through it.

## Part 1 — matron-web (primary PR)

### Wire shape

The attachment `send` payload gains one optional key:

```
payload: {
  blob_ref, name, filename, content_type, size, local_id,
  caption: "<trimmed caption>"     // ONLY when non-empty after trim
}
```

No `caption` key when the field was left empty — a no-caption send is
byte-identical to today's. Trim → omit is decided **once on the web side**, in
the modal confirm handler (authoritative owner); web code downstream of the
modal never re-interprets whitespace. (The bridge additionally re-trims and
clamps at its own input boundary — boundary hygiene per P8, not distrust of
this contract; see Part 2 §1.)

**Single payload builder.** Extract a private
`attachmentPayload(message: PendingMessage)` helper in `client.ts` returning the
payload object above (caption included when `message.caption` is set), and use
it from **both** emit sites: `emitPendingAttachment` and `sendPendingMessage`
(reconnect-replay). This removes the existing duplicated payload literal
(canonical-source) and guarantees the caption survives every path that re-sends
an outbox row.

### Staging state (`types.ts`, `client.ts`)

Entry points stop calling `attachFiles()` directly and instead stage:

- `ClientState` gains
  `stagedUploads?: { convoId: string; items: Array<{ id: string; file: File }>; total: number }`.
  - `id` = `crypto.randomUUID()` assigned at stage time — the **stable page
    identity** used as the modal body's React `key` and as the argument to
    confirm/skip (P5: key on item identity, not on a shifting array index).
  - `total` = cumulative count of files ever staged into this queue
    (paste-append increments it); the header shows "File k of N" with
    `k = total - items.length + 1`, `N = total`.
  - In-memory only (`File` objects are not serializable — never persisted to
    IndexedDB). A refresh mid-modal discards staging; nothing was uploaded yet,
    so nothing is lost or orphaned.
- `client.stageFiles(files: File[]): void` — no-op when no conversation is
  selected (same guard as today's `attachFiles`). Captures
  `selectedConversationId` at stage time. If a staging queue is already open,
  **appends** items (with fresh ids, incrementing `total`) — reachable only
  from the modal's own paste handler plus the structurally guarded entry
  points (see Modal UI); there is no different-convo replace branch.
- `client.confirmStagedFile(itemId: string, caption?: string): Promise<void>` —
  1. **Head guard (P23):** no-op unless `itemId` equals the current head
     item's id — a double-click or stale Enter cannot consume the next page
     with the previous page's caption.
  2. **Confirm-time check (P19, first of two):** re-check the staged `convoId`
     at this boundary — it must still exist in `state.conversations` and not
     be in `state.archivedIds`. If invalidated (cross-tab archive — see Edge
     cases), do NOT proceed: discard the queue and swap the modal to a visible
     error notice (fail visible).
  3. **Persist-then-advance (P3):** synchronously create and persist the
     `PendingMessage` outbox row (`attachState: "uploading"`, caption
     included) and **await that persist** before popping the head and
     advancing the modal — one IndexedDB put, imperceptible. This requires
     splitting today's `sendAttachment` into its two existing phases:
     **(a) persist** (build the `PendingMessage`, run the size/empty guards,
     `persistAttachment`) and **(b) upload+emit**
     (`uploadPendingAttachment` → `emitPendingAttachment`). `attachFiles`
     keeps its current behavior by calling both phases in sequence. The
     payoff: **every confirmed file has a persisted row from the moment the
     modal advances** — a refresh at any later point leaves error-chip
     evidence (the existing `startSession` uploading→`upload_failed`
     conversion) instead of silently vanishing a confirmed file whose upload
     had not yet started.
  4. **Deferred upload on the serialized send chain, with execution-time
     guards:** enqueue phase (b) on an internal chain so uploads run **one at
     a time in confirm order** (the serialization today's `attachFiles` loop
     provides via sequential `await`: wire order preserved, at most one
     upload buffer in memory) while captioning of file 2 proceeds during
     file 1's upload. The enqueued thunk **captures the owner tuple at
     confirm time** (`gen = sessionGen`, `db`, `api` — the existing
     `ownsAttachment` pattern) and, when it finally executes, re-checks:
     - **Session guard:** abort if `sessionGen` changed (mirrors
       `attachFiles`' `if (this.sessionGen !== gen) break` — a chain
       continuation must never upload/send under a different login; the
       persisted row simply surfaces as an error chip on the original
       session's next login via the existing resume conversion).
     - **Convo re-validation (P19, second of two):** the archived/absent
       check runs again HERE, at the act, not only at confirm — the gap
       between enqueue and execution is unbounded for items queued behind a
       slow upload. If the conversation was archived/removed in the gap, do
       not upload: mark the persisted row `attachState: "error"`,
       `errorKind: "send_failed"`, `canRetry: true` (fail visible; retry
       works after unarchiving).
     Upload progress/errors surface through the existing pending-chip
     machinery (`PendingAttachment` rows in the timeline).
- `client.skipStagedFile(itemId: string): void` — same head guard; pops the
  head without sending (modal Cancel / Escape), advances; clears when empty.
- `client.cancelStagedFiles(): void` — clears the whole queue ("Cancel all").
  Already-confirmed items are NOT affected (their rows are persisted and their
  uploads queued); cancel only discards not-yet-confirmed pages.
- `startSession()` clears `stagedUploads` and resets the send-chain pointer
  (session teardown already clears the sibling attachment maps). Continuations
  already attached to the old chain self-abort via the session guard above.

`attachFiles(files)` remains as the internal batch path but is no longer wired
to UI events (kept for tests / future callers, now delegating per-file with no
caption).

### `sendAttachment(file, convoId, caption?)` (`client.ts`)

- `PendingMessage` (`types.ts`) gains `caption?: string`. It rides the outbox
  row, so it persists across refresh and flows through retry / reconcile /
  reconnect-replay with zero extra handling (the outbox row is re-serialized
  whole by `persistAttachment`, and both emit sites use `attachmentPayload`).
- `sendAttachment` stores `caption` (already-trimmed, or absent) on the
  `PendingMessage`, and is **refactored into its two existing phases** —
  persist (build + guards + `persistAttachment`) and upload+emit — so the
  modal's persist-then-advance contract can await the first and defer the
  second (Staging state §3-4). `attachFiles` calls both in sequence, exactly
  today's behavior. The attachment **state machine itself is unchanged** —
  states, error kinds, retry, dismiss, reconcile all as in PR #1.
- `matchesOwnPendingMessage` (`database.ts`) matches by `local_id` — unchanged.

### Modal UI (`components.tsx`, `journal.pcss`) — new `UploadConfirmDialog`

New component rendered by `SignedInApp` **at the top level of the signed-in
tree, as a full-viewport overlay covering the conversation list AND the room
view** whenever `state.stagedUploads` is non-empty. The app has no dialog
primitive; new `mj_UploadConfirm*` classes, visual style echoing the auth-modal
panel look with a full-screen scrim.

**App-modal semantics (deliberate, resolves round-1 B2/M3):** while the modal
is open, everything beneath it is inert — no conversation switching, no
composer text send, no second staging entry point. This makes
`aria-modal="true"` truthful, guarantees the staged `convoId` cannot go stale,
and reduces `stagedUploads` to a single append-only queue. The cost (left panel
blocked for the seconds a caption takes) is nil in the operator's workflow.

- **Preview:** for `file.type.startsWith("image/")`, an `<img>` from
  `URL.createObjectURL(file)`, object-fit contain, max height ~50vh; object URL
  revoked on advance/close (effect cleanup). For other files: attachment icon +
  filename + `formatBytes(size)`.
- **Per-file remount (P5/P31):** the modal body (preview + caption field) is
  rendered with `key` = the head **item's `id`** (stable identity assigned at
  stage time — a popped-array index would collapse to `0` for every head and
  defeat the remount), so advancing to the next file **remounts** the body:
  caption state resets and autofocus re-fires by construction, not by manual
  effect. A test asserts file 1's caption text does not leak into file 2's
  field.
- **Caption field:** `<textarea>`, placeholder "Add a caption…", `maxLength`
  4096, autofocused on mount (per remount above).
- **Keyboard:** Enter confirms **iff the same `canSend` condition that enables
  the Send button holds** (pre-flight-invalid file ⇒ Enter does nothing);
  Shift+Enter inserts a newline; Escape skips the current file (same as
  Cancel). IME guard: ignore Enter when `event.nativeEvent.isComposing ||
  event.keyCode === 229` (right-sized; the full Safari composition-flag
  replication from the Matrix-era spec is not warranted in this small custom
  app — noted as a known limitation).
- **Buttons:** primary **Send** (disabled only by pre-flight error, see below),
  **Cancel** (skip current file). When more than one file is staged: header
  shows "File k of N" and a **Cancel all** action appears.
- **Focus contract:** focus lives in the caption textarea (via remount) while
  the modal is open; Tab cycles within the modal (focus trap). Focus returns to
  the composer textarea **only when the modal closes** (last file
  sent/skipped, or Cancel all) — never while a next page exists.
- **Paste while open + structural entry-point guards (exactly-once
  contract):** while the modal is open, a paste **anywhere** is handled by the
  modal's document-level paste listener and appends to the staged queue —
  **exactly once**. The guards on the other entry points exist to prevent
  *double*-staging through a second listener (a paste targeting the composer
  still bubbles to the document listener), not to swallow the paste:
  - Composer `onPaste`: early-return when `state.stagedUploads` is set — the
    modal's document listener handles the event instead.
  - Room-view `onDrop`: **`event.preventDefault()` runs unconditionally for
    file drags, BEFORE the staged-uploads check** — exact ordering:
    `if (!isFileDrag(event)) return; event.preventDefault(); setDragActive(false); if (state.stagedUploads) return; …` —
    otherwise a drop reaching the handler while the modal is open would fall
    through to the browser's native action (navigating the tab to the dropped
    file, destroying the modal and all staged state). A guard that skips
    `preventDefault` is strictly worse than no guard.
  The append path is keyed off the open queue itself (`stagedUploads.convoId`,
  captured at stage time), NOT the live `selectedConversationId` — so a
  cross-tab `clearSelection()` cannot silently turn paste-append into a no-op
  while the modal is showing (validity is enforced at confirm and at
  execution, not by breaking append).
- **Staged-convo invalidation error state:** if the confirm-time check-act
  guard finds the staged conversation archived/removed (cross-tab trigger),
  the modal swaps to an error notice — "This conversation was archived in
  another tab. Attachment(s) were not sent." — with a single Close button
  (fail visible; queue discarded, nothing uploaded).
- **Pre-flight validation (deterministic client-side only):** `size === 0` or
  `size > BROWSER_MEMORY_SAFETY_MAX_BYTES` (512MB) shows the error copy inline
  in the modal and disables Send (and Enter) for that file; Cancel advances.
  **This replaces the timeline error chip for these two pre-flight-detectable
  failures** — deliberate UX change (feedback moves earlier, before any outbox
  row exists), resolving the round-1 P3 note explicitly: no outbox row and no
  chip is created for a file the modal refused. `sendAttachment`'s own checks
  remain as defense-in-depth for non-modal callers. Server-side caps (journal
  50MB media cap) are **not** pre-checked client-side (server config is not
  client knowledge); an over-cap upload fails into the existing `too_large`
  error chip after confirm, exactly as today.
- **ARIA:** `role="dialog"`, `aria-modal="true"` (truthful under app-modal
  semantics), labelled by the filename heading.

### Entry-point rewires (`components.tsx`)

All three call `client.stageFiles([...])` instead of `client.attachFiles([...])`:

1. Attach-button `<input type="file" multiple>` `onChange` (`Composer`).
2. Composer textarea `onPaste` (clipboard files).
3. `SignedInApp` room-view `onDrop`.

### Render additions (`components.tsx`, `types.ts`)

- `file` tile (`EventContent` case `"file"`): render `payload.caption` as a
  caption line under the download link (images already render `figcaption`).
- `PendingAttachment` chip: show the caption under the filename while
  uploading/sending, so the optimistic row matches the final bubble.
- `eventSnippet` (`types.ts`): `file`/`image` snippets prefer the caption —
  e.g. `🖼 ${caption || filename}` — so the conversation list shows the
  meaningful text. (`eventSnippet` feeds both the left panel and `database.ts`
  snippet updates; one change covers both.)

## Part 2 — bridge consumer (small PR, `easelyte/claude-matrix-bridge` base `journal-deploy`)

Checkout `/opt/matron/bridge-journal`, service `matron-bridge-journal.service`.

1. **`lib/journal-input-router.js`:** extract the caption at the input
   boundary — trim, then clamp:
   `caption: typeof payload?.caption === "string" && payload.caption.trim() ? payload.caption.trim().slice(0, 4096) : null`
   — into the media object handed to `routeMediaToSession` (alongside
   `type/blobRef/contentType/name/size/dims`). The clamp mirrors the web
   textarea's `maxLength` so a non-web producer or modified client cannot push
   an unbounded string into the model prompt (P8 Guard Boundary Inputs; the
   web UI cap alone is not a wire boundary).
2. **`lib/journal-media.js`:** `routeOne` destructures `caption` from `media`
   and passes it through to `buildSavedBlocks(session, { buffer, mime, isImage,
   name, dims, caption })`. Audio path ignores it (no web voice notes).
3. **`index.js`:** the `createJournalMediaRouter` `buildSavedBlocks` wiring is
   where **both** session modes get covered — `buildSavedMediaBlocks` returns
   `{ blocks, ivHandled }` and folds the caption only in its iv branch, so the
   wiring re-creates the tail-append the removed Matrix caller used to do for
   SDK mode:
   ```js
   buildSavedBlocks: (session, { buffer, mime, isImage, name, dims, caption }) => {
     const safeName = safeMediaFilename(name);
     const { blocks, ivHandled } = buildSavedMediaBlocks(session, {
       buffer, mime, dims: dims || undefined, isImage,
       ivFilename: safeName, ivCaption: caption ?? null, workdirName: safeName,
     });
     if (caption && !ivHandled) blocks.push({ type: "text", text: caption });
     return blocks;
   },
   ```
   - `session.iv` truthy (interactive PTY mode): `ivUploadAnnotation` folds
     `${caption}\n\n${annotation}` — existing plumbing, now fed.
   - `session.iv` falsy (**the live default** — `MATRON_INTERACTIVE_MODE=0`):
     the explicit tail-append adds the caption as a text block after the saved
     image/file blocks.
   Claude therefore sees file + caption in one turn in **both** modes, whether
   the session is idle (immediate inject) or busy (queued blocks are built
   eagerly — the caption is inside the built blocks, so the queue path needs
   nothing extra).

Backwards compatibility: an old web client sends no `caption` (bridge sees
`null`, behavior identical). An old bridge ignores the unknown payload key —
the caption still renders in the timeline but does NOT reach Claude, which is
why deployment is **bridge-first** (see Delivery), not order-free.

## Edge cases

- **Empty / whitespace caption** → no `caption` key → exactly today's send.
- **Caption bounds:** web textarea `maxLength` 4096; bridge re-clamps at its
  boundary (Part 2 §1). WS frame size is nowhere near any limit (payload is
  small JSON; media bytes went via POST /media).
- **Multi-file:** sequential modal pages, per-file caption, per-file remount;
  Cancel/Escape skips one, Cancel-all clears the queue. Order preserved by the
  **serialized send chain** (uploads run one at a time in confirm order — the
  same serialization today's sequential-`await` `attachFiles` loop provides;
  the modal itself never waits on an upload).
- **Double-click Send / stale Enter:** the head guard (`itemId` must match the
  current head) makes the second activation a no-op; the next file cannot be
  sent with the previous file's caption.
- **Paste while modal open:** files append as additional pages (same convo by
  construction — the modal is app-modal + entry-point guards).
- **Convo switching while modal open:** same-tab switching is impossible (the
  overlay covers the conversation list). **Cross-tab invalidation is possible**:
  the existing `storage` listener reacts to another tab archiving the selected
  conversation with `clearSelection()`, which does not touch `stagedUploads` —
  the modal stays open over the collapsed room view. Caught **twice** (P19,
  check at the act, not only before the queue): the confirm-time check refuses
  new confirms into an archived/absent conversation (visible modal error
  state), and the execution-time re-check inside the send chain catches items
  that were queued *before* the archive landed (row marked `send_failed`,
  `canRetry` — visible chip, retryable after unarchiving). No queue depth
  produces a silent send into an archived conversation.
- **Pre-flight-invalid file (empty / >512MB):** inline modal error, Send +
  Enter disabled; **no outbox row, no timeline chip** (deliberate change from
  today — feedback moves into the modal, before any state exists).
- **Offline / upload failure / server oversize — after confirm:** unchanged —
  the existing pending-chip state machine handles error/retry/dismiss; retry
  re-emits via `emitPendingAttachment` → `attachmentPayload`, caption intact.
- **Refresh mid-modal:** staging (in-memory `File`s) of **not-yet-confirmed**
  pages is discarded; nothing of theirs was uploaded or persisted; user
  re-picks.
- **Refresh after confirm (upload in flight OR still queued):** every
  confirmed file has a persisted `uploading` outbox row from the moment its
  modal page advanced (persist-then-advance), so `startSession` converts each
  to an `upload_failed` error chip — **uniform visible evidence for all
  confirmed files**, including ones whose chained upload had not started yet.
  The `File` bytes are gone (in-memory only), so retry cannot proceed without
  re-picking (PR #1 known limitation, unchanged); the caption is lost with the
  file. This spec does NOT claim resumable uploads — it claims no confirmed
  file ever disappears without a trace.
- **Refresh / reconnect after upload completed (`blobRef` set, awaiting ack):**
  the reconnect-replay (`handleReady` → `sendPendingMessage`) re-sends the
  outbox row **with** the caption via the shared `attachmentPayload` helper.
- **Electron:** modal works, upload fails with the existing
  `electron_binary_unsupported` chip (unchanged from today).
- **Agent-published media** (bridge → journal `image` events): rendering path is
  shared; agent captions (already supported in the renderer) are unaffected.

## Testing

**matron-web** (`jest`, `corepack pnpm test` in `/opt/matron/web-journal`):

1. `client-test.ts`: `sendAttachment(file, convo, caption)` → emitted WS payload
   contains `caption`; without caption → no `caption` key (regression guard).
2. `client-test.ts`: outbox row persists `caption`; retry after `send_failed`
   re-emits with the same caption.
3. `client-test.ts`: **reconnect-replay** — an outbox row with `blobRef` and
   `caption` replayed via `handleReady`/`sendPendingMessage` includes `caption`
   in the payload (guards the second emit site).
4. `client-test.ts`: `stageFiles`/`confirmStagedFile`/`skipStagedFile`/
   `cancelStagedFiles` queue semantics incl. convoId capture, item ids,
   `total` accounting ("File k of N"), append-while-open, and clear-on-empty.
5. `client-test.ts`: **send serialization** — confirm files A then B rapidly;
   assert B's upload phase does not start until A's resolves (chain), and WS
   emit order is A then B.
6. `client-test.ts`: **persist-then-advance** — after confirming A and B
   rapidly (B's upload not yet started), the outbox contains persisted
   `uploading` rows for BOTH; simulate restart (`startSession` resume) and
   assert both surface as `upload_failed` chips (no silent loss of a
   confirmed-but-unstarted file).
7. `client-test.ts`: **head guard** — calling `confirmStagedFile` twice with
   the same `itemId` (double-click) produces exactly one persisted row / send.
8. `client-test.ts`: **check-act at confirm** — archive the staged
   conversation (simulate the cross-tab `storage` event) then confirm: nothing
   is persisted or sent and the staged state reflects the error (fail visible).
9. `client-test.ts`: **check-act at execution (queued item)** — confirm A
   (slow upload) then B; archive the conversation while B is queued; assert
   B's row is marked `send_failed`/`canRetry` and no upload/WS send fires
   for B.
10. `client-test.ts`: **session guard on the chain** — confirm A (slow) then
    B; run `startSession` (new session gen) before B executes; assert B's
    thunk aborts (no upload, no WS send under the new session).
11. `components-test.ts`: staging files renders the modal; image file shows an
    `img` preview; non-image shows name + size; typed caption + Send calls
    `confirmStagedFile(headId, "caption")`; Enter confirms; Shift+Enter does
    not; Escape skips; multi-file shows "File 1 of 2" and pages.
12. `components-test.ts`: **caption isolation** — type a caption on file 1,
    advance, assert file 2's field is empty (per-file remount keyed by item id).
13. `components-test.ts`: zero-byte file disables Send AND Enter does not
    confirm it.
14. `components-test.ts`: `file` tile renders `payload.caption`; pending chip
    shows caption; `eventSnippet` prefers caption.
15. `components-test.ts`: modal overlay covers the app shell (conversation list
    not interactive while open — assert overlay mount point / inertness), and
    **paste exactly-once** — a composer-targeted paste while the modal is open
    appends exactly ONE page (handled by the modal's document listener; the
    composer's own handler does not call `stageFiles`).
16. `components-test.ts`: **drop guard ordering** — a file drop on the room
    view while the modal is open calls `event.preventDefault()` (no native
    navigation) and stages nothing extra.
17. `components-test.ts`: **object-URL lifecycle** — `URL.revokeObjectURL` is
    called for the previewed image on advance, on skip, on Cancel-all, and on
    unmount (spy; guards the memory-safety contract).
18. **Existing-test updates (mechanical, expected):** the three
    `attachFiles`-spy assertions in `components-test.ts` (paste / drop /
    file-input entry points) are updated to spy `stageFiles` — planned
    breakage from the entry-point rewire, not a regression.

**bridge** (existing jest suite in the bridge repo):

1. Router test — media frame with `payload.caption` reaches
   `routeMediaToSession` with the trimmed, clamped caption; blank/absent →
   `null`; >4096 chars → clamped to 4096.
2. Media test — `routeOne` passes `caption` through to `buildSavedBlocks`.
3. **Blocks-content test (both modes)** — with a caption, the final returned
   blocks **contain the caption text**: iv-mode (annotation includes
   `${caption}`) and non-iv mode (trailing `{type:"text", text: caption}`
   block). Asserting on final block content, not argument forwarding, is the
   point — argument-forwarding tests stay green while dropping the caption.

**Manual acceptance (operator, live):** pick a screenshot → modal with preview →
type "what's wrong with this layout?" → Send → one bubble (image + caption) in
web timeline → Claude's next turn shows it received the image *and* the caption
text together (after bridge deploy + `matron-bridge-journal` restart; the live
bridge runs non-iv mode, so this exercises the tail-append path).

## Delivery

1. Branch `feat/upload-caption-modal` off `main` in `/opt/matron/web-journal`
   (this spec commits there). Slim chain: `/plan-slim` → `/plan-review` →
   `/execute-slim`. UI work applies the frontend-design skill at execute time.
2. Verification gates (R702 — test before deploy, BOTH repos):
   - web: `corepack pnpm lint` (if configured) + `corepack pnpm test` green
     inside `/opt/matron/web-journal` (`--prefix` / subshell `cd`, never the
     session).
   - bridge: `npm test` (vitest) green inside `/opt/matron/bridge-journal` —
     required both pre-merge on the PR branch AND on the merged SHA before the
     service restart in §6. The bridge Jest/vitest cases in Testing are a
     deploy gate, not documentation.
3. PR: `easelyte/matron-web` base `main` — **held for operator review +
   live-test** (operator backs up `webapp/` and runs `corepack pnpm build` to
   try it; merge is operator-gated).
4. Bridge PR: `easelyte/claude-matrix-bridge` base `journal-deploy` — held the
   same way.
5. **Deploy order (not order-free): bridge first.** Deploying web-first would
   render captions in the timeline while silently dropping them before Claude —
   a misleading success state (P3). Order: merge bridge PR → deploy bridge →
   merge web PR → deploy web. In practice the operator merges both in one
   sitting; the constraint is only "web must not go live while the old bridge
   runs."
6. **Bridge deploy + health gate + rollback:**
   - Deploy: `git -C /opt/matron/bridge-journal pull` (fast-forward to merged
     `journal-deploy`) → run the §2 bridge test gate on the pulled SHA →
     `systemctl restart matron-bridge-journal.service`.
   - Health gate (must distinguish the caption-aware build from the old one —
     service-active alone cannot):
     1. `git -C /opt/matron/bridge-journal rev-parse HEAD` equals the merged
        `journal-deploy` tip SHA (deterministic caption-aware evidence,
        checkable before the web deploy);
     2. `systemctl is-active matron-bridge-journal` is `active` and the log
        shows the agent reconnected (head_seq resume).
     The captioned end-to-end test necessarily runs AFTER the web deploy (the
     old web client cannot author captions); the SHA check is what licenses
     proceeding to the web deploy.
   - **Rollback (coupled, mirrors the deploy order):** the forbidden pairing
     "new web + old bridge" must not exist in either direction, so rollback is
     **web first, then bridge**:
     1. Restore the web client: swap the live `webapp/` back to the
        `webapp.bak.<timestamp>` taken before the build.
     2. Then roll the bridge back **without detaching the branch** — revert,
        don't checkout a raw SHA (a detached HEAD silently breaks the next
        `git pull` deploy):
        `git -C /opt/matron/bridge-journal revert -m 1 <merge-sha> --no-edit`
        → push the revert to `origin journal-deploy` →
        `systemctl restart matron-bridge-journal.service`.
        The repo stays on `journal-deploy` and the documented deploy recipe
        keeps working for the next attempt.
     Rolling back only the bridge while the new web stays live would recreate
     the misleading state Delivery §5 forbids (captions render but silently
     never reach Claude). Bridge-only rollback is permitted only if the web
     deploy has not happened yet.

## Risks

- **IME Enter-guard is the simplified form** (`isComposing || 229`), not
  Element's stateful Safari composition flag. Acceptable for this client's user
  base; revisit only if Safari IME captions misfire.
- **`components.tsx` is 1.5k lines and growing (P18).** The modal adds
  ~150-200 lines to a file already ~4x the cognitive-budget cap. A file split
  is deliberately out of scope for this PR (noise); **commitment, not prose: a
  follow-up loop for the `components.tsx` split is filed at ship time** (the
  ship-slim post-ship extract step, referencing this spec) so the debt is
  tracked in the loop store rather than only mentioned here.
- **Two-repo coordination:** web PR is buildable/testable independently, but
  deployment is ordered (bridge first — Delivery §5). The web PR alone is NOT
  the full feature; treating it as independently shippable was rejected in
  review round 1 (it reproduces rejected Approach A with a misleading success
  state).
