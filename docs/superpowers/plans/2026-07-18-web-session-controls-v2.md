# Session controls v2 (Pin, Favorites, Mark read/unread) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pin (sort-to-top), Favorites (star + segmented All|Favorites tab), and Mark read/Mark unread to the matron-web left-panel conversation controls, all client-local per-session in localStorage, generalizing the PR #2 archive pattern via a single `IdSetStore` factory.

**Architecture:** A new pure `conversation-flags.ts` module holds `makeIdSetStore(keyPrefix, label)` (read/write/parse/storageKey, `read()` returns `{ids, ok}`) and the pure `effectiveUnread` helper. `client.ts` instantiates four stores (archive refactored onto the factory with its key string unchanged → zero migration; plus pinned/favorite/unread-override), adds three `Set<string>` fields to `ClientState`, a generic `setFlag` setter (aborts on read failure), and restructures `markConversationRead` / `markAllRead` / `selectConversation`. `components.tsx` gains context-menu items, row affordances (pin glyph / star / unread dot), and a segmented All|Favorites tab. `icons.tsx` gains four icons; `journal.pcss` gains the matching classes.

**Tech Stack:** TypeScript, React (hooks), IndexedDB (existing `JournalDatabase`), localStorage (client-local flags), Jest + jsdom (`pnpm test`), Compound design tokens (`--cpd-*`) in PostCSS.

## Global Constraints

- **Repo & branch:** work in `/opt/matron/web-journal-wt-session-controls` (matron-web worktree, branch `feat/session-controls-v2`). Drive all git/pnpm by path (`git -C <path>`, `pnpm --dir <path>` or a subshell `cd`). Origin is `easelyte/matron-web`; **never push to the `upstream` (Matronhq) remote**.
- **Commit authorship:** every commit authored `easelyte <fantin@easelyte.ai>` (`git -c user.name=easelyte -c user.email=fantin@easelyte.ai commit`). Footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Client-local only:** no journal-server or bridge changes. All state is per-session localStorage keyed `${PREFIX}:${encodeURIComponent(session.serverUrl)}:${session.userId}`.
- **Storage key strings (exact, do not alter):** archive `matron_journal_archived_conversations_v1` (UNCHANGED — zero migration); pinned `matron_journal_pinned_conversations_v1`; favorite `matron_journal_favorite_conversations_v1`; unread-override `matron_journal_unread_conversations_v1`.
- **Store labels (exact — pin legacy warning strings):** archive store label `"archived-conversations"` (so read-failure warning `matron: archived-conversations read failed (storage unavailable)` and malformed warning `matron: malformed archived-conversations value, ignoring` reproduce the legacy text byte-for-byte, keeping `archive-test.ts:149`/`:157` green); pinned `"pinned-conversations"`, favorite `"favorite-conversations"`, unread-override `"unread-conversations"`.
- **`controlError` rename:** the `ClientState.archiveError` field is renamed to `controlError` (one unified error slot). Every reference migrates: `types.ts:186`, `client.ts` (`:73`, `:340`, `:919`, `:930`, `:934`), `components.tsx:558`, and `archive-test.ts` assertions (`:216`, `:220`, `:238`, `:262`). `pnpm lint:types` fails loud on any miss.
- **Lint/format:** `pnpm lint` = `pnpm lint:types && prettier --check ...`. Run `pnpm lint:fix` before committing to satisfy prettier.
- **No em-dashes rule does not apply** (this is code/docs, not operator-voice content).
- **Verify commands run from the worktree:** `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm <cmd>` (repo uses pnpm via corepack; `package.json` scripts: `test` = `jest --runInBand`, `lint`, `lint:fix`).

---

## Phase 1 — Persistence foundation (`conversation-flags.ts` + `IdSetStore`)

Pure module extraction. No client/UI coupling; fully unit-testable in isolation.

### T-1.1: `makeIdSetStore` factory + `effectiveUnread` helper

**Files:**
- Create: `src/journal/conversation-flags.ts`
- Test: `test/unit-tests/journal/conversation-flags-test.ts`

**Interfaces:**
- Consumes: `Session` (from `./types`), `Conversation` (from `./types`).
- Produces:
  - `interface IdSetStore { storageKey(session: Session): string; read(session: Session): { ids: Set<string>; ok: boolean }; write(session: Session, ids: Set<string>): void; parse(raw: string | null): Set<string>; }`
  - `function makeIdSetStore(keyPrefix: string, label: string): IdSetStore`
  - `function effectiveUnread(conversation: Pick<Conversation, "id" | "unread_count">, unreadOverrideIds: Set<string>): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit-tests/journal/conversation-flags-test.ts
import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { makeIdSetStore, effectiveUnread } from "../../../src/journal/conversation-flags";
import type { Session } from "../../../src/journal/types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

describe("makeIdSetStore", () => {
    beforeEach(() => localStorage.clear());

    it("derives a per-session storage key from prefix + serverUrl + userId", () => {
        const store = makeIdSetStore("matron_journal_pinned_conversations_v1", "pinned-conversations");
        expect(store.storageKey(SESSION)).toBe(
            "matron_journal_pinned_conversations_v1:https%3A%2F%2Fjournal.example:2",
        );
    });

    it("round-trips a set through write/read with ok:true", () => {
        const store = makeIdSetStore("k_v1", "pinned-conversations");
        store.write(SESSION, new Set(["c1", "c2"]));
        expect(store.read(SESSION)).toEqual({ ids: new Set(["c1", "c2"]), ok: true });
    });

    it("returns an empty ok:true set when nothing is stored", () => {
        const store = makeIdSetStore("k_v1", "pinned-conversations");
        expect(store.read(SESSION)).toEqual({ ids: new Set(), ok: true });
    });

    it("ignores a malformed stored value (parse → empty) and warns with the label", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const store = makeIdSetStore("k_v1", "archived-conversations");
        localStorage.setItem(store.storageKey(SESSION), "{not json");
        expect(store.read(SESSION)).toEqual({ ids: new Set(), ok: true });
        expect(warn).toHaveBeenCalledWith("matron: malformed archived-conversations value, ignoring");
        warn.mockRestore();
    });

    it("ignores a non-array JSON value with the distinct not-an-array warning", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const store = makeIdSetStore("k_v1", "archived-conversations");
        localStorage.setItem(store.storageKey(SESSION), JSON.stringify({ a: 1 }));
        expect(store.read(SESSION)).toEqual({ ids: new Set(), ok: true });
        expect(warn).toHaveBeenCalledWith("matron: archived-conversations value not an array, ignoring");
        warn.mockRestore();
    });

    it("returns ok:false with the legacy archive warning when getItem throws", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("unavailable");
        });
        const store = makeIdSetStore("matron_journal_archived_conversations_v1", "archived-conversations");
        expect(store.read(SESSION)).toEqual({ ids: new Set(), ok: false });
        expect(warn).toHaveBeenCalledWith("matron: archived-conversations read failed (storage unavailable)");
        getItem.mockRestore();
        warn.mockRestore();
    });
});

describe("effectiveUnread", () => {
    it("is true when server unread_count > 0", () => {
        expect(effectiveUnread({ id: "c1", unread_count: 3 }, new Set())).toBe(true);
    });
    it("is true when override set contains the id even with unread_count 0", () => {
        expect(effectiveUnread({ id: "c1", unread_count: 0 }, new Set(["c1"]))).toBe(true);
    });
    it("is false when read and not overridden", () => {
        expect(effectiveUnread({ id: "c1", unread_count: 0 }, new Set())).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- conversation-flags-test`
Expected: FAIL — `Cannot find module '../../../src/journal/conversation-flags'`.

- [ ] **Step 3: Write the module**

```ts
// src/journal/conversation-flags.ts
/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { Conversation, Session } from "./types";

export interface IdSetStore {
    storageKey(session: Session): string;
    // read returns { ids, ok } so callers distinguish an empty persisted set (ok:true)
    // from a failed storage read (ok:false) — the latter must NOT overwrite prior state.
    read(session: Session): { ids: Set<string>; ok: boolean };
    write(session: Session, ids: Set<string>): void;
    parse(raw: string | null): Set<string>;
}

export function makeIdSetStore(keyPrefix: string, label: string): IdSetStore {
    const storageKey = (session: Session): string =>
        `${keyPrefix}:${encodeURIComponent(session.serverUrl)}:${session.userId}`;

    const parse = (raw: string | null): Set<string> => {
        if (raw === null) return new Set();
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            console.warn(`matron: malformed ${label} value, ignoring`);
            return new Set();
        }
        if (!Array.isArray(parsed)) {
            console.warn(`matron: ${label} value not an array, ignoring`);
            return new Set();
        }
        return new Set(parsed.filter((value): value is string => typeof value === "string"));
    };

    const read = (session: Session): { ids: Set<string>; ok: boolean } => {
        let raw: string | null;
        try {
            raw = localStorage.getItem(storageKey(session));
        } catch {
            console.warn(`matron: ${label} read failed (storage unavailable)`);
            return { ids: new Set(), ok: false };
        }
        return { ids: parse(raw), ok: true };
    };

    const write = (session: Session, ids: Set<string>): void => {
        localStorage.setItem(storageKey(session), JSON.stringify([...ids]));
    };

    return { storageKey, read, write, parse };
}

export function effectiveUnread(
    conversation: Pick<Conversation, "id" | "unread_count">,
    unreadOverrideIds: Set<string>,
): boolean {
    return conversation.unread_count > 0 || unreadOverrideIds.has(conversation.id);
}
```

> NOTE `parse()` reproduces the legacy archive code's TWO distinct warning strings: `matron: malformed ${label} value, ignoring` on a JSON-parse throw, and `matron: ${label} value not an array, ignoring` on a non-array value (matching the original `parseArchivedValue` at `client.ts:120-137`, which logs different text per branch). `archive-test.ts`'s malformed/non-array test only asserts `toHaveBeenCalledTimes(1)`, but reproducing both strings keeps production log output byte-identical per spec §3.1.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- conversation-flags-test`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/conversation-flags.ts test/unit-tests/journal/conversation-flags-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): IdSetStore factory + effectiveUnread helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-1.2: Instantiate the four stores + refactor archive wrappers onto the factory

**Files:**
- Modify: `src/journal/client.ts` (lines ~29-30 key constants, ~116-151 archive helpers)
- Test: `test/unit-tests/journal/archive-test.ts` (regression only — must pass UNCHANGED)

**Interfaces:**
- Consumes: `makeIdSetStore` (T-1.1).
- Produces: module-level store singletons `archiveStore`, `pinnedStore`, `favoriteStore`, `unreadStore` (exported for use by tests + client); `storedArchivedIds` / `storeArchivedIds` / `archivedStorageKey` become thin wrappers over `archiveStore` (same signatures: `storedArchivedIds(session): Set<string>`).

- [ ] **Step 1: Run the existing archive regression to capture the green baseline**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- archive-test`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Add the four store instances and refactor the wrappers**

