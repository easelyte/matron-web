---
title: Upload confirmation modal with caption (file + caption as one message)
date: 2026-07-17
status: draft
author: claude (brainstorm-slim)
target_repo: easelyte/matron-web (journal client), PR base main
related_repos:
  - easelyte/claude-matrix-bridge @ journal-deploy (consumer — folds caption into the media annotation Claude sees)
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
Claude in **one turn**.

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

## Verified grounding (2026-07-17)

- **Wire format already half-exists.** The web renderer displays
  `payload.caption` on images (`components.tsx` `EventContent` case `"image"` →
  `AuthenticatedMedia caption=` → `<figcaption>`). The `file` tile does not
  render a caption yet (gap closed by this spec).
- **Journal server needs zero change.** The `send` op passes `msg.payload`
  through opaquely (`/opt/matron/journal/src/ws.js` ~line 392–402: validates
  `payload` is an object and `blob_ref` present for media, stores payload as-is).
- **Bridge has caption plumbing but the journal path drops it.**
  `/opt/matron/bridge-journal` (repo `easelyte/claude-matrix-bridge`, branch
  `journal-deploy`): `lib/iv-uploads.js` `ivUploadAnnotation({caption})` folds
  `${caption}\n\n${annotation}` into the text block Claude sees — but
  `index.js` `journalMediaRouter.buildSavedBlocks` wiring hardcodes
  `ivCaption: null`, and `lib/journal-input-router.js` extracts no caption from
  the payload. Small additive consumer change required (Part 2).
- **PR #1 pipeline is the substrate.** `sendAttachment(file, convoId)` in
  `client.ts` owns validation (512MB browser cap / empty), the outbox
  `PendingMessage`, upload (`api.uploadMedia`), and the WS `send` emit
  (`emitPendingAttachment`). This spec threads one optional field through it.

## Part 1 — matron-web (primary PR)

### Wire shape

`emitPendingAttachment` payload gains one optional key:

```
payload: {
  blob_ref, name, filename, content_type, size, local_id,
  caption: "<trimmed caption>"     // ONLY when non-empty after trim
}
```

No `caption` key when the field was left empty — a no-caption send is
byte-identical to today's. Trim → omit is decided **once**, in the modal
confirm handler (authoritative owner); downstream code never re-interprets
whitespace.

### Staging state (`types.ts`, `client.ts`)

Entry points stop calling `attachFiles()` directly and instead stage:

- `ClientState` gains `stagedUploads?: { convoId: string; files: File[] }`.
  In-memory only (`File` objects are not serializable — never persisted to
  IndexedDB). A refresh mid-modal discards staging; nothing was uploaded yet, so
  nothing is lost or orphaned.
