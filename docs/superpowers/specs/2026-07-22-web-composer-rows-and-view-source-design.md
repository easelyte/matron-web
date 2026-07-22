---
title: "Timeline event-row context menu, event View Source, composer draft persistence & double-send guard"
date: 2026-07-22
repo: easelyte/matron-web
loops: [471, 476, 478]
status: draft
approach: "B — shared headless menu hook + new per-feature modules; room-list menu untouched"
rejected_alternatives:
  - "A (slim): duplicate room-menu machinery inline into Timeline — grows components.tsx monolith (#448)"
  - "C (ambitious): also refactor shipped room-list menu onto the shared hook + add Share — regresses Dan's shipped code, diverges further from upstream; belongs as an upstream proposal not a fork delta"
related_principles: []
unresolved_questions: []
---

# Timeline event-row context menu + View Source + composer draft persistence + double-send guard

Three coupled loops for the Matron **journal** web client (`easelyte/matron-web`, deployed at
`/opt/matron/web-journal`, nginx :8082 → Tailscale :8443). All client-only UX; no journal-server or
bridge changes.

- **#471** — timeline event-row context menu (the shared long-press/right-click surface) **+**
  per-conversation composer draft persistence.
- **#476** — a "View source" item in that menu → pretty-printed event-DTO JSON in a scrollable,
  selectable sheet (apple parity: `Matron/Features/Chat/Rendering/EventSourceSheet.swift`).
- **#478** — rapid-Enter double-send guard in the composer (deferred from the #474 slash-palette ship).

#471 and #476 share the timeline-row menu surface, so they are designed together. #478 is an
independent composer fix bundled into the same branch/PR.

## Background / current state (verified against code at `feat/composer-rows`, origin/main a8357d8)

- **Room-LIST rows already have a long-press/right-click context menu** (`roomMenu` state,
  `mj_RoomItemMenu`, `createLongPressController` at `components.tsx` ~L280–L544 / L704+). This spec does
  **not** touch it. The **timeline event rows** (`EventRow`, `components.tsx` ~L1492) have **no** menu —
  that is the net-new surface for #471/#476.
- **`createLongPressController`** (`src/journal/longPress.ts`) is a reusable, pure (React-free) primitive:
  `onPointerDown/Move/Up/Cancel`, `didFire`, `isPending`, movement-threshold cancel. Reused as-is.
- **Composer** (`components.tsx` ~L1991) holds body as component-local `useState("")`. It is rendered
  **unkeyed** (`<Composer client={client} state={state} />`, L2424), so the single instance persists
  across conversation switches → **body currently bleeds across conversations** (latent bug). `send()`
  (L2015) is `async`: it `await`s `client.sendMessage(body)`, then `setBody("")`. Enter handling at
  L2103 calls `void send()` with no re-entrancy guard.
- **`client.sendMessage(bodyInput)`** (`client.ts` L464) trims, mints a fresh `crypto.randomUUID()`
  localId per call, adds to the IndexedDB outbox, returns `boolean`. **No server-side idempotency** — two
  calls with the same body produce two distinct messages. This is why #478 is a real duplicate-send bug:
  two synchronous Enter keydowns both read the not-yet-cleared React `body` and both call `sendMessage`.
- **Session-scoped localStorage store pattern** exists in `src/journal/conversation-flags.ts`
  (`makeIdSetStore(keyPrefix, label)` → key `${prefix}:${encodeURIComponent(serverUrl)}:${userId}`, with
  a fail-soft `read()` returning `{ ids, ok }`). The draft store mirrors this pattern for a string map.
- **Menu render/behavior conventions** (from the room-list menu, to be matched by the timeline menu):
  `mj_HeaderMenu` fixed-position div, `role="menu"` + `role="menuitem"` buttons, ArrowUp/Down cycling,
  Enter/Space activates, Escape closes + restores focus, outside `pointerdown` closes, `scroll` (capture)
  closes, `useLayoutEffect` viewport clamp (`Math.max(8, Math.min(pos, window.innerX − size − 8))`),
  initial focus to first menuitem.
- **Apple parity** (`ChatView.swift` L904 `.contextMenu`): Copy (text only) · Share (text only) ·
  View source (all kinds). `EventSourceSheet` renders `item.prettyJSON()` (the DTO, not raw SDK JSON) in a
  scrollable `.textSelection(.enabled)` `Text` with a Done button.