In `src/journal/client.ts`, near the existing key constants (lines 29-30), add the imports and stores, and replace the archive helper bodies (lines 116-151):

```ts
// Import only what this task uses — `noUnusedLocals: true` in tsconfig fails the build
// on an unused import. `effectiveUnread` is imported later (T-2.6 in client.ts, T-3.2 in
// components.tsx) where it is first referenced.
import { makeIdSetStore, type IdSetStore } from "./conversation-flags";

// Client-local per-session flag stores. Archive key string is UNCHANGED (zero migration).
export const archiveStore: IdSetStore = makeIdSetStore(
    "matron_journal_archived_conversations_v1",
    "archived-conversations",
);
export const pinnedStore: IdSetStore = makeIdSetStore(
    "matron_journal_pinned_conversations_v1",
    "pinned-conversations",
);
export const favoriteStore: IdSetStore = makeIdSetStore(
    "matron_journal_favorite_conversations_v1",
    "favorite-conversations",
);
export const unreadStore: IdSetStore = makeIdSetStore(
    "matron_journal_unread_conversations_v1",
    "unread-conversations",
);

// Preserved wrapper surface — archive-test.ts imports these three unchanged.
export function archivedStorageKey(session: Session): string {
    return archiveStore.storageKey(session);
}
export function storedArchivedIds(session: Session): Set<string> {
    return archiveStore.read(session).ids;
}
export function storeArchivedIds(session: Session, ids: Set<string>): void {
    archiveStore.write(session, ids);
}
```

**Delete `ARCHIVED_CONVERSATIONS_KEY_PREFIX` (line 30) IN THIS TASK.** Rewriting `archivedStorageKey` to delegate to `archiveStore.storageKey` removes the const's only reference; `archiveStore` is constructed with the literal `"matron_journal_archived_conversations_v1"` directly. Under `noUnusedLocals: true`, an unused top-level const is a hard `TS6133` error (round-1 finding, both reviewers) — so it must go now, not in Phase 2.

**KEEP `parseArchivedValue` (lines 120-138) in place** — unlike the const, it still has three live callers at this checkpoint (`startSession` storageListener line 888, `setArchived` line 917, `replaceSnapshot` line 962), so it is NOT unused and does not trip `noUnusedLocals`. Phase 2 (T-2.2 step 5c) migrates those callers and removes it. Keep `SELECTED_CONVERSATION_KEY_PREFIX` (line 29) untouched.

- [ ] **Step 3: Run the archive regression (must still pass unchanged)**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- archive-test`
Expected: PASS — identical to baseline. The wrappers delegate to `archiveStore`; the key string and warning text are unchanged, so `archive-test.ts:130-166` (storage round-trip, malformed, storage-unavailable warning, key uniqueness) all hold.

- [ ] **Step 4: Type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types`
Expected: PASS. The prefix const is deleted (no `TS6133`); `parseArchivedValue` still has live callers so it is not flagged.

- [ ] **Step 5: Lint + commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/client.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "refactor(session-controls): archive persistence onto IdSetStore (key unchanged)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Phase 1 acceptance:** `conversation-flags.ts` fully unit-tested; the four stores exist; archive-test.ts passes unchanged; the archive persistence path is now the factory with byte-identical key + warning strings.

---

## Phase 2 — Client state + behavior

All logic in `client.ts` + `types.ts`. No UI yet. This is the highest-risk phase (touches shipped archive behavior + adds the failure-path contracts from spec review).

### T-2.1: `ClientState` fields + `blankState` + `archiveError`→`controlError` rename

**Files:**
- Modify: `src/journal/types.ts` (`ClientState`, ~line 185-186)
- Modify: `src/journal/client.ts` (`blankState` ~67-80; every `archiveError` ref: `:73`, `:340`, `:919`, `:930`, `:934`)
- Modify: `src/journal/components.tsx` (`:558` render guard)
- Modify: `test/unit-tests/journal/archive-test.ts` (assertions `:216/:220/:238/:262`)

**Interfaces:**
- Produces: `ClientState.pinnedIds: Set<string>`, `.favoriteIds: Set<string>`, `.unreadOverrideIds: Set<string>`, `.controlError?: string` (replaces `.archiveError`).

- [ ] **Step 1: Update the type**

In `src/journal/types.ts`, in `ClientState` replace `archiveError?: string;` with `controlError?: string;` and add the three sets next to `archivedIds: Set<string>;`:

```ts
    archivedIds: Set<string>;
    pinnedIds: Set<string>;
    favoriteIds: Set<string>;
    unreadOverrideIds: Set<string>;
    controlError?: string;
```

- [ ] **Step 2: Update `blankState` in client.ts**

```ts
function blankState(): ClientState {
    return {
        phase: "loading",
        config: {},
        conversations: [],
        archivedIds: new Set(),
        pinnedIds: new Set(),
        favoriteIds: new Set(),
        unreadOverrideIds: new Set(),
        controlError: undefined,
        events: [],
        pendingMessages: [],
        connection: "offline",
        loadingHistory: false,
        hasOlderHistory: false,
        textStreams: {},
        toolStreams: {},
        dragActive: false,
    };
}
```

- [ ] **Step 3: Rename every remaining `archiveError` reference**

Run the sweep and edit each hit:

```bash
grep -rn "archiveError" /opt/matron/web-journal-wt-session-controls/src /opt/matron/web-journal-wt-session-controls/test
```

Change: `:934` (`setArchived` success patch) `archiveError: undefined` → `controlError: undefined`; `:919` / `:930` (`setArchived` error patches) `archiveError:` → `controlError:`; `components.tsx:558` `{state.archiveError && (` → `{state.controlError && (`; and in `archive-test.ts` change the four `client.getSnapshot().archiveError` assertions (`:216/:220/:238/:262`) to `.controlError`.

**`clearSelection` (client.ts:340) is the exception — REMOVE the error field from its patch entirely, do NOT rename it (round-4 Codex-B1, P3 Fail Visible).** With `archiveError` archive-specific, clearing it on deselect was harmless. But `controlError` is a **unified** slot across pin/favorite/unread/archive, so clearing it on `clearSelection` (a navigation action) would erase a still-unresolved pin/favorite storage-failure banner the moment the user navigates → false-success. So change `this.patch({ selectedConversationId: undefined, events: [], pendingMessages: [], archiveError: undefined })` to drop the error field: `this.patch({ selectedConversationId: undefined, events: [], pendingMessages: [] })`. If `archive-test.ts` asserts `clearSelection` clears the error, update that assertion (the banner now persists across navigation until a **control action** resolves it). **Single-slot clear semantics (deliberate, spec §3.2):** `controlError` is set on any control-write failure and cleared on any control-write *success* (`setFlag`/`setArchived`/`markAllRead`) — it reflects the most-recent control action, never navigation.

- [ ] **Step 4: Type-check + archive regression**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- archive-test`
Expected: PASS. A missed `archiveError` reference is a compile error here.

- [ ] **Step 5: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/types.ts src/journal/client.ts src/journal/components.tsx test/unit-tests/journal/archive-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): ClientState flag sets + archiveError→controlError rename

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-2.2: Seed the three sets on bootstrap + snapshot; generalize the storage listener

**Files:**
- Modify: `src/journal/client.ts` (`startSession` ~871-898; `replaceSnapshot` ~958-968; storage listener ~885-896; remove dead `parseArchivedValue` + `ARCHIVED_CONVERSATIONS_KEY_PREFIX`)
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Consumes: the four stores (T-1.2).
- Produces: state seeded with all four flag sets; storage listener reacts to all four keys; `replaceSnapshot` preserves prior in-memory sets on `ok:false`.

**Test harness reuse (verified against `client-test.ts`):** the file already has `SESSION` (const, line 22), `CONVERSATIONS` (fixture, line 9), `internals(client)` (private-member accessor, line 104), `signedInState(client)` (returns a signed-in `ClientState` **with `session: SESSION` set** — line 108), and `fakeDatabase(overrides)` (line 98). Use these — do NOT invent new sign-in helpers. Add ONE small seeding helper for tests that need specific conversations:

```ts
// near the new describe("session-controls flags", ...)
function withConvos(convos: Conversation[]): { client: MatronJournalClient; state: ReturnType<typeof internals> } {
    const client = new MatronJournalClient();
    const state = internals(client);
    state.state = { ...signedInState(client), conversations: convos, selectedConversationId: undefined };
    state.database = fakeDatabase({ conversations: jest.fn().mockResolvedValue(convos) });
    return { client, state };
}
```

- [ ] **Step 1: Write the failing tests** (import `pinnedStore`, `favoriteStore`, `unreadStore`, `archiveStore` from `client.ts`; `beforeEach(() => localStorage.clear())`)

```ts
it("seeds pinned/favorite/unread sets from storage on startSession", async () => {
    pinnedStore.write(SESSION, new Set(["c1"]));
    favoriteStore.write(SESSION, new Set(["c2"]));
    unreadStore.write(SESSION, new Set(["c3"]));
    const client = new MatronJournalClient();
    const database = fakeDatabase();
    // Mirror the existing startSession-driving tests (client-test.ts:1066-1069) — BOTH mocks are
    // required: without the JournalConnection.start mock, startSession opens a real WebSocket and
    // schedules an unbounded reconnect timer that hangs `jest --runInBand` (no --forceExit).
    jest.spyOn(JournalDatabase, "open").mockResolvedValue(database as unknown as JournalDatabase);
    jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
    await internals(client).startSession(SESSION);
    const s = client.getSnapshot();
    expect(s.pinnedIds).toEqual(new Set(["c1"]));
    expect(s.favoriteIds).toEqual(new Set(["c2"]));
    expect(s.unreadOverrideIds).toEqual(new Set(["c3"]));
});

it("sets controlError when a bootstrap flag read fails (round-5 Codex-B3, P3)", async () => {
    const client = new MatronJournalClient();
    jest.spyOn(JournalDatabase, "open").mockResolvedValue(fakeDatabase() as unknown as JournalDatabase);
    jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("unavailable");
    });
    await internals(client).startSession(SESSION);
    getItem.mockRestore();
    expect(client.getSnapshot().controlError).toBe("Couldn't load saved preferences — device storage unavailable.");
});