- `client.stageFiles(files: File[]): void` — no-op when no conversation is
  selected (same guard as today's `attachFiles`). Captures
  `selectedConversationId` at stage time; appends to an existing staging queue
  if one is open **for the same conversation** (pasting more files while the
  modal is up adds pages). If a stale staging exists for a *different*
  conversation (possible only via a programmatic race — the modal blocks the
  UI), it is replaced.
- `client.confirmStagedFile(caption?: string): Promise<void>` — pops the head
  file, calls `sendAttachment(file, stagedConvoId, caption)` (fire-and-forget
  like today's loop in `attachFiles`), advances the modal to the next file;
  clears `stagedUploads` when empty.
- `client.skipStagedFile(): void` — pops the head file without sending
  (modal Cancel), advances; clears when empty.
- `client.cancelStagedFiles(): void` — clears the whole queue ("Cancel all").
- `startSession()` clears `stagedUploads` (session teardown already clears the
  sibling attachment maps).

`attachFiles(files)` remains as the internal batch path but is no longer wired
to UI events (kept for tests / future callers, now delegating per-file with no
caption).

### `sendAttachment(file, convoId, caption?)` (`client.ts`)

- `PendingMessage` (`types.ts`) gains `caption?: string`. It rides the outbox
  row, so it **persists across refresh** and survives the existing
  resume/retry/reconcile paths with zero extra handling (the outbox row is
  re-serialized whole by `persistAttachment`).
- `sendAttachment` stores `caption` (already-trimmed, or absent) on the
  `PendingMessage`; `emitPendingAttachment` adds `caption` to the payload when
  present. No other state-machine change — validation, upload, retry, dismiss,
  reconcile all untouched.
- `matchesOwnPendingMessage` (`database.ts`) matches by `local_id` — unchanged.

### Modal UI (`components.tsx`, `journal.pcss`) — new `UploadConfirmDialog`

New component rendered by `SignedInApp` whenever `state.stagedUploads` is
non-empty (above the room view, overlay + centered panel; new `mj_UploadConfirm*`
classes — the app has no dialog primitive, style echoes the auth-modal look and
`mj_DragOverlay` scrim).

- **Preview:** for `file.type.startsWith("image/")`, an `<img>` from
  `URL.createObjectURL(file)`, object-fit contain, max height ~50vh; object URL
  revoked on advance/close (effect cleanup). For other files: attachment icon +
  filename + `formatBytes(size)`.
- **Caption field:** `<textarea>`, placeholder "Add a caption…", `maxLength`
  4096, autofocused on mount and on page advance, cleared per file.
- **Keyboard:** Enter confirms (send), Shift+Enter inserts a newline, Escape
  skips the current file (same as Cancel). IME guard: ignore Enter when
  `event.nativeEvent.isComposing || event.keyCode === 229` (right-sized; the
  full Safari composition-flag replication from the Matrix-era spec is not
  warranted in this small custom app — noted as a known limitation).
- **Buttons:** primary **Send** (always enabled unless pre-flight error, see
  below), **Cancel** (skip current file). When more than one file is staged:
  header shows "File k of N" and a **Cancel all** action appears.
- **Pre-flight validation (deterministic client-side only):** `size === 0` or
  `size > BROWSER_MEMORY_SAFETY_MAX_BYTES` (512MB) shows the existing error
  copy inline in the modal and disables Send for that file (Cancel advances).
  This *pre-empts* the same checks in `sendAttachment` — files that pass still
  go through them (defense-in-depth). Server-side caps (journal 50MB media cap)
  are **not** pre-checked client-side (server config is not client knowledge);
  an over-cap upload fails into the existing `too_large` error chip.
- **Focus/ARIA:** `role="dialog"`, `aria-modal="true"`, labelled by the
  filename heading. Focus moves into the caption field on open; Escape path
  returns focus to the composer textarea.

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
  `🖼 ${caption || filename}` — so the conversation list shows the meaningful
  text. (`eventSnippet` feeds both the left panel and `database.ts` snippet
  updates; one change covers both.)

## Part 2 — bridge consumer (small PR, `easelyte/claude-matrix-bridge` base `journal-deploy`)

Checkout `/opt/matron/bridge-journal`, service `matron-bridge-journal.service`.

1. **`lib/journal-input-router.js`:** extract
   `caption: typeof payload?.caption === "string" && payload.caption.trim() ? payload.caption.trim() : null`
   into the media object handed to `routeMediaToSession` (alongside
   `type/blobRef/contentType/name/size/dims`).
2. **`lib/journal-media.js`:** `routeOne` destructures `caption` from `media`
   and passes it through to `buildSavedBlocks(session, { buffer, mime, isImage,
   name, dims, caption })`. Audio path ignores it (no web voice notes).
3. **`index.js`:** the `createJournalMediaRouter` `buildSavedBlocks` wiring
   passes `ivCaption: caption ?? null` instead of the hardcoded `null` (and
   accepts `caption` in its destructured arg). `ivUploadAnnotation` then folds
   `${caption}\n\n${annotation}` into the injected text block — the identical
   contract the Matrix MSC2530 path uses, so Claude sees file + caption in one
   turn whether the session is idle (immediate inject) or busy (queued blocks,
   built eagerly — caption is inside the built blocks, so the queue path needs
   nothing extra).

Additive and backwards-compatible in both directions: an old web client sends no
`caption` (bridge sees `null`, behavior identical); an old bridge ignores the
unknown payload key (caption still renders in the timeline — graceful
degradation, no kill-switch needed).

## Edge cases

- **Empty / whitespace caption** → no `caption` key → exactly today's send.
- **Caption bounds:** textarea `maxLength` 4096. WS frame size is nowhere near
  any limit (payload is small JSON; media bytes went via POST /media).
- **Multi-file:** sequential modal pages, per-file caption; Cancel skips one,
  Cancel-all clears the queue. Order preserved (head-of-queue send matches
  today's sequential `attachFiles` ordering).
- **Paste while modal open (same convo):** files append as additional pages.
- **Convo switch while modal open:** staged `convoId` was captured at stage
  time; sends still target the original conversation (matches `sendAttachment`'s
  existing signature contract). The modal stays up until resolved.
- **Offline / upload failure / oversize:** unchanged — after modal confirm, the
  existing pending-chip state machine handles error/retry/dismiss; retry reuses
  the outbox row, which now carries the caption.
- **Refresh mid-modal:** staging (in-memory `File`s) is discarded; nothing was
  uploaded; user re-picks. Refresh *after* confirm: outbox row persists caption;
  existing resume path re-uploads with caption intact.
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
3. `client-test.ts`: `stageFiles`/`confirmStagedFile`/`skipStagedFile`/
   `cancelStagedFiles` queue semantics incl. convoId capture and clear-on-empty.
4. `components-test.ts`: staging files renders the modal; image file shows an
   `img` preview; non-image shows name + size; typed caption + Send calls
   `confirmStagedFile("caption")`; Enter confirms; Shift+Enter does not; Escape
   skips; multi-file shows "File 1 of 2" and pages; zero-byte file disables Send.
5. `components-test.ts`: `file` tile renders `payload.caption`; pending chip
   shows caption; `eventSnippet` prefers caption.

**bridge** (existing jest suite in the bridge repo): router test — media frame
with `payload.caption` reaches `routeMediaToSession` with `caption`; blank/absent
→ `null`. Media test — `routeOne` passes `caption` through to `buildSavedBlocks`.

**Manual acceptance (operator, live):** pick a screenshot → modal with preview →
type "what's wrong with this layout?" → Send → one bubble (image + caption) in
web timeline → Claude's next turn shows it received the image *and* the caption
text together (after bridge deploy + `matron-bridge-journal` restart).

## Delivery

1. Branch `feat/upload-caption-modal` off `main` in `/opt/matron/web-journal`
   (this spec commits there). Slim chain: `/plan-slim` → `/plan-review` →
   `/execute-slim`. UI work applies the frontend-design skill at execute time.
2. Verification gate: `corepack pnpm lint` (if configured) + `corepack pnpm test`
   green inside the repo (`--prefix` / subshell `cd`, never the session).
3. PR: `easelyte/matron-web` base `main` — **held for operator review +
   live-test** (operator backs up `webapp/` and runs `corepack pnpm build` to
   try it; merge is operator-gated).
4. Bridge PR: `easelyte/claude-matrix-bridge` base `journal-deploy` — held the
   same way; deploy = merge + `systemctl restart matron-bridge-journal.service`
   (does not affect the live Matrix bridge this session runs on).

## Risks

- **IME Enter-guard is the simplified form** (`isComposing || 229`), not
  Element's stateful Safari composition flag. Acceptable for this client's user
  base; revisit only if Safari IME captions misfire.
- **`components.tsx` is 1.5k lines and growing.** The modal adds ~150 lines. A
  file split is deliberately out of scope (PR noise); flagged for a future
  refactor loop if the next features keep landing here.
- **Two-repo coordination:** web PR is independently shippable (caption renders,
  degrades gracefully); bridge PR unlocks the Claude-delivery half. Order-free.
