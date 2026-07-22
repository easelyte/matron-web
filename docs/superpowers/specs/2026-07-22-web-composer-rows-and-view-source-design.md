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

The hook returns the state + the handler bundle; the **rendering** (the `mj_HeaderMenu` div + `menuitem`
buttons) stays in `components.tsx`. This keeps the hook presentation-free and testable in isolation, and
keeps menu markup where Dan keeps his (no split).

**Menu items** (rendered in `Timeline`, positioned `fixed` like the room menu):
1. **Copy** — shown only for `event.type === "text"` (payload `body`). `navigator.clipboard.writeText(body)`;
   on absence/failure, fall back to a hidden-textarea `execCommand("copy")` or silently no-op (never throw).
   Closes the menu.
2. **View source** — shown for **all** event kinds (#476). Sets the source-sheet target (below). Closes the menu.

Share is intentionally omitted (see Right-size decisions). The menu therefore has 1–2 items; when only
"View source" applies it is still a valid single-item menu (matches apple, where View source is the
universal item).

**A11y:** event rows already carry `tabIndex={-1}`. The `<li>` gains an `onKeyDown` for the ContextMenu key
/ Shift+F10 to open the menu when the row is focused (cheap, standard, exceeds apple which is long-press
only). `role="menu"`/`role="menuitem"`, focus management, and Escape handled by the hook.

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

### #471 Part B — Per-conversation composer draft persistence

**Store `makeDraftStore(session)`** (new `composer-drafts.ts`), mirroring `makeIdSetStore`:
- key `matron:draft:${encodeURIComponent(session.serverUrl)}:${session.userId}` → JSON object
  `{ [convoId: string]: string }`.
- `read(convoId): string` — fail-soft (storage/JSON errors → `""`, never throw; warn once like the id-set
  store).
- `write(convoId, text): void` — sets the entry; if `text.trim() === ""`, **deletes** the entry
  (prune-on-empty → bounded growth). Persists the whole map.
- `clear(convoId): void` — deletes the entry + persists (used after a successful send). Equivalent to
  `write(convoId, "")`; kept as a named method for call-site clarity.

**Composer integration** (unkeyed component; convoId arrives via `state.selectedConversationId`):
- `const store = useMemo(() => makeDraftStore(state.session), [state.session])`.
- Track the current convo with a ref. On convoId change (`useEffect` on `state.selectedConversationId`):
  1. flush the outgoing convo's current `body` to `store.write(prevConvoId, body)`;
  2. load `store.read(newConvoId)` into `body` (and reset textarea height);
  3. update the ref.
  This fixes the cross-convo bleed: each convo shows only its own draft.
- `onChange`: existing `setBody(next)` **plus** `store.write(convoId, next)` (write-through; cheap, drafts
  are small — no debounce needed for correctness, but a trailing microtask/rAF coalesce is acceptable if
  profiling shows churn).
- On successful send (`send()` after `sendMessage` returns true): `store.clear(convoId)` in addition to
  `setBody("")`.
- Guard: if `state.session` is undefined (signed-out transitions), the store is a no-op; body stays local.

Persistence is localStorage → drafts survive **both** in-app navigation and full page reload, per the
loop's "across navigation" (localStorage is the strictly-superior default over in-memory).

### #478 — Rapid-Enter double-send guard

In `Composer`, add `const sendingRef = useRef(false)`. Rewrite `send()` (`store` = the existing
recent-folders store; `drafts` = the new `makeDraftStore` instance; `convoId` =
`state.selectedConversationId`):

```
const send = async (): Promise<void> => {
    if (sendingRef.current) return;          // synchronous re-entrancy guard
    sendingRef.current = true;
    try {
        if (await client.sendMessage(body)) {
            const folder = recentFolderArgument(body);
            if (folder) store.record(folder);
            if (convoId) drafts.clear(convoId);   // #471: clear this convo's draft
            setBody("");
            setDismissed(null);
            if (textarea.current) textarea.current.style.height = "auto";
        }
    } finally {
        sendingRef.current = false;
    }
};
```

The guard is **synchronous** (a ref, set before the first `await`), so a second Enter keydown dispatched in
the same tick — before React clears `body` — sees `sendingRef.current === true` and returns without a
second `sendMessage`. Immune to React state-update batching. The in-flight window is milliseconds
(IndexedDB outbox add); nothing legitimate is lost (on a successful first send, body is cleared anyway).
`finally` guarantees the ref clears even if `sendMessage` throws.

(`client.sendMessage` already returns false on empty/child/no-db, so no extra emptiness check is added.)

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
- localStorage: draft `read`/`write` fail-soft exactly like `makeIdSetStore` (quota/unavailable → warn once,
  treat as empty; a failed read must not clobber an in-memory draft — load only overwrites on `ok`).
- Menu/sheet: Escape + outside-click always close; a convo switch or timeline unmount closes both (the
  hook's effects tear down on unmount; the sheet is conditionally rendered under `Timeline`).
- Double-send: `finally` guarantees ref reset; a thrown `sendMessage` does not wedge the composer.

## Testing

- **`composer-drafts-test.ts`:** write/read round-trip; prune-on-empty deletes the key entry; `clear`;
  per-session key isolation (different serverUrl/userId → different key); fail-soft read on malformed JSON
  and on a throwing `localStorage`.
- **`context-menu-test.ts`:** long-press `onFire` → `open` with pointer coords; viewport clamp math
  (right/bottom edges); keyboard nav index cycling (wrap up/down); Escape close.
- **`components-test.ts` (added cases):**
  - right-click an `EventRow` opens the menu; text event shows Copy, non-text hides it; View source always present;
  - "View source" opens `EventSourceSheet` with the event's JSON; Copy button copies; Done/Esc closes;
  - typing a draft in convo A, switching to B, back to A restores A's draft; B stays empty; draft persists across a simulated remount (reload);
  - successful send clears the draft;
  - **double-send:** two synchronous Enter keydowns with a slow-resolving `sendMessage` stub → `sendMessage` called exactly once.
- `pnpm lint` (tsc + prettier) + full `pnpm test` green before ship.

## Right-size decisions (quantified)

- **Drop Share.** `navigator.share` is mobile-first, unsupported/again-gated on most desktop browsers, and
  the journal web client is desktop-primary. Real-workflow gain ≈ zero; parity kept via Copy + View source.
- **Don't refactor the shipped room-list menu.** True DRY (both menus on one hook) is real but touches
  Dan's working code and deepens fork divergence (#448). Deferred to an upstream proposal (Follow-ups).
- **Single pruned localStorage blob** for drafts, not per-convo keys — simpler, and prune-on-empty bounds
  growth; no key-enumeration cleanup needed.
- **No debounce required** for draft writes — they're tiny synchronous localStorage sets; correctness
  doesn't need it. (Coalescing left as an optional micro-opt if profiling shows churn.)

## Follow-ups (not in this PR)

- **Upstream proposal to Dan:** converge the room-list menu onto the shared `useRowContextMenu` hook
  (fold into loop #448's upstream-refactor track, `type: operator`).
- Optional: raw server-frame source (vs DTO) once/if the bridge exposes original event JSON — mirrors the
  apple `EventTimelineItem.originalJson` TODO in `EventSourceSheet.swift`.

## Out of scope

- Room-list menu changes; bridge/journal-server changes; Share; message edit/delete/react; raw SDK JSON.