it("preserves prior in-memory flag sets when replaceSnapshot re-read throws (ok:false)", async () => {
    const { client, state } = withConvos(CONVERSATIONS);
    state.api = { snapshot: jest.fn().mockResolvedValue({ seq: 1, conversations: CONVERSATIONS }) };
    state.state = { ...client.getSnapshot(), pinnedIds: new Set(["c1"]) };
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("unavailable");
    });
    await state.replaceSnapshot(); // private, reached via internals()
    getItem.mockRestore();
    expect(client.getSnapshot().pinnedIds).toEqual(new Set(["c1"])); // not emptied on ok:false
});

it("patches the matching set when a foreign-tab storage event fires for each of the four keys", () => {
    const { client } = withConvos(CONVERSATIONS);
    const fire = (key: string, ids: string[]): void =>
        window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(ids) }));
    fire(archiveStore.storageKey(SESSION), ["c2"]); // exercise the archive key too (uses the imported archiveStore)
    expect(client.getSnapshot().archivedIds).toEqual(new Set(["c2"]));
    fire(pinnedStore.storageKey(SESSION), ["c1"]);
    expect(client.getSnapshot().pinnedIds).toEqual(new Set(["c1"]));
    fire(favoriteStore.storageKey(SESSION), ["c1"]);
    expect(client.getSnapshot().favoriteIds).toEqual(new Set(["c1"]));
    fire(unreadStore.storageKey(SESSION), ["c1"]);
    expect(client.getSnapshot().unreadOverrideIds).toEqual(new Set(["c1"]));
});
```

> Firing the archive key also uses the imported `archiveStore`, so all four imports are referenced (no `noUnusedLocals` TS6133 — round-5 Codex-B1).

> The `replaceSnapshot` test may need the `api`/`database` stubs the existing `replaceSnapshot` tests use (the `ClientInternals.api.snapshot` shape is at `client-test.ts:55`); mirror whichever existing `replaceSnapshot` test is closest. The point asserted is only the `ok:false` preservation branch.

- [ ] **Step 2: Run to verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "session-controls flags"`
Expected: FAIL.

- [ ] **Step 3: Seed sets in `startSession`**

Replace the state-construction block (lines 871-883) to read + seed all four sets (bootstrap has no prior state to preserve, so `ok:false` seeds empty — unchanged from archive today):

Also declare a private field near the other `MatronJournalClient` private members: `private unreadHydrated = false;` (tracks whether the unread store's bootstrap read succeeded — see T-2.3's `clearUnreadOverride`, round-4 Codex-M1).

```ts
        const conversations = await this.database.conversations();
        const storedConversationId = storedSelectedConversation(session);
        const archiveRead = archiveStore.read(session);
        const pinnedRead = pinnedStore.read(session);
        const favoriteRead = favoriteStore.read(session);
        const unreadRead = unreadStore.read(session);
        this.unreadHydrated = unreadRead.ok; // false ⇒ mirror unreliable; clearUnreadOverride won't short-circuit
        // If ANY flag read failed at bootstrap, the empty sets are NOT authoritative — surface a visible
        // banner rather than silently rendering "no pins/favorites" as if the user has none (round-5 Codex-B3, P3).
        const bootstrapReadFailed = !archiveRead.ok || !pinnedRead.ok || !favoriteRead.ok || !unreadRead.ok;
        const archivedIds = archiveRead.ids;
        const pinnedIds = pinnedRead.ids;
        const favoriteIds = favoriteRead.ids;
        const unreadOverrideIds = unreadRead.ids;
        const selectedConversation = firstSelectableConversation(conversations, storedConversationId, archivedIds);
        this.state = {
            ...blankState(),
            phase: "signed-in",
            config: this.state.config,
            session,
            conversations,
            archivedIds,
            pinnedIds,
            favoriteIds,
            unreadOverrideIds,
            controlError: bootstrapReadFailed
                ? "Couldn't load saved preferences — device storage unavailable."
                : undefined,
            selectedConversationId: selectedConversation?.id,
        };
```

> **Bootstrap P3 (round-5 Codex-B3):** `IdSetStore.read` already `console.warn`s on failure, but a warning isn't user-visible. Setting `controlError` when any read fails makes the degraded state visible (the empty pin/favorite lists are a read failure, not "you have none"). Rare in practice — a fully-unavailable `localStorage` also fails `storedSession`, signing the user out before this point — but the mixed/transient case is now surfaced. `client-test.ts` asserts: `startSession` with `getItem` throwing sets `controlError` on the signed-in snapshot.

- [ ] **Step 4: Generalize the storage listener (lines 885-896)**

> **Deliberate exception (round-1 Codex-major, accepted):** the listener keeps the archive code's existing `event.newValue === null` early-return, so a foreign-tab `removeItem`/`clear` (which produces `newValue: null`) does NOT clear the in-memory sets until reload. This matches spec §3.6 ("a cleared key is rare — sign-out removes the session but the listener is torn down on logout anyway") and preserves archive's shipped behavior byte-for-byte. The app itself always writes `[]` (never removes keys) on unset, so the mirror stays consistent for every in-app path; only an external `localStorage.clear()` from another tab hits this window. Not treating null-as-empty is intentional, not an oversight — do not "fix" it.

```ts
        if (this.storageListener) window.removeEventListener("storage", this.storageListener);
        this.storageListener = (event: StorageEvent): void => {
            const currentSession = this.state.session;
            if (!currentSession || event.newValue === null) return; // deliberate: see note above (spec §3.6)
            if (event.key === archiveStore.storageKey(currentSession)) {
                const archivedIds = archiveStore.parse(event.newValue);
                this.patch({ archivedIds });
                // Mirror the local archive path: if another tab archived the viewed convo, deselect.
                if (this.state.selectedConversationId && archivedIds.has(this.state.selectedConversationId)) {
                    this.clearSelection();
                }
            } else if (event.key === pinnedStore.storageKey(currentSession)) {
                this.patch({ pinnedIds: pinnedStore.parse(event.newValue) });
            } else if (event.key === favoriteStore.storageKey(currentSession)) {
                this.patch({ favoriteIds: favoriteStore.parse(event.newValue) });
            } else if (event.key === unreadStore.storageKey(currentSession)) {
                this.unreadHydrated = true; // a fresh authoritative value arrived from another tab
                this.patch({ unreadOverrideIds: unreadStore.parse(event.newValue) });
            }
        };
        window.addEventListener("storage", this.storageListener);
```

- [ ] **Step 5: Preserve-on-failure in `replaceSnapshot` (lines ~958-968)**

Replace the archive-only re-read block with a four-store re-read that honors `ok`:

```ts
        let { archivedIds, pinnedIds, favoriteIds, unreadOverrideIds } = this.state;
        const session = this.state.session;
        if (session) {
            const a = archiveStore.read(session);
            if (a.ok) archivedIds = a.ids;
            const p = pinnedStore.read(session);
            if (p.ok) pinnedIds = p.ids;
            const f = favoriteStore.read(session);
            if (f.ok) favoriteIds = f.ids;
            const u = unreadStore.read(session);
            if (u.ok) {
                unreadOverrideIds = u.ids;
                this.unreadHydrated = true; // recovered a fresh authoritative read
            }
        }
        const selectedConversation = firstSelectableConversation(conversations, previousSelection, archivedIds);
        this.patch({ conversations, archivedIds, pinnedIds, favoriteIds, unreadOverrideIds, selectedConversationId: selectedConversation?.id });
```

- [ ] **Step 5b: Refactor `setArchived`'s body onto `archiveStore` (it is the last `parseArchivedValue` caller).**

`setArchived` (lines 911-936) still reads via `parseArchivedValue(localStorage.getItem(archivedStorageKey(session)))`. It must migrate to `archiveStore.read` (honoring `ok`) before `parseArchivedValue` is deleted — otherwise removal breaks it:

```ts
    private setArchived(conversationId: string, archived: boolean): void {
        const session = this.state.session;
        if (!session) return;
        const current = archiveStore.read(session);
        if (!current.ok) {
            this.patch({ controlError: "Couldn't read saved archive — device storage unavailable." });
            return;
        }
        const next = new Set(current.ids);
        if (archived) next.add(conversationId);
        else next.delete(conversationId);
        try {
            archiveStore.write(session, next);
        } catch {
            this.patch({ controlError: "Couldn't save — device storage is full or unavailable." });
            return;
        }
        this.patch({ archivedIds: next, controlError: undefined });
        if (archived && conversationId === this.state.selectedConversationId) this.clearSelection();
    }
```

This preserves archive's existing behavior (including the `clearSelection` side effect) while removing the `parseArchivedValue` dependency. The `archive-test.ts` storage-failure test (`:309-321`, mocks `getItem` to throw) now exercises the `ok:false` branch — still sets an error (now `controlError`) and returns without writing.

- [ ] **Step 5c: Remove dead `parseArchivedValue`** (old lines 120-138) — grep first to confirm zero remaining callers (the storageListener now uses `archiveStore.parse`; `setArchived` and `replaceSnapshot` now use `archiveStore.read`). (`ARCHIVED_CONVERSATIONS_KEY_PREFIX` was already removed in T-1.2.)

- [ ] **Step 6: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- client-test archive-test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): seed flag sets on bootstrap/snapshot + 4-key storage listener

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-2.3: Generic `setFlag` setter (abort-on-read-failure) + pin/favorite/unread public methods + `clearUnreadOverride`

