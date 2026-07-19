# Web Subagent Sub-Chat Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render subagent child-conversations in the matron-web journal client — hidden from the main list, reachable via a running-subagent strip + parent switcher, opened in a read-only child viewer — matching apple iOS parity (loop #453).

**Architecture:** All changes are inline within the existing `src/journal/{types.ts,database.ts,client.ts,components.tsx,journal.pcss}` (no file splits — upstream-alignment constraint). A `parent_convo_id` field flows from the server (snapshot + `convo_meta`) into the client store; parent→child relationships are *derived* from `state.conversations`, never stored separately. Read-only is enforced in three layers: UI suppression (primary UX), client egress guards at both transmit functions (defense-in-depth), and a documented server-side follow-up (authoritative).

**Tech Stack:** TypeScript, React 18 (`useSyncExternalStore` over a hand-rolled `MatronJournalClient` external store), IndexedDB (`JournalDatabase`), plain PostCSS (`mj_*`/`mx_*` classes), Jest + jsdom (`test/unit-tests/journal/*-test.ts`, `node_modules/.bin/jest`).

Spec: `docs/superpowers/specs/2026-07-18-web-subagent-subchats-design.md` (converged at spec-review round 4). All `file:line` references verified against HEAD `ccca0fd`.

## Global Constraints

