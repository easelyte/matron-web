---
title: Session controls v2 — Pin, Favorites (tab + star), Mark read/unread
date: 2026-07-18
status: approved
revision: 5
review_rounds: 4
status_note: "converged at round 4. Round 4: Claude LGTM (all round-3 fixes verified against live code); Codex found 1 blocker (resumeSession→startSession citation error, grep-confirmed + fixed) + 2 majors (foreign-archive cross-tab race = accepted §3.1 last-writer-wins class, guarantee wording softened; markAllRead batch controlError aggregation defined). All findings across 4 rounds were partial-state-preservation / prompt-contract-gap sub-cases — textbook convergence-by-class. Remaining residuals are polish; the substantive design is stable and grep-grounded."
author: claude (brainstorm-slim)
target_repo: easelyte/matron-web (journal client), PR base main
approach: B — generic IdSetStore helper + polished Favorites tab (client-local, per-session localStorage)
rejected_alternatives:
  - "A (slim-down): triplicate the archivedIds machinery (4 storage keys, 4 parse paths, 4 storage-listener branches) and use a plain filter-toggle button instead of a segmented tab. Saves the helper extraction + tab styling but leaves 4x duplicated persistence code and a weaker Favorites affordance."
  - "C (over-built, rejected): server-side pin/favorite/unread persistence synced across devices. Requires journal-server + bridge changes that land in Matronhq upstream; operator explicitly scoped this client-local per the PR #2 archive precedent. Out of scope."