**Files:**
- Modify: `src/journal/client.ts` (add near `setArchived` ~911; add public methods near `archiveConversation` ~343)
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Produces:
  - `private setFlag(store: IdSetStore, stateKey: "pinnedIds" | "favoriteIds" | "unreadOverrideIds", id: string, on: boolean): boolean` — returns `true` on success, `false` on any storage failure (and sets `controlError`).
  - `private clearUnreadOverride(id: string): boolean` — best-effort remove from `unreadOverrideIds`; no-op (returns `true`) when absent; returns `false` on write failure (sets `controlError`).
  - `public pinConversation(id)`, `unpinConversation(id)`, `favoriteConversation(id)`, `unfavoriteConversation(id)`, `markConversationUnread(id)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("pins/unpins, persisting to the pinned store and patching pinnedIds", () => {
    const { client } = withConvos(CONVERSATIONS);
    client.pinConversation("c1");
    expect(client.getSnapshot().pinnedIds.has("c1")).toBe(true);
    expect(pinnedStore.read(SESSION).ids.has("c1")).toBe(true);
    client.unpinConversation("c1");
    expect(client.getSnapshot().pinnedIds.has("c1")).toBe(false);
    expect(pinnedStore.read(SESSION).ids.has("c1")).toBe(false);
});
it("favorites/unfavorites symmetrically", () => {
    const { client } = withConvos(CONVERSATIONS);
    client.favoriteConversation("c1");
    expect(client.getSnapshot().favoriteIds.has("c1")).toBe(true);
    expect(favoriteStore.read(SESSION).ids.has("c1")).toBe(true);
    client.unfavoriteConversation("c1");
    expect(client.getSnapshot().favoriteIds.has("c1")).toBe(false);
});
it("markConversationUnread adds to unreadOverrideIds and persists", () => {
    const { client } = withConvos(CONVERSATIONS);
    client.markConversationUnread("c1");
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(true);
    expect(unreadStore.read(SESSION).ids.has("c1")).toBe(true);
});
it("setFlag aborts on read failure without clobbering the stored set", () => {
    const { client } = withConvos(CONVERSATIONS);
    pinnedStore.write(SESSION, new Set(["a", "b"]));
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("unavailable");
    });
    client.pinConversation("c1");
    getItem.mockRestore();
    expect(client.getSnapshot().controlError).toBeDefined();
    expect(pinnedStore.read(SESSION).ids).toEqual(new Set(["a", "b"])); // not clobbered
});

it("clears a persisted override even when the in-memory mirror is stale-empty (round-4 Codex-M1, P48)", () => {
    // withConvos does not run startSession → unreadHydrated stays false, so clearUnreadOverride must
    // consult the authoritative store rather than trusting the empty mirror.
    const { client } = withConvos([{ ...CONVERSATIONS[0], id: "c1", unread_count: 0 }]);
    unreadStore.write(SESSION, new Set(["c1"])); // store has the override; mirror does not
    client.markConversationRead("c1"); // → clearUnreadOverride → setFlag (no short-circuit)
    expect(unreadStore.read(SESSION).ids.has("c1")).toBe(false); // authoritative store cleared
});
```

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "pins/unpins"`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement `setFlag`, `clearUnreadOverride`, and the public methods**

```ts
    private setFlag(
        store: IdSetStore,
        stateKey: "pinnedIds" | "favoriteIds" | "unreadOverrideIds",
        id: string,
        on: boolean,
    ): boolean {
        const session = this.state.session;
        if (!session) return false;

        const current = store.read(session);
        if (!current.ok) {
            this.patch({ controlError: "Couldn't read saved preference — device storage unavailable." });
            return false; // abort before mutating: never write a stale empty set
        }
        const next = new Set(current.ids);
        if (on) next.add(id);
        else next.delete(id);
        try {
            store.write(session, next);
        } catch {
            this.patch({ controlError: "Couldn't save — device storage is full or unavailable." });
            return false;
        }
        this.patch({ [stateKey]: next, controlError: undefined } as Partial<ClientState>);
        return true;
    }

    private clearUnreadOverride(id: string): boolean {
        // The in-memory no-op shortcut is only safe when the unread store hydrated successfully at
        // bootstrap — otherwise the mirror may be a stale-empty set masking a persisted override
        // (round-4 Codex-M1, P48 Authoritative Store Beats Local Mirror). When hydration failed,
        // always go through setFlag, which re-reads the authoritative store before deleting.
        if (this.unreadHydrated && !this.state.unreadOverrideIds.has(id)) return true; // fast no-op, no write
        return this.setFlag(unreadStore, "unreadOverrideIds", id, false);
    }

    public pinConversation(id: string): void {
        this.setFlag(pinnedStore, "pinnedIds", id, true);
    }
    public unpinConversation(id: string): void {
        this.setFlag(pinnedStore, "pinnedIds", id, false);
    }
    public favoriteConversation(id: string): void {
        this.setFlag(favoriteStore, "favoriteIds", id, true);
    }
    public unfavoriteConversation(id: string): void {
        this.setFlag(favoriteStore, "favoriteIds", id, false);
    }
    public markConversationUnread(id: string): void {
        this.setFlag(unreadStore, "unreadOverrideIds", id, true);
    }
```

> `unfavoriteConversation` calls ONLY `setFlag` — no `clearSelection` side effect (contrast `setArchived`, which conditionally clears). This is the spec's §3.5 M1 decision.

- [ ] **Step 4: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- client-test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): setFlag + pin/favorite/mark-unread setters (abort-on-read-fail)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-2.4: `selectConversation` clearUnread option + wire the restore paths

**Files:**
- Modify: `src/journal/client.ts` (`selectConversation` ~314-333; `startSession` :898; `replaceSnapshot` :969)
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Produces: `public async selectConversation(conversationId: string, opts?: { clearUnread?: boolean }): Promise<void>` — `clearUnread` defaults `true`; clears the override only when true.

- [ ] **Step 1: Write the failing tests** (executable — `withConvos` from T-2.2; `selectConversation` needs `database`, which `withConvos` sets. `selectConversation` awaits `refreshSelectedConversation`; stub the `database` methods it calls the way the existing selection tests do, or assert only the override set which is patched synchronously before the awaits).

```ts
it("user-initiated select clears the unread override (clearUnread defaults true)", async () => {
    const { client } = withConvos(CONVERSATIONS);
    client.markConversationUnread("c1");
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(true);
    await client.selectConversation("c1"); // no opts → clearUnread defaults true
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(false);
});

it("explicit clearUnread:false keeps the override (the programmatic restore contract)", async () => {
    const { client } = withConvos(CONVERSATIONS);
    client.markConversationUnread("c1");
    await client.selectConversation("c1", { clearUnread: false });
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(true); // marker survives restore
});

it("startSession restore does not clear a persisted override (drives the real bootstrap path)", async () => {
    unreadStore.write(SESSION, new Set(["c1"])); // c1 carries an override; firstSelectableConversation picks c1
    const client = new MatronJournalClient();
    jest.spyOn(JournalDatabase, "open").mockResolvedValue(fakeDatabase() as unknown as JournalDatabase);
    jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined); // avoid real WS + reconnect-timer leak
    await internals(client).startSession(SESSION);
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(true); // restore passed clearUnread:false
});
```

> The `clearUnread:false` unit test is the load-bearing assertion (it proves the option threads correctly). The `startSession` integration test is best-effort — if driving the full bootstrap selection is awkward with the stubs, keep the two `selectConversation` unit tests (they directly verify the option) and cover the restore-path wiring by asserting the two call sites pass `{ clearUnread: false }` via a spy on `selectConversation`.

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "clearUnread"`
Expected: FAIL (option not implemented; override cleared unconditionally or method signature lacks opts).

- [ ] **Step 3: Add the option + clear-on-user-open**

In `selectConversation` (line 314) change the signature and add the clear near the existing read-scheduling (after line 332):

```ts
    public async selectConversation(conversationId: string, opts?: { clearUnread?: boolean }): Promise<void> {
        if (!this.database || !this.state.session) return;
        if (opts?.clearUnread ?? true) this.clearUnreadOverride(conversationId);
        storeSelectedConversation(this.state.session, conversationId);
        // ... existing body unchanged ...
```

- [ ] **Step 4: Wire the two programmatic restorers to pass `{ clearUnread: false }`**

`startSession` line 898: `if (selectedConversation) await this.selectConversation(selectedConversation.id, { clearUnread: false });`
`replaceSnapshot` line 969: `if (selectedConversation) await this.selectConversation(selectedConversation.id, { clearUnread: false });`

- [ ] **Step 5: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- client-test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): selectConversation clearUnread opt; restore paths keep marker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-2.5: Restructure `markConversationRead` (existence-check + always-clear-override + conditional flush)

**Files:**
- Modify: `src/journal/client.ts` (`markConversationRead` :351-355)
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Produces: `public markConversationRead(id): boolean` — per spec §3.3 B1 + compound-failure contract. Returns `true` when the client marker is in the desired (cleared) state after the call, `false` when the override-clear write failed. **Returning a boolean is required so `markAllRead` (T-2.6) can delegate to this method and aggregate per-row failures (round-1 Codex P2 canonical-source finding) instead of duplicating the mark-read logic.**

- [ ] **Step 1: Write the failing tests** (real assertions — an empty `it()` passes silently, so each must fail for its intended reason). These reuse the existing client-test harness (`internals(client).state = {...}` seeding + `SESSION`, as in `archive-test.ts`/`client-test.ts`). Access `unreadOverrideIds` via `client.getSnapshot()`. Spy the connection send to detect `scheduleRead` → `read_marker`.

