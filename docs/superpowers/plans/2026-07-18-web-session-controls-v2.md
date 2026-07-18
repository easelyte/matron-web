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

    it("ignores a non-array JSON value (parse → empty)", () => {
        const store = makeIdSetStore("k_v1", "pinned-conversations");
        localStorage.setItem(store.storageKey(SESSION), JSON.stringify({ a: 1 }));
        expect(store.read(SESSION)).toEqual({ ids: new Set(), ok: true });
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
            console.warn(`matron: malformed ${label} value, ignoring`);
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

> NOTE the malformed-value message is a single `${label}` template used for BOTH the JSON-parse-throw and non-array branches — the legacy archive code logged the same text in both, so `archive-test.ts` (which only checks `toHaveBeenCalledTimes(1)` on the malformed path) stays green.

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
import { makeIdSetStore, effectiveUnread, type IdSetStore } from "./conversation-flags";

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

Delete the now-dead standalone `parseArchivedValue` function (lines 120-138) **only after** confirming its remaining callers (`startSession` storageListener line 888, `setArchived` line 917, `replaceSnapshot` line 962) are migrated in Phase 2. For this task, KEEP `parseArchivedValue` in place (Phase 2 T-2.2 removes it) and leave `ARCHIVED_CONVERSATIONS_KEY_PREFIX` (line 30) unused-but-present (Phase 2 removes it). Keep `SELECTED_CONVERSATION_KEY_PREFIX` (line 29) untouched.

- [ ] **Step 3: Run the archive regression (must still pass unchanged)**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- archive-test`
Expected: PASS — identical to baseline. The wrappers delegate to `archiveStore`; the key string and warning text are unchanged, so `archive-test.ts:130-166` (storage round-trip, malformed, storage-unavailable warning, key uniqueness) all hold.

- [ ] **Step 4: Type-check**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:types`
Expected: PASS (an unused `parseArchivedValue` is allowed; a broken signature is not).

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

Change `client.ts:340` (`clearSelection` patch) and `:934` (`setArchived` success patch) `archiveError: undefined` → `controlError: undefined`; `:919` / `:930` (`setArchived` error patches) `archiveError:` → `controlError:`; `components.tsx:558` `{state.archiveError && (` → `{state.controlError && (`; and in `archive-test.ts` change the four `client.getSnapshot().archiveError` assertions (`:216/:220/:238/:262`) to `.controlError`.

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

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/unit-tests/journal/client-test.ts (inside a new describe "session-controls flags")
it("seeds pinned/favorite/unread sets from storage on startSession", async () => {
    // arrange: pre-populate the three stores for SESSION, then sign in.
    // Use the exported stores to write, then drive startSession via the existing
    // sign-in harness used by archive seeding tests; assert getSnapshot() sets match.
});

it("preserves prior in-memory flag sets when replaceSnapshot re-read throws (ok:false)", async () => {
    // arrange: signed-in client with pinnedIds={c1}. Mock getItem to throw, trigger
    // replaceSnapshot; assert pinnedIds still {c1} (not emptied).
});

it("patches the matching set when a foreign-tab storage event fires for each of the four keys", () => {
    // fire a StorageEvent with key = pinnedStore.storageKey(SESSION), newValue=JSON(["c1"]);
    // assert state.pinnedIds === {c1}. Repeat for favorite + unread. Archive key still
    // deselects a viewed archived convo.
});
```

Fill each test body following the existing archive-seeding + storage-event tests already in `client-test.ts` / `archive-test.ts` (they show the sign-in harness, the `firstSelectableConversation` seeding, and how a `StorageEvent` is dispatched to the listener).

- [ ] **Step 2: Run to verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "session-controls flags"`
Expected: FAIL.

- [ ] **Step 3: Seed sets in `startSession`**

Replace the state-construction block (lines 871-883) to read + seed all four sets (bootstrap has no prior state to preserve, so `ok:false` seeds empty — unchanged from archive today):

```ts
        const conversations = await this.database.conversations();
        const storedConversationId = storedSelectedConversation(session);
        const archivedIds = archiveStore.read(session).ids;
        const pinnedIds = pinnedStore.read(session).ids;
        const favoriteIds = favoriteStore.read(session).ids;
        const unreadOverrideIds = unreadStore.read(session).ids;
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
            selectedConversationId: selectedConversation?.id,
        };
```

- [ ] **Step 4: Generalize the storage listener (lines 885-896)**

```ts
        if (this.storageListener) window.removeEventListener("storage", this.storageListener);
        this.storageListener = (event: StorageEvent): void => {
            const currentSession = this.state.session;
            if (!currentSession || event.newValue === null) return;
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
            if (u.ok) unreadOverrideIds = u.ids;
        }
        const selectedConversation = firstSelectableConversation(conversations, previousSelection, archivedIds);
        this.patch({ conversations, archivedIds, pinnedIds, favoriteIds, unreadOverrideIds, selectedConversationId: selectedConversation?.id });
```

Then remove the now-dead `parseArchivedValue` (old lines 120-138) and `ARCHIVED_CONVERSATIONS_KEY_PREFIX` (line 30) — grep to confirm no remaining callers first.

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
    // client.pinConversation("c1"); expect getSnapshot().pinnedIds has c1 AND pinnedStore.read(SESSION).ids has c1.
    // client.unpinConversation("c1"); expect both empty.
});
it("favorites/unfavorites symmetrically", () => { /* mirror pin */ });
it("markConversationUnread adds to unreadOverrideIds and persists", () => { /* ... */ });
it("setFlag aborts on read failure without clobbering the stored set", () => {
    // seed pinnedStore with {c1,c2}; mock getItem to throw; client.pinConversation("c3");
    // expect controlError set AND pinnedStore raw still {c1,c2} (no clobbering write).
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
        if (!this.state.unreadOverrideIds.has(id)) return true; // no-op, no write
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

- [ ] **Step 1: Write the failing tests**

```ts
it("user-initiated select clears the unread override", async () => {
    // mark c1 unread; await client.selectConversation("c1"); expect unreadOverrideIds has NOT c1.
});
it("programmatic restore keeps the override (startSession + replaceSnapshot pass clearUnread:false)", async () => {
    // mark c1 unread; drive a startSession restore that re-selects c1; expect override still {c1}.
    // repeat for replaceSnapshot.
});
```

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "unread override"`
Expected: FAIL.

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
- Produces: restructured `public markConversationRead(id)` per spec §3.3 B1 + compound-failure contract.

- [ ] **Step 1: Write the failing tests**

```ts
it("marks an override-only row (unread_count 0) read by clearing the override", () => {
    // mark c-read-server-0 unread (override), then markConversationRead; override cleared, no scheduleRead.
});
it("on a server-unread row, flushes the read marker AND clears any override", () => { /* ... */ });
it("compound failure: setItem throws while clearing override — still scheduleReads, sets controlError, override survives", () => {
    // c1 has unread_count>0 AND override; mock setItem throw; markConversationRead;
    // expect scheduleRead called (send read_marker), controlError set, unreadOverrideIds still has c1.
});
```

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "override-only row"`
Expected: FAIL (current guard early-returns for unread_count 0).

- [ ] **Step 3: Restructure (replace lines 351-355)**

```ts
    public markConversationRead(conversationId: string): void {
        const conversation = this.state.conversations.find((c) => c.id === conversationId);
        if (!conversation) return; // existence check only
        this.clearUnreadOverride(conversationId); // best-effort; sets controlError on failure, never throws
        if (conversation.unread_count > 0) this.scheduleRead(conversationId, conversation.last_seq, 0);
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
- Consumes: `effectiveUnread`, `clearUnreadOverride` (returns `ok`), `markConversationRead`.
- Produces: restructured `public markAllRead()` — gate `effectiveUnread(c, unreadOverrideIds) && !archivedIds.has(c.id)`, per-row delegation, single authoritative `controlError` patch.

- [ ] **Step 1: Write the failing tests**

```ts
it("marks active override-only rows read (unread_count 0) that the old gate skipped", () => {
    // c-override active (unread_count 0, override); markAllRead; override cleared.
});
it("leaves an archived conversation's override intact (mark unread → archive → mark-all)", () => {
    // c1 override; archive c1; markAllRead; unreadOverrideIds still has c1.
});
it("aggregates batch errors: one row setItem throws, another succeeds → controlError set to batch message", () => {
    // two active override rows; make write throw for the first only; markAllRead;
    // expect controlError === "Some conversations couldn't be updated — device storage is full or unavailable."
});
```

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- client-test -t "override-only rows read"`
Expected: FAIL.

- [ ] **Step 3: Restructure (replace lines 357-363)**

```ts
    public markAllRead(): void {
        let anyFailed = false;
        for (const conversation of this.state.conversations) {
            if (this.state.archivedIds.has(conversation.id)) continue;
            if (!effectiveUnread(conversation, this.state.unreadOverrideIds)) continue;
            // clearUnreadOverride returns false on write failure; scheduleRead is fire-and-forget.
            if (this.state.unreadOverrideIds.has(conversation.id) && !this.clearUnreadOverride(conversation.id)) {
                anyFailed = true;
            }
            if (conversation.unread_count > 0) this.scheduleRead(conversation.id, conversation.last_seq, 0);
        }
        // One authoritative final patch — overrides any transient per-row controlError side effects.
        this.patch({
            controlError: anyFailed
                ? "Some conversations couldn't be updated — device storage is full or unavailable."
                : undefined,
        });
    }
```

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

- [ ] **Step 1: Write the failing tests** (new render harness — see T-4.1 for the `createRoot`/`act` scaffold; this task establishes it)

```ts
it("menu shows Pin when unpinned and Unpin when pinned", () => { /* render ConversationList, open menu, assert */ });
it("menu shows Add to Favorites / Remove from Favorites by favorite state", () => { /* ... */ });
it("menu shows Mark as unread only for a read, non-archived row; Mark as read when effectively unread", () => { /* ... */ });
```

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

- [ ] **Step 1: Write the failing tests**

```ts
it("renders pinned rows before unpinned in the active list", () => { /* pinnedIds={c2}; assert c2 first */ });
it("override-unread row exposes an accessible name and renders no numeric badge", () => {
    // unreadOverrideIds={c1}, unread_count 0; assert an element with aria-label containing "marked unread"
    // exists and NO .mj_UnreadBadge (numeric) is rendered for c1.
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

- [ ] **Step 4: Row affordances in `renderConversation`** — compute `const overrideUnread = state.unreadOverrideIds.has(conversation.id) && conversation.unread_count === 0;` and `const unread = effectiveUnread(conversation, state.unreadOverrideIds);`. Apply the `mj_RoomListText_unread` class when `unread`. Render a pin glyph when `state.pinnedIds.has(id)` and a star when `state.favoriteIds.has(id)` (frontend-design placement). Replace the numeric badge block so an override-only row renders a dot instead of a count:

```tsx
{conversation.unread_count > 0 ? (
    <span className="mj_UnreadBadge" aria-label={`${conversation.unread_count} unread`}>
        {conversation.unread_count}
    </span>
) : overrideUnread ? (
    <span className="mj_UnreadDot" aria-label="Marked unread" />
) : null}
```

- [ ] **Step 5: Add CSS** in `journal.pcss` (alongside `.mj_UnreadBadge`):

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
    color: var(--cpd-color-icon-tertiary);
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

- [ ] **Step 1: Write the failing tests**

```ts
it("renders All + Favorites buttons with aria-pressed tracking the active view", () => { /* ... */ });
it("Favorites tab filters to favorited rows and hides the archived section", () => { /* ... */ });
it("shows the empty-favorites state when no favorites exist", () => { /* assert "No favorite conversations yet." */ });
it("switching tabs leaves selectedConversationId unchanged when the selected row is filtered out", () => { /* ... */ });
it("clicking Favorites sets its aria-pressed=true, filters the list, and leaves focus on the button", () => { /* ... */ });
```

- [ ] **Step 2: Verify failure**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- components-test -t "All + Favorites buttons"`
Expected: FAIL.

- [ ] **Step 3: Add tab state + filter.** Near line 254 add `const [tab, setTab] = useState<"all" | "favorites">("all");`. After computing the pin-sorted `active` (T-3.3), derive the visible list:

```tsx
const visibleActive = tab === "favorites" ? active.filter((c) => state.favoriteIds.has(c.id)) : active;
```

Render `visibleActive` in the `.mj_RoomList` map instead of `active`. Gate the Archived section render on `tab === "all"`. Extend `hasActiveUnread` (line 384) to use `effectiveUnread(conversation, state.unreadOverrideIds)`.

- [ ] **Step 4: Render the segmented control** (above `.mx_RoomListSearch`, ~line 564), honoring the fixed a11y contract:

```tsx
<div className="mj_RoomListTabs" aria-label="Filter conversations">
    <button type="button" className={`mj_RoomListTab${tab === "all" ? " mj_RoomListTab_active" : ""}`}
        aria-pressed={tab === "all"} onClick={() => setTab("all")}>All</button>
    <button type="button" className={`mj_RoomListTab${tab === "favorites" ? " mj_RoomListTab_active" : ""}`}
        aria-pressed={tab === "favorites"} onClick={() => setTab("favorites")}>Favorites</button>
</div>
```

Add the empty-favorites state in the room-list body: when `tab === "favorites" && !visibleActive.length`, render `<p className="mj_RoomListEmpty">No favorite conversations yet.</p>`.

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
    border-radius: var(--cpd-radius-pill, 9999px);
    background: transparent;
    color: var(--cpd-color-text-secondary);
    cursor: pointer;
    padding: var(--cpd-space-1x) var(--cpd-space-3x);
    font: var(--cpd-font-body-sm-medium);
}
.mj_RoomListTab_active {
    background: var(--cpd-color-bg-subtle-primary);
    color: var(--cpd-color-text-primary);
}
.mj_RoomListTab:focus-visible {
    outline: 2px solid var(--cpd-color-border-focused);
}
```

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

### T-4.1: `ConversationList` render-test scaffolding + remaining interaction tests

**Files:**
- Modify: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: everything above. Establishes the shared `createRoot`/`act` harness that renders `<ConversationList client={fakeClient} state={state} width={280} />` and a `fakeClient` stub whose `pin/favorite/markUnread/markConversationRead/markAllRead/selectConversation` record calls.

- [ ] **Step 1: Build the render harness** (a helper `renderList(state, client)` using `react-dom/client` `createRoot` inside `act`, mounting into a jsdom container; teardown unmounts). Cover any interaction tests not already written in Phase 3: M1 unfavorite-while-selected keeps `selectedConversationId`; tab-switch keeps selection; menu keyboard nav still works (arrow keys over the enlarged item set); long-press/right-click still open the menu.

- [ ] **Step 2: Run the full components suite**

Run: `cd /opt/matron/web-journal-wt-session-controls && corepack pnpm test -- components-test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /opt/matron/web-journal-wt-session-controls && corepack pnpm lint:fix
git -C /opt/matron/web-journal-wt-session-controls add test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "test(session-controls): ConversationList render harness + interaction coverage

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

- [ ] **Step 4: Final commit (if lint:fix changed anything)**

```bash
git -C /opt/matron/web-journal-wt-session-controls add -A
git -C /opt/matron/web-journal-wt-session-controls -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "chore(session-controls): lint/format pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" || echo "nothing to commit"
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