- **Test layout:** jest, one file per module under `test/unit-tests/journal/` (`longPress-test.ts`,
  `conversation-flags-test.ts`, `slash-palette-test.ts`, `components-test.ts`, …).

## Constraints (from project memory)

- **Do NOT split `components.tsx` / `client.ts`** ([[project_matron_web_stays_dan_upstream_aligned]], loop
  #448). New **per-feature modules** (`context-menu.ts`, `composer-drafts.ts`) are allowed — they match
  upstream's existing convention (`longPress.ts`, `conversation-flags.ts`, `slash-palette.ts`) and are not
  a split of the monoliths.
- **Do NOT refactor Dan's shipped room-list menu** in this PR (regression surface + fork divergence). The
  shared hook is used by the new timeline menu only; converging the room-list menu onto it is a future
  **upstream** proposal, noted under Follow-ups.
- Deploy per CLAUDE.local.md atomic runbook (`corepack pnpm build` in place → verify :8443). No Docker
  (that's the legacy Matrix :8420 client).

## Design

### Module map (new files + touched files)

| File | New? | Purpose |
|---|---|---|
| `src/journal/context-menu.ts` | **new** | Headless `useRowContextMenu` hook — open/close/position state, long-press + right-click + keyboard triggers, outside-click/Escape/scroll close, arrow-key nav helper, viewport clamp. React-aware but presentation-free. |
| `src/journal/composer-drafts.ts` | **new** | `makeDraftStore(session)` — per-session localStorage map `convoId → draft text`, fail-soft read, prune-on-empty. |
| `src/journal/components.tsx` | edit | Wire the timeline event-row menu (`EventRow`/`Timeline`), the `EventSourceSheet` modal, and the composer draft + double-send logic. |
| `src/journal/shell.pcss` (or `journal.pcss`) | edit | Styles for the event-row menu (reuse `mj_HeaderMenu`/`mj_RoomItemMenu` classes where possible) + `EventSourceSheet` modal, matching existing dialog styling (`UploadConfirmDialog`). |
| `test/unit-tests/journal/context-menu-test.ts` | **new** | Hook logic (open position clamp, keyboard nav index math, long-press fire → open). |
| `test/unit-tests/journal/composer-drafts-test.ts` | **new** | Draft store read/write/clear, prune-on-empty, fail-soft read, per-session key isolation. |
| `test/unit-tests/journal/components-test.ts` | edit | Timeline menu open/Copy/View source; EventSourceSheet content + close; draft load/save/clear across convo switch + reload; double-send guard drops the 2nd rapid Enter. |

### #471 Part A — Timeline event-row context menu (shared surface)

**Menu scope (round-1 clarification):** the context menu is wired **only** onto `EventRow` rows, which are
backed by a settled `JournalEvent`. The other `mx_EventTile`-classed `<li>` rows the `Timeline` renders —
`ToolStream` (L1546) and pending/sending placeholders (`mj_AttachmentChip` L1624, `mx_EventTile_sending`
L1858/L1874) — are **not** backed by a `JournalEvent` and get **no** menu (they have no DTO to view and
nothing text to copy). `EventSourceSheet`'s prop is `JournalEvent`, so this is enforced by construction.

**Trigger surface:** the `EventRow` `<li className="mx_EventTile">`. Triggers:
- **Right-click** (`onContextMenu`, `preventDefault`) → open at `{clientX, clientY}` (pointer position).
  Keyboard-invoked contextmenu (Shift+F10 / Menu key) reports `clientX===0 && clientY===0` → open anchored
  at the row's `getBoundingClientRect()` instead (same guard the room-list menu uses at L470).
- **Long-press** (touch only) via `createLongPressController` (`delayMs: 500`, movement cancels) → open at
  the press point. Mirrors the room-list wiring: `onPointerDown/Move/Up/Cancel` gated on
  `event.pointerType === "touch"`, plus a capture-phase `scroll` listener that cancels a pending press.
- A `didFire` guard suppresses the click/selection that would otherwise follow a long-press.

**Headless hook `useRowContextMenu<T>()`** (new `context-menu.ts`) encapsulates, for a menu whose target
is a value of type `T` (here `JournalEvent`):
- state `{ target: T; left: number; top: number } | undefined`, `open(target, left, top, opener)`, `close(restoreFocus?)`;
- the `createLongPressController` instance + pointer handlers factory + scroll-cancel;
- the document-level effects (outside `pointerdown` close, `Escape` close+restore, capture `scroll` close);
- the `useLayoutEffect` viewport clamp + initial-focus-first-menuitem;
- a `menuKeyDown(event)` handler implementing ArrowUp/Down cycling, Enter/Space activate, Escape close.

**DOM ownership (round-1 fix):** the hook owns a `menuRef: RefObject<HTMLDivElement>` that the caller
attaches to the menu-root div it renders. All measurement (viewport clamp), containment (outside-`pointerdown`
"is the click inside my menu?"), initial focus, and item navigation operate through `menuRef.current` and
`menuRef.current.querySelectorAll('[role="menuitem"]')` — **scoped to this menu's own subtree, never global
`document.querySelector` on role/class**, so the new timeline menu cannot measure, contain, or focus the
untouched room-list menu (which lives under a different, hook-unaware subtree). The hook returns
`{ state, menuRef, open, close, rowHandlers(target, rowEl), menuKeyDown }`; the **rendering** (the
`mj_HeaderMenu` div — with `ref={menuRef}` — + `menuitem` buttons) stays in `components.tsx`. This keeps the
hook presentation-free and testable in isolation, and keeps menu markup where Dan keeps his (no split).

**Menu items** (rendered in `Timeline`, positioned `fixed` like the room menu):
1. **Copy** — shown only for `event.type === "text"` (payload `body`). `navigator.clipboard.writeText(body)`;
   on absence/failure, fall back to a hidden-textarea `execCommand("copy")` or silently no-op (never throw).
   Closes the menu.
2. **View source** — shown for **all** event kinds (#476). Sets the source-sheet target (below). Closes the menu.

Share is intentionally omitted (see Right-size decisions). The menu therefore has 1–2 items; when only
"View source" applies it is still a valid single-item menu (matches apple, where View source is the
universal item).

**A11y (scope corrected after round 1):** the two open triggers are **pointer-based** — right-click
(`onContextMenu`) and touch long-press — matching apple's long-press-only affordance. Event rows are
`tabIndex={-1}` (`components.tsx` L1511) with no roving-tabindex or `.focus()` path anywhere in the file, so
a keyboard-only user cannot make a row the active element; a per-row `onKeyDown`/Shift+F10 handler could
never fire and is therefore **not** added (the earlier "exceeds apple" claim was false). Keyboard-invoked
`contextmenu` (Shift+F10 / Menu key) is still handled *for pointer-focusable elements* via the existing
`clientX===0 && clientY===0` branch (mirrors the room-list menu, L470) — it just isn't reachable on these
non-focusable rows today. **Once open**, the menu is fully keyboard-operable (Arrow/Enter/Space/Escape via
the hook, `role="menu"`/`role="menuitem"`, focus-first-item on open). Keyboard-*opening* on the timeline
(roving tabindex over rows) is a documented **follow-up**, not in this PR — it's net-new a11y beyond apple
and independent of these three loops.

### #476 — Event View Source sheet

**Component `EventSourceSheet`** (in `components.tsx`, beside `UploadConfirmDialog`):
- Props `{ event: JournalEvent; onClose: () => void }`.
- Renders `JSON.stringify(event, null, 2)` — the full DTO the client holds (`seq`, `convo_id`, `ts`,
  `sender`, `type`, `payload`) — inside a scrollable, user-selectable `<pre>` (`user-select: text`).
  Mirrors apple's "what does the app see?" DTO view (we don't have the raw server frame client-side).
- Modal chrome matching `UploadConfirmDialog`: backdrop, titled header ("Event source"), a **Copy** button
  (copies the JSON) and a **Done**/close button. Closes on Done, backdrop click, and Escape.
- Focus trapped minimally: focus the Done button on open; Escape closes; return focus to the timeline.

**State:** `Timeline` owns `const [sourceEvent, setSourceEvent] = useState<JournalEvent | undefined>()`. The
menu's "View source" calls `setSourceEvent(event)`; the sheet renders when defined. Kept in `Timeline` (not
global `ClientState`) — it's ephemeral view state, no persistence, no cross-component reach.

**Close-on-conversation-switch (round-1 blocker fix):** `Timeline` is rendered **unkeyed** (`components.tsx`
L2423), so a `selectedConversationId` change does **not** unmount it — a menu/sheet targeting convo A's
event would otherwise stay visible and copyable over convo B (conversation-scoped view-state leak). Fix:
`useEffect(() => { menu.close(); setSourceEvent(undefined); }, [state.selectedConversationId])` in
`Timeline` explicitly closes both surfaces on every convo switch. (Both the menu-close and sheet-clear are
idempotent no-ops when already closed.) Do **not** rely on unmount teardown for this.

### #471 Part B — Per-conversation composer draft persistence

**Store `makeDraftStore(session: Session | undefined)`** (new `composer-drafts.ts`). Signature and
self-guarding mirror **`makeRecentFoldersStore` (`slash-palette.ts` L176–195)**, NOT `makeIdSetStore` —
`makeRecentFoldersStore` accepts `Session | undefined` and returns an internally no-op object when the
session is absent, and its `record()` is `try/catch`-wrapped so a storage failure never throws into a
React handler. `makeIdSetStore.write` (`conversation-flags.ts` L50–52) is **not** fail-soft on write (no
`try/catch` — throws on quota/`SecurityError`); the draft store must not copy that. Contract:
- When `session` is `undefined`: every method is a no-op (`read` → `{ text: "", ok: false }`), so call
  sites need no guard. When present, key
  `matron:draft:${encodeURIComponent(session.serverUrl)}:${session.userId}` → JSON object
  `{ [convoId: string]: string }`.
- `read(convoId): { text: string; ok: boolean }` — fail-soft. `ok:false` on storage/JSON error (or absent
  session); `ok:true` with `text:""` for a legitimately absent draft. Callers overwrite the live body
  **only when `ok`** — a transient read failure must not clobber the in-memory draft or leak the previous
  convo's text. (Mirrors `makeIdSetStore.read`'s `{ ids, ok }` shape, which the old contradictory
  string-only `read` did not.)
