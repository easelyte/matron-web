---
title: "Web journal client — subagent sub-chat rendering"
status: draft
date: 2026-07-18
loop: 453
owner: easelyte
approach: "A — full apple/iOS parity minus split-view"
rejected_alternatives:
  - "B (A + desktop split-view): the one real gain — watching parent + child stream simultaneously — is largely nullified by the dominant execution pattern (when a subagent runs, the parent is blocked on the Task tool and produces nothing; by the time the parent resumes, the child is done). Split-view is where ~60% of the work lives (forcing the single-selected-convo store to hold two live convos: events/streams/status/activity keyed by convo_id + a second `viewing` subscription). Deferred to a follow-up loop if parallel-subagent monitoring proves valuable."
  - "C (B + inline tappable subtask markers in the parent timeline): not wire-supported. The bridge publishes the parent's spawn marker as a plain `type:'text'` event `🔀 Subtask: <desc>` carrying no child convo id and no Task `tool_use_id` (index.js:2889 → 4036). There is no correlation key in the parent timeline to anchor a tappable link. Requires a bridge change (cross-repo, serialized separately) + an upstream proposal to Matronhq. Out of scope; file as follow-up."
related_principles:
  - "P2 Canonical Source of Truth — parent_convo_id has one authoritative source (server); client derives children from it, no sync"
  - "P5 / P31 Don't mirror external state — scroll follow-state reads the DOM scroll position, cached minimally, not a full React mirror of the scroll machine"
  - "P13 Global CSS platform interactions — throttle the new scroll handler with rAF; targeted scrollIntoView not global smooth-scroll"
  - "P23 Explicit state machines for async UI — tail-follow is a small explicit state (following / not-following) not a tangle of booleans"
  - "P35 Code-coordinate citations grep-confirmed at write time — all file:line refs below verified against HEAD ccca0fd"
constraint: "components.tsx (1874) and client.ts (1395) must NOT be split — matron-web stays structurally aligned with Matronhq/matron-web upstream (memory: project_matron_web_stays_dan_upstream_aligned). All new components/state land INLINE in the existing files."
---

# Web journal client — subagent sub-chat rendering

## 1. Problem & goal