- **No file splits:** `components.tsx` (1874) and `client.ts` (1395) stay structurally aligned with `Matronhq/matron-web` upstream. All new components/state land INLINE. (Accepted P18 exception; upstream split tracked as loop #448.)
- **No new server/bridge dependency to ship:** the `session_status: done` completion signal is pre-existing and verified. Client-side read-only is defense-in-depth; authoritative server-side rejection is a documented follow-up (spec §5), out of scope here.
- **No IndexedDB object-store schema bump:** the new `parent_convo_id` field is backward-compatible; a one-time *data* backfill reconciles existing records.
- **Commit author:** `easelyte <fantin@easelyte.ai>`. Origin remote is `easelyte`; NEVER push `upstream`/Matronhq.
- **Test runner:** `node_modules/.bin/jest <path>` (jest `--runInBand`, jsdom). Lint: `pnpm lint` (tsc + prettier).
- **Parent→child linkage is child→parent only** (structural). Child convo ids are hierarchical: `<parentConvoId>:sub:<agentId>`. Nesting works at any depth — never assume children are leaves.

---

## Phase & task overview

- **Phase 1 — Data model, boundary parser, derivations, backfill** (pure/data layer)
- **Phase 2 — List exclusion & full consumer audit**
- **Phase 3 — Read-only egress enforcement** (data-layer invariant; lands before children are openable)
- **Phase 4 — Navigation surfaces & read-only child viewer** (strip, parent switcher, child header, in-child switcher, UI suppression)
- **Phase 5 — Tail-follow & jump-to-bottom**
- **Phase 6 — Styling**
- **Phase 7 — Verify, deploy, follow-ups**

**Dependency graph:** Phase 1 blocks all. Phase 2 → 1. Phase 3 → 1. Phase 4 → 1, 3 (egress invariant must exist before the child viewer exposes children). Phase 5 → 1 (`ClientState.sendTick`) and sequences after 4 (both touch `Timeline`). Phase 6 → 4, 5. Phase 7 → all.

**Spec-coverage map** (spec §→plan task):
- §4.1 data model + ingestion + resync coalesce → T-1.1, T-1.3
- §4.2 derivation helpers (`isSubChat`/`childrenOf`/`runningChildrenOf`/`parentPresent`) → T-1.2
- §4.8 backfill → T-1.4
- §4.3 list exclusion + consumer audit → T-2.1, T-2.2
- §4.5 read-only egress (both transmit fns + upload + prompt + staging + fail-visible + selection race + ratchet) → T-3.1…T-3.5
- §4.4 running strip + parent switcher → T-4.1, T-4.2
- §4.5 child viewer chrome + isReadOnly threading + in-child switcher → T-4.3, T-4.4, T-4.5
- §4.6 tail-follow + jump-to-bottom + sendTick → T-5.1…T-5.4
- §4.7 styling → T-6.1
- §7 tests → embedded per task; §9 acceptance → T-7.1 manual matrix
- Non-goals / follow-ups (split-view B, inline markers C, server-side rejection) → T-7.2

---

## Phase 1 — Data model, boundary parser, derivations, backfill

### T-1.1: `parent_convo_id` field + `coerceParentId` boundary parser

**Files:**
- Modify: `src/journal/types.ts` (add field to `Conversation` ~line 38; add `coerceParentId`)
- Test: `test/unit-tests/journal/subchat-model-test.ts` (create)

**Interfaces:**
- Produces: `Conversation.parent_convo_id?: string | null`; `coerceParentId(x: unknown): string | null` (trims; non-string/empty/whitespace → `null`).

- [ ] **Step 1: Write the failing test**

```ts
import { coerceParentId } from "../../../src/journal/types";

describe("coerceParentId", () => {
    it("returns null for non-string, empty, and whitespace inputs", () => {
        for (const bad of [0, {}, [], null, undefined, "", "   "]) {
            expect(coerceParentId(bad)).toBeNull();
        }
    });
    it("returns the trimmed string for a real id", () => {
        expect(coerceParentId("p1:sub:a1")).toBe("p1:sub:a1");
        expect(coerceParentId("  p1:sub:a1  ")).toBe("p1:sub:a1");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-model-test.ts -t coerceParentId`
Expected: FAIL — `coerceParentId is not a function`.

- [ ] **Step 3: Implement**

In `src/journal/types.ts`, add to the `Conversation` interface (after `created_at`):
```ts
    parent_convo_id?: string | null; // null/undefined = top-level; set once at child creation, immutable
```
Add the exported parser:
```ts
export function coerceParentId(x: unknown): string | null {
    const s = typeof x === "string" ? x.trim() : "";
    return s || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-model-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/types.ts test/unit-tests/journal/subchat-model-test.ts
git commit -m "feat(subchat): parent_convo_id field + coerceParentId boundary parser"
```

**Acceptance:** `Conversation` carries `parent_convo_id?`; `coerceParentId` normalizes non-string/empty/whitespace to `null` and trims real ids (spec §4.1, §7.1).

### T-1.2: derivation helpers — `isSubChat`, `childrenOf`, `runningChildrenOf`, `parentPresent`

**Files:**
- Modify: `src/journal/types.ts` (add four helpers)
- Test: `test/unit-tests/journal/subchat-derivations-test.ts` (create)

**Interfaces:**
- Consumes: `Conversation`.
- Produces: `isSubChat(c): boolean`; `childrenOf(convos, parentId: string|null|undefined): Conversation[]` (oldest-first, `[]` on nullish); `runningChildrenOf(...)`; `parentPresent(c, ids: ReadonlySet<string>): boolean` (false for self-parent).

- [ ] **Step 1: Write the failing test**

```ts
import { isSubChat, childrenOf, runningChildrenOf, parentPresent } from "../../../src/journal/types";

const convo = (id: string, extra: Partial<any> = {}) => ({
    id, title: "", session_state: "done", last_seq: 0, unread_count: 0,
    snippet: "", created_at: 0, read_up_to_seq: 0, ...extra,
});

describe("subchat derivations", () => {
    const p = convo("p1");
    const c1 = convo("p1:sub:a1", { parent_convo_id: "p1", created_at: 1, session_state: "running" });
    const c2 = convo("p1:sub:a2", { parent_convo_id: "p1", created_at: 2, session_state: "done" });
    const all = [p, c2, c1];

    it("isSubChat true only for linked convos", () => {
        expect(isSubChat(p)).toBe(false);
        expect(isSubChat(c1)).toBe(true);
    });
    it("childrenOf is oldest-first and nullish-safe", () => {
        expect(childrenOf(all, "p1").map((c) => c.id)).toEqual(["p1:sub:a1", "p1:sub:a2"]);
        expect(childrenOf(all, undefined)).toEqual([]);
    });
    it("runningChildrenOf filters to running", () => {
        expect(runningChildrenOf(all, "p1").map((c) => c.id)).toEqual(["p1:sub:a1"]);
    });
    it("parentPresent false for self-parent and absent parent", () => {
        const ids = new Set(all.map((c) => c.id));
        expect(parentPresent(c1, ids)).toBe(true);
        expect(parentPresent(convo("x", { parent_convo_id: "x" }), new Set(["x"]))).toBe(false); // self
        expect(parentPresent(convo("y", { parent_convo_id: "gone" }), ids)).toBe(false); // orphan
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-derivations-test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement** (in `src/journal/types.ts`):

```ts
export function isSubChat(c: Pick<Conversation, "parent_convo_id">): boolean {
    return c.parent_convo_id != null && c.parent_convo_id !== "";
}

export function childrenOf(conversations: Conversation[], parentId: string | null | undefined): Conversation[] {
    if (!parentId) return [];
    return conversations
        .filter((c) => c.parent_convo_id === parentId)
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function runningChildrenOf(conversations: Conversation[], parentId: string | null | undefined): Conversation[] {
    return childrenOf(conversations, parentId).filter((c) => c.session_state === "running");
}

export function parentPresent(c: Conversation, ids: ReadonlySet<string>): boolean {
    return isSubChat(c) && c.parent_convo_id !== c.id && c.parent_convo_id != null && ids.has(c.parent_convo_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-derivations-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/types.ts test/unit-tests/journal/subchat-derivations-test.ts
git commit -m "feat(subchat): derivation helpers (isSubChat/childrenOf/runningChildrenOf/parentPresent)"
```

**Acceptance:** helpers pure + unit-tested incl. nested/finished fixtures, nullish parentId, and the self-parent guard (spec §4.2, §7.2).

### T-1.3: ingestion — `applyJournal` convo_meta set-once + `replaceWithSnapshot` coalesce

**Files:**
- Modify: `src/journal/database.ts` — `emptyConversation` (~36), `applyJournal` `convo_meta` branch (~190), `replaceWithSnapshot` (~106, spread ~119)
- Test: `test/unit-tests/journal/subchat-ingestion-test.ts` (create; use the existing DB test harness / fake-indexeddb pattern already in `test/unit-tests/` — mirror an existing `database`-touching test's setup)

**Interfaces:**
- Consumes: `coerceParentId` (T-1.1).
- Produces: persisted `parent_convo_id` that is set-once (a later null/absent `convo_meta` never clears it) and preserved across a resync.

- [ ] **Step 1: Write the failing tests** (mirror the setup of the existing database test file; assertions):

```ts
// after applying a titleless convo_meta carrying parent_convo_id, the child record is linked:
//   expect(convo.parent_convo_id).toBe("p1")
// a later convo_meta with no parent_convo_id does NOT clear it:
//   expect(convo.parent_convo_id).toBe("p1")
// replaceWithSnapshot whose summary omits parent_convo_id for an already-linked child keeps the link:
//   expect(afterResync.parent_convo_id).toBe("p1")
// self-parent (convo_meta / snapshot with parent_convo_id === the convo's own id) → stored as null (top-level):
//   expect(convo.parent_convo_id).toBeNull()
// emptyConversation defaults parent_convo_id null.
```

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-ingestion-test.ts`
Expected: FAIL (link null / cleared).

- [ ] **Step 3: Implement**

`emptyConversation` (~36): add `parent_convo_id: null,` to the returned object.

`applyJournal` `convo_meta` branch — **relax the `&& title` guard** so a titleless meta is processed, and **reject self-parent** (`database.ts:190`):
```ts
if (event.type === "convo_meta") {
    if (typeof event.payload.title === "string") conversation.title = event.payload.title;
    let incoming = coerceParentId(event.payload.parent_convo_id);
    if (incoming === conversation.id) incoming = null; // self-parent → top-level (Codex R2)
    if (conversation.parent_convo_id == null && incoming) {
        conversation.parent_convo_id = incoming;
    }
}
```
Apply the same `incoming === <id> → null` self-reject in `replaceWithSnapshot` and `backfillParentLinks` (both have the summary id + incoming in scope).
(The `else if (event.type === "session_status" ...)` chain that follows is preserved — `convo_meta` never carries state/message semantics.)

`replaceWithSnapshot` (~106): before `conversations.clear()`, read existing parent ids into a `Map<string,string|null>`; when re-`put`-ting each summary, coalesce **existing-first** so a non-null incoming never moves an established link (true immutability, matches the live `applyJournal` rule):
```ts
parent_convo_id: existingParents.get(summary.id) ?? coerceParentId(summary.parent_convo_id) ?? null,
```

- [ ] **Step 4: Run to verify pass**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-ingestion-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/database.ts test/unit-tests/journal/subchat-ingestion-test.ts
git commit -m "feat(subchat): ingest parent_convo_id (set-once, resync-coalesced)"
```

**Acceptance:** parent link set once from `convo_meta` (incl. titleless), never cleared by a later null, preserved across resync (spec §4.1, §7.1).

### T-1.4: one-time existing-client backfill

**Files:**
- Modify: `src/journal/client.ts` — `startSession` (after DB open, ~865); `src/journal/database.ts` — add a `backfillParentLinks(snapshot)` method + a `meta` key read/write helper if not present
- Test: `test/unit-tests/journal/subchat-backfill-test.ts` (create)

**Interfaces:**
- Consumes: `JournalApi.snapshot()`, `coerceParentId`.
- Produces: idempotent, run-once reconcile keyed on `meta["subchat_backfill_v1"]`; merges `parent_convo_id` + `session_state` onto existing records (events + cursor untouched), key-set atomic with the merge; transient AND malformed-snapshot failures leave the key unset and do not wedge startup.

- [ ] **Step 1: Write the failing tests** (assertions):

```ts
// cursor present + key absent → snapshot fetched, existing child records get parent_convo_id (existing-first)
//   + session_state, events untouched, key set. Second startup: no re-fetch (api.snapshot not called again).
// transient snapshot throw → key stays unset, startSession still resolves, incremental path proceeds.
// malformed snapshot (missing .conversations) → rejected pre-write, key unset, no throw out of startSession.
// mid-array malformed element (valid summary, then a null/no-id element) → validation rejects BEFORE any
//   store.put, so NO record is mutated and the key stays unset (atomic all-or-nothing).
// existing non-null parent + snapshot reports a DIFFERENT non-null parent → existing link preserved (immutable).
```

- [ ] **Step 2: Run to verify fail**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-backfill-test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `database.ts`, add. **Validate the whole snapshot BEFORE opening the write transaction** (Codex R1-M2) so a mid-array malformed element can never leave records partially written with the key unset; existing-first coalesce; abort the tx on any error:
```ts
public async backfillParentLinks(snapshot: SnapshotResponse): Promise<void> {
    // Validate first — a malformed element must reject before any write.
    if (!snapshot || !Array.isArray(snapshot.conversations)) throw new Error("malformed snapshot");
    const summaries = snapshot.conversations;
    for (const s of summaries) {
        if (!s || typeof s.id !== "string") throw new Error("malformed snapshot element");
    }
    const tx = this.database.transaction(["conversations", "meta"], "readwrite");
    try {
        const store = tx.objectStore("conversations");
        for (const summary of summaries) {
            const existing = (await requestResult(store.get(summary.id))) as Conversation | undefined;
            if (!existing) continue;
            existing.parent_convo_id = existing.parent_convo_id ?? coerceParentId(summary.parent_convo_id) ?? null; // existing-first
            if (typeof summary.session_state === "string") existing.session_state = summary.session_state;
            store.put(existing);
        }
        tx.objectStore("meta").put(true, BACKFILL_KEY); // atomic: records + key commit together
        await transactionDone(tx);
    } catch (err) {
        try { tx.abort(); } catch { /* already aborting */ }
        throw err;
    }
}
public async markBackfillDone(): Promise<void> {
    const tx = this.database.transaction("meta", "readwrite");
    tx.objectStore("meta").put(true, BACKFILL_KEY);
    await transactionDone(tx);
}
public async backfillDone(): Promise<boolean> {
    const tx = this.database.transaction("meta");
    const done = Boolean(await requestResult(tx.objectStore("meta").get(BACKFILL_KEY)));
    await transactionDone(tx); // match the file's read-method idiom (surfaces tx-level errors)
    return done;
}
```
Add a module const near the other `meta` keys: `const BACKFILL_KEY = "subchat_backfill_v1";`.
In `client.ts` `startSession`, at the `cursor === undefined` fresh branch (right after `await this.database.replaceWithSnapshot(snapshot)`) call `await this.database.markBackfillDone();` so fresh installs never backfill. For existing clients:
```ts
if (cursor !== undefined && !(await this.database.backfillDone())) {
    try {
        await this.database.backfillParentLinks(await this.api.snapshot());
    } catch (err) {
        // Classify (V6): a malformed snapshot rejects with an Error message starting "malformed"
        // (permanent); anything else is a transient fetch/IDB failure. Persist a diagnostic for the
        // permanent case (observable, human-reviewable) rather than only console.warn.
        const permanent = err instanceof Error && err.message.startsWith("malformed");
        if (permanent) await this.database.recordBackfillError(String(err)).catch(() => undefined);
        console.warn(`matron: subchat backfill deferred (${permanent ? "permanent" : "transient"})`, err);
        // Deliberate: leave the done-key unset either way, so the backfill retries next startup. Bounded
        // to one snapshot fetch per launch; the real journal server is well-formed, so a permanent
        // malformed payload is a server bug that self-heals once fixed — giving up forever would instead
        // strand a client on a transient server hiccup. The persisted subchat_backfill_error meta key
        // (via recordBackfillError) is the V6 "flag for human review" surface without a give-up path.
    }
}
```
Add `recordBackfillError(reason: string)` to `database.ts` (writes `{ ts, reason }` to `meta` key `subchat_backfill_error` via a `readwrite` `meta` tx + `transactionDone`).

- [ ] **Step 4: Run to verify pass**

Run: `node_modules/.bin/jest test/unit-tests/journal/subchat-backfill-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/client.ts src/journal/database.ts test/unit-tests/journal/subchat-backfill-test.ts
git commit -m "feat(subchat): one-time existing-client parent-link backfill"
```

**Acceptance:** upgraded clients reconcile links once (events/cursor intact); transient + malformed failures never wedge startup and retry next launch (spec §4.8, §7.8).

---

## Phase 2 — List exclusion & full consumer audit

### T-2.1: exclude linked children from the conversation list

**Files:**
- Modify: `src/journal/components.tsx` — `ConversationList` `conversations` `useMemo` (~375)
- Test: `test/unit-tests/journal/subchat-list-test.ts` (create; render `ConversationList` with a fake client/state per existing component-test pattern)

**Interfaces:**
- Consumes: `parentPresent` (T-1.2).

- [ ] **Step 1: Write the failing test**

Assertions: given `[root, linkedChild, orphanChild]`, `ConversationList` renders rows for `root` and `orphanChild` (parent absent → fallback) but NOT `linkedChild`.

- [ ] **Step 2: Run to verify fail** — `node_modules/.bin/jest test/unit-tests/journal/subchat-list-test.ts` → FAIL (child row present).

- [ ] **Step 3: Implement** (`components.tsx:375`):

```ts
const conversations = useMemo(() => {
    const ids = new Set(state.conversations.map((c) => c.id));
    return state.conversations
        .filter((c) => !parentPresent(c, ids)) // linked child hidden; orphan falls back to top-level
        .filter((conversation) => /* existing search-query filter, unchanged */);
}, [query, state.conversations]);
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx test/unit-tests/journal/subchat-list-test.ts
git commit -m "feat(subchat): hide linked children from conversation list (orphans stay)"
```

**Acceptance:** linked children never render as top-level rows; orphans do (spec §4.3, §7.3).

### T-2.2: consumer audit — aggregations, `markAllRead`, `firstSelectableConversation`

**Files:**
- Modify: `src/journal/components.tsx` — `hasAnyFavorite` (~392), `hasActiveUnread` (~399)
- Modify: `src/journal/client.ts` — `markAllRead` (~373), `emit()` badge reduce (~1381), `firstSelectableConversation` (~144-153, BOTH preferred + fallback branches)
- Test: extend `test/unit-tests/journal/subchat-list-test.ts` + `test/unit-tests/journal/subchat-select-test.ts` (create) + `test/unit-tests/journal/subchat-badge-test.ts` (create)

**Interfaces:**
- Consumes: `parentPresent`, `isSubChat`.

- [ ] **Step 1: Write the failing tests**

Assertions: a linked child with an unread override does not surface in `hasActiveUnread`; `markAllRead` does not mark it; the Electron `setBadgeCount` value excludes a linked child's `unread_count` (root + orphan counted, linked child not); `firstSelectableConversation` returns neither a linked child stored as `preferredId` NOR a linked child via fallback, but DOES return an orphan.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement**

`hasAnyFavorite`/`hasActiveUnread` (`components.tsx:392,399`): compute `const ids = new Set(state.conversations.map(c=>c.id))` once and add `&& !parentPresent(conversation, ids)` to each `.some(...)` predicate.

`markAllRead` (`client.ts:373`): build `const ids = new Set(this.state.conversations.map(c=>c.id))`; add `if (parentPresent(conversation, ids)) continue;` at the top of the loop.

`emit()` Electron badge (`client.ts:1381`) — the `setBadgeCount` reduce sums `unread_count` over ALL conversations, so hidden children inflate the desktop badge (Codex R1-B2). Change the reduce to exclude linked children:
```ts
const ids = new Set(this.state.conversations.map((c) => c.id));
const unread = this.state.conversations.reduce(
    (total, c) => total + (parentPresent(c, ids) ? 0 : c.unread_count), 0);
```

`firstSelectableConversation` (`client.ts:144`): compute `const ids = new Set(conversations.map((c) => c.id))` at the top from its existing `conversations` param (no new param, no call-site changes at `startSession` ~905 / `replaceSnapshot` ~1045), and add `!parentPresent(c, ids)` to BOTH the `preferred` `find` predicate and the fallback `find` predicate.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx src/journal/client.ts test/unit-tests/journal/subchat-list-test.ts test/unit-tests/journal/subchat-select-test.ts test/unit-tests/journal/subchat-badge-test.ts
git status --porcelain test/unit-tests/journal/subchat-badge-test.ts  # assert the badge test is tracked, not left untracked
git commit -m "feat(subchat): exclude linked children from unread/markAll/badge/auto-select (both branches)"
```

**Acceptance:** no linked child contributes to unread/favorite aggregation, `markAllRead`, or auto-selection (preferred or fallback); orphan remains selectable (spec §4.3, §7.3).

---

## Phase 3 — Read-only egress enforcement

### T-3.1: gate the two content-transmit functions + fail-visible

**Files:**
- Modify: `src/journal/client.ts` — `sendPendingMessage` (~1298), `emitPendingAttachment` (~635); add a private `isChildConvo(convoId): boolean` helper + a `markChildBlocked(message)` helper
- Test: `test/unit-tests/journal/readonly-egress-test.ts` (create)

**Interfaces:**
- Consumes: `isSubChat`.
- Produces: no `op:"send"` transmits for a child; blocked records **retained** (never deleted); text → visible `controlError` notice; attachment → errored dismissable row via the existing persist+refresh path. (Right-sized fail-visible per spec §4.5 implementation revision — the text-pending branch, `components.tsx:1474-1490`, has no error render and this edge is unreachable, so no net-new text-error UI.)

- [ ] **Step 1: Write the failing tests**

Assertions: with a child convo in state — (a) `sendPendingMessage({convoId: child, kind: undefined/text})` fires zero `connection.send({op:"send"})`, leaves the record in the outbox, and sets `state.controlError` to the read-only message; (b) `emitPendingAttachment({convoId: child, ...})` fires zero sends and marks the record `attachState:"error"` (via the existing persist+refresh path, so it survives a `refreshSelectedConversation`).

- [ ] **Step 2: Run to verify fail** → FAIL (send fires).

- [ ] **Step 3: Implement**

Add the classifier helper:
```ts
private isChildConvo(convoId: string): boolean {
    const c = this.state.conversations.find((x) => x.id === convoId);
    return !!c && isSubChat(c);
}
```
`sendPendingMessage` (`client.ts:1298`, synchronous — text + attachment-replay) — guard at the very top, before either `connection.send`:
```ts
if (this.isChildConvo(message.convoId)) {
    // retain the outbox record; surface a visible notice (no per-row text-error UI — unreachable edge)
    this.patch({ controlError: "Couldn't send to a read-only subagent transcript." });
    return;
}
```
`emitPendingAttachment` (`client.ts:635`, async — has `owner.db`/`owner.gen`) — guard at the top, marking the attachment errored via the **existing** mechanism (mirror `client.ts:658-664`):
```ts
if (this.isChildConvo(message.convoId)) {
    message.attachState = "error";
    message.errorKind = "send_failed";
    message.errorMessage = "Can't send to a read-only subagent transcript.";
    if (!this.ownsAttachment(owner, message.localId)) return;
    if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
    if (!this.ownsAttachment(owner, message.localId)) return;
    await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
    return;
}
```
Do **not** modify the `Timeline` text-pending branch.

**`handleReady` replay purge — the reconnect path is the ONLY reachable one, so purge undeliverable child-targeted TEXT records there (Claude R2-M1/M2; DESIGN LOCKED — no further flips per the reviewer-oscillation stop rule).** In `handleReady` (`client.ts:1058`, async, `db` in scope), before the replay loop at `client.ts:1068`, partition the outbox: a child-targeted **text** record is provably undeliverable (permanent read-only target) — remove it from the outbox via `db` and, if any were removed, set `controlError` **once** for this reconnect. This prevents the retained-forever record from re-firing `controlError` on every reconnect (Claude M2) and from stranding a stuck row (M1). Child-targeted **attachment** records are left to replay → `emitPendingAttachment`'s guard marks them errored+dismissable (existing UI). Non-child records replay normally.
```ts
const kept: PendingMessage[] = [];
let purged = 0;
for (const message of outbox) {
    if (this.isChildConvo(message.convoId) && message.kind !== "image" && message.kind !== "file") {
        await db.removeFromOutbox(message.localId); purged++;      // undeliverable text → drop (after the notice below)
    } else kept.push(message);
}
if (purged > 0) this.patch({ controlError: "Couldn't send to a read-only subagent transcript." });
if (!ownsReplay()) return;
for (const message of kept) this.sendPendingMessage(message, connection);
```
(`removeFromOutbox(localId)` mirrors the existing outbox-delete used by `dismissAttachment`; if a distinctly-named method exists, reuse it.) The sync `sendPendingMessage` text guard from above stays as a pure backstop for any non-replay path (never reached in practice, but keeps the invariant total). This one-time-notice-then-purge is P3-compliant (the loss is surfaced before removal, not silent) and is the FINAL word on blocked-text handling.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/client.ts test/unit-tests/journal/readonly-egress-test.ts
git commit -m "feat(subchat): gate both transmit fns for child convos (retain + fail-visible)"
```

**Acceptance:** neither transmit sends to a child; text → retained + `controlError` notice; attachment → errored dismissable row (spec §4.5 revision, §7.6, §7.7).

### T-3.2: guard the media upload before bytes egress

**Files:**
- Modify: `src/journal/client.ts` — `sendAttachment` (~515) and `retryAttachment` (~528): early-return before any `uploadMedia`
- Test: extend `test/unit-tests/journal/readonly-egress-test.ts`

- [ ] **Step 1: Write the failing tests**

Assertions: (a) `sendAttachment(file, childConvoId)` calls `api.uploadMedia` **zero** times and creates no outbox record (nothing to preserve — it's a fresh call, blocked before staging); (b) `retryAttachment(localId)` on a child-targeted record with no `blobRef` calls `uploadMedia` zero times and marks the loaded record errored (retained).

- [ ] **Step 2: Run to verify fail** → FAIL (uploadMedia called).

- [ ] **Step 3: Implement**

`sendAttachment(file, convoId, caption?)` (`client.ts:515`) — `convoId` is a **parameter**, available at entry. Guard immediately after the `if (!api || !db) return;` (`client.ts:519`), before `buildPendingAttachment` (`client.ts:521`): `if (this.isChildConvo(convoId)) return;` (a fresh send with nothing yet built/staged — early-return, nothing to retain).
`retryAttachment(localId)` (`client.ts:528`) — after the outbox record is loaded (the record has `.convoId`), before the `uploadPendingAttachment`/`emitPendingAttachment` branch: `if (this.isChildConvo(record.convoId)) { /* mark errored via existing path or set controlError, retain */ return; }`. The `emitPendingAttachment` guard (T-3.1) is the backstop for the with-`blobRef` branch.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/client.ts test/unit-tests/journal/readonly-egress-test.ts
git commit -m "feat(subchat): block media upload for child convos before bytes egress (P15)"
```

**Acceptance:** no file bytes upload for a child-targeted send/retry (spec §4.5 M3, §7.6c).

### T-3.3: gate prompt replies + staging, keyed on the correct convo

**Files:**
- Modify: `src/journal/client.ts` — `sendPromptReply` (~824), `stageFiles` (~682), `confirmStagedFile` (~708)
- Test: extend `test/unit-tests/journal/readonly-egress-test.ts`

- [ ] **Step 1: Write the failing tests**

Assertions: `sendPromptReply` no-ops when the selected convo is a child; `stageFiles`/`confirmStagedFile` no-op when `staged.convoId` is a child; but `confirmStagedFile` is NOT blocked when `staged.convoId` is a non-child even though the current selection changed to a child.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement**

`sendPromptReply` (`client.ts:824`): `if (this.isChildConvo(this.state.selectedConversationId ?? "")) return false;` at the top.
`stageFiles` (`client.ts:682`) has two sub-paths: (i) **append** to an existing staged queue (`staged` truthy) → guard `if (this.isChildConvo(staged.convoId)) return;` inside that branch; (ii) **new** stage where `const convoId = this.state.selectedConversationId` (`client.ts:696`) → immediately after resolving `convoId` (and its `if (!convoId) return`), add `if (this.isChildConvo(convoId)) return;`.
`confirmStagedFile` (`client.ts:708`): guard on `staged.convoId` **before** the `this.patch({ stagedUploads: { ...staged, confirming: true } })` at `client.ts:713` — insert right after the `if (!staged || staged.confirming || staged.error) return;` / head checks, so a child-targeted confirm returns without ever stranding the dialog in `confirming:true`.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/client.ts test/unit-tests/journal/readonly-egress-test.ts
git commit -m "feat(subchat): gate prompt-reply + staging (staged.convoId, not selection)"
```

**Acceptance:** prompt replies + staging inert for children; staged non-child send not falsely blocked by a mid-dialog selection change (spec §4.5 M1b, §7.6).

### T-3.4: `op:"send"` grep ratchet + selection-race guard

**Files:**
- Modify: `src/journal/client.ts` — `selectConversation` (~320, selected-id guard before `viewing`); confirm/extend `refreshSelectedConversation` (~1216) events staleness guard
- Test: `test/unit-tests/journal/egress-ratchet-test.ts` (create — reads `client.ts` source) + extend `test/unit-tests/journal/subchat-select-test.ts`

- [ ] **Step 1: Write the failing tests**

Ratchet: read `src/journal/client.ts` text, `match(/op:\s*"send"/g)` → assert exactly 3 matches and each is within a function body that contains `isChildConvo(` before it (simple bracket/preceding-lines heuristic). Selection: `selectConversation(A)` then `(B)` with B's refresh resolving first → no trailing `viewing:A` sent, and B's events not overwritten by A's late refresh.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement**

`selectConversation` (~320): after `await this.refreshSelectedConversation(conversationId);` add `if (this.state.selectedConversationId !== conversationId) return;` before the `viewing` send and `scheduleRead`.
`refreshSelectedConversation` (~1216): confirm its existing `selectedConversationId !== expectedId` guard covers a same-generation sibling switch; if it only checks `gen`, add the selection-identity check before the `patch({events, pendingMessages})`.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/client.ts test/unit-tests/journal/egress-ratchet-test.ts test/unit-tests/journal/subchat-select-test.ts
git commit -m "feat(subchat): op:send grep ratchet + rapid-switch selection guard"
```

**Acceptance:** exactly 3 guarded `op:"send"` sites; rapid sibling switch leaves no stale `viewing`/events (spec §4.5 ratchet + M1, §7.6d, §7.9).

---

## Phase 4 — Navigation surfaces & read-only child viewer

### T-4.1: `RunningSubagentStrip` (running children)

**Files:**
- Modify: `src/journal/components.tsx` — add `RunningSubagentStrip` inline; mount above `<Timeline>` in `SignedInApp` (~1845)
- Test: `test/unit-tests/journal/subchat-strip-test.ts` (create)

**Interfaces:**
- Consumes: `runningChildrenOf`, `conversationTitle`, `client.selectConversation`.

- [ ] **Step 1: Write the failing test**

Assertions: with 2 running + 1 finished child of the selected convo, the strip renders 2 pills; clicking a pill calls `selectConversation(childId)`; renders nothing when zero running children; nested (viewing a child shows its running grandchildren).

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement**

```tsx
function RunningSubagentStrip({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement | null {
    const running = runningChildrenOf(state.conversations, state.selectedConversationId);
    if (running.length === 0) return null;
    return (
        <div className="mj_SubagentStrip" role="list">
            {running.map((child) => (
                <button key={child.id} className="mj_SubagentPill" role="listitem"
                    aria-label={`Open subagent ${conversationTitle(child)}`}
                    onClick={() => void client.selectConversation(child.id)}>
                    <span className="mj_Spinner" aria-hidden="true" />
                    {conversationTitle(child)}
                </button>
            ))}
        </div>
    );
}
```
Mount between `<ChatHeader …>`/`<SubChatHeader>` and `<Timeline …>` in `SignedInApp` (~1845).

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx test/unit-tests/journal/subchat-strip-test.ts
git commit -m "feat(subchat): running-subagent pill strip above the timeline"
```

**Acceptance:** one pill per running child, click opens it, nested-safe (spec §4.4, §7.4).

### T-4.2: parent-header subagent switcher (all children, reachability)

**Files:**
- Modify: `src/journal/components.tsx` — `ChatHeader` (~875): add an "N subagents ▾" `mj_HeaderMenu` when the selected convo has ≥1 child
- Test: extend `test/unit-tests/journal/subchat-strip-test.ts`

**Interfaces:**
- Consumes: `childrenOf`.

- [ ] **Step 1: Write the failing test**

Assertions: with 1 finished child (no running), the strip shows nothing but the `ChatHeader` shows a "1 subagent" switcher listing the finished child; selecting it calls `selectConversation`; hidden when 0 children.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement** — add to `ChatHeader` a menu button gated on `childrenOf(state.conversations, client.selectedConversation()?.id).length > 0`, listing all children oldest-first with a running/finished glyph, each `onClick={() => client.selectConversation(child.id)}`.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx test/unit-tests/journal/subchat-strip-test.ts
git commit -m "feat(subchat): parent-header switcher lists all children (finished reachable)"
```

**Acceptance:** every child reachable incl. finished-before-opened (spec §4.4, §7.4).

### T-4.3: read-only child viewer branch + `SubChatHeader`

**Files:**
- Modify: `src/journal/components.tsx` — `SignedInApp` (~1788) child-mode branch per the §4.5 composition sketch; add `SubChatHeader` + `ReadOnlyHint` inline
- Test: `test/unit-tests/journal/subchat-viewer-test.ts` (create)

**Interfaces:**
- Consumes: `isSubChat`, `client.selectedConversation`, `client.selectConversation`, `client.clearSelection`.

- [ ] **Step 1: Write the failing tests**

Assertions: when the selected convo is a child, `SubChatHeader` renders (title, running/finished label, model/context from `sessionStatus`), `Composer` is absent (`ReadOnlyHint` present), `onDrop` is not wired; back button calls `selectConversation(parent)` when parent present, else `clearSelection()`.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement** the §4.5 sketch:
```tsx
const selected = client.selectedConversation();
const childMode = selected != null && isSubChat(selected);
// <div className="mx_RoomView" onDrop={childMode ? undefined : onDrop} …>
<div className="mx_RoomView_body mx_MainSplit_timeline" data-layout="bubble">
    {childMode ? <SubChatHeader client={client} state={state} /> : <ChatHeader client={client} state={state} />}
    <RunningSubagentStrip client={client} state={state} />
    <Timeline client={client} state={state} isReadOnly={childMode} />
    {childMode ? <ReadOnlyHint /> : <Composer client={client} state={state} />}
</div>
```
`SubChatHeader`: reuse `mj_ChatHeader` chrome + `sessionStatus`; back button → `const p = selected.parent_convo_id; p && p !== selected.id && state.conversations.some(c=>c.id===p) ? client.selectConversation(p) : client.clearSelection()` (the `p !== selected.id` backstop guarantees Back never re-selects a self-parented child even if ingestion missed it, Codex R2-B2); running/finished label from `selected.session_state`.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx test/unit-tests/journal/subchat-viewer-test.ts
git commit -m "feat(subchat): read-only child viewer + SubChatHeader (back-to-parent)"
```

**Acceptance:** child opens read-only (no composer, no drop), mini-header with back-to-parent + fallback (spec §4.5, §7.5).

### T-4.4: thread `isReadOnly` → PromptCard + PendingAttachment (UI suppression)

**Files:**
- Modify: `src/journal/components.tsx` — `Timeline` (~1346), `EventRow` (~1178), `EventContent` (~1104), `PromptCard` (~924), `PendingAttachment` (~1267): accept + honor `isReadOnly`
- Test: extend `test/unit-tests/journal/subchat-viewer-test.ts`

- [ ] **Step 1: Write the failing tests**

Assertions: under `isReadOnly`, `PromptCard` renders no answer buttons / no free-text form; the `PendingAttachment` Retry action is hidden (Dismiss still present).

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement** — add `isReadOnly?: boolean` prop through `Timeline → EventRow → EventContent → PromptCard` and to `PendingAttachment`; when set, `PromptCard` returns the question text without the options/`PromptText` form, and `PendingAttachment` omits the "retry" action.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx test/unit-tests/journal/subchat-viewer-test.ts
git commit -m "feat(subchat): isReadOnly suppresses prompt buttons + attachment retry"
```

**Acceptance:** interactive controls suppressed in a child viewer (spec §4.5 layer 1, §7.6g).

### T-4.5: in-child sibling switcher

**Files:**
- Modify: `src/journal/components.tsx` — `SubChatHeader`: sibling dropdown when siblings > 1
- Test: extend `test/unit-tests/journal/subchat-viewer-test.ts`

**Interfaces:**
- Consumes: `childrenOf`.

- [ ] **Step 1: Write the failing tests**

Assertions: switcher hidden when the child has ≤1 sibling; when >1, lists all siblings with current(checkmark)/running(filled)/finished(hollow) glyphs, current disabled; selecting a sibling calls `selectConversation`.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement** — in `SubChatHeader`, `const siblings = childrenOf(state.conversations, selected.parent_convo_id)`; render an `mj_HeaderMenu` only when `siblings.length > 1`, glyph per `session_state` + current-id, `onClick` → `client.selectConversation(sibling.id)`.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx test/unit-tests/journal/subchat-viewer-test.ts
git commit -m "feat(subchat): in-child sibling switcher (siblings > 1)"
```

**Acceptance:** in-child switcher gated on siblings>1 with correct glyphs (spec §4.5, §7.5).

---

## Phase 5 — Tail-follow & jump-to-bottom

### T-5.1: `isNearBottom` pure helper (threshold 80)

**Files:**
- Modify: `src/journal/types.ts` — add `isNearBottom`
- Test: `test/unit-tests/journal/tail-follow-test.ts` (create)

**Interfaces:**
- Produces: `isNearBottom(scrollTop, scrollHeight, clientHeight, thresholdPx = 80): boolean`.

- [ ] **Step 1: Write the failing test**

Assertions: distance 79 → true, 80 → true, 81 → false (with `clientHeight`/`scrollHeight` chosen to hit those boundaries).

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement**
```ts
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number, thresholdPx = 80): boolean {
    return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}
```

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/types.ts test/unit-tests/journal/tail-follow-test.ts
git commit -m "feat(subchat): isNearBottom pure helper (80px threshold)"
```

**Acceptance:** threshold boundary correct at 80px (spec §4.6, §7.10).

### T-5.2: `sendTick` signal at exact call sites + `blankState` init

**Files:**
- Modify: `src/journal/types.ts` — `ClientState.sendTick: number`
- Modify: `src/journal/client.ts` — `blankState` (~80) init `sendTick: 0`; bump via `patch({ sendTick: this.state.sendTick + 1 })` in `sendMessage` (~432), `confirmStagedFile` (~708), `retryAttachment` (~528)
- Test: extend `test/unit-tests/journal/tail-follow-test.ts`

- [ ] **Step 1: Write the failing tests**

Assertions: a **successful** `sendMessage` (non-empty body, non-child convo), `confirmStagedFile` (valid staged head), and `retryAttachment` (record found) each increment `state.sendTick`. **Negative (Codex R2-M3):** each method's early-return / rejection paths leave `sendTick` UNCHANGED — empty-body `sendMessage`, child-blocked send, missing/invalid staged head in `confirmStagedFile`, and `retryAttachment` with no matching outbox record. An incoming journal event through `refreshSelectedConversation` also does NOT change `sendTick`.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement** — add the field, init `sendTick: 0` in `blankState`. Place `this.patch({ sendTick: this.state.sendTick + 1 })` **only past the success boundary** in each method, NOT at the top: in `sendMessage` after the `if (!body || !conversationId || !this.database) return false;` guard AND after the child-block guard (so a blocked/empty send never bumps); in `confirmStagedFile` after the head/validity checks pass (durable stage confirmed); in `retryAttachment` after the outbox record is found and not child-blocked. **Never** bump inside `refreshSelectedConversation`. This makes `sendTick` a *successful-own-send* signal, not an invocation counter — so no-op or blocked calls don't yank the reader to the tail.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/types.ts src/journal/client.ts test/unit-tests/journal/tail-follow-test.ts
git commit -m "feat(subchat): sendTick own-send signal at exact call sites"
```

**Acceptance:** own-send bumps `sendTick`; incoming events do not (spec §4.6 M3/M2, §7.10 negative).

### T-5.3: follow-state, rAF scroll handler, reset effect, jump-to-bottom button

**Files:**
- Modify: `src/journal/components.tsx` — `Timeline` (~1346): `isFollowingTail` state, rAF-throttled scroll handler (handle in a ref; cancelled on convo-switch cleanup AND on `sendTick` bump; stale-frame guard), gate the existing `useLayoutEffect` (~1387) jump on `isFollowingTail`, add a `selectedConversationId`-keyed reset effect, `sendTick`-watch effect, `mj_JumpToBottom` button
- Test: `test/unit-tests/journal/tail-follow-timeline-test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Assertions: button hidden when following, shown when not; click re-enables follow + scrolls to bottom; `sendTick` bump forces follow (and cancels a pending stale frame); convo switch forces follow; an incoming event while scrolled up does NOT force-follow; a stale frame queued before a switch does not flip follow off after it.

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement** per §4.6: `const [isFollowingTail, setFollow] = useState(true)`; a scroll handler `onScroll` that `cancelAnimationFrame(pending.current)` then `pending.current = requestAnimationFrame(() => setFollow(isNearBottom(node.scrollTop, node.scrollHeight, node.clientHeight)))`; cleanup cancels `pending.current`; gate the `useLayoutEffect` bottom-jump on `isFollowingTail`; `useEffect(() => setFollow(true), [state.selectedConversationId])`; `useEffect(() => { cancelAnimationFrame(pending.current); setFollow(true); scrollToBottom(); }, [state.sendTick])`; render `{!isFollowingTail && <button className="mj_JumpToBottom" onClick={() => { setFollow(true); node.scrollTop = node.scrollHeight; }}>↓</button>}`.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/components.tsx test/unit-tests/journal/tail-follow-timeline-test.ts
git commit -m "feat(subchat): tail-follow state + jump-to-bottom + rAF cancellation"
```

**Acceptance:** tails by default, stops on scroll-up, jump button when not following, re-follows on jump/own-send/switch, no yank on incoming while scrolled up, no stale-frame flip (spec §4.6, §7.10).

---

## Phase 6 — Styling

### T-6.1: `mj_*` styles for strip, pills, spinner, sub-chat header, switcher, jump-to-bottom

**Files:**
- Modify: `src/journal/journal.pcss`
- Test: none (visual); covered by T-7.1 manual matrix

- [ ] **Step 1: Add classes** — `mj_SubagentStrip` (horizontal scroll row), `mj_SubagentPill` (capsule), `mj_Spinner` (CSS-only keyframe spinner), `mj_SubChatState` (running/finished label), `mj_ReadOnlyHint` (muted composer-slot text), switcher styles (reuse `mj_HeaderMenu`), `mj_JumpToBottom` (bottom-trailing overlay button). No JS animation.
- [ ] **Step 2: Build check** — `pnpm lint` (prettier over pcss) passes.
- [ ] **Step 3: Commit**

```bash
git add src/journal/journal.pcss
git commit -m "style(subchat): strip, pills, spinner, sub-chat header, switcher, jump-to-bottom"
```

**Acceptance:** new UI styled with `mj_*` classes, CSS-only spinner (spec §4.7).

---

## Phase 7 — Verify, deploy, follow-ups

### T-7.1: full verification + manual acceptance matrix

**Files:** none (verification)

- [ ] **Step 1:** `pnpm lint && pnpm test` → all green (tsc clean, prettier clean, jest suite passes).
- [ ] **Step 2: Build** — `corepack pnpm build` succeeds.
- [ ] **Step 3: Manual matrix against the live journal server** (per §9 acceptance): spawn a session, run a subagent; confirm — child hidden from list; running pill appears + parent switcher lists finished children; tapping opens a read-only child (no composer); **drag a file onto a child pane → rejected, no upload**; prompt/permission cards non-interactive in a child; switcher across parallel subagents; back returns to parent; rapid sibling switch has no stale view; jump-to-bottom appears on scroll-up and re-follows; own message re-follows; incoming agent output while scrolled up does NOT yank down; existing-client (with history) shows previously-flat children now grouped (backfill).
- [ ] **Step 4: Deploy — OPERATOR-EXECUTED manual step (not autonomous; the operator running it IS the R102 confirmation).** The deploy target is the nginx-served static dir `/opt/matron/web-journal/webapp` (per the CLAUDE.local.md web deploy runbook), NOT the repo root — the plan's build/verify tasks run in the worktree, but deployment copies into the live dir. Preflight-asserted, R102-safe (no unconfirmed destructive delete):

```bash
DEPLOY_DIR=/opt/matron/web-journal          # nginx vhost root; served subdir is $DEPLOY_DIR/webapp
[ -d "$DEPLOY_DIR/webapp" ] || { echo "ABORT: $DEPLOY_DIR/webapp missing"; exit 1; }   # resolved-path preflight
cd "$DEPLOY_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp -a webapp "webapp.bak.$TS"               # explicit resolved timestamp; backup BEFORE any mutation
# build the new bundle into place (from the built worktree artifacts per the runbook), then:
# verify https://vmi3096107.taild3d6c4.ts.net:8443 loads + sub-chat features work
# --- rollback (ONLY if verification fails) — reversible rename-swap, validated backup, never rm live first:
[ -d "webapp.bak.$TS" ] || { echo "ABORT: backup webapp.bak.$TS missing"; exit 1; }
mv webapp "webapp.failed.$TS"               # set the bad build ASIDE (retained), not deleted
mv "webapp.bak.$TS" webapp                  # restore the known-good backup
# webapp.failed.$TS kept for post-mortem; prune manually only after confirming the restore is healthy.
```

R102-compliant: this is an operator-run step (the human executing it is the confirmation), the target path is resolved + preflight-asserted, and the only removal of the live tree is a reversible `mv` gated on a validated backup — no `rm -rf` against production. Prune old `webapp.bak.*` / `webapp.failed.*` manually once confident.

**Acceptance:** every §9 criterion verified live; deploy reversible; rollback R102-compliant (validated backup, atomic rename-swap, no unconfirmed destructive delete).

### T-7.2: file follow-up loops

**Files:** son-of-anton loop store (via `/close` or `add_loop`)

- [ ] **Step 1:** File three follow-up loops (each with `owner` + a valid `next_action.type` from the locked enum `{analysis, brainstorm, implementation, cleanup, verification, operator}` — R203):
  - **Server-side authoritative child-write rejection** — `owner: easelyte`, `next_action.type: implementation`. `easelyte/matron-journal` `ws.js` `send` handler rejects `op:"send"` where the target convo has `parent_convo_id` set (~2 lines) + Matronhq upstream proposal (spec §5, Codex R3/R4-B1). Priority: this closes the P1 authoritative gap the client-side layers only mitigate.
  - **Desktop split-view (rejected alt B)** — `owner: easelyte`, `next_action.type: brainstorm`. Re-evaluate only if parallel-subagent monitoring proves valuable (spec §5).
  - **Inline tappable subtask markers (rejected alt C)** — `owner: easelyte`, `next_action.type: analysis`. Blocked on the bridge wire-gap (parent `🔀 Subtask` event carries no child id); scope a bridge change + upstream proposal (spec §5).

File via `add_loop` (canonical store, from the son-of-anton workspace) or defer to `/close`. Each references loop #453 as the parent.

**Acceptance:** deferred scope captured as three valid loops (owner + next_action present), not lost.

---

## Self-review notes (author)

- **Spec coverage:** every §4.x, §7.x, §9 item maps to a task (see coverage map above). No uncovered spec content.
- **No placeholders:** every code step shows concrete code or exact assertions; test-only steps state the assertion set explicitly.
- **Type consistency:** `coerceParentId`, `isSubChat`, `childrenOf`, `runningChildrenOf`, `parentPresent`, `isNearBottom`, `isChildConvo`, `markChildBlocked`, `sendTick`, `isReadOnly`, `childMode` are used consistently across tasks with the signatures defined in T-1.1/T-1.2/T-3.1/T-5.1/T-5.2.
- **Principles pass:** P2 (single source — links derived, not stored), P8/P33 (`coerceParentId` boundary parse), P1/P29 (read-only enforced at data-layer choke points, not UI hiding; server-side authoritative deferred + documented), P3 (fail-visible blocked sends), P15 (upload guarded before bytes egress), P17 (grep ratchet, acknowledged backstop), P18 (no split — accepted exception, loop #448), P23 (explicit follow-state), V6 (backfill transient/permanent classification). No new hardcoded path literals, no prose-to-machine-stream, no duplicate logic.

---

## Appendix: Verified Claims (research pass 2026-07-18)

Tavily batch was unavailable this session; the two load-bearing external claims are textbook-certain and grounded from spec + codebase evidence rather than web search:

✓ **Claim:** An IndexedDB transaction spanning multiple object stores commits atomically (all writes persist or none). **Verified:** Core W3C IndexedDB semantics — a transaction is the atomic unit; on `abort()` or an uncaught error all writes in the transaction roll back. T-1.3/T-1.4 rely on this to key-set the backfill flag atomically with the record merge (open the tx over both `conversations` + `meta`, commit together).
✓ **Claim:** React 18 `useSyncExternalStore(subscribe, getSnapshot)` re-renders subscribers when `getSnapshot` returns a new value after a `subscribe` notification. **Verified:** Documented React 18 behavior AND already the working store binding in this codebase (`components.tsx:1865`, `MatronJournalClient.subscribe`/`getSnapshot` → `patch()`). New `ClientState` fields (`sendTick`) propagate through the same mechanism.
? None — no uncertain external claim remains; all other plan references are internal (grep-verified `file:line`) or standard framework idioms already in use.