related_specs:
  - 2026-07-15-web-attachment-send-design.md (PR #1 — attachment send pipeline)
  - 2026-07-17-web-upload-caption-modal-design.md (PR #3 — caption modal)
related_prs:
  - "PR #2 (archive) — the client-local per-session localStorage precedent this feature generalizes (archivedIds / ARCHIVED_CONVERSATIONS_KEY_PREFIX / storageListener)"
---

# Session controls v2 — design

## Problem

The conversation right-click / long-press / kebab context menu in the left panel
currently offers only **Archive** (plus **Mark as read** when the row has server
unread, and **Unarchive** for already-archived rows). Operators managing many
agent conversations have no way to:

1. **Pin** a conversation so it stays at the top of the list regardless of
   activity ordering.
2. **Favorite / star** conversations and view just those (a focused subset).
3. **Mark a conversation unread** after reading it (a "come back to this" marker).

All three are standard messaging-client affordances. The archive feature (PR #2)
already established the pattern for per-conversation, client-local, per-session
state persisted in `localStorage` — this feature generalizes that pattern to
three more flags and adds the UI to drive them.

## Goal

Extend the left-panel conversation controls with **Pin**, **Favorites**, and
**Mark unread**, all persisted client-side per session exactly like `archivedIds`:

- **Pin** — pinned conversations sort to the top of the active list.
- **Favorites** — a star toggle in the menu plus a segmented **All | Favorites**
  tab at the top of the left panel that filters the list to favorited rows.
- **Mark read / Mark unread** — Mark-read already exists; add **Mark unread** as
  a client-local overlay that visually marks a read conversation as unread until
  it is opened again.

### Non-goals (v1)

- **Server-side sync.** All state is client-local per device, keyed per session,
  exactly like `archivedIds`. Opening the same account on another device / after
  clearing storage starts fresh. (Matches PR #2; server sync is out of scope and
  would require upstream Matronhq changes.)
- **Upstream PR to Matronhq.** Ships to the easelyte fork's `main` (the deployed
  client). Upstreaming is a separate operator decision.
- **Reordering pins by drag.** Pinned rows keep their existing activity order
  among themselves; no manual pin-ordering.
- **Pin/favorite of archived rows surfacing in the active list.** Archived rows
  stay in the archived section regardless of pin/favorite state (see §3.4).
- **Persisting the selected tab across reloads.** The All/Favorites tab is
  in-component UI state (`useState`), defaults to All on load. (Cheap to add
  later; deliberately omitted to avoid a fifth storage key for a cosmetic gain.)
- **Electron badge changes for override-unread.** The OS/app badge count
  (`emit()` → `setBadgeCount`) reflects real **server-side** unread only.
  Mark-unread is a soft local visual marker and does NOT increment the app badge
  (see §3.3).
- **A "Pinned" collapsible section.** Pins sort-to-top inline; no separate
  section header (unlike Archived, which is a distinct collapsed section).

## Grounding: the archive pattern this generalizes

From `src/journal/client.ts` (PR #2):

```
const ARCHIVED_CONVERSATIONS_KEY_PREFIX = "matron_journal_archived_conversations_v1";

archivedStorageKey(session)      // `${PREFIX}:${encodeURIComponent(serverUrl)}:${userId}`
parseArchivedValue(raw)          // JSON → Set<string>, tolerant of malformed/non-array (warn + empty set)
storedArchivedIds(session)       // read localStorage, storage-unavailable-safe (warn + empty set)
storeArchivedIds(session, ids)   // write JSON array

// in-state:  ClientState.archivedIds: Set<string>
// setter:    private setArchived(id, archived)  — re-reads current from storage, mutates, writes, patches state, dedupes selection
// listener:  this.storageListener reacts to archivedStorageKey change (cross-tab), patch({archivedIds}), deselect if the viewed convo was archived
// render:    components.tsx partitions active vs archived by state.archivedIds.has(id)
```

Three new flags (`pinnedIds`, `favoriteIds`, `unreadOverrideIds`) need the same
read/write/parse/listener surface. Rather than copy those ~6 functions three more
times, we extract them **once**.

## Approach (B): generic `IdSetStore` + polished tab

### 3.1 Persistence: `IdSetStore` factory

Add a small factory in `client.ts` (or a sibling `conversation-flags.ts` if it
keeps `client.ts` from growing — see §6) that captures the archive persistence
logic parameterized by a key-prefix:

```ts
interface IdSetStore {
    storageKey(session: Session): string;
    read(session: Session): { ids: Set<string>; ok: boolean };   // ok=false ⇒ storage read threw
    write(session: Session, ids: Set<string>): void;
    parse(raw: string | null): Set<string>;                       // reused by the storage listener
}

function makeIdSetStore(keyPrefix: string, label: string): IdSetStore { ... }
```

- `parse` = current `parseArchivedValue` logic (JSON → filter string[] → Set;
  malformed / non-array → `console.warn("matron: malformed ${label} value, ignoring")` + empty set).
- `read` = current `storedArchivedIds` logic (try/catch around `getItem`, warn on
  storage-unavailable) — but returns `{ ids, ok }` so callers can **distinguish an
  empty persisted set from a failed read** (Codex round-1 finding). On a
  `getItem` throw it returns `{ ids: new Set(), ok: false }`; on success
  `{ ids: parse(raw), ok: true }`.
  - **Preserve the archive instance's exact warning strings (round-3 finding).**
    `archive-test.ts:149` asserts the *exact* legacy read-failure text
    `"matron: archived-conversations read failed (storage unavailable)"`. The
    factory's warning messages are built from the `label` argument, and the
    archive store MUST be instantiated with `label = "archived-conversations"` so
    both the read-failure warning (`matron: ${label} read failed (storage
    unavailable)`) and the malformed-value warning (`matron: malformed ${label}
    value, ignoring`) reproduce the legacy archive strings byte-for-byte. This is
    a hard requirement of the §3.1/§5/§7 scoped-unchanged guarantee, not just the
    new stores' cosmetics. (New stores use their own labels — `"pinned-
    conversations"`, `"favorite-conversations"`, `"unread-conversations"` — no
    test pins those.) **Rationale:** the existing archive path
  (`client.ts:962`, the `replaceSnapshot` re-read) deliberately *keeps the
  in-memory set* when storage is unavailable rather than clobbering it with an
  empty set. A naive `read()` that collapsed absence and failure into a bare
  empty `Set` would let `replaceSnapshot` (§3.2) blow away all four sets on a
  transient storage error — surfacing archived rows and dropping every pin /
  favorite / unread marker, then persisting that empty state on the next toggle.
  The `{ ids, ok }` shape lets the re-read paths preserve prior state on `ok:false`.
  - The archive test-facing wrapper `storedArchivedIds(session)` returns just
    `store.read(session).ids` (preserves its existing `Set<string>` signature —
    tests unchanged); the client's re-read paths call `read()` directly and honor `ok`.
- `write` = `setItem(key, JSON.stringify([...ids]))`.
- `storageKey` = `${keyPrefix}:${encodeURIComponent(session.serverUrl)}:${session.userId}`.

**Concurrency contract (last-writer-wins, not a lock — Codex round-1 finding).**
`setFlag` (§3.2) re-reads the current set from storage immediately before
mutating, which narrows — but does **not** eliminate — a cross-tab lost-update
race: two tabs can read the same set, each add a different id, and the later
`write` overwrites the earlier one; the `storage` event then converges both tabs
on the lossy value. This is **last-writer-wins**, identical to the archive
feature's existing behavior — not a regression this spec introduces, and not
worth a lock for a soft per-device preference (the operator would have to toggle
two different conversations in two tabs within the same event-loop tick). The
spec commits to last-writer-wins explicitly; the re-read is a best-effort
narrowing, not an atomicity guarantee. Do not describe it as "guards against"
concurrent writes.

Instantiate four stores with these exact key strings:

| Store        | Key prefix (localStorage)                              | Notes |
|--------------|--------------------------------------------------------|-------|
| archive      | `matron_journal_archived_conversations_v1` (UNCHANGED) | Refactored onto the factory; key string identical → **zero data migration** for existing persisted archive state. |
| pinned       | `matron_journal_pinned_conversations_v1`               | new |
| favorite     | `matron_journal_favorite_conversations_v1`             | new |
| unread-override | `matron_journal_unread_conversations_v1`            | new |

**Refactoring archive onto the factory is required for B** (that's the DRY win),
and is safe precisely because the key string does not change — already-persisted
`archivedIds` in operators' browsers continue to load. **Decision (committed, not
a preference):** the existing exported functions `archivedStorageKey`,
`storedArchivedIds`, `storeArchivedIds` are **kept as thin wrappers** over the
archive store instance so the tests that import them keep compiling and their
persistence assertions pass **without edits to those import sites**.
`storedArchivedIds` returns `archiveStore.read(session).ids`; `storeArchivedIds`
delegates to `archiveStore.write`; `archivedStorageKey` delegates to
`archiveStore.storageKey`.

**Scope of "unchanged" (round-2 Codex-B2 / Claude-M1):** the wrapper preservation
keeps the *persistence-function* surface stable — it does NOT make the whole
archive suite unchanged, because §3.2 renames the `archiveError` **state field**
to `controlError`. `archive-test.ts` asserts on `archiveError` at **lines 216,
220, 238, 262**. In production, `archiveError` appears throughout `client.ts`
(declaration/init `:73`; resets/patches `:340`, `:934`; error-message sets
`:919`, `:930`), the field declaration in `types.ts:186`, and the render guard in
`components.tsx:558` — every one is a required mechanical edit under the rename. A
plain `grep archiveError` sweep across `src/` + `test/` finds them all;
`pnpm lint:types` fail-loud catches any straggler. The "unchanged" guarantee is
therefore scoped precisely to the three persistence wrappers, not to the
`controlError` rename edits, which are expected. No section may claim the archive
tests are globally unchanged.

### 3.2 Client state + setters

`ClientState` (`types.ts`) gains three sets mirroring `archivedIds`:

```ts
pinnedIds: Set<string>;
favoriteIds: Set<string>;
unreadOverrideIds: Set<string>;
```

`blankState()` initializes all three to `new Set()`. Both state-seeding paths
that read `archivedIds` from storage today must read all four stores:
- **Session bootstrap** (the `startSession` path that calls `storedArchivedIds`
  and installs the `storageListener`) seeds `pinnedIds`, `favoriteIds`,
  `unreadOverrideIds` alongside `archivedIds`. At bootstrap there is no prior
  in-memory set to preserve, so a `read()` returning `ok:false` seeds the empty
  set (unchanged from archive today).
- **`replaceSnapshot`** (the reconnect/snapshot-required path) currently re-reads
  `archivedIds` from storage into the patched state; it must likewise re-read the
  three new sets so a snapshot swap doesn't drop pin/favorite/unread state.
  **Honor the `ok` flag (Codex round-1 finding):** for each of the four stores,
  if `read()` returns `ok:false` (storage threw), **keep the existing in-memory
  set** for that flag rather than patching it to empty — mirroring the archive
  code's existing `try/catch` at `client.ts:962` ("Keep the in-memory set when
  storage is temporarily unavailable"). Only patch a flag's set when its read
  succeeded.

A single generic setter replaces per-flag duplication:

```ts
private setFlag(store: IdSetStore, stateKey: "pinnedIds" | "favoriteIds" | "unreadOverrideIds",
                conversationId: string, on: boolean): void
```

- Re-reads the current set from storage (best-effort last-writer-wins narrowing
  per the §3.1 concurrency contract — NOT an atomicity guarantee) via
  `store.read(session)`, mutates, writes back, `patch({ [stateKey]: next })`.
- **Abort on failed read (round-2 Codex-M1).** If `read()` returns `ok:false`
  (the `getItem` throw path), `setFlag` **aborts before mutating**: set
  `controlError` and return, leaving both storage and the in-memory set untouched.
  This mirrors the existing `setArchived` which catches the read failure and
  returns before writing (`client.ts:911-919`). A naive "mutate the returned set,
  write it back" would otherwise take the empty `ok:false` set, add just the
  toggled id, and persist it — clobbering every previously-stored id. `setFlag`
  must branch on `ok`, not treat the returned `ids` as authoritative when
  `ok:false`.
- On storage failure: set a user-visible error. Reuse the existing
  `archiveError` field **renamed/​generalized to `controlError`** (a single
  error slot for all four flags — only one menu action fires at a time, so one
  slot suffices). Message text is per-action, e.g. "Couldn't save pin — device
  storage is full or unavailable." *(Renaming `archiveError` → `controlError`
  touches `types.ts`, `client.ts`, `components.tsx`, and the archive tests;
  alternatively keep `archiveError` for archive and add `controlError` for the
  new flags. Decision: rename to `controlError` for one unified slot — cleaner,
  and the rename is mechanical. Archive's existing messages are preserved.)*

Public methods (thin wrappers over `setFlag`, mirroring
`archiveConversation`/`unarchiveConversation`):

```ts
pinConversation(id) / unpinConversation(id)
favoriteConversation(id) / unfavoriteConversation(id)
markConversationUnread(id)          // adds to unreadOverrideIds
// markConversationRead(id) already exists — MUST be restructured (see §3.3 B1)
```

### 3.3 Mark read / Mark unread semantics

`unread_count` is **server-authoritative** — derived from `read_up_to_seq` vs
`last_seq`, persisted in IndexedDB, and mark-read flushes a `read_marker` op to
the server (read state is shared across devices via the server). There is **no
server "mark unread" op**. So mark-unread is a purely client-local overlay.

Define **effective unread**:

```ts
effectiveUnread(convo) = convo.unread_count > 0 || state.unreadOverrideIds.has(convo.id)
```

- **Mark unread** (menu, offered only when `!effectiveUnread` today, i.e. the row
  is currently fully read): `markConversationUnread(id)` adds `id` to
  `unreadOverrideIds` (persisted). The row renders in the unread visual style
  with a **dot** indicator (NOT a numeric badge — the server count is 0, there is
  no number to show). **Accessibility contract (M2, testable):** the dot element
  carries `aria-label="Marked unread"` (or, if the whole row's `aria-label` is
  extended instead, it appends ", marked unread"). Either way the row exposes a
  screen-reader signal that override-unread state exists, matching the existing
  numeric badge's `aria-label={`${n} unread`}`. `components-test.ts` asserts the
  accessible name is present on override-unread rows and that no numeric badge is
  rendered — this replaces the untestable "visual dot" criterion.

- **`markConversationRead` restructure (B1 — required, not "extend").** The
  existing method early-returns when `unread_count` is falsy:
  ```ts
  public markConversationRead(id): void {
      const conversation = this.state.conversations.find((c) => c.id === id);
      if (!conversation?.unread_count) return;               // ← returns for override-only rows
      this.scheduleRead(id, conversation.last_seq, 0);
  }
  ```
  An override-only-unread row has `unread_count === 0`, so appending a
  clear-override call *after* this guard would never run for exactly the rows
  "Mark as read" must serve. Restructure so the two concerns are independently
  gated:
  ```ts
  public markConversationRead(id): void {
      const conversation = this.state.conversations.find((c) => c.id === id);
      if (!conversation) return;                             // existence check only
      this.clearUnreadOverride(id);                          // best-effort clear of the client marker (persists)
      if (conversation.unread_count > 0)
          this.scheduleRead(id, conversation.last_seq, 0);   // server flush only when real unread
  }
  ```
  `clearUnreadOverride(id)` is a no-op (no write, no patch) when `id` isn't in the
  override set, so calling it for genuinely-read rows costs nothing.
  - **Compound-failure contract (round-2 Codex-M2).** `clearUnreadOverride` is
    **best-effort and independent** of the server flush: if its `store.write`
    throws, it sets `controlError`, leaves the override in place (state + storage
    unchanged), and does **not** throw. `markConversationRead` still proceeds to
    `scheduleRead` when `unread_count > 0` — the server read marker is the
    authoritative unread signal and clearing it is correct regardless of whether
    the local marker persisted. Net on this rare compound failure: server unread
    clears, the local override survives (row still shows the dot), and
    `controlError` surfaces the failure so the user can retry or open the row
    (which clears the override on a subsequent successful write). This is a
    defined, visible degradation — not an undefined path. A client-test asserts:
    with `setItem` throwing, `markConversationRead` on a both-unread row still
    calls `scheduleRead` and sets `controlError`, override unchanged.

- **User-initiated vs programmatic selection (B2 — required).**
  `selectConversation` is called both from the row click handler **and
  programmatically** to restore the last-viewed conversation: `startSession`
  (`client.ts:898`) on every app load, and `replaceSnapshot` (`client.ts:969`) on
  every websocket reconnect / snapshot-required event. Since the conversation a
  user marks unread is typically the one they were just viewing, an unconditional
  "clear override on select" would let the next reload or mid-session reconnect
  silently wipe the marker — defeating the feature's "until it is opened again"
  contract. Fix: only a **user-initiated open** clears the override.
  - Add an options param: `selectConversation(id, opts?: { clearUnread?: boolean })`.
    The row `onClick` (and the keyboard-activation path) passes
    `{ clearUnread: true }`; `clearUnread` defaults to `true` for the public
    method so existing call sites need no change **except** the two programmatic
    restorers, which pass `{ clearUnread: false }`.
  - When `clearUnread` is true, `selectConversation` calls `clearUnreadOverride(id)`
    (persist) alongside the existing read-scheduling.
  - `startSession` and `replaceSnapshot` call `selectConversation(id, { clearUnread: false })`
    — restoring the view without touching the marker. (These paths already do NOT
    flush server reads beyond what `scheduleRead` schedules; leaving the override
    intact is consistent with "the user hasn't actively opened it this session.")
- **Clearing the override — summary of paths:**
  - User opens the conversation (row click / keyboard) → cleared.
  - `markConversationRead(id)` (menu "Mark as read") → cleared (see restructure above).
  - `markAllRead()` uses a **single per-row mechanism — no separate bulk write**
    (round-3 Codex-B1/major). The existing loop is gated on `unread_count > 0 &&
    !archived` (`client.ts:357-360`), which skips override-only active rows
    (unread_count 0). Change the gate to `effectiveUnread(c) && !archivedIds.has(c.id)`
    and call `markConversationRead(c.id)` for each such row. Because
    `markConversationRead` already (a) clears that row's override via
    `clearUnreadOverride` and (b) flushes the server read marker when
    `unread_count > 0`, the loop handles both real-unread and override-only active
    rows through **one** code path. **Do NOT also compute a bulk `next` set and
    `store.write` it** — that was the round-2 formulation and it created two
    overlapping override mutations with undefined ordering (Codex-B1) and a
    stale-in-memory bulk-write cross-tab race that could delete a foreign tab's
    archived override (Codex-major). The per-row `clearUnreadOverride` goes
    through the same `setFlag`-style read-modify-write as every other flag mutation
    (re-reads storage each call → last-writer-wins per §3.1, never writes a stale
    whole-set snapshot). **Archived overrides survive** because the loop never
    visits a row `archivedIds` currently marks archived. *Cross-tab caveat
    (round-4 Codex-major, accepted):* the archived-check reads this tab's
    `archivedIds` snapshot — if another tab archives an override-unread convo and
    this tab runs mark-all before its `storage` event lands, mark-all still treats
    it as active and clears the override. This is the **same last-writer-wins
    cross-tab race already accepted in §3.1** (a soft per-device marker; the losing
    write is a rare two-tab interleave within one event-loop tick), not a new
    guarantee-breaking defect. The guarantee is therefore "archived overrides
    survive within a tab's consistent view," not an atomic cross-tab invariant; no
    lock is warranted for a soft marker.
  - **Batch error semantics (round-4 Codex-major).** `markAllRead` is one user
    action that fans out to N per-row mutations, so it needs a defined
    `controlError` aggregation rather than letting per-row set/clear race. Rule:
    `markAllRead`'s **final `controlError` write is authoritative** — it runs the
    loop (per-row calls may set/clear `controlError` as a transient side effect,
    which never renders since `markAllRead` is synchronous and React batches),
    accumulates a local `anyFailed` flag from each row's write outcome, and issues
    **one final `patch`** overriding the field: `controlError` = a batch message
    ("Some conversations couldn't be updated — device storage is full or
    unavailable.") if `anyFailed`, else `undefined`. This is deterministic
    regardless of row order — a trailing success can't mask an earlier failure and
    a stale error can't survive a fully-successful pass — and needs no change to
    `markConversationRead` (its per-row side effects are simply overwritten by the
    final authoritative patch). To read each row's outcome, `clearUnreadOverride`
    returns a boolean `ok` (false when its `store.write` threw); `markAllRead` ORs
    the failures. (Single-menu-action mutations keep their existing per-action
    set-on-failure / clear-on-success behavior — the aggregation applies only
    inside `markAllRead`.) `client-test.ts` asserts a mixed batch (one row's
    `setItem` throws, another succeeds) ends with `controlError` set to the batch
    message.
  - Programmatic restore (`startSession` / `replaceSnapshot`) → **not** cleared.
- **Interaction with real server unread:** if a new message arrives while the
  override is set, `unread_count` becomes > 0 → still effectively unread (now
  with a real count badge). When the user opens it, both the server unread flush
  and the override clear happen. The override never "fights" the server count;
  it only matters when the server count is 0.
- **Menu item visibility:**
  - Show **Mark as read** when `effectiveUnread(convo)` is true (covers both real
    server unread AND override-only unread — marking an override-unread row read
    just clears the override).
  - Show **Mark as unread** when `effectiveUnread(convo)` is false (a fully-read
    row). **Mark read/unread are offered for active rows only** — archived rows
    get Unarchive; the read affordances stay scoped to the active partition as
    today, where "Mark as read" is already gated on `!archivedIds.has(id)`. So
    the mark-unread menu item is gated `!archivedIds.has(id) && !effectiveUnread(convo)`.
- **Electron / OS badge:** `emit()` sums `unread_count` across conversations for
  `setBadgeCount`. Override-unread rows have `unread_count === 0`, so they do NOT
  bump the app badge. This is deliberate: the OS badge reflects genuine unread
  messages from the agent, not a soft local "revisit" marker. Documented as a
  non-goal (§Non-goals).
- **`hasActiveUnread`** (controls the header "Mark all as read" button):
  currently `state.conversations.some(c => c.unread_count > 0 && !archived)`.
  Extend to `effectiveUnread(c) && !archived` so the mark-all button also appears
  when only override-unread rows exist, and `markAllRead()` clears them.

### 3.4 Pin — sort-to-top

- `pinnedIds` is client-local. Pinned rows sort to the top of the **active**
  (non-archived) list, preserving the existing activity order among pinned rows
  and among the rest.
- Applied at **render** in `components.tsx`, layered on the already-sorted
  `state.conversations` (database sorts by `last_ts`/`last_seq`). Stable
  partition:

  ```ts
  const active = conversations.filter(c => !archivedIds.has(c.id));
  const pinnedActive   = active.filter(c => pinnedIds.has(c.id));
  const unpinnedActive = active.filter(c => !pinnedIds.has(c.id));
  const orderedActive  = [...pinnedActive, ...unpinnedActive];   // both already activity-sorted
  ```

- **Pin scope:** pin affects sort within the active list only. Archived rows stay
  in the archived section regardless of pin state (archiving is orthogonal; an
  archived+pinned row shows in Archived, unpinned-positioned there — archived
  section keeps its own order). Pin state persists through archive/unarchive.
- **Visual affordance:** a small pin indicator on pinned rows (e.g. a pin glyph
  near the name) so the reason for top-ordering is legible. Exact placement is a
  frontend-design decision (see §4).
- **Menu items:** **Pin** (when not pinned) / **Unpin** (when pinned).

### 3.5 Favorites — star + segmented tab

- `favoriteIds` is client-local. **Star toggle** in the menu: **Add to Favorites**
  (when not favorited) / **Remove from Favorites** (when favorited), with a star
  icon. Optionally a star affordance on the row for favorited rows (frontend-design).
- **Segmented tab** at the top of the left panel (below the header, near the
  search): **All | Favorites**. In-component `useState<"all" | "favorites">`,
  default `"all"`.
  - **All** view: the current behavior — active list (pin-sorted) + the Archived
    collapsible section.
  - **Favorites** view: the active list filtered to `favoriteIds.has(id)`
    (pin-sorted within favorites). **No Archived section** in Favorites view
    (favorites is a focus filter over active convos). Empty state: "No favorite
    conversations yet."
- **The tab is a LEFT-LIST VIEW FILTER ONLY — it never touches selection or the
  right pane (round-3 Codex-major).** Switching All↔Favorites re-filters the row
  list and nothing else: `selectedConversationId`, the open chat pane, and the
  `viewing` websocket op are all untouched. If the currently-selected conversation
  is not in the active tab's filter (e.g. a non-favorite selected in All, then
  switch to Favorites), it simply isn't shown/highlighted in the list **while
  staying open in the right pane** — identical to the unfavorite-while-viewing
  case below, and to how a search query that excludes the selected row already
  behaves today. This is the single consistent rule for every "selected row leaves
  the visible list" transition (tab switch, unfavorite, search): filter affects
  the list, never the selection. `components-test.ts` asserts a tab switch that
  hides the selected row leaves `selectedConversationId` unchanged.
- **Unfavorite the currently-viewed conversation while in the Favorites tab (M1).**
  Unlike archive — which makes a conversation *unreachable* and therefore
  `clearSelection()`s it (`client.ts:935`) — unfavoriting does **not** clear the
  selection. The right pane stays open on the (now-unfavorited) conversation and
  the tab does **not** auto-switch; only the row disappears from the filtered
  list. Rationale: the conversation is still fully reachable (switch to All, or
  it stays open), so evicting the open pane would be surprising data-loss-of-
  context. Concretely: `unfavoriteConversation(id)` calls **only** `setFlag` — it
  adds no `clearSelection` side effect (contrast `setArchived`, which conditionally
  clears). The selected-but-filtered-out row remains the chat pane's subject until
  the user navigates away. `components-test.ts` asserts: unfavoriting the selected
  row in Favorites view removes it from the list while `selectedConversationId`
  is unchanged. This closes the §7 "no undefined combination" gap for the
  selection-transition case, not just static placement.
- **Search** composes with the tab: the existing search query filters within the
  current tab's set.
- The tab lives in the left panel and must match the panel's visual language
  (this is the primary new UI surface — frontend-design skill drives its look,
  §4).

### 3.6 Cross-tab sync (storage listener)

The existing `storageListener` reacts only to `archivedStorageKey`. Generalize it
to react to all four keys:

- On a `storage` event, match `event.key` against each of the four store keys for
  the current session; when matched and `event.newValue !== null`, parse and
  `patch` the corresponding set.
- Preserve the archive-specific side effect: when another tab archives the
  currently-viewed conversation, `clearSelection()` (existing behavior).
- **Unread-override cross-tab:** if another tab marks the viewed conversation
  unread, no deselect is needed (it's a soft marker) — just patch the set. If
  another tab opens (reads) it, the override clears via that tab's write, which
  this tab picks up.
- `event.newValue === null` (key removed) is currently ignored for archive; keep
  that behavior for all four (a cleared key is rare — sign-out path removes
  session but the listener is torn down on logout anyway).

## 4. UI / frontend-design

The **segmented All | Favorites tab** and the **expanded context menu** are the
new visible surfaces. During implementation, invoke the **frontend-design skill**
to drive the *visual* design. The **accessibility/interaction contract below is
NOT delegated** — it is a fixed acceptance criterion (round-3 Codex-major: "a
skill invocation is not an executable success criterion").

- The segmented-tab control:
  - **A11y/interaction contract (pinned, testable):** two native `<button
    type="button">` elements inside a container labelled `aria-label="Filter
    conversations"`. Each button carries `aria-pressed={active}` reflecting the
    current view (`"all"` / `"favorites"`) and text labels "All" / "Favorites".
    Activation is native button semantics — `Tab` moves focus between the two,
    `Enter`/`Space` activates, and focus **remains on the activated button** after
    the view switches (no focus loss to `document.body`). No arrow-key roving and
    no ARIA `tablist`/`tab`/`tabpanel` roles: the control filters a list, it does
    not swap tabpanels, and the codebase uses plain `aria-pressed`/`aria-label`
    buttons throughout (no existing tablist pattern to match). `components-test.ts`
    asserts: both buttons present, `aria-pressed` tracks the active view, clicking
    "Favorites" filters the list and sets `aria-pressed="true"` on it, and focus
    stays on the clicked button.
  - **Visual (frontend-design):** styling, active-state treatment, placement
    relative to the header + search, mobile behavior. Must read as native to the
    existing `mj_RoomList*` / `mx_LeftPanel*` visual system, not a bolted-on
    control — but must not alter the a11y contract above.
- The context-menu additions (Pin/Unpin, Add/Remove Favorites, Mark unread):
  ordering, icons, separators. Keep the existing menu's role="menu" semantics,
  arrow-key navigation, focus-restore-after-action, and long-press/right-click
  parity (all already implemented in `ConversationList`).
- Row affordances: pin glyph on pinned rows, star on favorited rows, dot for
  override-unread rows. These must not crowd the existing name/preview/unread-badge
  layout.

New icons needed in `icons.tsx` (match the existing `<Icon>` wrapper, 24×24,
`currentColor` stroke): **PinIcon**, **UnpinIcon** (or one pin icon toggled),
**StarIcon** / **StarFilledIcon**, **MarkUnreadIcon**.

New CSS in `journal.pcss` alongside the existing `.mj_RoomList*`,
`.mj_RoomItemMenu*`, `.mj_UnreadBadge`, `.mj_RoomListText_unread` classes.

## 5. Testing

Jest + jsdom, `pnpm test`. `client-test.ts` and `archive-test.ts` have a rich
existing pattern for the state/persistence layer (mock `Storage.prototype`,
`getSnapshot()` assertions) to follow. **`components-test.ts` does NOT have an
existing `ConversationList` render/menu pattern to mirror** (round-2 Claude
minor) — its only archive-adjacent tests cover the upload-modal's "archived in
another tab" error banner, not list rendering or the room-item menu. The M1 / M2
/ tab-filter / menu-visibility tests below require **new render-test scaffolding**
(a `createRoot`/`act` harness around `ConversationList`); budget for authoring it,
not copying a template.

**client-test.ts** (state + persistence):
- Pin/unpin persists to the pinned key and patches `pinnedIds`; survives a
  re-read (round-trip). Malformed/non-array stored value → ignored (empty set),
  same as archive.
- Favorite/unfavorite persists + patches `favoriteIds`.
- Mark-unread adds to `unreadOverrideIds` and persists.
- **B1 — `markConversationRead` on an override-only row (unread_count 0) clears
  the override** (the restructured guard); on a real-server-unread row it both
  flushes the read marker AND clears any override; on a genuinely-read row with
  no override it is a no-op (no write).
- **B2 — user-initiated `selectConversation(id, { clearUnread: true })` clears
  the override; programmatic `selectConversation(id, { clearUnread: false })`
  (the `startSession` bootstrap AND `replaceSnapshot` restore paths) does NOT** —
  a marker survives BOTH a simulated reload (`startSession` re-selects the stored
  conversation) and a simulated reconnect (`replaceSnapshot`). Cover both call
  sites (`client.ts:898` / `:969`), not just reconnect (round-4 Codex).
- **`markAllRead()` per-row mechanism (round-2/3):** visits active
  effectively-unread rows only (gate `effectiveUnread(c) && !archived`), delegating
  each to `markConversationRead` — clears active override-only rows AND flushes
  server unread, with NO separate bulk write. **Leaves an archived conversation's
  override intact** (mark unread → archive → mark-all → override survives;
  unarchive shows it still marked). Assert per-row storage writes, not a bulk set.
- **Round-4 — mark-all batch error aggregation:** a mixed batch where one active
  row's `setItem` throws and another succeeds ends with `controlError` set to the
  batch message (deterministic regardless of row order — no masking, no stale
  error after a fully-successful pass).
- **Codex-M1 — `setFlag` aborts on read failure:** with a pre-populated flag set
  and `getItem` throwing, toggling one id sets `controlError` and does NOT persist
  a set that drops the other ids (no clobber).
- **Codex-M2 — mark-read compound failure:** on a both-unread row with `setItem`
  throwing, `markConversationRead` still calls `scheduleRead`, sets `controlError`,
  and leaves the override in place.
- `effectiveUnread` truth table (server unread only / override only / both / neither).
- `hasActiveUnread`-equivalent includes override-unread rows (mark-all button logic).
- Storage-listener: a foreign-tab write to each of the four keys patches the
  right set; archive-key write still deselects the viewed archived convo.
- **Codex-M2 — read-failure preservation:** when `store.read` returns `ok:false`
  (throwing `localStorage.getItem`), `replaceSnapshot` keeps the prior in-memory
  set for each flag rather than emptying it (assert pins/favorites/overrides
  survive a snapshot swap under storage failure).
- Storage-unavailable on **write** (throwing `setItem`) → `controlError` set, no
  crash (mirror archive's storage-failure test).
- **Regression (scoped):** the factory refactor keeps the archive **persistence**
  assertions passing without edits (key string unchanged; `storedArchivedIds` /
  `storeArchivedIds` / `archivedStorageKey` wrappers preserved per §3.1). The
  `archiveError`→`controlError` rename (§3.2) **does** require mechanical edits to
  `archive-test.ts` lines 216/220/238/262 (assertions on the state field) plus the
  production sites `client.ts:73` and `components.tsx:558`. Those edits are
  expected, enumerated, and verified by `pnpm lint:types` (a missed reference is a
  compile error). No claim of globally-unchanged archive tests.

**components-test.ts** (render + menu):
- Menu shows Pin when unpinned, Unpin when pinned; Add/Remove Favorites; Mark
  unread when read (and non-archived), Mark read when effectively unread.
- Pinned rows render before unpinned in the active list.
- Favorites tab filters to favorited rows; All tab shows all + archived section;
  Favorites view hides the archived section; empty-favorites empty state.
- **M1 — unfavoriting the selected row in Favorites view removes it from the list
  while `selectedConversationId` is unchanged** (no `clearSelection`).
- **M2 — override-unread row exposes an accessible name** (`aria-label`
  containing "marked unread" on the dot or row) and renders **no** numeric badge.
- **Round-3 — tab switch leaves selection intact:** with a non-favorite
  conversation selected, switching to Favorites hides its row but
  `selectedConversationId` is unchanged (the tab is a list filter, §3.5).
- **Round-3 — segmented-control a11y:** both All/Favorites buttons render with
  `aria-pressed` tracking the active view; clicking "Favorites" sets its
  `aria-pressed="true"`, filters the list, and leaves focus on the clicked button
  (§4 contract).

## 6. File-size / structure note

`client.ts` (~1.4k lines) and `components.tsx` (~1.9k lines) are already flagged
as split candidates (son-of-anton loop #448, P18 debt). This feature adds the
`IdSetStore` factory + three stores + setters to `client.ts` and the tab + menu
items + row affordances to `components.tsx`. To avoid worsening the debt:

- Put the `IdSetStore` factory and the four store instances in a new
  `src/journal/conversation-flags.ts` module (pure functions, no client
  coupling) — `client.ts` imports and uses them. This is a net structural
  improvement (extracts persistence from the god-object) rather than growth.
- Keep the tab as a small extracted component if it exceeds ~40 lines inline.

Full component/client splits remain out of scope (that's the separate #448 loop);
this feature just avoids piling onto the god-objects.

## 7. Risks & edge cases

- **Refactor regression on archive.** The factory refactor of archive is the
  highest-risk change (touches shipped, operator-verified behavior). Mitigation:
  key string unchanged (no data migration), preserve `storedArchivedIds` /
  `storeArchivedIds` / `archivedStorageKey` export wrappers so their persistence
  assertions pass unedited (§3.1 scoped-unchanged), and keep the archive
  storage-listener deselect side effect.
- **`archiveError` → `controlError` rename** ripples to `types.ts:186`,
  `client.ts` (`:73`, `:340`, `:919`, `:930`, `:934`), `components.tsx:558`, and
  `archive-test.ts` (assertions `:216/:220/:238/:262`). Do a `grep archiveError`
  sweep across `src/` + `test/`; mechanical but must be complete (fail-loud: a
  missed reference is a type error, caught by `pnpm lint:types`). These edits are
  enumerated so §5's scoped-unchanged claim doesn't contradict the rename.
- **Menu height / positioning.** The menu already clamps to the viewport
  (`useLayoutEffect` in `ConversationList`); adding 2-3 items is within the
  existing clamp logic — verify on a short viewport that the clamp still keeps it
  on-screen.
- **Pin + Favorites + Archive interaction matrix.** A convo can be
  pinned+favorited+archived simultaneously. Static placement: archived → archived
  section (pin/fav ignored for placement, retained as state); active+pinned →
  top; Favorites view → favorited active rows, pin-sorted. **Selection
  transitions** (round-1 M1): archiving the viewed convo clears selection
  (existing); unfavoriting the viewed convo does NOT (§3.5); marking the viewed
  convo unread does not affect selection. No undefined combination.
- **`markAllRead` single-mechanism + batch error** (round-3/4 Codex): iterates
  active effectively-unread rows and delegates each to `markConversationRead` — NO
  separate bulk prune-and-write (that created undefined per-row-vs-bulk ordering
  and a stale-bulk-write cross-tab race). Per-row clears re-read storage
  (last-writer-wins, §3.1). Archived overrides survive within a tab's view (the
  cross-tab foreign-archive race is the accepted §3.1 last-writer-wins limitation,
  not an atomic invariant). `controlError` is aggregated: one authoritative final
  patch set-if-any-row-failed, so a trailing success can't mask an earlier failure.
- **Favorites tab = list filter only** (round-3 Codex): switching tabs never
  changes `selectedConversationId` or the right pane; a selected row outside the
  filter stays open but unlisted — same rule as search and unfavorite-while-viewing.
- **Segmented-control a11y is a fixed contract, not delegated** (round-3 Codex):
  two `aria-pressed` buttons, native focus, tested in §5 — frontend-design owns
  visuals only.
- **Storage-failure sub-paths** (round-2 Codex): `setFlag` aborts on a failed
  read (no clobber, §3.2); `markConversationRead`'s override-clear is best-effort
  and the server flush proceeds regardless (§3.3); `replaceSnapshot` preserves
  prior in-memory sets on a failed re-read (§3.2). All surface `controlError`.
- **Programmatic reselection dropping mark-unread** (round-1 B2): the
  `startSession` / `replaceSnapshot` restore paths pass `{ clearUnread: false }`
  so a load / reconnect doesn't wipe the marker. Regression-guarded by a
  client-test simulating reconnect.
- **`markConversationRead` guard** (round-1 B1): restructured to existence-check +
  always-clear-override + conditional server flush, so "Mark as read" works on
  override-only rows (unread_count 0).
- **Storage-read failure vs empty set** (round-1 Codex-M2): `IdSetStore.read`
  returns `{ ids, ok }`; re-read paths preserve prior in-memory state on
  `ok:false` so a transient storage error during `replaceSnapshot` can't wipe all
  four sets. Cross-tab writes are **last-writer-wins** (§3.1), matching archive.