**`scheduleRead` defers via `window.setTimeout(fn, 0)` (a macrotask, `client.ts:1244`) — it is NEVER synchronous.** Any test asserting the `read_marker` send MUST use fake timers, exactly like the existing mark-read tests (`client-test.ts:224-243`): `jest.useFakeTimers()`, then `await jest.runAllTimersAsync()` before asserting on `send`. Reset with `jest.useRealTimers()` in `afterEach` (or per the file's existing timer teardown).

```ts
it("marks an override-only row (unread_count 0) read by clearing the override; returns true", () => {
    const { client } = withConvos([{ ...CONVERSATIONS[0], id: "c1", unread_count: 0 }]);
    client.markConversationUnread("c1");
    const ok = client.markConversationRead("c1");
    expect(ok).toBe(true);
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(false);
});

it("on a server-unread row, flushes the read marker AND clears any override", async () => {
    jest.useFakeTimers();
    const { client, state } = withConvos([{ ...CONVERSATIONS[0], id: "c1", unread_count: 3, last_seq: 9 }]);
    const send = jest.fn().mockReturnValue(true);
    state.connection = { send };
    client.markConversationUnread("c1");
    client.markConversationRead("c1");
    await jest.runAllTimersAsync();
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(false);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: "read_marker", convo_id: "c1" }));
    jest.useRealTimers();
});

it("compound failure: setItem throw while clearing override still flushes read, sets controlError, keeps override", async () => {
    jest.useFakeTimers();
    const { client, state } = withConvos([{ ...CONVERSATIONS[0], id: "c1", unread_count: 3, last_seq: 9 }]);
    const send = jest.fn().mockReturnValue(true);
    state.connection = { send };
    client.markConversationUnread("c1");
    // Capture the native impl BEFORE spying so the throw doesn't recurse (archive-test.ts:189 idiom).
    const originalSetItem = Storage.prototype.setItem;
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage) {
        throw new Error("full");
    });
    const ok = client.markConversationRead("c1");
    setItem.mockRestore();
    void originalSetItem; // (restored via mockRestore; captured only to document the safe pattern)
    await jest.runAllTimersAsync();
    expect(ok).toBe(false);
    expect(client.getSnapshot().controlError).toBeDefined();
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(true); // clear failed → override survives
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: "read_marker", convo_id: "c1" }));
    jest.useRealTimers();
});
```

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "override-only row"`
Expected: FAIL (current guard early-returns for unread_count 0; method returns `void` not `boolean`).

- [ ] **Step 3: Restructure (replace lines 351-355)**

```ts
    public markConversationRead(conversationId: string): boolean {
        const conversation = this.state.conversations.find((c) => c.id === conversationId);
        if (!conversation) return true; // nothing to do; not a failure
        const cleared = this.clearUnreadOverride(conversationId); // best-effort; sets controlError on failure, never throws
        if (conversation.unread_count > 0) this.scheduleRead(conversationId, conversation.last_seq, 0);
        return cleared;
    }
```

- [ ] **Step 4: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- client-test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): markConversationRead clears override on override-only rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-2.6: `markAllRead` single-mechanism + batch `controlError` aggregation

**Files:**
- Modify: `src/journal/client.ts` (`markAllRead` :357-363)
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Consumes: `effectiveUnread` (import into `client.ts` in this task — round-1 Claude finding: no task imported it there yet), `markConversationRead` (returns `boolean`).
- Produces: restructured `public markAllRead()` — gate `effectiveUnread(c, unreadOverrideIds) && !archivedIds.has(c.id)`, **delegates each row to `markConversationRead` (single canonical mark-read path, round-1 Codex P2)**, single authoritative `controlError` patch.

- [ ] **Step 0: Add the client.ts import** — extend the `./conversation-flags` import (added in T-1.2) to include `effectiveUnread`:

```ts
import { makeIdSetStore, effectiveUnread, type IdSetStore } from "./conversation-flags";
```

- [ ] **Step 1: Write the failing tests** (real assertions — reuse the `withConvos` helper from T-2.2)

```ts
it("marks active override-only rows read (unread_count 0) that the old gate skipped", () => {
    const { client } = withConvos([{ ...CONVERSATIONS[0], id: "c1", unread_count: 0 }]);
    client.markConversationUnread("c1");
    client.markAllRead();
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(false);
});

it("leaves an archived conversation's override intact (mark unread → archive → mark-all)", () => {
    const { client } = withConvos([{ ...CONVERSATIONS[0], id: "c1", unread_count: 0 }]);
    client.markConversationUnread("c1");
    client.archiveConversation("c1");
    client.markAllRead();
    expect(client.getSnapshot().unreadOverrideIds.has("c1")).toBe(true);
});

it("aggregates batch errors: one row's setItem throws → controlError set to the batch message", () => {
    const { client } = withConvos([
        { ...CONVERSATIONS[0], id: "c1", unread_count: 0 },
        { ...CONVERSATIONS[0], id: "c2", unread_count: 0 },
    ]);
    client.markConversationUnread("c1");
    client.markConversationUnread("c2");
    // Capture the native impl BEFORE spying (archive-test.ts:189 idiom) — calling the prototype
    // method from inside its own mock would recurse infinitely. Throw once, then delegate.
    const originalSetItem = Storage.prototype.setItem;
    let throws = 1;
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k, v) {
        if (throws-- > 0) throw new Error("full");
        return originalSetItem.call(this, k, v);
    });
    client.markAllRead();
    setItem.mockRestore();
    expect(client.getSnapshot().controlError).toBe(
        "Some conversations couldn't be updated — device storage is full or unavailable.",
    );
});
```

> No fake timers needed here: these conversations have `unread_count 0`, so `markConversationRead`/`markAllRead` only clear overrides (no `scheduleRead` → no timer). A batch test that mixed in server-unread rows would need `jest.useFakeTimers()` + `runAllTimersAsync()` as in T-2.5.

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "override-only rows read"`
Expected: FAIL.

- [ ] **Step 3: Restructure (replace lines 357-363) — delegate to `markConversationRead`**

```ts
    public markAllRead(): void {
        let anyFailed = false;
        for (const conversation of this.state.conversations) {
            if (this.state.archivedIds.has(conversation.id)) continue;
            if (!effectiveUnread(conversation, this.state.unreadOverrideIds)) continue;
            // Single canonical mark-read path (P2); it clears the override + flushes server read
            // and returns false when the override-clear write failed.
            if (!this.markConversationRead(conversation.id)) anyFailed = true;
        }
        // One authoritative final patch — overrides any transient per-row controlError side effects.
        this.patch({
            controlError: anyFailed
                ? "Some conversations couldn't be updated — device storage is full or unavailable."
                : undefined,
        });
    }
```

> Delegating to `markConversationRead` (rather than re-inlining `clearUnreadOverride` + `scheduleRead`) is the round-1 Codex P2 fix: one canonical mark-read implementation, so a future change to existence-checking, scheduling, or failure handling can't drift between the two paths.

- [ ] **Step 4: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- client-test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): markAllRead single-mechanism + batch controlError aggregation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Phase 2 acceptance:** all client-layer behavior + failure contracts implemented and unit-tested; `pnpm test` (client-test + archive-test + conversation-flags-test) green; `pnpm lint:types` clean.

---

## Phase 3 — UI (icons, menu, row affordances, segmented tab, CSS)

`components.tsx` + `icons.tsx` + `journal.pcss`. **Invoke the `frontend-design` skill at the start of this phase** to drive the visual language of the segmented tab, the menu-item ordering/icons, and the row affordances (pin glyph, star, unread dot) so they read as native to the existing `mj_RoomList*` / `mx_LeftPanel*` system. The a11y/interaction contract (§4 of the spec) is fixed and NOT delegated.

### T-3.1: Add the four icons

**Files:**
- Modify: `src/journal/icons.tsx`
- Test: `test/unit-tests/journal/components-test.ts` (a smoke import is enough; icons are SVG)

**Interfaces:**
- Produces: `PinIcon`, `StarIcon`, `StarFilledIcon`, `MarkUnreadIcon` (each `(props: IconProps) => React.ReactElement`, using the existing `<Icon>` wrapper: 24×24 viewBox, `currentColor` stroke).

- [ ] **Step 1: Add the icons** (match the existing `<Icon>` wrapper pattern at `icons.tsx:11-29`)

```tsx
export function PinIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" />
            <path d="M12 16v4" />
        </Icon>
    );
}
export function StarIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.9 7.2 19l.9-5.4L4.2 9.7l5.4-.8L12 4Z" />
        </Icon>
    );
}
export function StarFilledIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props} fill="currentColor">
            <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.9 7.2 19l.9-5.4L4.2 9.7l5.4-.8L12 4Z" />
        </Icon>
    );
}
export function MarkUnreadIcon(props: IconProps): React.ReactElement {
    return (
        <Icon {...props}>
            <circle cx="17" cy="7" r="3" fill="currentColor" stroke="none" />
            <path d="M4 7h7M4 12h16M4 17h16" />
        </Icon>
    );
}
```

> Exact SVG path geometry is a frontend-design detail — refine during the phase-3 frontend-design pass; the export names + signatures above are the contract other tasks rely on.

- [ ] **Step 2: Type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/icons.tsx
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): pin/star/mark-unread icons

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-3.2: Context-menu items (Pin/Unpin, Add/Remove Favorites, Mark unread)

**Files:**
- Modify: `src/journal/components.tsx` (the `roomMenu` render block ~647-690; icon imports ~22-34)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: `client.pinConversation` / `unpinConversation` / `favoriteConversation` / `unfavoriteConversation` / `markConversationUnread` (Phase 2); `effectiveUnread`; `state.pinnedIds` / `.favoriteIds` / `.unreadOverrideIds`.

- [ ] **Step 0: Wire session + HYDRATE the flag sets into the test harness (round-1 Claude + round-2 Codex findings — REQUIRED first).** Two coupled problems with the existing `signedInClient()` helper (`components-test.ts:38-55`): (a) `setFlag`/`setArchived` early-return silently when `state.session` is falsy, and the helper doesn't set `session`; (b) the helper builds state by spreading `client.getSnapshot()` (blank flag sets) and never calls `startSession`, so **seeding a store does NOT populate the in-memory set** the component reads. Fix `signedInClient` to both set `session` AND hydrate the four flag sets from their stores, so "write store → render" works:

```ts
const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

// in signedInClient, replace the internals(client).state = { ...client.getSnapshot(), ... } assignment with:
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: options.events ?? [],
        pendingMessages: options.pendingMessages ?? [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
```

Import the four stores + `Session` type from `client.ts`/`types`. `beforeEach(() => localStorage.clear())` to isolate. Now a test does `pinnedStore.write(SESSION, new Set([CONVERSATION.id]))` **before** `signedInClient()` and the hydrated `pinnedIds` reflects it. This keeps existing tests working (they seed nothing → empty sets, same as today) while making the new store-seeded tests hydrate correctly.

- [ ] **Step 1: Write the failing tests** using the EXISTING `renderClient(client)` harness (renders `MatronApp` with a real `MatronJournalClient`). Open the row's kebab menu by clicking its "Conversation options" trigger, then assert on menu-item text. Helper: `const menuItem = (c: HTMLElement, text: string) => [...c.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes(text));`