- `write(convoId, text): void` — `try/catch`-wrapped (warn once on failure, never throw). If
  `text.trim() === ""`, **deletes** the entry (prune-on-empty). If `utf8Length(text) > MAX_DRAFT_BYTES`
  (const, 64 KiB), the entry is **not** persisted (the oversized text stays live in the composer; a reload
  simply won't restore it) — bounds the per-entry cost of the synchronous whole-blob serialize.
- `clear(convoId): void` — deletes the entry + persists (used after a successful send).
- **Write coalescing:** the Composer calls `write` through a trailing-edge debounce (~250 ms) so rapid
  keystrokes don't stringify+rewrite the whole blob on every keypress; the debounce is **flushed
  synchronously** on convo-switch, blur, and send so no committed draft is lost. `clear` bypasses the
  debounce (immediate). This keeps the hot path off the per-keystroke blob write that round 1 flagged.

Total blob size is bounded in practice by (active-conversation count × ≤`MAX_DRAFT_BYTES`) with
prune-on-empty removing entries as they clear; there is no per-conversation-count hard cap (conversations
are archived, not deleted — `client.ts` archive path), which is acceptable because each entry is capped and
empty entries are pruned. Draft persistence is **best-effort**, not a durability guarantee (see Error
handling) — the design does not surface a persist-failure toast (a draft is convenience state, still
visible live; over-alerting on it is worse UX than a silent console warn).

**Composer integration** (unkeyed component; convoId arrives via `state.selectedConversationId`):
- `const drafts = useMemo(() => makeDraftStore(state.session), [state.session])` (self-guards on undefined
  session — no call-site guard needed, per the store contract).
- Keep `const convoIdRef = useRef(state.selectedConversationId)` updated every render so async
  continuations read the *current* convo, not a stale closure.
- **All body mutations go through one helper** `setBodyDraft(next)` = `setBody(next)` + debounced
  `drafts.write(convoIdRef.current, next)`. `onChange`, `selectCommand`, and `selectFolder` (the three
  `setBody` call sites, `components.tsx` L2003–2014, L2059–2066) route through it — this closes the round-1
  gap where completion picks bypassed `onChange` and their composed body was never persisted.
- On convoId change (`useEffect` on `state.selectedConversationId`, prevConvo tracked via a ref):
  1. **flush** the debounce, then `drafts.write(prevConvoId, body)` for the outgoing convo;
  2. `const { text, ok } = drafts.read(newConvoId)` — set body **only when `ok`** (a failed read leaves the
     composer empty for the new convo rather than showing the previous convo's text); reset textarea height;
  3. update both refs.
  This fixes the cross-convo bleed: each convo shows only its own draft, and a transient storage failure
  can't leak text across conversations.
- **Send (per-conversation lock + convo-scoped completion)** — replaces the single `sendingRef`:
  - `const sendingConvos = useRef(new Set<string>())`.
  - `send()`: `const convoId = convoIdRef.current; if (!convoId || sendingConvos.current.has(convoId)) return;`
    then `sendingConvos.current.add(convoId)` (synchronous, pre-`await` → blocks the same-tick second Enter
    for *this* convo only, so a send in A never drops an Enter in B). `try { if (await
    client.sendMessage(body)) { … } } finally { sendingConvos.current.delete(convoId); }`.
  - **Completion is convo-scoped:** on success always `drafts.clear(convoId)` (safe — clears the convo we
    sent from). Touch the live composer (`setBody("")`, `setDismissed(null)`, reset height) **only when
    `convoIdRef.current === convoId`** — i.e. the same convo is still on screen. If the operator switched
    away mid-send, the new convo's draft/body is left untouched (it was already saved by write-through).
    This kills the round-1 "resolves-after-switch blanks the new convo" blocker.
  - **Wedge scope:** `finally` releases the lock on resolve *and* reject; the only residual is a promise
    that never settles, which for this path means a hung local IndexedDB `addToOutbox` (no network in the
    awaited path). Per-convo scoping bounds even that to the one affected conversation (others still send);
    no timeout is added because a spurious mid-send unlock would reintroduce the double-send. Documented,
    not silently assumed.

Persistence is localStorage → drafts **best-effort** survive both in-app navigation and full page reload
(the loop's "across navigation"). Best-effort because a storage failure (quota, Safari private mode) is
swallowed with a console warn; the draft stays live on screen but may not survive a reload. This is the
right trade for convenience state — see Error handling.

### #478 — Rapid-Enter double-send guard

The guard is the **per-conversation send lock** defined in "#471 Part B → Send" above (`sendingConvos =
useRef(new Set<string>())`), not a single boolean. Rationale for the shape (round-1 driven):

- The duplicate arises because `send()` is `async` and two Enter keydowns fire as separate tasks before
  React clears `body`, so both read the stale body and both call `client.sendMessage` (which mints a fresh
  `crypto.randomUUID()` per call — no server idempotency, `client.ts` L464–482). The lock is added
  **synchronously before the first `await`**, so the second Enter sees the convo already locked and returns
  — immune to React state-update batching.
- **Keyed by convoId, not global:** a boolean `sendingRef` would silently drop an Enter in convo B while a
  send in A is still in flight (round-1 blocker). Locking per-convo means only a genuine same-convo double
  fire is suppressed.
- **Completion is convo-scoped** (see above): the live composer is cleared only if the sending convo is
  still on screen, so an in-flight send that resolves after a switch never blanks the newly selected
  conversation. The earlier "nothing legitimate is lost" claim was false for the cross-convo interleave and
  is removed.
- `finally` releases on resolve and reject; a never-settling local promise is bounded to the one affected
  convo (Major issue mitigation, above).

`client.sendMessage` already returns false on empty/child/no-db, so no extra emptiness check is added.

## Data flow

```
touch long-press / right-click / Menu-key on EventRow
  → useRowContextMenu.open(event, x, y, rowEl)
  → mj_HeaderMenu renders [Copy?, View source]
      Copy        → navigator.clipboard.writeText(payload.body) → close
      View source → Timeline.setSourceEvent(event) → close
                    → EventSourceSheet renders JSON.stringify(event,null,2)
                        → Copy / Done / Esc / backdrop → setSourceEvent(undefined)

convo switch → Composer effect: write(prev, body); body = read(next)
composer typing → setBody(next) + draftStore.write(convo, next)  (prune when empty)
Enter (guarded) → sendingRef gate → sendMessage → on success: draftStore.clear(convo) + setBody("")
```

## Error handling

- Clipboard: `navigator.clipboard` may be unavailable (insecure context) or reject — wrap in try/catch,
  fall back to `execCommand` or no-op; never surface an exception into the timeline.
- localStorage: draft `read` **and** `write` are both fail-soft — modeled on `makeRecentFoldersStore.record`
  (`try/catch`, warn once), **not** `makeIdSetStore.write` (which is unguarded and throws on quota). `read`
  returns `{ text, ok }`; a failed read (`ok:false`) must **not** clobber the in-memory draft or leak the
  previous convo's text — the load step overwrites the body only when `ok`. `write` failure is swallowed
  (draft stays live on screen; persistence is best-effort, not durable — no user-facing error, by design,
  for convenience state).
- Menu/sheet: Escape + outside-click always close; a convo switch closes both via the **explicit**
  `selectedConversationId` effect in `Timeline` (the unkeyed `Timeline` does **not** unmount on switch, so
  unmount teardown alone is insufficient — see #476 state). The hook's document-level effects still tear
  down on true unmount (sign-out, etc.).
- Double-send: the per-convo lock (`sendingConvos` set) releases in `finally` on resolve and reject; a
  thrown `sendMessage` does not wedge the composer. A never-settling local promise is bounded to the single
  affected convo (all other conversations still send).

## Testing

- **`composer-drafts-test.ts`:** write/read round-trip; `read` returns `{ text, ok }`; `ok:false` on
  malformed JSON, on a throwing `getItem`, and on `undefined` session; prune-on-empty deletes the entry;
  `clear`; per-session key isolation (different serverUrl/userId → different key); **write fail-soft** on a
  throwing `setItem` (no throw propagates); oversized draft (`> MAX_DRAFT_BYTES`) is **not** persisted while
  smaller ones are; undefined-session store is a full no-op.
- **`context-menu-test.ts`:** long-press `onFire` → `open` with pointer coords; viewport clamp math
  (right/bottom edges); keyboard nav index cycling (wrap up/down); Escape close; containment/measurement use
  the passed `menuRef` node (a sibling menu node is not selected).
- **`components-test.ts` (added cases):**
  - right-click an `EventRow` opens the menu; text event shows Copy, non-text hides it; View source always present;
  - a `ToolStream` / pending placeholder row gets **no** menu on right-click;
  - "View source" opens `EventSourceSheet` with the event's JSON; Copy button copies; Done/Esc/backdrop closes;
  - **menu + sheet close on conversation switch** (change `selectedConversationId` while open → both gone, JSON no longer in DOM);
  - typing a draft in convo A, switching to B, back to A restores A's draft; B stays empty; draft persists across a simulated remount (reload);
  - a **completion pick** (`selectCommand` / `selectFolder`) then reload restores the composed body (write-through covers the non-`onChange` path);
  - a failed `read` (`ok:false`) on switch leaves the new convo's composer empty, **not** showing the previous convo's text;
  - successful send clears **that convo's** draft;
  - **double-send:** two synchronous Enter keydowns (same convo) with a slow-resolving `sendMessage` stub → `sendMessage` called exactly once;
  - **cross-convo interleave:** send in A (slow stub, still pending) → switch to B → Enter in B is **not** blocked (fires its own send); when A resolves, B's live composer body is **untouched**.
- `pnpm lint` (tsc + prettier) + full `pnpm test` green before ship.

## Right-size decisions (quantified)

- **Drop Share.** `navigator.share` is mobile-first, unsupported/again-gated on most desktop browsers, and
  the journal web client is desktop-primary. Real-workflow gain ≈ zero; parity kept via Copy + View source.
- **Don't refactor the shipped room-list menu.** True DRY (both menus on one hook) is real but touches
  Dan's working code and deepens fork divergence (#448). Deferred to an upstream proposal (Follow-ups).
- **Single localStorage blob** for drafts, not per-convo keys — simpler, no key-enumeration cleanup.
  Growth is bounded per-entry by `MAX_DRAFT_BYTES` (64 KiB, oversized drafts not persisted) and by
  prune-on-empty; total scales with active-conversation count (acceptable — see store contract). Round 1
  correctly flagged that prune-on-empty alone does not bound total size, hence the per-entry cap.
- **Trailing debounce (~250 ms) on draft writes, flushed on switch/blur/send** — round 1 flagged that an
  unguarded per-keystroke whole-blob stringify is a synchronous hot path that degrades with blob size. The
  debounce coalesces keystrokes; the synchronous flush on convo-switch/blur/send guarantees no committed
  draft is lost. `clear` bypasses it (immediate).

## Follow-ups (not in this PR)

- **Upstream proposal to Dan:** converge the room-list menu onto the shared `useRowContextMenu` hook
  (fold into loop #448's upstream-refactor track, `type: operator`).
- Optional: raw server-frame source (vs DTO) once/if the bridge exposes original event JSON — mirrors the
  apple `EventTimelineItem.originalJson` TODO in `EventSourceSheet.swift`.

## Out of scope

- Room-list menu changes; bridge/journal-server changes; Share; message edit/delete/react; raw SDK JSON.
