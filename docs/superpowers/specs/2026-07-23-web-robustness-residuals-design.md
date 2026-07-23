# Design — matron-web robustness residuals batch (#481/#483/#484/#485/#486/#491/#494)

**Status:** design (brainstorm-slim)
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client)
**Loops:** son-of-anton #481, #483, #484, #485, #486, #491, #494
**Origin:** P4/P5 residual follow-ups deferred from prior ship reviews (#466, #479, #480, #487-490). No shared spec existed; this batch triages each against current fork-main (95ca752) and fixes the real ones in one branch.
**Branch:** `feat/web-residuals` off `origin/main`.

## Constraint

Upstream-alignment (`project_matron_web_stays_dan_upstream_aligned`): **no file splits, no restructuring, no NEW source files.** All changes are inline, minimal-diff, within existing `src/journal/{client.ts,composer-drafts.ts,components.tsx,markdown.tsx,theme.ts}` + `test/unit-tests/journal/`. Styling foundation stays plain PostCSS over `--cpd-*` tokens (`reference_matron_web_styling_foundation`) — no new deps, no CSS-in-JS.

(Round-2 removed the earlier FIX 4 markdown lazy-load entirely — #491 is now closed-as-accepted; see CLOSE 3. No `markdown.tsx` changes ship in this branch.)

Principles: **drift-detection over silent coupling** (#494 adds a parity guard across the 3 dark-canvas literals — a drift ratchet, NOT true P2 derivation, since the pre-paint bootstrap can't import a shared constant; see FIX 1), **fail-loud / no silent loss** (#486 surfaces quota/persist failures; the dropped eviction *was* a silent-loss defect), **right-size-to-gain** (#481/#483/#491 closed because the fix machinery outweighs the real-workflow benefit).

## Triage outcome (operator-confirmed 2026-07-23)

| Loop | Premise verified? | Disposition |
|---|---|---|
| #494 dark-canvas drift-guard | Yes — `#16191d` in theme.ts:59, index.html:23, shell.pcss:64 | **FIX** (test-only) |
| #485 sendMessage identity tuple | Yes — client.ts:602-638 re-reads `this.*` after await | **FIX** |
| #486 durable draft persistence | Yes — composer-drafts.ts single session-blob, silent quota loss | **FIX** |
| #491 markdown-bundle-trim | Premise WRONG (grammars ≈190KB; 1.9MB = whole md pipeline) | **CLOSE** accepted (round-2: lazy-load disproportionate) |
| #481 reconnect-purge draft durability | Yes but undeliverable data, sub-second window | **CLOSE** accepted-risk |
| #483 recent-folders agent-scoping | Yes but advisory autocomplete, forks Dan layout | **CLOSE** verified-safe |
| #484 send idempotency + hung-send | Yes — but real fix is server-side (matron-journal) | **FILE cross-repo + CLOSE** gated-on-upstream |

---

## FIX 1 — #494 dark-canvas single-source drift-guard (test-only)

**Where:** `test/unit-tests/journal/theme-test.ts` (add a describe block).

**⚠ Post-rebase reconciliation (final-review):** the values below (`#16191d`) were current at authoring time. During this session origin/main's v2 warm-neutral palette (e81cf44) changed the dark `--cpd-color-bg-canvas-default` to **`#1a1c20`**. On rebase, the shipped #494 guard **correctly caught** the drift (shell.pcss moved; the two JS `theme-color` copies didn't), so Phase 1 also updates `theme.ts` + `index.html` to `#1a1c20`. The shipped test asserts **parity across the three literals (not a pinned value)** so a legitimate future palette change doesn't churn the test. Read the `#16191d` references below as the historical example; the canonical value is now whatever shell.pcss's dark token holds.

**Problem:** the dark canvas color `#16191d` is duplicated in three places:
- `src/journal/shell.pcss:64` — `--cpd-color-bg-canvas-default: #16191d;` (the `[data-theme="dark"]` CSS token, canonical source).
- `src/journal/theme.ts:59` — `applyTheme` sets `<meta theme-color>` to `#16191d` for dark.
- `src/index.html:23` — the pre-paint inline bootstrap sets the same meta.

Existing tests pin the two JS copies to the literal but never assert against the CSS token, so a future contrast-driven canvas tweak in `shell.pcss` leaves both `theme-color` copies stale (browser chrome color drifts from the app canvas).

**Fix:** add a jest test that:
1. Reads `src/journal/shell.pcss`, extracts the dark `--cpd-color-bg-canvas-default` value (the declaration inside the `[data-theme="dark"]` / `:root` dark block — see resolution below).
2. Reads `src/journal/theme.ts`, extracts the dark-branch literal in the `theme-color` `setAttribute` line.
3. Reads `src/index.html` bootstrap script, extracts the dark-branch literal.
4. Asserts all three are byte-equal (case-insensitive hex).

**CSS-token extraction (the one real subtlety):** `--cpd-color-bg-canvas-default` appears twice in shell.pcss — line 12 (`#fff`, light default at `:root`) and line 64 (`#16191d`, dark override). The test must select the **dark** occurrence. shell.pcss structures the dark tokens under a `[data-theme="dark"]` (or `:root[data-theme="dark"]`) selector block. Extraction approach: locate the dark selector block, then match `--cpd-color-bg-canvas-default:\s*(#[0-9a-fA-F]{3,8})` within it. Regex on the file is acceptable (no CSS parser dep — stays within the no-new-deps constraint); the test reads the raw file exactly like the existing `bootstrapScript()` helper reads index.html.

**Verification-before-completion:** the test must FAIL if any of the three values is edited in isolation (prove the guard by temporarily desyncing one during dev, then reverting). Documented as the acceptance check, not committed as a mutation.

**What this delivers — drift detection, NOT true single-source (round-3 Major-2, honest P2 framing):** the guard is a **parity ratchet**, not P2 canonical derivation. The CSS token stays the *reference*, but the two JS literals are not *derived* from it — a legitimate canvas change still requires 3 coordinated edits, and the test only *catches* a missed one. That is the deliverable: fail-the-build-on-drift, not eliminate-the-coupling.

**Why not true derivation (codegen):** generating the JS values from the palette source would restructure theme.ts + the inline bootstrap to import a shared constant — the bootstrap is a pre-paint inline `<script>` in index.html precisely so it runs before any bundle loads, so it cannot import. Given derivation is impossible without breaking the pre-paint contract, a drift guard is the proportionate enforcement.

---

## FIX 2 — #485 sendMessage full session-identity tuple

**Where:** `src/journal/client.ts` → `sendMessage` (602-638).

**Race (real, pre-existing):**
```ts
await this.database.addToOutbox(message); // await boundary
// ...after the await, these re-read live this.* state:
if (this.state.selectedConversationId === conversationId) { this.patch(...); }
void (async () => { await this.refreshSelectedConversation(conversationId); })();
this.sendPendingMessage(message); // default connection = this.connection
```
`sendMessage` captures `conversationId` and builds `message` before the await, but after `await addToOutbox` it re-reads `this.database` (implicitly, via the outbox already written), `this.connection` (via `sendPendingMessage`'s default param), and `this.sessionGen` is never checked. A sign-out / session-swap that lands during the `addToOutbox` await means `sendPendingMessage` dispatches an **old-session** message through the **new session's** connection (P56 identity-tuple violation). The message was durably queued in the old session's outbox (correct) but then egresses on the wrong connection.

**Fix — capture-before-await + verify-after (mirror `handleReady`'s `ownsReplay`):**
```ts
public async sendMessage(bodyInput: string, targetConvoId?: string): Promise<boolean> {
    const body = bodyInput.trim();
    const conversationId = targetConvoId ?? this.state.selectedConversationId;
    if (!body || !conversationId || !this.database) return false;
    if (this.isChildConvo(conversationId)) return false;

    // Capture the full identity tuple BEFORE the durable await.
    const db = this.database;
    const gen = this.sessionGen;
    const connection = this.connection;
    const owns = (): boolean =>
        this.sessionGen === gen && this.database === db && this.connection === connection;

    const message: PendingMessage = { localId: crypto.randomUUID(), convoId: conversationId, body, createdAt: Date.now() };
    await db.addToOutbox(message); // use captured db, not this.database

    // If the session swapped during the await, do NOT dispatch: the ONLY real harm this
    // guard prevents is egress of an old-session message through a *new* session's connection
    // (P56 identity-tuple violation). Return false so the composer keeps the visible draft
    // (fail-loud, no silent loss) — see "ownership-change semantics" below for why the row
    // itself is already gone in every reachable swap.
    if (!owns()) return false;

    if (this.state.selectedConversationId === conversationId) {
        try { this.patch({ sendTick: this.state.sendTick + 1 }); }
        catch (error) { console.warn("matron: post-send state update failed (message still queued)", error); }
    }
    void (async () => {
        try { await this.refreshSelectedConversation(conversationId); }
        catch (error) { console.warn("matron: post-send refresh failed (message still queued)", error); }
    })();
    try { this.sendPendingMessage(message, connection); } // pass captured connection explicitly
    catch (error) { console.warn("matron: post-send dispatch threw (message still queued)", error); }
    return true;
}
```

**Ownership-change semantics — the `owns()` guard covers THREE transition windows (updated through round-5 B1):**
`owns()` compares the full `{sessionGen, database, connection}` tuple, so it fires on any of:
- `logout()` (client.ts:333) — `sessionGen += 1`, `connection.stop()` + `connection = undefined` (340-341), `await database.reset()` which `clear()`s the outbox (348), `database = undefined` (353). Row wiped.
- `startSession()` boundary (client.ts:1100) — `sessionGen += 1` and `this.database` is replaced at 1127, but `this.connection` is only `stop()`ed at 1124 (**not** nulled) and not *reassigned* until ~1259, after `phase: "signed-in"` is emitted (≈1197). So a send in that intra-`startSession` window captures `{new gen, new db, the STOPPED old connection}` (verified: 1124 stops but retains the reference). `owns()` may then stay **true** (the stopped connection reference is unchanged across `addToOutbox`), so the eager `sendPendingMessage` targets a **stopped** socket — a **harmless no-op, no egress** — and the row stays in the outbox for `handleReady`'s replay on the new connection (1513) to deliver. **Benign residual (round-5/6 B1):** no loss, no cross-session egress (the old socket is stopped), and if the stopped socket somehow flushed, it would be the **same `localId`** also replayed → absorbed by #484's server-side localId dedup. The earlier "move together on exactly two paths" claim was too strong; the tuple-compare still catches the logout case.
- A plain reconnect (websocket drop/resume) **reuses the same `JournalConnection` instance** and touches nothing in the tuple, so `owns()` stays true — no false-positive on reconnect.

**Why #485 stays (not pulled) despite the transitional residual:** its core value — capturing the tuple and refusing to eagerly dispatch across a `logout()` (where `this.connection` IS nulled → `owns()` false → guard fires) — closes the primary cross-session-egress race. The startSession residual above is benign (stopped socket + same-localId replay). Fully eliminating even the benign transitional dispatch would require a client.ts "connection-ready" state-machine signal — out of scope for a P5 residuals batch and touching Dan's upstream core (`project_matron_web_stays_dan_upstream_aligned`). Per the reviewer-oscillation stop-rule (Codex flipped undefined↔stale on this exact point across rounds 5-6), this is a documented decision, not re-opened.

**Return-value decision — `false`, and this is CLOSED, not re-litigated (round-5 reviewer-oscillation stop).** Across rounds the correct `!owns()` return value was argued five ways (true unsound → false → reset-failure → fresh-localId dup → startSession-window wants the opposite of logout). The two sub-cases genuinely want opposite returns — logout (row wiped) wants `false` to avoid silent loss; the survive-and-replay windows (startSession-lag, or `reset()`-threw) want `true` so the cleared draft can't be manually re-sent into a dup. **No single client-side return value is correct for both; this is design-undecidable at the client layer and fully resolvable only by server-side idempotency (#484).** Deliberate choice: **`false`** — bias toward never silently losing user-typed text (the worse harm), accepting that in the narrow survive-and-replay windows a *manual* resend could double-post. That residual requires a sub-second race **plus** a deliberate manual resend and is tracked in the #484 follow-up (incl. the content-level-dedup stretch). Per the oscillation stop-rule, this is not re-opened in further rounds.

In the reachable `!owns()` cases: when the row was wiped by `logout()`'s `reset()` —
- Returning `false` is correct (the durable copy no longer exists → not "queued"); it prevents the composer's `send()` (components.tsx:2629) from clearing the draft/blanking the textarea → **no silent loss** (fixes the P3/fail-loud violation both reviewers flagged).
- Skipping `sendPendingMessage` prevents the actual P56 harm: dispatching the abandoned message through a *newly-logged-in* session's connection.
- No double-send **in the common case**: the row is gone, and returning `false` keeps only the visible textarea text (which is empty anyway if the composer was unmounted by the sign-out). If the user re-sends, it's a fresh `localId`.
- **Reset-failure edge (round-3 B1 / round-4 B2 — honest scoping, #485 strictly improves it):** `logout()`'s `await database.reset()` is wrapped in a swallowing try/catch (client.ts:347-351) so signing out is never blocked by local-cleanup failure. If `reset()` *throws* (IndexedDB unavailable mid-logout), the outbox row can survive; on re-login the new session's `handleReady` reads the same user's IndexedDB and replays it (client.ts:1482/1513) — the original message still gets delivered. `sendMessage` returned `false` (draft retained), so a *manual user resend* of that draft would create a **fresh `localId`** and double-post — and because the resend's `localId` differs from the replayed original, server-side `localId` dedup (#484) **cannot** catch it. So this is **NOT subsumed by #484**; it is a distinct, pre-existing, ultra-rare edge that would need **content-level** idempotency to fully close.
  - **Why #485 still strictly improves it:** the pre-#485 code returned `true` AND called `sendPendingMessage(message)` on the post-await `this.connection` — so on logout→relogin it *double-egressed* (the direct dispatch on the new connection **plus** the replay). #485 blocks the direct cross-session dispatch (the P56 fix), removing that vector entirely. The only residual is the human-in-the-loop manual resend, gated on the near-impossible `reset()`-throws-mid-send-mid-logout sequence. **Accepted limitation** (documented; content-level idempotency noted as a stretch goal in the #484 follow-up), not a regression — #485 reduces the dup surface, never widens it.

**Contract points:**
- `sendPendingMessage(message, connection)` — the captured `connection`, not the default `this.connection`. The method already accepts an optional `connection` param (used by `handleReady`'s replay at line 1513), so this is the sanctioned call shape.
- No behavior change on the happy path (no session swap): `owns()` is true, all downstream logic runs identically, returns `true`.

**Scope note:** this is the pre-existing narrow race called out in #485 — NOT introduced by the composer-rows PR (that PR's proportionate identity fix was binding `targetConvoId`, already present at line 604).

---

## FIX 3 — #486 durable, robust draft persistence

**Where:** `src/journal/composer-drafts.ts` (rewrite the store internals), + a minimal non-durable signal surfaced through `src/journal/components.tsx` composer.

**Problems (both real):**
1. **Last-writer-wins cross-tab clobber.** `persist()` serializes the *entire* in-memory map to one localStorage key (`matron:draft:v1:<server>:<user>`). Two tabs sharing that origin+user each hold their own `mem` map. Tab B's `persist()` writes B's whole map, silently dropping any draft Tab A wrote for a conversation B never touched. Genuine data loss (a typed-but-unsent draft vanishes).
2. **Silent eviction / quota loss.** `>64KiB` entries are dropped from the serialized output (line 80), `>50` entries evict oldest (line 60/102), and `setItem` quota/SecurityError is swallowed to a `console.warn` (line 83-85). The user gets no signal their draft won't survive reload.

**Fix — per-conversation keys, no eviction, non-durable signal.** (Design simplified across two review rounds: dropped the shared eviction index, the storage-event listener, *and* the whole entry-cap eviction — each reintroduced a defect the reviewers flagged. Per-key value is now just the raw draft text. See "review revisions folded in" at the end.)

**A. Per-key storage (kills the stated clobber).** Store each conversation's draft under its own key, value = the raw draft text (no header):
```
matron:draft:v2:<encodeURIComponent(serverUrl)>:<userId>:<encodeURIComponent(convoId)>
```
- **The debounced `persist(convoId)` owns the localStorage write** (resolves round-1 Claude-#2 + round-2 B3 identity): `setDraft(convoId, text)` updates only the in-memory `mem` map (per-keystroke, no I/O), exactly as today. `persist` **takes an explicit `convoId`** and writes **only that convo's key** via `setItem(perKey(convoId), text)` (empty/whitespace → `removeItem`). The three call sites pass the convo whose edit scheduled the write:
  - the `setBodyDraft` debounce (components.tsx:2578) **captures `cid` at schedule time** in its closure → `setTimeout(() => drafts.persist(cid), 250)` (not `convoIdRef.current` at fire time);
  - `flushDraft` (components.tsx:2565) flushes the convo it was scheduled for — since the convo-switch effect calls `flushDraft()` at components.tsx:2601 *before* updating `prevConvoIdRef`, it passes `prevConvoIdRef.current` (the convo being left);
  - `send()`'s else-branch (components.tsx:2635) passes its local `cid`.
  - **Why this is race-free (grounds round-2 B3):** `flushDraft` (2565) calls `cancelDraftDebounce()` which `clearTimeout`s the pending debounce, and the convo-switch effect runs `flushDraft()` synchronously on switch (2601). So a pending debounce for convo A is always flushed-and-cancelled before B's first `setDraft` — no debounce ever fires with a stale convoId. An explicit captured `convoId` makes this correct even if that invariant were ever weakened. **Acceptance test covers the edit-A → switch-to-B → edit-B sequence.**
  - Because `persist` writes exactly one convo's key, a tab persisting convo X can never touch convo Y's key. **Cross-convo clobber is structurally impossible in the steady state** — this is the entire fix for the stated bug. (The one transient exception is the retained-v1 blob rewrite during a *partial* migration — an ultra-rare precondition documented in F/round-6 Major-2; it does not exist once migration completes.)
- `read(convoId)` → returns `{ text, ok }` (**preserving the current signature + `ok:false`-on-storage-failure contract**, composer-drafts.ts:89 — round-6 Major-3). **Fallback chain** for `text`: `mem[convoId]` (in-session edits authoritative) ?? the convo's v2 per-key value ?? (if a legacy v1 blob is still present because migration is incomplete — see F) that convo's v1 entry ?? `""`. **v2 always precedes v1** (a migrated/edited v2 value wins over the stale v1 copy); the v1 fallback keeps a *retained-on-partial-migration* entry readable in-session (resolves round-3 B2 — the current store hydrates v1 into memory at composer-drafts.ts:52; this fallback preserves that recovery without eager hydration). **Read-failure handling (round-6 Major-3):** the `getItem` reads are wrapped in try/catch exactly like today; a `SecurityError`/read throw returns `{ text: "", ok: false }` (NOT a crash, NOT a silent blank that overwrites) — the composer already handles `ok:false` by not clobbering (`setBody(ok ? text : "")` at components.tsx:2603). Acceptance test covers a `getItem`-throws read.
- `clear(convoId)` → drop from `mem`, `removeItem(perKey)`, **AND if a legacy v1 blob is still retained (incomplete migration), remove `convoId` from it too** (rewrite the blob without that entry; delete the v1 key if it becomes empty). This is required because the `read()` v1 fallback would otherwise **resurrect a just-sent draft** from the retained v1 blob on the next read/reload (round-4 B1). All three removals are wrapped in try/catch (resolves round-3 Major-1); a rare `removeItem`/rewrite `SecurityError` is logged, **sets `durability(convoId) → non-durable` as a best-effort P3 signal** (round-5 Major-2), and `mem` is cleared regardless so the in-session composer is correct. A storage-throw leaving a stale copy is an ultra-rare pre-existing edge (same `SecurityError` class as persist failures; see FIX 2 on content-level idempotency for the resend-dup residual), not silent draft *loss*.

**B. Bounded by a REFUSE-not-evict cap (reconciles round-2 B2 + round-4 B3).** Two failure modes had to be squared: silent *eviction* of an old draft (round-2 B2 — itself the #486 defect) and *unbounded growth* consuming origin-wide localStorage until an unrelated write fails, e.g. login's `SESSION_KEY` `setItem` (round-4 B3, client.ts:327-328). The resolution is a **count cap that refuses rather than evicts**:
- `MAX_DRAFT_ENTRIES` (50) bounds the number of persisted draft keys (prefix-scan count). **Updating an existing convo's key is always allowed** (no growth). When persisting would create a **new** key beyond the cap, the write is **refused** — the current convo goes `non-durable` and shows the badge (D). **No existing draft is ever evicted** (kills silent loss) and **draft-store growth is bounded** at 50 keys × the 64KiB byte cap (kills the unbounded-growth/login-wedge risk).
- The per-key **byte cap** (C) is retained. Real drafts are small (bytes–KB), so the practical footprint is far under the theoretical 50×64KiB bound; the cap's job is to prevent pathological accumulation, and hitting it is always fail-loud on the current convo, never silent on an old one.
- **Soft bound, not a hard invariant (round-5 Major-1):** the count is a prefix-scan then a write — not atomic across tabs. Two tabs each at 49 keys can both pass the check and write different new keys → a transient 51. This is a **soft bound**: overshoot is bounded by the number of concurrent writers (realistically 1–2), it still prevents *unbounded* growth (the login-wedge risk), and it never evicts. The acceptance test asserts the single-writer refusal; the cross-tab overshoot is documented as accepted, not asserted-exact.
- **Scope of the bound: per-identity, not origin-wide (round-6 Major-1).** The cap counts *this* store's keys (scoped by `serverUrl:userId`). A browser used under multiple server/user identities could hold ~50 keys *per namespace*, so the cap bounds per-identity growth but not total origin localStorage — a multi-identity user could still, in principle, pressure the origin quota and starve unrelated writes (login's `SESSION_KEY`). This is a rarer (multi-identity) residual than the single-identity unbounded-growth it fixes; a global origin-wide draft budget is out of scope (would couple the draft store to every other localStorage consumer). Documented, not closed.

**C. Byte cap.** `MAX_DRAFT_BYTES` (64KiB) still applies per-key at write time; an oversized draft is NOT written to storage (in-memory `mem` stays authoritative for the session) and triggers the non-durable signal (D).

**D. Non-durable signal (fail-loud).** When a `persist(convoId)` for the *current* conversation fails or is skipped (quota `SecurityError`/`QuotaExceededError`, oversized-skip per C, or refused for exceeding the entry cap per B), set a store-level per-convo flag readable by the composer, which renders a small inline non-durable badge ("Draft won't be saved — storage full") near the composer — reuses the existing notice styling vocabulary, no new component. The badge clears when a subsequent persist for that conversation succeeds. Scope the badge to the selected conversation to avoid cross-convo noise.
- Interface addition: `DraftStore` gains `durability(convoId): "ok" | "non-durable"`.
- **Render-state contract (round-5 Major-3 + round-6 B2 — the store flag is canonical, React state mirrors it and must be re-synced, never blindly reset):** the store's per-convo `durability` flag is the **canonical source** (P2). The composer holds `const [nonDurable, setNonDurable] = useState(false)` as a render mirror and calls `setNonDurable(drafts.durability(cid) === "non-durable")`:
  - **immediately after every `persist(convoId)`** (the 250ms debounce callback, `flushDraft`, `send()`'s else-branch) — the explicit `setState` is what forces React to render the badge, since the debounce fires inside a `setTimeout` with no other state change;
  - **on convo-switch, synced FROM the store for the NEW convo** (`setNonDurable(drafts.durability(newConvoId) === "non-durable")`) in the convo-change `useLayoutEffect` — **NOT a blind reset to `false`** (round-6 B2: resetting to false would drop a still-non-durable warning when the user switches away from A and back, since re-selecting A doesn't re-persist). Reading the canonical store flag on switch keeps the mirror correct.
  - Because `clear()`-failure also sets the store flag (section A), the switch-sync path surfaces it on next selection even without a persist.
- **Acceptance tests:** (a) a timer-driven persist failure alone flips rendered output (badge appears, no other interaction); (b) fail persist on A → switch to B → switch back to A → badge is still shown (synced from the store, not reset).

**E. Same-convo two-tab editing = accepted last-writer-wins (scope narrowing — resolves round-1 M2/M5/Claude-#4).** The stated #486 bug is clobber of an **unrelated** convo's draft; per-key storage (A) fixes that completely. Two tabs *editing the same conversation simultaneously* is an inherent controlled-editor conflict (you cannot merge two textareas) — last-writer-wins is the correct, expected semantic and **explicitly out of scope**. We add **no `storage`-event listener** (round-1 M2: cache-invalidation can't reconcile React-controlled composer state; M5: the listener needs a lifecycle the `DraftStore` doesn't have). Residual, documented + strictly better than status quo: a convo's draft edited in tab B, then *viewed without reload* in tab A that cached it in `mem`, may show tab A's older value until reload — requires two live tabs on the *same* convo, never loses another convo's draft, self-heals on reload.

**F. Migration from v1 — gated + v2-precedence, retain-on-partial-failure (resolves round-1 B2 + round-2 B1 + Major-1).** On first store construction for a session, if the legacy `matron:draft:v1:<server>:<user>` blob exists:
- For each entry, write its v2 per-key form **only if that v2 key does not already exist** (`getItem(perKey) === null`). **v2 always wins** — a newer v2 draft the user wrote after a prior partial migration is never overwritten by the stale v1 copy (round-2 B1: retry is now genuinely idempotent). Respect the byte cap (C).
- **Only `removeItem` the v1 blob if *every* entry is now durable in v2** — i.e. each entry's v2 key exists (either freshly written or already present) AND no write threw. If any entry is skipped-oversized or its write failed (quota), **retain the v1 blob untouched** (round-2 Major-1: an oversized v1 entry — which the current v1 writer can't even produce, since line 80 excludes >64KiB, so this only arises from external tampering — never gets deleted before it's durable) and surface the non-durable signal. Migration retries idempotently on next construction.
- A malformed v1 blob → skip migration, leave it (fail-open, matches current `parseMap` reset-on-malformed). **No entry is ever deleted from v1 before its v2 copy is confirmed durable.**
- **While a v1 blob is retained (partial migration), its un-migrated entries stay readable via the `read()` v1 fallback (A)** — so a quota-failed entry B is never blank in-session (resolves round-3 B2). Once B's v2 write later succeeds and the whole v1 blob is removed, reads come from v2. Acceptance test: seed a 2-entry v1, force the 2nd write to throw, assert v1 retained AND `read()` returns the failed entry's text.
- **Retained-v1 `clear()`-rewrite cross-tab race (round-6 Major-2 — accepted, ultra-rare).** While a v1 blob is retained, `clear()` rewrites it minus the cleared entry (A), which is a non-atomic whole-blob read-modify-write — two tabs clearing different convos concurrently could have the last writer restore the other's removed entry, and the `read()` v1 fallback could then resurrect a sent draft. **Precondition stack makes this vanishingly rare:** it needs the one-time v1→v2 migration to be *partial* (which itself requires quota-exhaustion during a migration of tiny drafts — near-impossible) AND two tabs concurrently clearing during that transient retained-v1 window. Once migration completes (the overwhelming normal case), there is no v1 blob and the per-key isolation is absolute. Accepted as an ultra-rare edge within an already-near-impossible state; not worth an atomic-guard mechanism for a P5 draft store.

**Bounds / non-goals:**
- Not moving to IndexedDB (heavier, async; per-key localStorage closes the stated clobber at far lower cost — right-size-to-gain). Drafts remain best-effort (localStorage is browser-evictable); the badge makes non-durability *visible*, which is the honest fix.
- **Forward-only migration; rollback shows no v2 drafts (accepted, round-5 B2).** Once migration completes and the v1 blob is deleted, a *rolled-back* or stale-cached pre-v2 client (which reads only `matron:draft:v1`) will show blank drafts — the data is in v2 keys it doesn't know about. This is accepted: drafts are unsent best-effort text, client rollback is rare, and the alternative (dual-writing v1 for a compat window) would reintroduce the whole-blob cross-tab clobber that is *the* bug being fixed. Showing blank (re-type) is cleaner than showing stale v1 drafts. Not mitigated further.

**Review revisions folded in:** dropped the shared `matron:draft:v2:index` key (r1-M1), dropped the `storage`-event listener (r1-M2/M5), dropped the embedded-timestamp header + *eviction* and replaced it with a **refuse-not-evict** entry cap (r2-B2 no-silent-loss + r4-B3 bounded-growth), made `persist` take an explicit `convoId` captured at schedule time (r1-Claude#2 + r2-B3), added v2-precedence migration + `read()` v1 fallback for retained entries (r2-B1 + r3-B2) with `clear()` purging the retained v1 blob so a sent draft can't resurrect (r4-B1), and gated v1 deletion on full durability incl. oversized (r1-B2 + r2-Major-1).

---

## CLOSE 3 — #491 markdown bundle trim (accepted — lazy-load disproportionate)

**Corrected premise:** #491 attributes +1.9MB to "14 highlight.js grammars." Measured against fork-main: the 13 imported grammars total ~116KB raw + hljs `core.js` ~76KB ≈ **190KB**. The remaining ~1.7MB is `react-markdown` + `remark-gfm` + `rehype-highlight` + the `micromark`/`mdast`/`hast` transitive graph. **Trimming grammars is low-yield** (~100KB of ~1900KB) and costs highlighting for real languages — rejected.

**Why the lazy-load reframe is also dropped (round-2 M2/M3 + Claude dependency-leak):** the only material lever is deferring the whole render pipeline via dynamic `import()`. Two review rounds surfaced that this is disproportionate for a P5, tailnet-only, cached-after-first-load PWA:
- **Inherent initial-load reflow (round-2 Codex M2):** the 1.9MB *is* the markdown-parse pipeline — you cannot defer it without rendering raw text first. Every message body mounted before the async chunk resolves renders raw, then re-renders to markdown together → a mass reflow / scroll displacement on every fresh page load. There is no flash-free deferral.
- **Poisoned module-promise (round-2 Codex M3):** a memoized `rendererPromise` rejected once (transient chunk 404 on a long-lived PWA tab) disables markdown for the whole page lifetime; recovery needs a full reload.
- **Split fragility + restructure cost (round-2 Claude dependency-leak):** every heavy-dep helper (`CURATED`/`HIGHLIGHT_OPTIONS`/`componentsFor`/`CodeBlock`) must move behind the boundary or the split silently fails the measure-gate; and webpack `splitChunks` may hoist react-markdown back into the entry chunk anyway.

Weighed against the gain — deferring a **one-time** 1.9MB on a tailnet PWA that caches after first load — the complexity, the new failure surface, and the guaranteed initial-load reflow are not worth it (right-size-to-gain). The measure-gate the operator pre-authorized ("downgrade to close-as-accepted if the split is disproportionate") resolves to close.

**Close rationale (one line):** grammar-trim is low-yield (premise wrong); full-pipeline lazy-load causes an inherent initial-load mass reflow + poisoned-promise failure surface for a one-time cached cost on a tailnet PWA — accepted as-is, revisit only if the client ever ships to a non-cached / metered context. Note in closure: `detect:true` remains removed (DoS mitigation, spec Implementation-revision) — untyped fences render unhighlighted.

---

## CLOSE 1 — #481 reconnect-purge draft crash durability (accepted-risk)

**Verified:** the window is real — `handleReady` (client.ts:1495-1504) patches the volatile `controlError` notice, then durably `deleteOutboxRows(blockedTextIds)`. A tab death between the durable delete-commit and the notice paint loses both the blocked text and its explanation on reload.

**Why close, not fix:**
- The lost data is an **undeliverable** draft: `blockedTextIds` are messages targeting a read-only subagent/child transcript (`isChildConvo` true). The text can never be sent regardless of persistence.
- Sub-second window (delete-commit → next paint).
- The proper fixes (tombstone in the same IndexedDB tx + startup restore, OR mark-don't-delete with a new errored-text render path since `attachState` is attachment-semantic) add real code + a new render surface for marginal value on undeliverable data.
- The loop's own text dispositions it as "a documented override … low priority. Upstream-PR candidate to Matronhq/matron-web."

**Disposition — accepted RISK, not "verified-safe" (round-1 M3, P3 Fail Visible):** Codex correctly notes "undeliverable" ≠ "valueless" — the user could copy/retarget the text once told the transcript is read-only, and the crash path removes both the text and its failure evidence. So this is closed as an **operator-acknowledged accepted risk** (operator confirmed the close in triage 2026-07-23), NOT a claim that no defect exists. Tier 2 (narrow window); the proper fix (same-tx tombstone + startup restore) stays an upstream-PR candidate.

**Close rationale (one line):** accepted risk — sub-second window on undeliverable-draft data, durable deletion is correct, notice is best-effort by design; operator-acknowledged, upstream-PR candidate, not a local fix.

---

## CLOSE 2 — #483 composer recent-folders agent-scoping (verified-safe)

**Verified:** `makeRecentFoldersStore` (slash-palette.ts:176) keys by `serverUrl:userId` only, not agent. `store.record()` (components.tsx:2631) pools folders across all agents; `recentFolders(agent.device_id)` (client.ts:381) is a separate RPC path. Folder paths are agent-machine-specific, so cross-agent pooling can surface a wrong-machine path.

**Why close, not fix:**
- The store drives **advisory autocomplete only** — a wrong suggestion is ignorable; the path still sends exactly as typed. No wrong action, no data loss.
- Effectively single-agent today (operator-bridge). Cross-agent collision is speculative.
- Per-agent keying threads agent identity into the composer draft/folder store, **forking the composer store shape from Dan's upstream layout** (`project_matron_web_stays_dan_upstream_aligned`) for near-zero real-workflow gain.

**Close rationale (one line):** advisory autocomplete (no wrong action), effectively single-agent, per-agent keying forks Dan's layout for negligible gain — upstream-PR candidate, not a local fix.

---

## FILE + CLOSE — #484 send idempotency + hung-send recovery (gated on matron-journal)

**Verified:**
- (a) End-to-end idempotency: reconnect-replay (`handleReady` → `sendPendingMessage` for kept outbox rows) + clear-failure-resurrect can re-dispatch an already-delivered message. There is no server-side dedup on `localId`. The **only** correct fix is a stable-`localId` dedup key enforced server-side in **matron-journal** (Dan's repo).
- (b) Hung `addToOutbox`: `send` in components.tsx adds `cid` to `sendingConvos` (2627), awaits `client.sendMessage`, removes it in `finally` (2646). If `addToOutbox` (IndexedDB) wedges, the await never resolves → that convo's composer is locked until reload.

**Why file + close, not fix client-side now:**
- (b)'s safe recovery is **gated on (a)**. Any client watchdog that releases the `sendingConvos` lock (or retries) risks a double-send if the hung `addToOutbox` later commits — exactly the dup that only server-side `localId` dedup can absorb. The loop itself notes "a timer risks slow-success dups." Adding an indeterminate-state indicator without releasing the lock is cosmetic (composer still can't send to that convo) and doesn't recover the wedge.
- Therefore: **file a matron-journal follow-up loop** for server-side `localId` dedup (the enabling work), and close #484 as gated-on-upstream. Once server dedup lands, the client half (watchdog + safe retry + indeterminate state) becomes safe and can be a fresh matron-web loop.

**Cross-repo follow-up to file (son-of-anton loop store) — with explicit `next_action` (round-1 M4, R203):**
- Title: `matron-journal-server-side-localid-dedup`; owner: operator; priority: 4; status: active.
- `next_action`: `{ action_id: "impl-localid-dedup", type: "implementation", priority: 4 }` (R203 Open Loops Must Have Next Step — a body alone is insufficient).
- Body: enforce idempotent message ingest keyed on client `localId` in matron-journal (`easelyte/matron-journal`, `/opt/matron/journal`) so reconnect-replay / resurrect cannot double-post; unblocks matron-web #484 client-side hung-send watchdog + safe retry. **Stretch:** consider content-level (body+convo+short-window) dedup in addition to `localId` — the FIX 2 reset-failure edge produces a manual resend with a *fresh* `localId` that `localId`-only dedup cannot catch.

**Ordering — closure gated on durable follow-up creation (round-1 M4, P19):** in execute/ship, the `add_loop` for `matron-journal-server-side-localid-dedup` MUST be committed to the loop store and verified present **before** `close_loop_by_id(484)`. If the follow-up filing fails, #484 stays open (do not orphan its only enabling dependency). The two mutations ride the same `chore(loops)` commit; the close is contingent on the add succeeding.

**Close rationale (one line for #484):** client-side recovery is unsafe without server-side `localId` dedup (double-send risk); matron-journal follow-up filed (with next_action) as the enabling work and verified present before close — client half deferred until that lands.

---

## File-touch summary

| File | FIX | Change |
|---|---|---|
| `test/unit-tests/journal/theme-test.ts` | #494 | add describe: extract dark canvas token from shell.pcss, assert 3-way parity |
| `src/journal/client.ts` | #485 | `sendMessage` capture-before-await identity tuple + `owns()` gate; return `false` on `!owns()`; pass captured `connection` to `sendPendingMessage` |
| `src/journal/composer-drafts.ts` | #486 | per-key v2 storage (raw-text value, write owned by debounced `persist(convoId)`), refuse-not-evict count cap (soft, no eviction), `durability(convoId)`, gated v2-precedence v1 migration + `read()` v1 fallback + `clear()` v1-purge; no storage listener |
| `src/journal/components.tsx` | #486 | read `drafts.durability(convoId)` after persist, render non-durable badge (selected convo only) |
| `test/unit-tests/journal/composer-drafts-test.ts` | #486 | per-key isolation + cross-convo no-clobber + switch-mid-debounce persist(convoId) + gated v2-precedence migration (retain-on-fail) + durability flag |

**No changes** for #491 (closed — no markdown.tsx / markdown-test.ts edits).

**No changes** for #481, #483 (closed), #484 (client deferred; matron-journal loop filed).

## Test plan

- **#494:** parity test fails if any of the 3 canvas literals desyncs (proven in dev, not committed as a mutation).
- **#485:** unit tests for both `!owns()` transition windows — (a) mock `addToOutbox` to bump `sessionGen` (logout/reset) mid-await; (b) mock so `this.connection` is `undefined` at capture then assigned during the await (startSession-lag). In both, assert `sendMessage` returns `false` and `sendPendingMessage` is NOT called on any connection. Happy-path test asserts the `owns()`-true path returns `true` and dispatches on the captured connection identically to today.
- **#486:** two-store instances on shared localStorage — write different convos, assert neither clobbers the other's per-key value; `persist(convoId)` with the edit-A→switch-to-B→edit-B sequence writes each convo's own key (no stale-debounce cross-write); gated v2-precedence migration from a seeded v1 blob (all-success → v1 removed; a pre-existing v2 key is NOT overwritten by stale v1; forced 2nd-entry write-failure → v1 retained AND `read()` still returns the failed entry via the v1 fallback); quota-throw on persist → durability flips to `non-durable` + badge renders; `clear()` with `removeItem` throwing → mem still cleared, no crash; `clear()` while a v1 blob is retained → the entry is purged from v1 too (reload does NOT resurrect the sent draft); `read()` when `getItem` throws → returns `{text:"", ok:false}` (no crash, composer keeps its buffer); refuse-not-evict cap → a 51st NEW convo is refused with the badge while the existing 50 keys are untouched (no eviction); badge persistence across convo switch-away/back (synced from the store flag, not reset).
- **#491:** no test changes — closed (accepted).

## Rejected alternatives

- **#494 codegen from palette:** breaks the pre-paint inline-bootstrap contract (can't import). Test guard chosen.
- **#486 IndexedDB:** heavier async rewrite; per-key localStorage closes the clobber at lower cost.
- **#486 shared eviction index (`matron:draft:v2:index`) AND the per-key embedded-timestamp header:** round-1 M1 killed the shared index; round-2 B2 then killed the embedded-timestamp header + *eviction* (any silent eviction reproduces the #486 defect). Final design has **no eviction and no timestamp** — per-key value is raw text; growth is bounded by a **refuse-not-evict soft count cap** (`MAX_DRAFT_ENTRIES`), fail-loud via badge, never dropping an old draft.
- **#486 storage-event reconciliation + listener:** round-1 M2/M5 — cache-invalidation can't reconcile React-controlled composer state, and the listener lacked a lifecycle owner. Dropped; same-convo two-tab is accepted last-writer-wins (out of scope for the unrelated-convo clobber #486 targets).
- **#485 return `true` on `!owns()`:** round-1 B1/Claude-M1 — the outbox row is already wiped by `logout()`'s `reset()`, so `true` clears the draft = silent loss. Return `false` (fail-loud); the guard's real job is blocking cross-session dispatch.
- **#491 lazy-load the markdown pipeline (both the new-file `React.lazy` and the inline-`import()` variants):** round-1 B3 (new file breaks the no-new-files constraint; list-level Suspense blanks scrollback) → reworked to inline `import()`, then round-2 M2/M3 showed the inline variant has an inherent initial-load mass reflow (the 1.9MB *is* the parse pipeline) + a poisoned-module-promise failure surface. Disproportionate for a cached tailnet PWA → closed-as-accepted (CLOSE 3).
- **#491 trim grammars:** premise-wrong (grammars ≈190KB of 1.9MB); low-yield. Rejected.
- **#486 entry-cap *eviction* (embedded-timestamp or index):** round-2 B2 — any silent eviction reproduces the exact silent-loss defect #486 names. Replaced with a **refuse-not-evict** cap (round-4 B3): the 50-key bound is kept (so unbounded growth can't starve origin-wide localStorage / wedge login), but hitting it *refuses* the new key with a fail-loud badge instead of silently evicting an old draft.
- **#486 drop the cap entirely (round-2→round-4):** round-2 removed the cap to kill silent eviction, but round-4 B3 showed unbounded draft growth can exhaust origin-wide quota and wedge unrelated writes (login's `SESSION_KEY`). Refuse-not-evict cap restores the bound without the silent loss.
- **#484 client watchdog now:** unsafe without server dedup (double-send). Deferred behind the filed matron-journal loop; closure gated on that loop's durable creation.
- **#481/#483 local fixes:** disproportionate to gain / fork-divergence; #481 closed as operator-acknowledged accepted risk (P3), #483 as upstream-PR candidate.

## related_principles
- drift-detection guard #494 (parity ratchet, not P2 derivation), fail-loud/no-silent-loss (#486 badge + dropped silent eviction), right-size-to-gain (#481/#483/#491 close).