The matron-web journal client renders subagent child-conversations as **flat, top-level sibling rows** in the conversation list — indistinguishable from root conversations, with no way to see which subagents a session spawned or to follow one while it runs. This is the biggest remaining apple-parity gap (loop #453).

The data to fix it already flows end-to-end (bridge #141 + journal server), but the web client has **zero** `parent_convo_id` handling. The goal is to reach parity with the apple client's iOS surface: children are grouped under their parent, hidden from the main list, and reachable through a running-subagent strip + a header switcher + a read-only child viewer, with proper tail-follow and a jump-to-bottom control.

**Parity target = apple iOS behavior** (push-navigation model). The apple Mac split-view is explicitly a non-goal for this iteration (see rejected alternative B).

## 2. What already works (no server/bridge change needed)

Verified against the journal server (`/opt/matron/journal`, Node) and the bridge (`/opt/matron/bridge-journal`, journal-deploy):

- **Snapshot payload** — every convo in `GET /snapshot` carries `parent_convo_id` (`journal.js:139-144`). NULL for normal convos; set for children.
- **Live `convo_meta` event** — emitted on child creation/title change with `payload: { title, parent_convo_id }` (`ws.js:557-562`). The bridge forces this even titleless so a live client links the child immediately rather than waiting for the next snapshot.
- **`session_state`** on each convo = `"running"` | `"done"` — drives the running/finished distinction. The web client already updates it **live** from a durable `session_status` journal event (`database.ts:192-193`, `conversation.session_state = payload.state`), so a child's running→done transition propagates without new plumbing — the same mechanism the apple client's `isRunning` relies on. **VERIFIED (round-1 code trace), not an open assumption:** the bridge's `finish(agentId)` (`subagent-convos.js:150-155`) calls `upsertConvo(childId, { sessionState: 'done' })` → `convo_upsert` WS frame (`journal-publisher.js:568-587`) → the journal server mints a durable, fanned-out `session_status` event (`ws.js:521-553`, `appendAndFan({ type:'session_status', payload:{ state } })`) into the child convo — exactly the event `database.ts:192-193` consumes. `finish()` fires from all three completion paths (`noteTaskResult` sync, `noteTaskCompleted` background, `finishAll` teardown). So the running-pill-disappears and switcher running/finished behavior is wire-backed, and the "no new server/bridge dependency" acceptance holds. **Bounded exception** (see §6): sync-Task FIFO pairing is best-effort (`subagent-convos.js:60-68`) — a mispaired or nested child can stay `running` until `finishAll` at parent teardown.
- **Server already treats children as silent** — no unread badge bump, no push, read-marker recompute skips them (`journal.js:109-117, 193`; `push.js:160-167`). The client mirrors this defensively but does not depend on it.
- **Linkage is child→parent only** (structural). The parent timeline's `🔀 Subtask` line is cosmetic text with no child id — which is exactly why inline tappable markers (alternative C) are out of scope.

**Child convo id convention:** `<parentConvoId>:sub:<agentId>` (bridge `subagent-convos.js:22`). Nesting works at any depth — a grandchild's `parent_convo_id` is simply its parent-child's id. The design must not assume children are leaves.

## 3. Current web-client architecture (the seams we build on)

All paths under `src/journal/`. Verified against HEAD `ccca0fd`.

- **Data model** — `Conversation` (`types.ts:38-48`) has no parent field. `SnapshotResponse` (`types.ts:50-53`). `ClientState` (`types.ts:180-203`) is a single flat immutable store object holding `conversations: Conversation[]`, `selectedConversationId?`, `events: JournalEvent[]`, and single-valued ephemeral fields (`activity`, `sessionStatus`, `textStreams`, `toolStreams`).
- **Store** — `MatronJournalClient` (`client.ts`), a hand-rolled external store exposed via `useSyncExternalStore` (`components.tsx:1865`). All mutation flows through `patch()` (`client.ts:1375`). Convos persist in IndexedDB (`database.ts`, `conversations` object store keyPath `id`).
- **Ingestion** — live events → `handleJournal` → `database.applyJournal` (`database.ts:167-215`), which already special-cases `convo_meta` for `title` (`database.ts:190`) and mints new convo records via `emptyConversation` (`database.ts:36-48`). Bootstrap → `api.snapshot()` → `database.replaceWithSnapshot` (`database.ts:106-126`, spreads `...summary`). Then `refreshConversations` (`client.ts:1211`) re-reads the DB into state.
- **Selection** — `selectConversation(id)` (`client.ts:305`) sets `selectedConversationId`, clears `events`, sends `{ op: "viewing", convo_id: id }` over the socket (`client.ts:321`) so the server replays that convo's ephemeral status/streams, and loads history. `clearSelection()` (`client.ts:330`) returns to the list. `selectedConversation()` returns the selected convo record.
- **Main list** — `ConversationList` (`components.tsx:247`) derives its rows from a `useMemo` over `state.conversations` (search filter, `components.tsx:375`), then partitions pinned/active/archived; `renderConversation` rows call `client.selectConversation(id)`.
- **Main pane** — `SignedInApp` (`components.tsx:1788`) renders, for the selected convo, `<ChatHeader>` + `<Timeline>` + `<Composer>` (`components.tsx:1844-1846`). `ChatHeader` (`components.tsx:875`) already has a `mj_BackButton` → `clearSelection()` and reuses `state.sessionStatus` for model/context/usage.
- **Timeline** — `Timeline` (`components.tsx:1346`). A `useLayoutEffect` (`components.tsx:1387-1423`) unconditionally jumps to the bottom on new content; there is **no** user-scrolled-up detection and **no** jump-to-bottom button today.
- **Styling** — plain PostCSS, `journal.pcss` / `shell.pcss`, global `mj_*` (matron-journal) + `mx_*` (element-derived) classes. Reusable: `mj_ChatHeader`, `mj_HeaderTitleCluster`, `mj_ModelContextCluster`, `mj_BackButton`, `mj_HeaderMenu`.
- **Tests** — Jest + jsdom, `test/unit-tests/`, `pnpm test` (`--runInBand`).

## 4. Design

Four inline additions, all within `types.ts` / `database.ts` / `client.ts` / `components.tsx` / `journal.pcss` (no file splits):

### 4.1 Data model — carry `parent_convo_id`, set-once-immutable

Add to `Conversation` (`types.ts:38`):

```ts
export interface Conversation {
    // …existing fields…
    parent_convo_id?: string | null; // null/undefined = top-level; set once at child creation, immutable
}
```

`SnapshotResponse` needs no change — its `conversations` are `Conversation` objects, and `replaceWithSnapshot` already spreads `...summary`, so the field flows through to IndexedDB once the type carries it.

**Ingestion (`database.ts`):**

- `emptyConversation` (`database.ts:36`) initializes `parent_convo_id: null`.
- `applyJournal` `convo_meta` branch (`database.ts:190`): **the current guard is `if (event.type === "convo_meta" && typeof event.payload.title === "string")` — it skips a titleless `convo_meta` entirely.** But the bridge deliberately sends a **titleless** `convo_meta` carrying only `parent_convo_id` as the primary live child-link signal (§2). So the guard must be relaxed to `event.type === "convo_meta"`, with the title check moved inside. Then extract `parent_convo_id` and apply the **immutability rule** — set only when not already set; a later `convo_meta` lacking the field (or carrying null) must **not** clear a previously-set value:

  ```ts
  if (event.type === "convo_meta") {
      if (typeof event.payload.title === "string") conversation.title = event.payload.title;
      const incoming = coerceParentId(event.payload.parent_convo_id); // string | null
      if (conversation.parent_convo_id == null && incoming) {
          conversation.parent_convo_id = incoming;
      }
  }
  ```

  This mirrors the apple client's set-only-when-nil rule (JournalStore.swift:258-263, 346-348) and prevents a titleless meta from de-linking a child. `coerceParentId` is the same shared boundary parser used by `replaceWithSnapshot` (below).

- `replaceWithSnapshot` (bootstrap, no cursor): snapshot is authoritative, but **the two ingestion paths must validate identically** (M1 — P8 Guard Boundary Inputs / P33 Parse-Don't-Validate). The live `convo_meta` path guards for a non-empty string; the snapshot path currently spreads `...summary` raw (`database.ts:119`), so a malformed `parent_convo_id` (e.g. `0`, an object, or a whitespace-only `"  "`) would pass `isSubChat` (non-null/non-empty) yet never match `childrenOf` — hiding the convo from the list while making it unreachable. Factor the check into a shared boundary parser used by **both** `applyJournal` and `replaceWithSnapshot` so they cannot drift, and **trim** so whitespace-only never counts as a link:

  ```ts
  export function coerceParentId(x: unknown): string | null {
      const s = typeof x === "string" ? x.trim() : "";
      return s || null;
  }
  ```

**IndexedDB compatibility:** the `conversations` store has keyPath `id` and stores whole objects (`database.ts:77-78`); a new optional field is backward-compatible — existing records lack it → `undefined` → treated as top-level. **No schema-version bump.**

### 4.2 Derivations — client-side, from `state.conversations`

Because all convos (parents and children) live in `state.conversations`, the parent→child relationships are derived, never stored separately (P2 — one source of truth). Add small pure exported helpers (co-located with the other convo helpers in `types.ts`, imported where needed — they are reused by both `ConversationList` and the parent/child panes):

```ts
export function isSubChat(c: Pick<Conversation, "parent_convo_id">): boolean {
    return c.parent_convo_id != null && c.parent_convo_id !== "";
}

// children of a given convo id, oldest-first (created_at ASC, id ASC tiebreak).
// parentId accepts null/undefined (returns []) so call sites can pass
// selectedConversationId (string | undefined) or child.parent_convo_id without a tsc cast.
export function childrenOf(conversations: Conversation[], parentId: string | null | undefined): Conversation[] {
    if (!parentId) return [];
    return conversations
        .filter((c) => c.parent_convo_id === parentId)
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function runningChildrenOf(conversations: Conversation[], parentId: string | null | undefined): Conversation[] {
    return childrenOf(conversations, parentId).filter((c) => c.session_state === "running");
}

// True iff the given child's parent record is present. Takes a precomputed id Set
// so callers that filter the whole array stay O(n), not O(n²) (Codex R3-M5):
// build `ids` once per derivation, not once per element.
export function parentPresent(c: Conversation, ids: ReadonlySet<string>): boolean {
    return isSubChat(c) && c.parent_convo_id != null && ids.has(c.parent_convo_id);
}
```

`isLinkedChild` (a child whose parent is present) is the single exclusion predicate used everywhere in §4.3 — an **orphan** (`isSubChat` but parent absent) is never excluded and never blocked, so it stays reachable as a top-level row. Every consumer that filters `state.conversations` first computes `const ids = new Set(state.conversations.map((c) => c.id))` and reuses it across the pass.

Pure functions → unit-testable in isolation, and they keep derivation logic out of the render bodies (P12).

### 4.3 Main-list exclusion — children never appear as top-level rows

In `ConversationList`'s `conversations` `useMemo` (`components.tsx:375`), exclude **linked** children so they never render as top-level rows (mirrors apple's `parent_convo_id IS NULL` list query, `JournalStore.swift:428-430`) — but exclude only children whose parent is present, so an **orphan** (parent pruned/absent) falls back to a top-level row rather than becoming unreachable (B3, §6):

```ts
const conversations = useMemo(() => {
    const ids = new Set(state.conversations.map((c) => c.id));
    return state.conversations
        .filter((c) => !parentPresent(c, ids)) // linked child hidden; orphan falls back to top-level
        .filter(/* existing search filter */);
}, [query, state.conversations]);
```

**Full consumer audit (M2, M1a — the round-1 fix missed two consumers of the raw `state.conversations` array).** Every site that scans `state.conversations` and would act on a child must exclude **linked** children (`parentPresent`, i.e. `isSubChat && parent present`) — **uniformly, so the predicate never contradicts itself** (Codex R3-M2): an orphan is excluded nowhere and remains a valid selection everywhere.
- `hasAnyFavorite` (`components.tsx:392`), `hasActiveUnread` (`components.tsx:399`) — unread/favorite aggregation (already covered round 1).
- `client.markAllRead()` (`client.ts:373`) — iterates all non-archived convos and flushes read state; must `continue` on a linked child, else a child's pre-link unread override gets marked/sent.
- `firstSelectableConversation` (`client.ts:144-153`) — picks the bootstrap/post-resync landing convo (`startSession` `client.ts:905`, `replaceSnapshot` `client.ts:1045`); filtering only `archivedIds` today means the app can auto-open **directly into a linked child** as the home screen, bypassing the parent→strip/switcher→child entry point (§1). Add the `!parentPresent` guard to its fallback `find`. *Decision:* auto-select never lands on a **linked** child (reachable only through its parent), but an **orphan** IS a valid landing convo (it has no parent to reach it from). This is exactly `!parentPresent`, matching the list filter and §7.3.

### 4.4 Running-subagent strip (parent pane)

New inline component `RunningSubagentStrip({ client, state })`, mounted in `SignedInApp` directly above `<Timeline>` (between `<ChatHeader>` and `<Timeline>`, `components.tsx:1844-1845`). It keys on the **selected** convo id (works whether the selected convo is a root or itself a child — nesting):

- `const running = runningChildrenOf(state.conversations, state.selectedConversationId)`.
- Renders nothing when `running.length === 0`.
- Otherwise a horizontal scroll row of capsule pills, one per running child: a small spinner (`mj_Spinner`, CSS-only) + `conversationTitle(child)`. Each pill is a `<button onClick={() => client.selectConversation(child.id)}>` (a11y label `Open subagent <title>`).

The strip is present for both root convos and children, so a child that itself spawned grandchildren shows its running grandchildren.

**Reachability: the strip is running-only, so it is not the entry point for *finished* children.** A subagent that finishes before the user looks (common — subagents are often fast) would otherwise be hidden from the list (§4.3) with no pill and no switcher (which lives inside a child), making its transcript unreachable (Codex R3-B1). So the parent also gets a **subagent switcher button** in its `ChatHeader` — the "sub-chat switcher button" from the parity brief — shown whenever the selected convo has **≥1 child** (running or finished): a `mj_HeaderMenu`-style "N subagents ▾" control listing **all** children oldest-first with running/finished glyphs, each opening that child via `selectConversation`. Two surfaces, both from the apple brief: the strip = at-a-glance *live* status (running only); the header switcher = *reachability* for every child, finished included. Derive its list from `childrenOf(state.conversations, selectedConversationId)`.

### 4.5 Read-only child viewer + mini-header + switcher

In `SignedInApp`, branch the selected-convo pane on `isSubChat(selectedConversation)`:

- **Header:** render a `SubChatHeader` instead of `ChatHeader`. It reuses the `mj_ChatHeader` chrome and `state.sessionStatus` (the server replays the child's status on `viewing`, so model/context/usage are the child's), plus:
  - **Back button** → returns to the **parent**: `client.selectConversation(child.parent_convo_id)` when the parent record exists in `state.conversations`, else `client.clearSelection()` (parent archived/absent fallback).
  - **State label** — `session_state === "running"` → spinner + "Running", else "Finished".
  - **Switcher** — rendered only when the child has **more than one sibling** (`childrenOf(conversations, parentId).length > 1`), matching apple's "siblings > 1" gate. A `mj_HeaderMenu`-style dropdown listing every sibling oldest-first, each a button with a glyph: check = current (disabled), filled dot = other running, hollow dot = finished; selecting → `client.selectConversation(sibling.id)`.
- **Read-only enforcement — three honest layers (P1 — UI Hiding Is Never Authorization).** The web client cannot be *authoritative* on its own (Codex R3-B2: an old PWA tab, a stale client, or any direct WS caller can still `op:"send"` to a child because the protocol is unchanged). So the guarantee is split:
  1. **UI suppression (primary UX — the layer that stops the real, single-user threat: the operator accidentally posting into a subagent transcript).** For a child: don't render `<Composer>` (a muted "Read-only — subagent transcript" hint replaces it); pass `onDrop={childMode ? undefined : onDrop}` on the `mx_RoomView` wrapper (`components.tsx:1823`) so drag never stages; thread an `isReadOnly` prop `Timeline → EventRow → EventContent → PromptCard` (`components.tsx:1113-1119`) so prompt/permission cards render non-interactively; and thread `isReadOnly` to the **`PendingAttachment` chip** (`components.tsx:1267`) so its "Retry" action is hidden for a child (only "Dismiss" remains).
  2. **Client egress guards (defense-in-depth for legacy/stale outbox records the UI can't prevent — the pre-`convo_meta` window, an upgrade, cross-tab).** Round 3 corrected round 2's false claim: there are **two** content-transmit functions, not one — `sendPendingMessage` (`client.ts:1298`; used by `sendMessage` `client.ts:444` + outbox replay `handleReady` `client.ts:1068`) **and** `emitPendingAttachment` (`client.ts:635`; used by attachment first-send `client.ts:620` **and** `retryAttachment` `client.ts:569`). `sendAttachment`/`retryAttachment` do **not** funnel through `sendPendingMessage`. **Gate the invariant at the grep-verifiable set of `op:"send"` transmit sites — exactly three today** (`client.ts:649` in `emitPendingAttachment`; `client.ts:1302` + `client.ts:1312` in `sendPendingMessage`): each enclosing function early-returns when `isSubChat(convo-by message.convoId)`. Plus `sendPromptReply` (`client.ts:824`) on `isSubChat(this.selectedConversation())`, and `stageFiles`/`confirmStagedFile` keyed on **`staged.convoId`** (the upload target), not `selectedConversation()` (M1b). *Ratchet (P17):* a test greps `op: "send"` in `client.ts` and asserts each match is inside a child-guarded function — so a future fourth transmit site can't silently reopen the hole.
  3. **Server-side rejection (authoritative — documented follow-up, out of this web loop's scope).** The journal server's `send` handler (`ws.js:392`) has **no** guard rejecting a write whose target convo has `parent_convo_id` set — verified. The authoritative fix is a ~2-line server change (reject `op:"send"` to a child convo); it lives in `easelyte/matron-journal` (cross-repo, shared server) and is filed as a follow-up loop + upstream proposal, not built here.
- **Fail visible on a blocked send (P3 — never silently delete user data).** When an egress guard blocks a child-targeted outbox record, it must **not** silently drop it (Codex R3-B3 = data loss). Instead: skip transmission, mark the record a **permanent error** (`attachState:"error"`, `canRetry:false`, message "Can't send to a read-only subagent transcript"), and leave it **dismissable**. The record stays visible and diagnosable, and the user has a clear exit — no vanished message.
- **Timeline:** structurally reused, but receives `isReadOnly` when the selected convo is a child. The running-subagent strip (4.4) still mounts above it (grandchildren case).
- **Stale selection on rapid switching (M1 — P23), guarding BOTH the `viewing` frame and the `events` overwrite.** The switcher lets the user hop siblings fast. `selectConversation` (`client.ts:305`) `await`s `refreshSelectedConversation` **before** sending `{ op: "viewing", convo_id }` (`client.ts:320-321`) without rechecking the selection — so selecting A then B, if B's refresh resolves first, sends `viewing B` then a stale `viewing A`, leaving B displayed but unsubscribed. **And** because `refreshSelectedConversation` patches the single shared `state.events`, A's slower refresh can overwrite B's transcript under B's header (Codex R3-M1). Fix both: (a) `refreshSelectedConversation` must patch `events`/`pendingMessages` only if its `conversationId` is still `this.state.selectedConversationId` (a stale-refresh no-op — verify against the existing `expectedId`/`gen` ownership check and extend it to the selection identity if it doesn't already cover a same-generation sibling switch); (b) after the await in `selectConversation`, guard `if (this.state.selectedConversationId !== conversationId) return;` before `viewing` and `scheduleRead`. §7.8 tests both the frame order and that B's events remain displayed.

The parent pane (root or a child-with-children being viewed as a parent) is unchanged except for the strip above the timeline.

**Composition of the selected-convo pane (executable sketch).** All of §4.4–§4.5 lands in the single `mx_RoomView_body` block (`components.tsx:1843-1847`). The `isSubChat` branch swaps the header and composer **inside** the existing `mx_RoomView` wrapper — the wrapper and its drag handlers stay (they are neutralized for children via the `!isSubChat` gate in §4.5.2, not by removing the wrapper), so the drag-gate can't be silently dropped:

```tsx
const selected = client.selectedConversation();
const childMode = selected != null && isSubChat(selected);
// …inside <div className="mx_RoomView" onDrop={childMode ? undefined : onDrop} …>
<div className="mx_RoomView_body mx_MainSplit_timeline" data-layout="bubble">
    {childMode ? <SubChatHeader client={client} state={state} /> : <ChatHeader client={client} state={state} />}
    <RunningSubagentStrip client={client} state={state} />   {/* renders null when no running children */}
    <Timeline client={client} state={state} isReadOnly={childMode} />
    {childMode ? <ReadOnlyHint /> : <Composer client={client} state={state} />}
</div>
```

### 4.6 Tail-follow + jump-to-bottom (Timeline)

Replace the unconditional jump-to-bottom with an explicit follow-state (P23), matching apple's model:

- State (component-local `useState`/`useRef`, not global store): `isFollowingTail` (default `true`).
- A pure decision helper `isNearBottom(scrollTop, scrollHeight, clientHeight, thresholdPx)` (exported, unit-tested; keeps the math out of the effect). **`thresholdPx` default = 80** (`distanceFromBottom = scrollHeight - scrollTop - clientHeight <= 80`) — small enough to not fire on a genuine scroll-away, large enough to survive sub-pixel/momentum jitter.
- A scroll handler on the message-panel node, throttled with `requestAnimationFrame` (P13): sets `isFollowingTail = isNearBottom(...)` — scrolling up disables follow, scrolling back to the bottom re-enables it.
- **rAF-frame staleness across convo switch (M4 — P23).** The pending rAF handle is stored in a ref and **cancelled on cleanup** (`cancelAnimationFrame` in the scroll-effect teardown, which re-runs on `selectedConversationId` change), and the queued callback also **early-returns if the convo changed** (it captures the `selectedConversationId` it was queued under and compares to current). Otherwise a frame queued just before a switch could run after the switch's `isFollowingTail = true` reset and flip it back to `false` against the newly-mounted panel.
- The existing `useLayoutEffect` (`components.tsx:1387`) jumps to bottom **only when `isFollowingTail`**. The history-prepend anchor branch is preserved. **A new reset effect keyed on `selectedConversationId` must be _added_** (not "preserved" — `isFollowingTail` is brand-new state) that force-follows the newly selected convo (`isFollowingTail = true`).
- **Own-send force-follow needs an explicit signal wired at the exact call sites (M3/M2 — P14).** `isFollowingTail` is local to `Timeline`, but sends originate outside it (`Composer` → `sendMessage`; attachment `confirmStagedFile` via `UploadConfirmDialog`). Deriving from `pendingMessages.length` is unreliable (a pending item can be acknowledged as another is inserted → length unchanged). Add a monotonic `sendTick: number` to `ClientState` (`types.ts:180`) **and initialize `sendTick: 0` in `blankState()` (`client.ts:80`)**. Bump it with `this.patch({ sendTick: this.state.sendTick + 1 })` **at the three concrete local-send call sites — `sendMessage` (`client.ts:432`), `confirmStagedFile` (`client.ts:708`), `retryAttachment` (`client.ts:528`)** — **NOT** inside `refreshSelectedConversation` / a generic `patch()` hook: `sendMessage` delegates its state update through `refreshSelectedConversation`, which **also runs on every incoming live journal event** (`handleJournal`, `client.ts:1122-1128`), so bumping there would force-follow on every agent line and defeat the feature for a streaming transcript. `Timeline` watches `state.sendTick` in an effect: on increment, **cancel any pending scroll rAF frame** (`cancelAnimationFrame` on the stored handle — otherwise a same-convo frame queued while scrolled-up can run *after* the send effect and flip follow back off from its stale measurement, Codex R3-M4), then set `isFollowingTail = true` and scroll to bottom. Single-writer monotonic signal; the deliberate store-level exception to "component-local state" above, because the producer is cross-component.
- **Jump-to-bottom button** — a bottom-trailing overlay (`mj_JumpToBottom`, `↓`), shown **only when `!isFollowingTail`**. Click → set `isFollowingTail = true` and `node.scrollTop = node.scrollHeight` (targeted, not global smooth-scroll).

This is the same enhancement for root and child timelines (the child viewer reuses `Timeline`) — and it is most valuable precisely for a long-running subagent transcript streaming output, which is why it lives in this spec rather than a follow-up.

### 4.7 Styling

New `mj_*` classes in `journal.pcss` (no Tailwind): `mj_SubagentStrip`, `mj_SubagentPill`, `mj_Spinner`, `mj_SubChatHeader` (or reuse `mj_ChatHeader` + a `mj_SubChatState` label), `mj_SwitcherMenu` / reuse `mj_HeaderMenu`, `mj_JumpToBottom`. CSS-only spinner (no JS animation).

### 4.8 Existing-client backfill (one-time)

**The problem (B1).** `startSession` fetches `/snapshot` **only when no cursor exists** (`client.ts:866`, `if (cursor === undefined)`). An already-installed client (the operator's own PWA) has a cursor **and** historical child-convo records in IndexedDB that the old client stored **without** `parent_convo_id` (it never parsed the field — even though `convo_meta` carried it after bridge #141). On upgrade those children would stay top-level and writable forever — breaking grouping and read-only for exactly the real user. "No IndexedDB **schema**-version bump" (§4.1) is true (the object-store shape is unchanged), but a one-time **data** backfill is still required.

**The fix.** A meta-keyed, run-once reconcile. In `startSession`, after opening the DB, if the `meta` key `subchat_backfill_v1` is absent, fetch `/snapshot` and **merge** each summary's `coerceParentId(parent_convo_id)` and `session_state` onto the existing conversation record (update fields only — do **not** touch stored events or the cursor), then set the key. Bounded (one snapshot, one pass), idempotent (keyed), reuses the authoritative source (the snapshot already carries `parent_convo_id` for every convo, `journal.js:139-144`). Fresh installs are unaffected (they already `replaceWithSnapshot` on the `cursor === undefined` path; set the key there too).

**Failure semantics (Codex R3-M3 — P3 Fail Visible / V6 Classify Errors).** The completion key is load-bearing: committing it after a partial merge would suppress future repair forever. So: run the merge + key-set **inside a single IndexedDB transaction** (all records + the key commit atomically, or none do). Classify the snapshot fetch — **transient** failure (timeout, 5xx, offline) → do **not** set the key; leave existing children as reachable orphans (§6) and retry the backfill on the next startup. **Permanent** failure (malformed snapshot) → log visibly, still don't set the key. Startup never wedges on backfill failure: the app proceeds with the incremental cursor path; unlinked children stay top-level and reachable until a later startup completes the backfill. The backfill is best-effort-but-eventually-consistent, never silently-half-done-then-sealed.

## 5. Non-goals (explicit)

- **Desktop split-view** (parent + child side-by-side) — rejected alternative B; a follow-up loop if parallel-subagent monitoring proves valuable. Its cost is real: the single-selected-convo store would have to hold two live convos (events/streams/status/activity keyed by convo_id + a second `viewing` op), and its gain is largely nullified by the blocking-Task execution pattern.
- **Inline tappable subtask markers** in the parent timeline — rejected alternative C; not wire-supported (the parent `🔀 Subtask` event carries no child id / `tool_use_id`). Needs a bridge change + Matronhq upstream proposal. File as a follow-up loop.
- **Splitting `components.tsx` / `client.ts`** — forbidden by the upstream-alignment constraint. All additions are inline. **Accepted P18 (Cognitive Budget) exception:** adding the strip/header/switcher/tail-follow inline pushes `components.tsx` further past the ~400-line guideline. This is a deliberate, operator-decided tradeoff (memory `project_matron_web_stays_dan_upstream_aligned`) — divergence from Dan's upstream layout taxes every future merge, so the split is proposed **upstream** (loop #448, `type: operator`) rather than forked locally. Not re-litigated per-feature.
- **Push notifications for children** — server already suppresses; no client work.
- **Authoritative server-side read-only enforcement** — the journal server's `send` handler (`ws.js:392`) does not reject writes to a child convo, so client-side read-only is defense-in-depth, not authoritative (§4.5, Codex R3-B2). The ~2-line server guard (reject `op:"send"` where the target convo has `parent_convo_id` set) lives in `easelyte/matron-journal` (cross-repo, shared server) and is a **follow-up loop + Matronhq upstream proposal**, not built here. The single-user threat model (the operator's own journal; the real risk is an *accidental* self-send, fully covered by the UI suppression layer) makes this acceptable for the web loop.

## 6. Error handling & edge cases

- **Immutability** — a `convo_meta` with null/absent `parent_convo_id` never clears a set value (§4.1). A snapshot at bootstrap is authoritative (fresh DB).
- **Parent absent / orphan child** — a child whose parent record is not in `state.conversations` (pruned/archived) is an **orphan**. It is **not** hidden (§4.3 excludes only children with a present parent, via `parentPresent`), so it falls back to a normal top-level row and stays reachable — never a vanished transcript (B3). If such a child is opened, its back button falls back to `clearSelection()`, and the switcher still works among any siblings that share its `parent_convo_id`.
- **Existing-client upgrade** — historical child records stored without `parent_convo_id` by the old client are reconciled once via the §4.8 backfill; until it runs (first startup post-upgrade) they render as orphans (top-level, reachable), not lost.
- **Only child** — `childrenOf(...).length === 1`: the in-child sibling switcher is hidden (siblings ≤ 1); back + title only. The **parent** header switcher (§4.4) still shows for a single child (its gate is ≥1 child, not >1), so a lone finished child is reachable.
- **Finished child never opened** — reachable via the parent header switcher (§4.4, all children incl. finished), not the running-only strip.
- **Blocked send to a child (legacy/stale outbox record)** — the egress guard skips transmission and marks the record a permanent, dismissable error (§4.5) — never a silent drop (P3). Applies to text and attachment records alike (both transmit functions guarded).
- **Running → finished while viewing** — `session_state` flips via the durable `session_status: done` event (§2); the parent's strip pill disappears and the child header label updates reactively from `state.conversations`. No manual refresh.
- **Child stuck `running` (bounded, bridge-inherited)** — the bridge's `finish()` FIFO pairing for sync-Task children is best-effort (`subagent-convos.js:60-68`) and nested-Task children carry no `task_ref`, so a mispaired/nested child can stay `running` until `finishAll` at parent-session teardown. Its pill/label then reads "Running" for that window. This is a **pre-existing bridge limitation**, not introduced here; the web client renders `session_state` faithfully, so a lingering pill is a bridge signal, not a web regression. No client-side timeout is added (that would mask the real signal). Called out so it isn't triaged as a web bug.
- **Pre-`convo_meta` window (bounded self-correcting)** — a new convo record is minted from whatever event arrives first (`applyJournal`, `database.ts:182`), initialized `parent_convo_id: null`; if a child's content/status event were ingested before its titleless `convo_meta` link, the child would briefly render as a top-level row. In practice the bridge upserts the child convo (→ `convo_meta`) at creation, before publishing any child content, so `convo_meta` precedes content on the happy path; the window is bounded and self-correcting (once the link arrives, `isSubChat` removes it from the list on the next `refreshConversations`). The unread half of the risk is doubly covered: the server suppresses child unread bumps (§2), and the §4.3 `!isSubChat` aggregation guards drop any locally-counted child unread post-link. No ordering guarantee is asserted; acceptance is worded "once the `convo_meta` linkage is known" (§9).
- **Nested subagents** — a child that has its own children shows its running grandchildren in the strip (the strip keys on the selected id, whatever its depth).
- **Empty title child** — `conversationTitle` already falls back to the convo id (`types.ts:222`); pills/switcher inherit that.
- **IndexedDB back-compat** — no object-store **schema** change (the store holds whole objects); the new optional field is backward-compatible. A one-time **data** backfill (§4.8) reconciles `parent_convo_id` onto historical records for existing clients.

## 7. Testing (Jest + jsdom, `test/unit-tests/`)

Pure-logic + component tests (jsdom); no live server needed.

1. **Data model / ingestion** — `applyJournal` sets `parent_convo_id` from `convo_meta` once; a later null/absent value does not clear it; `emptyConversation` defaults `null`. **Boundary parse (M1):** `coerceParentId` returns `null` for non-string / empty inputs (`0`, `{}`, `""`, `null`) and the string otherwise; `replaceWithSnapshot` and `applyJournal` both route through it, so a malformed snapshot `parent_convo_id` normalizes to `null` (convo stays top-level and reachable) rather than becoming a hidden-but-unreachable record.
2. **Derivation helpers** — `isSubChat`, `childrenOf` (ordering: created_at ASC, id tiebreak), `runningChildrenOf` (running-only) with fixtures including nested + finished children.
3. **List exclusion + full consumer audit** — `ConversationList` renders no **linked** child rows; a child's unread does not surface in `hasActiveUnread` / `hasAnyFavorite`; `markAllRead` skips linked children (a child with a pre-link unread override is not marked/sent); `firstSelectableConversation` never returns a linked child (bootstrap/resync never auto-lands on one). **Orphan fallback:** a child whose parent is absent from the list DOES render as a top-level row (reachable), and IS a valid `firstSelectableConversation` result.
4. **Strip + parent switcher (reachability)** — `RunningSubagentStrip` renders one pill per *running* child, none when zero; click calls `selectConversation(childId)`; nested case (viewing a child shows its running grandchildren). The **parent header switcher** shows for ≥1 child and lists **all** children incl. finished; a child that finished before being opened is reachable through it (Codex R3-B1).
5. **Child viewer** — for a child: `SubChatHeader` present, `Composer` absent; back button targets the parent (and falls back to `clearSelection` when parent absent); in-child sibling switcher visible only when siblings > 1 with correct current/running/finished glyphs; selecting a sibling calls `selectConversation`.
6. **Read-only enforcement (P1, ship-blocking) — both transmit functions, grep-ratcheted:** (a) `sendPendingMessage(msg)` with a child `msg.convoId` transmits nothing — covers `sendMessage` + reconnect replay; (b) **`emitPendingAttachment(msg)` with a child `msg.convoId` transmits nothing — covers attachment first-send AND `retryAttachment`** (the round-2 gap); (c) a **grep ratchet** test asserts every `op: "send"` match in `client.ts` sits inside a child-guarded function (P17 — a future 4th transmit site can't silently reopen the hole); (d) `sendPromptReply` no-op for a child selection; (e) `stageFiles`/`confirmStagedFile` no-op keyed on **`staged.convoId`**, NOT blocked when the staged target is a non-child even if selection changed mid-dialog (M1b); (f) UI: `onDrop` absent for a child, `PromptCard` and the `PendingAttachment` Retry action suppressed under `isReadOnly`.
7. **Fail-visible blocked send (Codex R3-B3 — P3)** — a child-targeted outbox record (text or attachment) is not deleted: it is marked `attachState:"error"`, `canRetry:false`, with the read-only message, and remains dismissable.
8. **Backfill (§4.8)** — with a cursor present and `subchat_backfill_v1` absent, `startSession` reconciles `parent_convo_id`+`session_state` from `/snapshot` onto existing records without wiping events, then sets the key (atomically); a second startup does not re-fetch. **Failure:** a transient snapshot failure leaves the key **unset** (children remain reachable orphans) and does not wedge startup; the next startup retries (V6).
9. **Selection race (M1)** — `selectConversation(A)` then `(B)` with B resolving first: `viewing B` sent, no trailing stale `viewing A`, **and** B's `events` are not overwritten by A's late refresh (both guards).
10. **Tail-follow** — `isNearBottom` pure helper (threshold boundary at 80px: 79/80/81px cases); jump-to-bottom button hidden when following, shown when not; clicking re-enables follow. **Own-send:** bumping `state.sendTick` cancels any pending rAF frame, forces `isFollowingTail = true`, scrolls to bottom (independent of `pendingMessages.length`); a stale scroll frame queued before the send does not flip follow off after it (Codex R3-M4). **Negative (critical):** an incoming journal event on the selected convo while scrolled up does **NOT** force-follow (guards against bumping `sendTick` in the shared `refreshSelectedConversation` path). **Convo-switch:** switching forces follow; a frame queued before the switch does not flip follow off after (stale-frame guard). Regression: non-child timeline still tails as before.

## 8. Implementation steps

Ordered for TDD (test-first per step); each step is self-contained and leaves the app green.

- **T1 — Data model + ingestion.** Add `parent_convo_id?` to `Conversation` (`types.ts:38`); add the shared `coerceParentId(x): string | null` boundary parser (trims; `types.ts`); default `parent_convo_id: null` in `emptyConversation` (`database.ts:36`); apply the set-once rule via `coerceParentId` in `applyJournal` `convo_meta` (relax the `&& title` guard, `database.ts:190`); normalize via `coerceParentId` in `replaceWithSnapshot` (`database.ts:106`, spread at `:119`). Tests per §7.1.
- **T2 — Derivation helpers.** Add `isSubChat` / `childrenOf` / `runningChildrenOf` / `parentPresent` to `types.ts` (childrenOf/runningChildrenOf accept nullish parentId). Tests per §7.2.
- **T3 — List exclusion + full consumer audit.** Exclude linked children (`parentPresent`, Set-based) from `ConversationList` `useMemo` (`components.tsx:375`), `hasAnyFavorite` (`components.tsx:392`), `hasActiveUnread` (`components.tsx:399`), `client.markAllRead()` (`client.ts:373`), and `firstSelectableConversation` (`client.ts:144-153`); orphans (parent absent) fall back to top-level. Tests per §7.3.
- **T4 — Running-subagent strip + parent switcher.** Inline `RunningSubagentStrip`; mount above `<Timeline>` in `SignedInApp` (`components.tsx:1845`). Add the parent-header subagent switcher (all children, ≥1-child gate) in `ChatHeader` (`components.tsx:875`). Tests per §7.4.
- **T5 — Read-only child viewer + egress enforcement.** Branch `SignedInApp` on `isSubChat(selectedConversation)` per the §4.5 composition sketch: `SubChatHeader` replaces `ChatHeader`; `<ReadOnlyHint>` replaces `Composer`; `onDrop={childMode ? undefined : onDrop}` (`components.tsx:1823`); thread `isReadOnly` through `Timeline` → `EventRow` → `EventContent` → `PromptCard` **and** to `PendingAttachment` (`components.tsx:1267`, hide Retry). **Load-bearing egress guards — BOTH transmit functions (the round-2 gap was missing the second):** `sendPendingMessage` (`client.ts:1298`, covering `sendMessage` `445` + replay `1068`) **and** `emitPendingAttachment` (`client.ts:635`, covering attachment first-send `620` + `retryAttachment` `569`) each early-return + **fail-visible-mark** (not drop, §4.5) when `msg.convoId` is a child; `sendPromptReply` (`client.ts:824`) no-ops for a child selection; `stageFiles`/`confirmStagedFile` (`client.ts:682/708`) no-op keyed on `staged.convoId`. Add the grep-ratchet test over `op: "send"` sites. Also add the selected-id guard in `selectConversation` (`client.ts:320`) before `viewing`, and the stale-refresh events guard in `refreshSelectedConversation` (M1). Tests per §7.5 (chrome), §7.6 (egress + ratchet), §7.7 (fail-visible), §7.9 (selection race).
- **T6 — In-child sibling switcher.** Sibling dropdown in `SubChatHeader`, gated on siblings > 1, with current/running/finished glyphs → `selectConversation`. Tests per §7.5 (switcher).
- **T7 — Backfill.** In `startSession` (`client.ts`), after DB open, run the one-time §4.8 snapshot reconcile gated on the `subchat_backfill_v1` meta key — merge `parent_convo_id` + `session_state`, keep events + cursor, **key-set atomic with the merge**, and on a transient snapshot failure leave the key unset + proceed (V6). Tests per §7.8.
- **T8 — Tail-follow + jump-to-bottom.** Extract `isNearBottom` pure helper (threshold 80); add `sendTick` to `ClientState` **and `blankState()` (`client.ts:80`)**, bumped via `patch({ sendTick: … })` at the three concrete call sites (`sendMessage`/`confirmStagedFile`/`retryAttachment`) — NOT in `refreshSelectedConversation`; add follow-state + rAF-throttled scroll handler (handle in a ref, cancelled on convo-switch cleanup **and on the `sendTick` bump**, stale-frame guard) + `sendTick`-watch effect + an **added** `selectedConversationId`-keyed reset effect + gated `useLayoutEffect` + `mj_JumpToBottom` button in `Timeline`. Tests per §7.10 (incl. the negative own-send test).
- **T9 — Styling.** `mj_*` classes in `journal.pcss` for strip, pills, spinner, sub-chat header/state, switcher, jump-to-bottom.
- **T10 — Verify + deploy.** `pnpm lint && pnpm test`; build (`corepack pnpm build`); manual check against the live journal server (spawn a session, run a subagent, confirm: child hidden from list, running pill + parent switcher list finished children, tapping opens read-only child, switcher across parallel subagents, back returns to parent, jump-to-bottom works; drag a file onto a child pane → rejected). Follow the atomic web deploy runbook (backup `webapp`, build in place, verify 8443, restore-on-fail). File follow-up loops for split-view (B), inline markers / bridge wire-gap (C), and **authoritative server-side child-write rejection** (`easelyte/matron-journal` `ws.js` send handler, §5).

## 9. Acceptance criteria

- `Conversation` carries `parent_convo_id`; it is parsed from both `/snapshot` and live `convo_meta`, and is immutable once set (a null/absent later value never clears it). ✔ §4.1, T1, §7.1
- **Linked** child convos never appear as top-level rows once their `convo_meta` linkage is known, and never contribute to unread/favorite aggregations, `markAllRead`, or `firstSelectableConversation` (full consumer audit). A malformed/whitespace snapshot `parent_convo_id` normalizes to top-level (reachable); an **orphan** child (parent absent) falls back to a top-level row rather than vanishing. ✔ §4.1, §4.3, §6, T1/T3, §7.1/§7.3
- Every child is **reachable**: running children via the pill strip above the parent's timeline (one spinning pill each, tap to open, any nesting depth), and **all** children — running or finished, including those that finished before being opened — via the parent header subagent switcher. ✔ §4.4, T4, §7.4
- Opening a child shows a **read-only** viewer. Read-only is enforced in three layers (P1): (1) UI suppression stops the real single-user threat (accidental self-send) — no composer, no drop, no answerable prompt/permission cards, no attachment Retry; (2) client egress guards at **both** transmit functions (`sendPendingMessage` + `emitPendingAttachment`, grep-ratcheted over `op:"send"` sites) are defense-in-depth for legacy/stale outbox records, and a blocked send is **marked visibly, never silently dropped** (P3); (3) authoritative server-side rejection is a documented follow-up (§5). The viewer has a mini-header (child title, running/finished, child's model/context, back-to-parent with list fallback) and — when the child has >1 sibling — an in-child switcher; rapid sibling switching leaves neither a stale `viewing` subscription nor a wrong-transcript render. ✔ §4.5, T5-T6, §7.5/§7.6/§7.7/§7.9
- Existing clients (with a cursor) backfill `parent_convo_id`/`session_state` onto historical child records once (atomic key-set; transient failure retries, never wedges startup), so upgraded users get grouping + read-only, not just fresh installs. ✔ §4.8, T7, §7.8
- The timeline tails new content by default, stops tailing when the user scrolls up (80px threshold), shows a jump-to-bottom button while not tailing, and re-enables tailing on jump-to-bottom, on own-send (via `sendTick` bumped at the exact send call sites, not on incoming events), and on convo switch (with no stale rAF frame flipping it back off). Incoming agent output while scrolled up does NOT yank the view down. Non-child timelines behave as before. ✔ §4.6, T8, §7.10
- No new server/bridge dependency to **ship** the web feature (the `session_status: done` completion signal is pre-existing and verified, §2); client-side read-only is defense-in-depth with authoritative server rejection as a documented follow-up (§5). No IndexedDB schema-version bump (a one-time data backfill, §4.8, not a store-shape change); `components.tsx` and `client.ts` are not split (accepted P18 exception, §5). ✔ §2, §4.5, §4.8, §5, constraint
- `pnpm lint && pnpm test` green; the feature verified manually against the live journal server. ✔ T9