```ts
async function openMenu(container: HTMLElement): Promise<void> {
    await act(async () => button(container, "Conversation options").click());
}

it("menu shows Pin when unpinned and Unpin when pinned", async () => {
    const client = signedInClient(); // CONVERSATION.id is the seeded row
    const { container } = await renderClient(client);
    await openMenu(container);
    expect(menuItem(container, "Pin")).toBeTruthy();
    expect(menuItem(container, "Unpin")).toBeFalsy();
    await act(async () => (menuItem(container, "Pin") as HTMLElement).click());
    await openMenu(container);
    expect(menuItem(container, "Unpin")).toBeTruthy();
});

it("menu shows Add to Favorites when unfavorited and Remove from Favorites when favorited", async () => {
    favoriteStore.write(SESSION, new Set([CONVERSATION.id]));
    const client = signedInClient();
    const { container } = await renderClient(client);
    await openMenu(container);
    expect(menuItem(container, "Remove from Favorites")).toBeTruthy();
});

it("menu shows Mark as unread (not Mark as read) for a read, non-archived row", async () => {
    const { container } = await renderClient(signedInClient()); // CONVERSATION unread_count 0, not archived
    await openMenu(container);
    expect(menuItem(container, "Mark as unread")).toBeTruthy();
    expect(menuItem(container, "Mark as read")).toBeFalsy();
});

it("menu shows Mark as read (not Mark as unread) for an override-only unread row, and clicking it clears the override", async () => {
    unreadStore.write(SESSION, new Set([CONVERSATION.id])); // effectively unread via override, unread_count 0
    const client = signedInClient();
    const { container } = await renderClient(client);
    await openMenu(container);
    expect(menuItem(container, "Mark as read")).toBeTruthy();
    expect(menuItem(container, "Mark as unread")).toBeFalsy();
    await act(async () => (menuItem(container, "Mark as read") as HTMLElement).click());
    expect(client.getSnapshot().unreadOverrideIds.has(CONVERSATION.id)).toBe(false);
});

it("menu offers neither Mark-read nor Mark-unread for an archived row (read affordances are active-only)", async () => {
    archiveStore.write(SESSION, new Set([CONVERSATION.id]));
    const { container } = await renderClient(signedInClient());
    // Expand the archived section. The toggle has NO aria-label (text is "Archived (n)"), so do NOT use
    // the aria-label-only `button()` helper — select by class (round-5 finding).
    const toggle = container.querySelector<HTMLButtonElement>(".mj_RoomList_archivedToggle")!;
    await act(async () => toggle.click());
    await openMenu(container); // the single archived row's "Conversation options" trigger (has aria-label)
    expect(menuItem(container, "Mark as unread")).toBeFalsy();
    expect(menuItem(container, "Mark as read")).toBeFalsy();
    expect(menuItem(container, "Unarchive")).toBeTruthy();
});
```

> With one archived conversation and no active rows, expanding the archived section yields exactly one row and one "Conversation options" trigger, so `openMenu` is unambiguous. The load-bearing checks: override-only → "Mark as read" present + clears override; archived → both read affordances absent.

> `CONVERSATION` is the existing top-of-file test fixture (`unread_count: 0`). If it has non-zero unread, add a read fixture. Model `openMenu`/`button` on the existing attachment-composer tests (they already `act`-click buttons by `aria-label`).

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- components-test -t "menu shows Pin"`
Expected: FAIL.

- [ ] **Step 3: Add the menu items** inside the `roomMenu && menuConversation` block, using the existing `mj_RoomItemMenu_item` button pattern + `closeRoomMenu()` + `restoreFocusAfterMenuAction()`. Add Pin/Unpin and Favorite/Unfavorite unconditionally; gate Mark-unread on `!state.archivedIds.has(menuConversation.id) && !effectiveUnread(menuConversation, state.unreadOverrideIds)`. Extend the existing Mark-as-read gate to `effectiveUnread(...)` instead of `unread_count > 0`. Import `PinIcon, StarIcon, StarFilledIcon, MarkUnreadIcon` and `effectiveUnread`. Example (Pin item):

```tsx
{state.pinnedIds.has(menuConversation.id) ? (
    <button className="mj_RoomItemMenu_item" type="button" role="menuitem"
        onClick={() => { closeRoomMenu(); client.unpinConversation(menuConversation.id); restoreFocusAfterMenuAction(); }}>
        <PinIcon aria-hidden /> Unpin
    </button>
) : (
    <button className="mj_RoomItemMenu_item" type="button" role="menuitem"
        onClick={() => { closeRoomMenu(); client.pinConversation(menuConversation.id); restoreFocusAfterMenuAction(); }}>
        <PinIcon aria-hidden /> Pin
    </button>
)}
```

Mirror for Favorites (StarIcon/StarFilledIcon, "Add to Favorites"/"Remove from Favorites") and Mark-unread (MarkUnreadIcon, "Mark as unread", calls `client.markConversationUnread`). Item ordering (frontend-design): Pin, Favorite, Mark read/unread, Archive/Unarchive.

- [ ] **Step 4: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- components-test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): context-menu Pin/Favorite/Mark-unread items

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-3.3: Pin sort-to-top + row affordances (pin glyph, star, override-unread dot with aria-label)

**Files:**
- Modify: `src/journal/components.tsx` (`active` partition ~379; `renderConversation` ~397-490; unread badge ~476-482)
- Modify: `src/journal/journal.pcss` (new row-affordance classes)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: `state.pinnedIds`, `state.unreadOverrideIds`, `effectiveUnread`.

- [ ] **Step 1: Write the failing tests** (via `renderClient`; the override-unread test asserts the ROW BUTTON's accessible name, not a child span — see step 4b for why)

**Helper for the two-row test:** `signedInClient` seeds one conversation (`CONVERSATION`). Add a `signedInWithRooms(convos: Conversation[])` variant that is `signedInClient` but with `conversations: convos` in the state assignment (same session + hydration as step 0). The DB `conversations()` mock in the real client sorts by activity; here the render reads `state.conversations` order after the component's pin-partition, so pass them already in activity order.

```ts
it("renders pinned rows before unpinned in the active list", async () => {
    const roomA = { ...CONVERSATION, id: "room-a", title: "Room A" };
    const roomB = { ...CONVERSATION, id: "room-b", title: "Room B" };
    pinnedStore.write(SESSION, new Set(["room-b"]));
    // roomA first in activity order; pinning room-b must float it to index 0.
    const { container } = await renderClient(signedInWithRooms([roomA, roomB]));
    const names = [...container.querySelectorAll('[data-testid="room-name"]')].map((el) => el.textContent);
    expect(names[0]).toBe("Room B");
    expect(names[1]).toBe("Room A");
});

it("override-unread row announces marked-unread in the row button's accessible name and renders no numeric badge", async () => {
    unreadStore.write(SESSION, new Set([CONVERSATION.id])); // CONVERSATION.unread_count === 0
    const { container } = await renderClient(signedInClient());
    const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]');
    expect(row?.getAttribute("aria-label")).toContain("marked unread"); // state in the BUTTON's name, not a masked child
    expect(container.querySelector(".mj_UnreadBadge")).toBeNull(); // no numeric badge for override-only
});
```

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- components-test -t "pinned rows before"`
Expected: FAIL.

- [ ] **Step 3: Pin-sort the active partition** (replace line 379):

```tsx
const activeAll = conversations.filter((conversation) => !state.archivedIds.has(conversation.id));
const active = [
    ...activeAll.filter((c) => state.pinnedIds.has(c.id)),
    ...activeAll.filter((c) => !state.pinnedIds.has(c.id)),
];
```

- [ ] **Step 4: Row affordances in `renderConversation`** — compute `const overrideUnread = state.unreadOverrideIds.has(conversation.id) && conversation.unread_count === 0;` and `const unread = effectiveUnread(conversation, state.unreadOverrideIds);`. Apply the `mj_RoomListText_unread` class when `unread`. Render a pin glyph (`<span className="mj_RoomListPinGlyph"><PinIcon aria-hidden /></span>`) when `state.pinnedIds.has(id)` and a star when `state.favoriteIds.has(id)` (frontend-design placement). For the override-only row, render a **visual-only** dot:

```tsx
{conversation.unread_count > 0 ? (
    <span className="mj_UnreadBadge" aria-label={`${conversation.unread_count} unread`}>
        {conversation.unread_count}
    </span>
) : overrideUnread ? (
    <span className="mj_UnreadDot" aria-hidden />
) : null}
```

- [ ] **Step 4b: Put the marked-unread state in the ROW BUTTON's accessible name (round-1 Codex blocker).** The row is a `<button aria-label={`Open room ${name}`}>` (`components.tsx:410`). An explicit `aria-label` on the button **overrides** any child's accessible name, so a dot's `aria-label` is never announced — a screen-reader user would hear only "Open room X". Fix: fold the state into the button's own label, and make the dot purely visual (`aria-hidden`, above):

```tsx
aria-label={`Open room ${name}${overrideUnread ? ", marked unread" : ""}`}
```

(The pre-existing numeric badge keeps its own `aria-label` — it is a separate latent issue out of scope here; this task only guarantees the NEW override-unread state is announced.)

- [ ] **Step 5: Add CSS** in `journal.pcss` (the feature's other `.mj_RoomList*` classes live there; note `.mj_UnreadBadge` itself is defined in `shell.pcss:251`, so co-location isn't exact — put the new classes in `journal.pcss` with the rest of the room-list styles):

```pcss
.mj_UnreadDot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--cpd-color-icon-accent-primary);
}
.mj_RoomListPinGlyph,
.mj_RoomListStarGlyph {
    flex: 0 0 auto;
    color: var(--cpd-color-icon-secondary);
}
.mj_RoomListPinGlyph svg,
.mj_RoomListStarGlyph svg {
    width: 14px;
    height: 14px;
}
```

- [ ] **Step 6: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- components-test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/components.tsx src/journal/journal.pcss test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): pin sort-to-top + row affordances + override-unread dot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-3.4: Segmented All | Favorites tab + Favorites filter + empty state

**Files:**
- Modify: `src/journal/components.tsx` (`ConversationList` — add tab state near line 254; render tab above the room list ~564; apply favorites filter to `active`; extend `hasActiveUnread` to `effectiveUnread`)
- Modify: `src/journal/journal.pcss` (segmented-control classes)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: `state.favoriteIds`, `effectiveUnread`.
- Produces: `const [tab, setTab] = useState<"all" | "favorites">("all");` and a favorites-filtered active list; the Archived section renders only when `tab === "all"`.

- [ ] **Step 1: Write the failing tests** (via `renderClient`; `tab = (c, name) => c.querySelector<HTMLButtonElement>(\`button[aria-pressed][... ]\`)` — locate by text "All"/"Favorites")

