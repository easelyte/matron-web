---
title: Session controls v2 — Pin, Favorites (tab + star), Mark read/unread
date: 2026-07-18
status: draft
revision: 1
review_rounds: 0
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
    read(session: Session): Set<string>;          // storage-unavailable-safe, tolerant parse
    write(session: Session, ids: Set<string>): void;
    parse(raw: string | null): Set<string>;       // reused by the storage listener
}

function makeIdSetStore(keyPrefix: string, label: string): IdSetStore { ... }
```

- `parse` = current `parseArchivedValue` logic (JSON → filter string[] → Set;
  malformed / non-array → `console.warn("matron: malformed ${label} value, ignoring")` + empty set).
- `read` = current `storedArchivedIds` logic (try/catch around `getItem`, warn on
  storage-unavailable, empty set).
- `write` = `setItem(key, JSON.stringify([...ids]))`.
- `storageKey` = `${keyPrefix}:${encodeURIComponent(session.serverUrl)}:${session.userId}`.

Instantiate four stores with these exact key strings:

| Store        | Key prefix (localStorage)                              | Notes |
|--------------|--------------------------------------------------------|-------|
| archive      | `matron_journal_archived_conversations_v1` (UNCHANGED) | Refactored onto the factory; key string identical → **zero data migration** for existing persisted archive state. |
| pinned       | `matron_journal_pinned_conversations_v1`               | new |
| favorite     | `matron_journal_favorite_conversations_v1`             | new |
| unread-override | `matron_journal_unread_conversations_v1`            | new |

**Refactoring archive onto the factory is required for B** (that's the DRY win),
and is safe precisely because the key string does not change — already-persisted
`archivedIds` in operators' browsers continue to load. The existing exported
functions (`archivedStorageKey`, `storedArchivedIds`, `storeArchivedIds`) that
tests import stay as thin wrappers over the archive store instance (preserve the
export surface so `client-test.ts` keeps compiling), OR the tests are updated —
prefer keeping the wrappers to minimize test churn (see §5).

### 3.2 Client state + setters

`ClientState` (`types.ts`) gains three sets mirroring `archivedIds`:

```ts
pinnedIds: Set<string>;
favoriteIds: Set<string>;
unreadOverrideIds: Set<string>;
```

`blankState()` initializes all three to `new Set()`. Session bootstrap
(`resumeSession` / snapshot replace) reads all four stores and seeds state, same
as `archivedIds` is seeded today.

A single generic setter replaces per-flag duplication:

```ts
private setFlag(store: IdSetStore, stateKey: "pinnedIds" | "favoriteIds" | "unreadOverrideIds",
                conversationId: string, on: boolean): void
```

- Re-reads current set from storage (guards against another tab's write),
  mutates, writes back, `patch({ [stateKey]: next })`.
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
// markConversationRead(id) already exists — extend it to also clear the override
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
  no number to show).
- **Clearing the override:**
  - `selectConversation(id)` removes `id` from `unreadOverrideIds` (persist) —
    opening the conversation clears the marker. This runs alongside the existing
    read-scheduling on select.
  - `markConversationRead(id)` (menu "Mark as read") also removes `id` from the
    override, in addition to its existing server-unread flush.
  - `markAllRead()` clears `unreadOverrideIds` entirely (in addition to flushing
    server unread on each active row).
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
    row). Archived rows: mark-unread offered the same as active rows? Keep it
    simple — **mark read/unread offered for active rows only** (archived rows get
    Unarchive; the read affordances stay scoped to the active partition as today,
    where "Mark as read" is already gated on `!archivedIds.has(id)`).
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
to drive:

- The segmented-tab control: styling, active-state, keyboard/focus behavior,
  placement relative to the header + search, mobile behavior. Must read as native
  to the existing `mj_RoomList*` / `mx_LeftPanel*` visual system, not a bolted-on
  control.
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

Mirror the existing archive tests in `test/unit-tests/journal/client-test.ts`
and `components-test.ts` (Jest + jsdom, `pnpm test`):

**client-test.ts** (state + persistence):
- Pin/unpin persists to the pinned key and patches `pinnedIds`; survives a
  re-read (storedPinnedIds round-trip). Malformed/non-array stored value →
  ignored (empty set), same as archive.
- Favorite/unfavorite persists + patches `favoriteIds`.
- Mark-unread adds to `unreadOverrideIds` and persists; `selectConversation`
  clears it; `markConversationRead` clears it; `markAllRead` clears all overrides.
- `effectiveUnread` truth table (server unread only / override only / both / neither).
- `hasActiveUnread`-equivalent includes override-unread rows (mark-all button logic).
- Storage-listener: a foreign-tab write to each of the four keys patches the
  right set; archive-key write still deselects the viewed archived convo.
- Storage-unavailable (throwing `localStorage`) → `controlError` set, no crash
  (mirror archive's storage-failure test).
- **Regression:** existing archive tests still pass after the factory refactor
  (archive key string unchanged; `storedArchivedIds`/`storeArchivedIds` wrappers
  preserved OR tests updated — prefer wrappers).

**components-test.ts** (render + menu):
- Menu shows Pin when unpinned, Unpin when pinned; Add/Remove Favorites; Mark
  unread when read, Mark read when effectively unread.
- Pinned rows render before unpinned in the active list.
- Favorites tab filters to favorited rows; All tab shows all + archived section;
  Favorites view hides the archived section; empty-favorites empty state.
- Override-unread row renders the unread style + dot (no numeric badge).

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
  `storeArchivedIds` / `archivedStorageKey` export wrappers so existing tests
  compile unchanged, and keep the archive storage-listener deselect side effect.
- **`archiveError` → `controlError` rename** ripples to `types.ts`, `client.ts`,
  `components.tsx`, and archive tests. Mechanical but must be complete (fail-loud:
  a missed reference is a type error, caught by `pnpm lint:types`).
- **Menu height / positioning.** The menu already clamps to the viewport
  (`useLayoutEffect` in `ConversationList`); adding 2-3 items is within the
  existing clamp logic — verify on a short viewport that the clamp still keeps it
  on-screen.
- **Pin + Favorites + Archive interaction matrix.** A convo can be
  pinned+favorited+archived simultaneously. Defined: archived → archived section
  (pin/fav ignored for placement, retained as state); active+pinned → top;
  Favorites view → favorited active rows, pin-sorted. No undefined combination.
- **`markAllRead` clearing overrides** must persist the cleared `unreadOverrideIds`
  to storage (not just patch state) or a reload resurrects them.