```ts
const tabButton = (c: HTMLElement, text: "All" | "Favorites"): HTMLButtonElement =>
    [...c.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) => b.textContent === text)!;

it("renders All + Favorites buttons with aria-pressed tracking the active view", async () => {
    const { container } = await renderClient(signedInClient());
    expect(tabButton(container, "All").getAttribute("aria-pressed")).toBe("true");
    expect(tabButton(container, "Favorites").getAttribute("aria-pressed")).toBe("false");
});

it("clicking Favorites filters to favorited rows, sets aria-pressed, focuses the tab, hides archived section", async () => {
    const fav = { ...CONVERSATION, id: "fav", title: "Fav Room" };
    const other = { ...CONVERSATION, id: "other", title: "Other Room" };
    favoriteStore.write(SESSION, new Set(["fav"]));
    const { container } = await renderClient(signedInWithRooms([fav, other]));
    await act(async () => tabButton(container, "Favorites").click());
    expect(tabButton(container, "Favorites").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(tabButton(container, "Favorites")); // explicit .focus() in handler → testable
    const names = [...container.querySelectorAll('[data-testid="room-name"]')].map((el) => el.textContent);
    expect(names).toEqual(["Fav Room"]); // only the favorited row
    expect(container.querySelector(".mj_RoomList_archivedToggle")).toBeNull(); // archived section hidden in Favorites
});

it("shows the no-favorites-yet state when nothing is starred", async () => {
    const { container } = await renderClient(signedInClient());
    await act(async () => tabButton(container, "Favorites").click());
    expect(container.textContent).toContain("No favorite conversations yet.");
});

it("distinguishes 'no favorites match search' from 'no favorites yet' (round-4 Codex-M2)", async () => {
    const fav = { ...CONVERSATION, id: "fav", title: "Alpha" };
    favoriteStore.write(SESSION, new Set(["fav"]));
    const { container } = await renderClient(signedInWithRooms([fav]));
    await act(async () => tabButton(container, "Favorites").click());
    // type a search that excludes the favorite (search input is the existing #room-list-search-input)
    const search = container.querySelector<HTMLInputElement>("#room-list-search-input")!;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(search, "zzz-no-match");
        search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No favorites match your search.");
    expect(container.textContent).not.toContain("No favorite conversations yet.");
});

it("switching tabs leaves selectedConversationId unchanged when the selected row is filtered out", async () => {
    const client = signedInClient(); // CONVERSATION selected, not favorited
    const { container } = await renderClient(client);
    await act(async () => tabButton(container, "Favorites").click());
    expect(client.getSnapshot().selectedConversationId).toBe(CONVERSATION.id); // unchanged
});
```

> **Focus retention IS asserted (round-4 correction).** Because the tab handler explicitly calls `event.currentTarget.focus()` (step 4 — required for Safari, which doesn't focus buttons on click), `document.activeElement` moves to the clicked tab in jsdom too (jsdom honors explicit `.focus()`). So the assertion above is valid and load-bearing. (This reverses the round-2 decision to drop it — that was correct only under the wrong assumption that focus was native-on-click; with explicit `.focus()` it's both cross-browser-correct and testable.)

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- components-test -t "All + Favorites buttons"`
Expected: FAIL.

- [ ] **Step 3: Add tab state + filter.** Near line 254 add `const [tab, setTab] = useState<"all" | "favorites">("all");`. After computing the pin-sorted `active` (T-3.3), derive the visible list:

```tsx
const visibleActive = tab === "favorites" ? active.filter((c) => state.favoriteIds.has(c.id)) : active;
// Favorite existence is computed from the UNFILTERED conversation set (like hasActiveUnread at line 384),
// so a search query that hides all favorites does NOT read as "no favorites" (round-4 Codex-M2).
const hasAnyFavorite = state.conversations.some(
    (c) => state.favoriteIds.has(c.id) && !state.archivedIds.has(c.id),
);
```

Render `visibleActive` in the `.mj_RoomList` map instead of `active`. Gate the Archived section render on `tab === "all"`. Extend `hasActiveUnread` (line 384) to use `effectiveUnread(conversation, state.unreadOverrideIds)`.

- [ ] **Step 4: Render the segmented control** (above `.mx_RoomListSearch`, ~line 564), honoring the fixed a11y contract:

```tsx
<div className="mj_RoomListTabs" aria-label="Filter conversations">
    <button type="button" className={`mj_RoomListTab${tab === "all" ? " mj_RoomListTab_active" : ""}`}
        aria-pressed={tab === "all"}
        onClick={(e) => { setTab("all"); e.currentTarget.focus({ preventScroll: true }); }}>All</button>
    <button type="button" className={`mj_RoomListTab${tab === "favorites" ? " mj_RoomListTab_active" : ""}`}
        aria-pressed={tab === "favorites"}
        onClick={(e) => { setTab("favorites"); e.currentTarget.focus({ preventScroll: true }); }}>Favorites</button>
</div>
```

> **Explicit `.focus()` is REQUIRED, not native (round-4 Codex-B2, P7).** Safari (and macOS Firefox) do NOT focus a `<button>` on pointer-click by default ([MDN: button clicking-and-focus](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#clicking_and_focus)). Relying on native click-to-focus would silently break the §4 "focus remains on the activated tab" contract in Safari. Calling `event.currentTarget.focus()` in the handler makes the contract cross-browser-correct AND jsdom-testable (jsdom honors explicit `.focus()` even though it doesn't focus on `.click()`).

Add TWO distinct Favorites empty states in the room-list body (round-4 Codex-M2):
- `tab === "favorites" && !hasAnyFavorite` → `<p className="mj_RoomListEmpty">No favorite conversations yet.</p>` (the user has starred nothing).
- `tab === "favorites" && hasAnyFavorite && !visibleActive.length` → `<p className="mj_RoomListEmpty">No favorites match your search.</p>` (favorites exist but the search query hides them all).

- [ ] **Step 5: Add CSS** in `journal.pcss`:

```pcss
.mj_RoomListTabs {
    display: flex;
    gap: var(--cpd-space-1x);
    padding: var(--cpd-space-2x) var(--cpd-space-4x);
}
.mj_RoomListTab {
    flex: 1 1 0;
    border: 0;
    border-radius: 9999px;
    background: transparent;
    color: var(--cpd-color-text-secondary);
    cursor: pointer;
    padding: var(--cpd-space-1x) var(--cpd-space-3x);
    font: var(--cpd-font-body-sm-regular);
}
.mj_RoomListTab_active {
    background: var(--cpd-color-bg-subtle-primary);
    color: var(--cpd-color-text-primary);
}
.mj_RoomListTab:focus-visible {
    outline: 2px solid var(--cpd-color-border-interactive-primary);
}
```

> CSS tokens verified to exist in `src/journal/shell.pcss:8-31` (round-1 Claude finding): `--cpd-color-border-interactive-primary` is the codebase's established focus-ring token (`journal.pcss:505,532`); `--cpd-font-body-sm-regular` is the only `sm` body font defined; `--cpd-color-icon-secondary` (T-3.3) and `--cpd-color-icon-accent-primary` (dot) both exist. The invented `--cpd-color-border-focused` / `--cpd-font-body-sm-medium` / `--cpd-color-icon-tertiary` do NOT exist — a `var()` with no fallback on an undefined property drops the whole declaration (the focus outline would silently never render, no build error).

- [ ] **Step 6: Run tests + type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types && corepack pnpm test -- components-test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add src/journal/components.tsx src/journal/journal.pcss test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(session-controls): segmented All|Favorites tab + filter + empty state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Phase 3 acceptance:** menu items, row affordances, pin-sort, override-unread dot, and the segmented tab all render and are covered by `components-test.ts`; frontend-design pass applied to visuals; a11y contract asserted.

---

## Phase 4 — Integration, full-suite verification, and build

### T-4.1: Remaining interaction tests via the existing render harness

**Files:**
- Modify: `test/unit-tests/journal/components-test.ts`

**Reuse the EXISTING harness — do NOT invent a new one.** `components-test.ts` already renders through `renderClient(client)` (lines ~57-90): it `createRoot`s a jsdom container and `act`-renders `MatronApp` with a **real `MatronJournalClient`** (`import React, { act } from "react"` — React 19 exports `act` from `react` itself; `createRoot` from `react-dom/client`). `ConversationList` is a private (non-exported) component inside `components.tsx` — do NOT export it or build a `fakeClient` stub. Instead follow the established pattern: seed the four localStorage stores for the test `SESSION` **before** sign-in (`pinnedStore.write(SESSION, ...)` etc., imported from `client.ts`), sign the real client in, and drive behavior through real client methods + DOM clicks (`button(container, "Pin")`, `.click()` inside `act`), asserting on the rendered DOM (`container.querySelector`) and on `client.getSnapshot()`. All Phase-3 component tests use this same harness.

**Interfaces:**
- Consumes: `renderClient` (existing helper), `MatronApp` (existing export), the real `MatronJournalClient`, and the exported stores (`pinnedStore`/`favoriteStore`/`unreadStore`/`archiveStore`).

- [ ] **Step 1: Add the remaining interaction tests** to `components-test.ts` using `renderClient`. Cover any not already written in Phase 3:
  - **M1 unfavorite-while-selected keeps `selectedConversationId`.** IMPORTANT (round-3 Codex): the row only leaves the list when the **Favorites** tab is active — in the default All tab, unfavoriting does not hide the row. So the test must **click the Favorites tab first**, then open the selected row's menu and click "Remove from Favorites", then assert the row is gone from the (Favorites-filtered) list while `getSnapshot().selectedConversationId` is unchanged. Concretely: `favoriteStore.write(SESSION, new Set([CONVERSATION.id]))` → `renderClient(signedInClient())` (CONVERSATION selected) → click Favorites tab → open menu → click "Remove from Favorites" → assert no `[data-testid="room-name"]` rows AND `client.getSnapshot().selectedConversationId === CONVERSATION.id`.
  - **Menu keyboard nav** still works (arrow keys over the enlarged item set — the existing menu keydown handler at `components.tsx:620-640`).
  - **Long-press / right-click** still open the menu.
  Model each on the existing archive-menu / mark-all render tests already in this file.

- [ ] **Step 2: Run the full components suite**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- components-test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "test(session-controls): interaction coverage via existing render harness

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### T-4.2: Full-suite green + lint + production build

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test`
Expected: PASS — conversation-flags-test, client-test, archive-test, components-test, and all pre-existing suites green.

- [ ] **Step 2: Lint (types + prettier)**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint`
Expected: PASS. If prettier flags formatting, run `corepack pnpm lint:fix` and re-run.

- [ ] **Step 3: Production build smoke**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm build`
Expected: build succeeds (webpack). This does NOT deploy — the operator live-tests separately per the CLAUDE.local.md web-deploy runbook. Do not touch `/opt/matron/web-journal/webapp`.

- [ ] **Step 4: Final commit (if lint:fix changed anything)** — stage EXPLICIT paths only. `git add -A|.|--all` is forbidden by `CLAUDE.md` and blocked by the `preuse-no-git-add-all.sh` hook. Review `git status --short`, then add only the feature's files:

```bash
WT=/opt/matron/web-journal-wt-session-controls
git -C "$WT" status --short
# stage only the touched source/test/doc files:
git -C "$WT" add \
    src/journal/client.ts src/journal/components.tsx src/journal/types.ts \
    src/journal/icons.tsx src/journal/journal.pcss src/journal/conversation-flags.ts \
    test/unit-tests/journal/client-test.ts test/unit-tests/journal/components-test.ts \
    test/unit-tests/journal/archive-test.ts test/unit-tests/journal/conversation-flags-test.ts
# Commit ONLY if there is something staged; do NOT mask a real commit failure as "nothing to commit"
# (round-5 Codex-B2, P44/R700): distinguish empty-index from a failing commit, verify status after.
if git -C "$WT" diff --cached --quiet; then
    echo "nothing staged — no lint/format changes to commit"
else
    git -C "$WT" -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "chore(session-controls): lint/format pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
    git -C "$WT" status --short  # verify a clean tree after the commit
fi
```

**Phase 4 acceptance:** `pnpm test`, `pnpm lint`, and `pnpm build` all pass. Branch is ready for `/ship-slim` → PR (HOLD for operator review + live-test; do not merge).

---

## Dependency graph

- **Phase 1** (T-1.1 → T-1.2): foundation, no deps. T-1.2 depends on T-1.1.
- **Phase 2** (T-2.1 → T-2.6): depends on Phase 1. T-2.1 (types + rename) blocks all of 2.2-2.6. T-2.3 (setFlag/clearUnreadOverride) blocks T-2.4/2.5/2.6. T-2.5 (markConversationRead) blocks T-2.6 (markAllRead delegates to it).
- **Phase 3** (T-3.1 → T-3.4): depends on Phase 2 (calls the client methods + `effectiveUnread`). T-3.1 (icons) blocks T-3.2/3.3. T-3.3 (pin-sort `active`) blocks T-3.4 (favorites filter layers on `active`).
- **Phase 4**: depends on all. T-4.1 before T-4.2.

Phases are sequential; within a phase, tasks are mostly sequential per the graph above.

## Spec coverage map

| Spec part | Task(s) |
|---|---|
| §3.1 `IdSetStore` factory, `{ids, ok}` read, label warning-string pin | T-1.1, T-1.2 |
| §3.1 archive refactor onto factory, key unchanged, wrappers preserved | T-1.2 |
| §3.1 concurrency last-writer-wins (no lock) | T-2.3 (setFlag re-reads; documented behavior) |
| §3.2 `ClientState` sets + `blankState` | T-2.1 |
| §3.2 `archiveError`→`controlError` rename (all enumerated sites) | T-2.1 |
| §3.2 seed on `startSession` + `replaceSnapshot` honoring `ok` | T-2.2 |
| §3.2 `setFlag` abort-on-read-failure | T-2.3 |
| §3.3 mark-unread overlay + `effectiveUnread` | T-1.1 (helper), T-2.3 (setter) |
| §3.3 dot indicator + aria-label (accessible name, no numeric badge) | T-3.3 |
| §3.3 `markConversationRead` restructure + compound failure | T-2.5 |
| §3.3 user-vs-programmatic `selectConversation` (`clearUnread`) | T-2.4 |
| §3.3 `markAllRead` single-mechanism + batch `controlError` | T-2.6 |
| §3.3 `hasActiveUnread` extended to `effectiveUnread` | T-3.4 |
| §3.3 Electron badge unchanged (override doesn't bump) | (no-op — `emit()` sums `unread_count`; nothing to change) |
| §3.4 pin sort-to-top + pin glyph | T-3.3 |
| §3.5 favorites star + segmented tab + filter + empty state | T-3.2 (star menu), T-3.4 (tab) |
| §3.5 unfavorite-while-viewing keeps selection (no clearSelection) | T-2.3 (`unfavoriteConversation` = setFlag only), T-4.1 (test) |
| §3.5 tab = list-filter-only, never touches selection | T-3.4, T-4.1 (test) |
| §3.6 storage listener for all four keys | T-2.2 |
| §4 segmented-control a11y contract (aria-pressed, native focus) | T-3.4 |
| §4 new icons | T-3.1 |
| §4/§5 new CSS classes | T-3.3, T-3.4 |
| §5 all client + component tests | T-1.1, T-2.2-2.6, T-3.2-3.4, T-4.1 |
| §6 `conversation-flags.ts` module (avoid god-object growth) | T-1.1 |
| §7 all risk mitigations | covered across Phase 1-2 tasks + tests |

## Notes / deliberate exceptions

- **Electron badge:** no code change needed — `emit()` already sums `unread_count`, and override-unread rows have `unread_count === 0`, so they correctly do NOT bump the app badge (spec §3.3 non-goal). Listed for completeness, no task.
- **Selected-tab persistence:** deliberately NOT persisted (spec non-goal) — `useState` resets to `"all"` on reload. No fifth storage key.
- **frontend-design skill** is invoked at the start of Phase 3 for visual polish of the tab, menu, and row affordances; the a11y/interaction contract (§4) is fixed in-plan and not delegated.
- **No server/bridge changes** — entirely client-local, per spec non-goals.
- **Cross-tab last-writer-wins + null-event stale mirror (accepted operator-owned risks, not fixed).** Two `partial-state-preservation` findings that Codex re-raised at every spec-review and plan-review round (~8 times): (a) `setFlag`/`setArchived` re-read before mutating but two tabs toggling different ids within one event-loop tick can lose a write; (b) the storage listener ignores `event.newValue === null`, so a foreign-tab `removeItem`/`clear` leaves a stale mirror until reload. Both are **explicitly accepted at the spec level** (design §3.1 and §3.6): these are soft per-device preferences, the trigger windows are narrow (simultaneous two-tab toggles / external `localStorage.clear()` — the app never removes keys itself), and versioned compare-and-retry or a cross-tab lock is disproportionate machinery for the payoff. **Disposition: accepted, no serialization added.** This is a convergence-by-class call — the same class re-flagged past the point of new signal. If the operator later decides cross-tab consistency matters (e.g. heavy multi-tab use), that is a **separate enhancement loop the operator owns**, filed at their discretion — not a defect blocking this feature. Do not add serialization machinery in this plan.

## Plan-review changelog

- **Round 1** (Claude + Codex): fixed 3 blockers — (1) T-1.2 now removes the unused `ARCHIVED_CONVERSATIONS_KEY_PREFIX` (would fail `noUnusedLocals`); (2) all `it()` test bodies are now executable with real assertions (comment-only stubs pass silently → false green); (3) T-3.3 folds the marked-unread state into the row **button's** `aria-label` (a child span's label is masked by the button's explicit label), dot is `aria-hidden`. Plus 5 majors: `effectiveUnread` now imported into `client.ts` (T-2.6 step 0); CSS uses real `--cpd-*` tokens verified against `shell.pcss`; `signedInClient` test harness now wires `state.session` (T-3.2 step 0) or menu clicks silently no-op; `markAllRead` now delegates to `markConversationRead` (one canonical mark-read path, P2) with `markConversationRead` returning `boolean`; storage-listener `newValue===null` early-return documented as a deliberate spec §3.6 exception. Plus 1 minor: `parse()` reproduces both distinct legacy warning strings.
- **Round 2** (Claude + Codex): all findings were test-authoring bugs in round-1's new test code, fixed against the verified-real `client-test.ts` harness. (1) T-2.4's stub tests are now executable; (2) all `read_marker` assertions use `jest.useFakeTimers()` + `runAllTimersAsync()` (scheduleRead defers via `setTimeout(0)`, `client.ts:1244`); (3) the batch-error `setItem` mock captures `originalSetItem` before spying (was self-recursive → stack overflow); (4) the jsdom-untestable focus assertion is dropped (real-browser behavior, live-tested); (5) invented sign-in helpers replaced with the real `withConvos`/`signedInState`/`internals`/`fakeDatabase` primitives; (6) `signedInClient` now HYDRATES the four flag sets from their stores (the harness never calls `startSession`, so store-seed→render needs explicit hydration). Minor: CSS anchor note corrected (`.mj_UnreadBadge` is in `shell.pcss`).
- **Round 3** (Claude + Codex): 4 mechanical execution-blockers fixed. (1) The `startSession`-driving tests (T-2.2 seeding, T-2.4 restore) now mock `JournalConnection.prototype.start` — without it `startSession` opens a real WebSocket + unbounded reconnect timer that hangs `jest --runInBand`; (2) removed the undeclared `storeSelectedConversation?.(...)` call (private/unexported → TS2304); (3) T-4.2's final commit stages explicit paths instead of the forbidden `git add -A` (CLAUDE.md + hook); (4) T-4.1's unfavorite-while-selected test now clicks the Favorites tab first (in the default All tab, unfavoriting doesn't hide the row). The cross-tab lost-update major is the spec-accepted last-writer-wins limitation (see Notes) — no change.
- **Round 4** (Codex; Claude LGTM): 2 blockers + 3 majors — runtime-correctness issues surfaced once the tests were solid. (1) `clearSelection` no longer clears the unified `controlError` (was archive-only; clearing on navigation would hide an unresolved pin/favorite failure — P3); (2) the segmented tab handler now explicitly `.focus()`es the clicked button (Safari doesn't focus buttons on click — P7 — reversing the round-2 assertion-drop, now testable); (3) `clearUnreadOverride` guards its in-memory no-op with an `unreadHydrated` flag so a failed-then-recovered bootstrap read can't resurrect a persisted override (P48); (4) the Favorites empty state distinguishes "no favorites yet" from "no favorites match search" (computed from the unfiltered set); (5) the T-3.2 menu test split into read / override-only / archived cases (was single-branch).
- **Round 5** (Claude + Codex) — CONVERGED. 3 trivial mechanical blockers fixed: (1) the four-key storage-event test now fires the archive key too (was leaving `archiveStore` unused → TS6133); (2) T-4.2's final commit uses a `git diff --cached --quiet` pre-check instead of `commit || echo` (which masked real commit failures — P44/R700); (3) `startSession` sets a visible `controlError` when any bootstrap flag read fails, instead of rendering empty-as-authoritative (P3). Claude's archived-row menu test now selects the `.mj_RoomList_archivedToggle` by class (the toggle has no `aria-label`). The two recurring `partial-state-preservation` majors (cross-tab last-writer-wins, null-event stale mirror) are **spec-accepted convergence-by-class** — documented as operator-owned accepted risks (§3.1/§3.6, see Notes), no serialization added.
