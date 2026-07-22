# Timeline Event-Row Menu, View Source, Composer Drafts & Double-Send Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a timeline event-row context menu (Copy / View source) with a scrollable event-DTO source sheet (#476), per-conversation composer draft persistence (#471), and a rapid-Enter double-send guard (#478) to the Matron journal web client.

**Architecture:** Two new per-feature modules (`context-menu.ts` headless menu hook, `composer-drafts.ts` in-memory-authoritative draft store) plus in-place edits to `components.tsx` (menu/sheet/composer wiring, shared `copyText` helper) and a small bug-fix to `client.ts` `sendMessage` (explicit target convo + outbox-authoritative). Dan's shipped room-list menu is untouched; no monolith split (#448).

**Tech Stack:** React 19 (`react-dom/client`), TypeScript, jest 30 + jsdom (raw `createRoot`/`act`, no `@testing-library`), webpack, PostCSS (`.pcss`). Repo: `easelyte/matron-web`, worktree `/opt/matron/web-journal-wt-composer-rows`, branch `feat/composer-rows`.

## Global Constraints

- **Do NOT split `components.tsx` / `client.ts`** — in-place edits only; new logic goes in new per-feature modules (matches `longPress.ts` / `conversation-flags.ts` / `slash-palette.ts` convention). (#448 / `project_matron_web_stays_dan_upstream_aligned`.)
- **License header** on every new source/test file (copy verbatim from any existing `src/journal/*.ts`):
  ```
  /*
  Copyright 2026 Matron Contributors.

  SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
  Please see LICENSE files in the repository root for full details.
  */
  ```
- **Constants:** `MAX_DRAFT_BYTES = 64 * 1024`; `MAX_DRAFT_ENTRIES = 50`; `DRAFT_DEBOUNCE_MS = 250`; `LONG_PRESS_MS = 500`. (No send-watchdog constant — the watchdog was removed in plan-review round 3; see T-3.2.)
- **Menu scope:** the timeline context menu attaches ONLY to `EventRow` rows (settled `JournalEvent`); never to `ToolStream` / pending placeholders.
- **No em-dashes** are irrelevant here (code/comments allowed); this is not operator-voice copy.
- **Verification gate:** `pnpm lint` (tsc + prettier) and `pnpm test` must be green before ship. Run `pnpm exec prettier --write` on touched files before each commit.
- **Deploy target:** static build `webapp/` → nginx :8082 → Tailscale :8443 (NOT the legacy Docker :8420 client). Deploy is out of plan scope (handled at ship).

**Reference:** full design at `docs/superpowers/specs/2026-07-22-web-composer-rows-and-view-source-design.md` (5-round reviewed). Every task's behavior traces to a spec section; consult it for the "why."

---

## Phase 0 — Baseline reconciliation (do FIRST)

### T-0.1: Rebase onto current origin/main + grep-confirm references

At plan-writing time `feat/composer-rows` was **14 commits behind origin/main**, and the upstream delta touches `client.ts` (~41 lines, incl. egress/upload-session guards) — the exact file T-1.3 edits. Implementing `sendMessage` against the stale base risks conflicts or silently dropping upstream guards (round-4 Maj-1). Reconcile before writing any code.

**Files:** none (git + verification only).

- [ ] **Step 1: Rebase the worktree onto current origin/main**

```bash
git -C /opt/matron/web-journal-wt-composer-rows fetch origin
git -C /opt/matron/web-journal-wt-composer-rows rebase origin/main
```
Resolve any conflicts (expected mainly in `client.ts` / `components.tsx`). If the rebase is non-trivial, pause and reconcile deliberately — do NOT force past a conflict.

- [ ] **Step 2: Re-verify `sendMessage`'s current shape** — the T-1.3 patch assumes `sendMessage(bodyInput)` awaits `addToOutbox` then `refreshSelectedConversation`. Re-read the post-rebase `client.ts:464`+ and adapt the T-1.3 diff to the reconciled code (the upstream egress guards must be **preserved**, not overwritten).

- [ ] **Step 3: Grep-confirm every symbol the plan references** (round-4 Maj-4 — verify against HEAD, don't assume):

```bash
cd /opt/matron/web-journal-wt-composer-rows/src/journal
grep -n "export function utf8Length" types.ts                    # T-1.1
grep -n "export function createLongPressController\|interface LongPressController" longPress.ts   # T-1.2
grep -n "recentFolderArgument\|parseFolderCommand\|interface RecentFoldersStore\|makeRecentFoldersStore" slash-palette.ts  # T-3.1/T-3.2
grep -n "mj_UploadConfirm_scrim\|mj_HeaderMenu\|mj_RoomItemMenu" journal.pcss   # T-2.1/T-4.1
grep -n "internals\|signedInClient\|const SESSION" ../../test/unit-tests/journal/components-test.ts  # test harness
```
Confirm each resolves; if any moved/renamed post-rebase, update the citing task before implementing it.

- [ ] **Step 4: Baseline green** — `pnpm install` (if lockfile changed) then `pnpm lint && pnpm test` on the reconciled base. Record the pass; every later task's "run tests" is relative to this baseline.

## Phase 1 — Foundation modules (leaf, no interdependencies)

`composer-drafts.ts`, `context-menu.ts` pure helpers, `client.ts` fixes, and the `copyText` helper are independent; they can be built in any order and are prerequisites for Phases 2–3. **Do Phase 0 first.**

### T-1.1: `composer-drafts.ts` — in-memory-authoritative draft store

**Files:**
- Create: `src/journal/composer-drafts.ts`
- Test: `test/unit-tests/journal/composer-drafts-test.ts`

**Interfaces:**
- Consumes: `Session` from `./types`; `utf8Length` from `./types`.
- Produces: `makeDraftStore(session: Session | undefined): DraftStore` where
  `interface DraftStore { read(convoId: string): { text: string; ok: boolean }; setDraft(convoId: string, text: string): void; persist(): void; clear(convoId: string): void; }`
  and exported consts `MAX_DRAFT_BYTES`, `MAX_DRAFT_ENTRIES`.
- **Memory/persist split (round-1 B3 fix):** `setDraft` mutates the in-memory map ONLY (cheap, synchronous — safe to call every keystroke); `persist()` serializes the whole map to localStorage (the expensive `JSON.stringify` + `setItem`, best-effort). The Composer calls `setDraft` on every edit and **debounces `persist()`** so localStorage is written at most once per ~250 ms. `clear` deletes from memory then persists immediately. This makes the debounce real (memory always current for navigation-safety; localStorage coalesced). A single debounce timer is correct because `persist()` writes the *whole* map — there is no per-convo timer to race.
- **Memory holds oversized drafts too (round-2 B2 / round-3 minor):** the in-memory map keeps every draft including `> MAX_DRAFT_BYTES` ones (so navigating away and back never loses live text); `persist()` omits oversized entries from the localStorage mirror only. Consequence (deliberate tradeoff): `MAX_DRAFT_ENTRIES` (50) bounds the *number* of in-memory drafts, not each entry's byte size — up to 50 large pasted drafts can coexist in memory. Accepted for a single-user local tool (data-loss risk beats unbounded-growth risk; entry count is still capped).

- [ ] **Step 1: Write the failing test file** (`composer-drafts-test.ts`)

```ts
/* <license header> */
import { makeDraftStore, MAX_DRAFT_BYTES } from "../../../src/journal/composer-drafts";
import type { Session } from "../../../src/journal/types";

const SESSION: Session = { serverUrl: "https://j.example", token: "t", deviceId: 1, userId: 2, username: "u" };
const KEY = `matron:draft:v1:${encodeURIComponent(SESSION.serverUrl)}:${SESSION.userId}`;

beforeEach(() => localStorage.clear());

test("setDraft updates memory but does NOT touch localStorage; persist writes it", () => {
    const s = makeDraftStore(SESSION);
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    s.setDraft("c1", "hello");
    expect(s.read("c1")).toEqual({ text: "hello", ok: true });
    expect(setItem).not.toHaveBeenCalled();            // memory-only
    s.persist();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ c1: "hello" });
    setItem.mockRestore();
});

test("undefined session is a full no-op, read ok:true empty", () => {
    const s = makeDraftStore(undefined);
    s.setDraft("c1", "x");
    s.persist();
    expect(s.read("c1")).toEqual({ text: "", ok: true });
});

test("empty text prunes the entry", () => {
    const s = makeDraftStore(SESSION);
    s.setDraft("c1", "hi");
    s.setDraft("c1", "   ");
    s.persist();
    expect(s.read("c1").text).toBe("");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({});
});

test("in-memory map survives a throwing setItem (navigation-safe)", () => {
    const s = makeDraftStore(SESSION);
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    s.setDraft("c1", "kept");
    expect(() => s.persist()).not.toThrow();
    expect(s.read("c1")).toEqual({ text: "kept", ok: true }); // memory-first, unaffected by persist failure
    spy.mockRestore();
});

test("fresh store reads a valid localStorage blob (reload path)", () => {
    localStorage.setItem(KEY, JSON.stringify({ c1: "restored" }));
    expect(makeDraftStore(SESSION).read("c1")).toEqual({ text: "restored", ok: true });
});

test("wrong-shape valid JSON: bad value dropped, string siblings survive", () => {
    localStorage.setItem(KEY, JSON.stringify({ c1: 7, c2: "ok" }));
    const s = makeDraftStore(SESSION);
    expect(s.read("c1")).toEqual({ text: "", ok: true });
    expect(s.read("c2")).toEqual({ text: "ok", ok: true });
});

test("array/null top-level treated as empty map", () => {
    localStorage.setItem(KEY, JSON.stringify([1, 2]));
    expect(makeDraftStore(SESSION).read("c1")).toEqual({ text: "", ok: true });
});

test("unparseable JSON reads empty and next persist resets the blob", () => {
    localStorage.setItem(KEY, "{not json");
    const s = makeDraftStore(SESSION);
    expect(s.read("c1")).toEqual({ text: "", ok: true });
    s.setDraft("c2", "new");
    s.persist();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ c2: "new" });
});

test("throwing getItem on a memory-miss read returns ok:false", () => {
    const s = makeDraftStore(SESSION);
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(s.read("never-written")).toEqual({ text: "", ok: false });
    spy.mockRestore();
});

test("oversized draft stays in memory (navigation-safe) but is omitted from localStorage", () => {
    const s = makeDraftStore(SESSION);
    const big = "x".repeat(MAX_DRAFT_BYTES + 1);
    s.setDraft("c1", big);
    s.setDraft("c2", "small");
    expect(s.read("c1").text).toBe(big);          // memory keeps it → navigation-safe
    s.persist();
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.c1).toBeUndefined();            // oversized omitted from the reload mirror
    expect(stored.c2).toBe("small");              // normal entry persisted
});

test("per-session key isolation", () => {
    const a = makeDraftStore(SESSION); a.setDraft("c1", "a"); a.persist();
    const other: Session = { ...SESSION, userId: 99 };
    expect(makeDraftStore(other).read("c1").text).toBe("");
});

test("entry cap evicts by recency (re-write refreshes position)", () => {
    const s = makeDraftStore(SESSION);
    for (let i = 0; i < 50; i++) s.setDraft(`k${i}`, `v${i}`);
    s.setDraft("k0", "refreshed");     // k0 becomes most-recent
    s.setDraft("k50", "new");          // triggers eviction of the now-oldest (k1)
    expect(s.read("k0").text).toBe("refreshed");
    expect(s.read("k1").text).toBe("");
});

test("hydration from a >50-entry blob is capped to MAX_DRAFT_ENTRIES", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 60; i++) big[`k${i}`] = `v${i}`;
    localStorage.setItem(KEY, JSON.stringify(big));
    const s = makeDraftStore(SESSION);
    s.read("k59"); // force hydrate
    // oldest evicted: k0..k9 gone, newest 50 kept
    expect(s.read("k0").text).toBe("");
    expect(s.read("k59").text).toBe("v59");
});

test("clear removes the entry from memory and persists immediately", () => {
    const s = makeDraftStore(SESSION);
    s.setDraft("c1", "x"); s.persist();
    s.clear("c1");
    expect(s.read("c1").text).toBe("");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec jest composer-drafts-test -i`
Expected: FAIL — cannot find module `composer-drafts`.

- [ ] **Step 3: Implement `composer-drafts.ts`**

```ts
/* <license header> */
import type { Session } from "./types";
import { utf8Length } from "./types";

export const MAX_DRAFT_BYTES = 64 * 1024;
export const MAX_DRAFT_ENTRIES = 50;

export interface DraftStore {
    read(convoId: string): { text: string; ok: boolean };
    setDraft(convoId: string, text: string): void; // in-memory only
    persist(): void;                                 // serialize whole map → localStorage (best-effort)
    clear(convoId: string): void;                    // memory delete + persist
}

const NOOP: DraftStore = {
    read: () => ({ text: "", ok: true }),
    setDraft: () => undefined,
    persist: () => undefined,
    clear: () => undefined,
};

function parseMap(raw: string | null): Record<string, string> {
    if (raw === null) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn("matron: malformed draft store, resetting");
        return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
    }
    return out;
}

export function makeDraftStore(session: Session | undefined): DraftStore {
    if (!session) return NOOP;
    // Versioned key (round-2 M3) so a future shape change gets a fresh namespace, not a silent
    // reinterpret of v1 blobs. Bump to :v2: with an explicit migration/fallback when the shape changes.
    const key = `matron:draft:v1:${encodeURIComponent(session.serverUrl)}:${session.userId}`;
    // In-memory map is session-authoritative (holds EVERYTHING, incl. oversized — navigation-safe);
    // localStorage is a best-effort reload mirror that omits oversized entries.
    const mem = new Map<string, string>();
    let hydrated = false;

    const hydrate = (): boolean => {
        // Returns ok=false only on a storage EXCEPTION; a malformed/absent blob is ok=true (empty).
        try {
            const map = parseMap(localStorage.getItem(key));
            for (const [k, v] of Object.entries(map)) if (!mem.has(k)) mem.set(k, v);
            // Enforce the entry cap on hydration too (round-4 Maj-2): a persisted blob with >50 entries
            // (manual edit / older build) must not exceed MAX_DRAFT_ENTRIES. Evict oldest (insertion order).
            while (mem.size > MAX_DRAFT_ENTRIES) mem.delete(mem.keys().next().value as string);
            hydrated = true;
            return true;
        } catch {
            console.warn("matron: draft read failed (storage unavailable)");
            return false;
        }
    };

    const persist = (): void => {
        try {
            // Mirror memory to localStorage, OMITTING oversized entries (round-2 B2): oversized text
            // stays live in memory (navigation-safe) but must not bloat the reload blob — it simply
            // won't survive a reload. Normal entries persist.
            const out: Record<string, string> = {};
            for (const [k, v] of mem) if (utf8Length(v) <= MAX_DRAFT_BYTES) out[k] = v;
            localStorage.setItem(key, JSON.stringify(out));
        } catch {
            console.warn("matron: draft persist failed (storage full/unavailable)");
        }
    };

    return {
        read(convoId) {
            if (mem.has(convoId)) return { text: mem.get(convoId)!, ok: true };
            if (!hydrated) {
                const ok = hydrate();
                if (!ok) return { text: "", ok: false };
            }
            return { text: mem.get(convoId) ?? "", ok: true };
        },
        setDraft(convoId, text) {
            if (!hydrated) hydrate();
            mem.delete(convoId); // delete-then-reinsert → recency ordering
            if (text.trim() !== "") {
                mem.set(convoId, text); // memory holds EVERYTHING incl. oversized (navigation-safe)
                while (mem.size > MAX_DRAFT_ENTRIES) {
                    const oldest = mem.keys().next().value as string;
                    mem.delete(oldest);
                }
            }
            // NO persist here — memory only; the Composer debounces persist(). Oversized entries are
            // filtered out at persist() time, not dropped from memory.
        },
        persist,
        clear(convoId) {
            if (!hydrated) hydrate();
            mem.delete(convoId);
            persist();
        },
    };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec jest composer-drafts-test -i` → Expected: PASS (all cases).

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/composer-drafts.ts test/unit-tests/journal/composer-drafts-test.ts
git add src/journal/composer-drafts.ts test/unit-tests/journal/composer-drafts-test.ts
git commit -m "feat(composer): in-memory-authoritative per-conversation draft store (#471)"
```

### T-1.2: `context-menu.ts` — headless row context-menu hook + pure helpers

**Files:**
- Create: `src/journal/context-menu.ts`
- Test: `test/unit-tests/journal/context-menu-test.ts`

**Interfaces:**
- Consumes: `createLongPressController` from `./longPress`.
- Produces:
  - pure helpers `clampToViewport(left, top, width, height, vw, vh): { left: number; top: number }` and `nextMenuIndex(current: number, delta: 1 | -1, count: number): number` (exported for direct unit test);
  - hook `useRowContextMenu<T>(opts?: { longPressMs?: number }): RowContextMenu<T>` where
    `interface RowContextMenu<T> { state: { target: T; left: number; top: number } | undefined; menuRef: React.RefObject<HTMLDivElement>; open(target: T, left: number, top: number, opener: HTMLElement | null): void; close(restoreFocus?: boolean): void; rowHandlers(target: T, getRow: () => HTMLElement): { onContextMenu; onPointerDown; onPointerMove; onPointerUp; onPointerCancel }; menuKeyDown(e: React.KeyboardEvent): void; }`.

> **Test note:** the repo has no hook-testing library. Unit-test the **pure helpers** here; the hook's stateful wiring (open on right-click / long-press, close on switch, keyboard nav) is covered by rendering `EventRow` in `components-test.ts` (T-2.1). This mirrors how `longPress-test.ts` tests the pure controller while its wiring is exercised elsewhere.

- [ ] **Step 1: Write the failing test** (`context-menu-test.ts`)

```ts
/* <license header> */
import { clampToViewport, nextMenuIndex } from "../../../src/journal/context-menu";

test("clamp keeps an in-bounds menu unchanged", () => {
    expect(clampToViewport(100, 100, 200, 150, 1000, 800)).toEqual({ left: 100, top: 100 });
});
test("clamp pulls a right/bottom overflow inside with 8px margin", () => {
    expect(clampToViewport(950, 780, 200, 150, 1000, 800)).toEqual({ left: 1000 - 200 - 8, top: 800 - 150 - 8 });
});
test("clamp floors at 8px on the top/left", () => {
    expect(clampToViewport(-50, -50, 100, 100, 1000, 800)).toEqual({ left: 8, top: 8 });
});
test("nextMenuIndex cycles forward and wraps", () => {
    expect(nextMenuIndex(-1, 1, 3)).toBe(0);
    expect(nextMenuIndex(2, 1, 3)).toBe(0);
});
test("nextMenuIndex cycles backward and wraps", () => {
    expect(nextMenuIndex(-1, -1, 3)).toBe(2);
    expect(nextMenuIndex(0, -1, 3)).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec jest context-menu-test -i` → FAIL (module missing).

- [ ] **Step 3: Implement `context-menu.ts`** (pure helpers + hook)

```ts
/* <license header> */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createLongPressController, type LongPressController } from "./longPress";

const MARGIN = 8;

export function clampToViewport(left: number, top: number, width: number, height: number, vw: number, vh: number) {
    return {
        left: Math.max(MARGIN, Math.min(left, vw - width - MARGIN)),
        top: Math.max(MARGIN, Math.min(top, vh - height - MARGIN)),
    };
}

export function nextMenuIndex(current: number, delta: 1 | -1, count: number): number {
    if (count === 0) return -1;
    if (current === -1) return delta === 1 ? 0 : count - 1;
    return (current + delta + count) % count;
}

export interface RowContextMenu<T> {
    state: { target: T; left: number; top: number } | undefined;
    menuRef: React.RefObject<HTMLDivElement | null>;
    open(target: T, left: number, top: number, opener: HTMLElement | null): void;
    close(restoreFocus?: boolean): void;
    rowHandlers(target: T, getRow: () => HTMLElement): {
        onContextMenu(e: React.MouseEvent): void;
        onPointerDown(e: React.PointerEvent): void;
        onPointerMove(e: React.PointerEvent): void;
        onPointerUp(e: React.PointerEvent): void;
        onPointerCancel(e: React.PointerEvent): void;
    };
    menuKeyDown(e: React.KeyboardEvent): void;
    didFireRef: React.MutableRefObject<boolean>;
}

export function useRowContextMenu<T>(opts?: { longPressMs?: number }): RowContextMenu<T> {
    const [state, setState] = useState<{ target: T; left: number; top: number }>();
    const stateRef = useRef(state);
    stateRef.current = state;
    const menuRef = useRef<HTMLDivElement | null>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    const didFireRef = useRef(false);
    const pressTargetRef = useRef<{ target: T; getRow: () => HTMLElement } | undefined>(undefined);
    const controllerRef = useRef<LongPressController | undefined>(undefined);
    const pressScrollCleanupRef = useRef<() => void>(() => undefined); // cancels a PENDING press on scroll

    const open = useCallback((target: T, left: number, top: number, opener: HTMLElement | null) => {
        openerRef.current = opener;
        setState({ target, left, top });
    }, []);
    const close = useCallback((restoreFocus = false) => {
        if (!stateRef.current) return;
        setState(undefined);
        if (restoreFocus) openerRef.current?.focus();
    }, []);

    if (!controllerRef.current) {
        controllerRef.current = createLongPressController({
            delayMs: opts?.longPressMs ?? 500,
            onFire: () => {
                pressScrollCleanupRef.current();
                const p = pressTargetRef.current;
                if (!p) return;
                didFireRef.current = true;
                const rect = p.getRow().getBoundingClientRect();
                open(p.target, rect.right, rect.top, p.getRow());
            },
        });
    }

    // Outside-click / Escape / scroll close — scoped to menuRef.
    useEffect(() => {
        if (!state) return;
        const onDown = (e: PointerEvent) => {
            if (menuRef.current?.contains(e.target as Node)) return;
            close();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(true); };
        const onScroll = () => close();
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        document.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("scroll", onScroll, true);
        };
    }, [Boolean(state), close]);

    // Viewport clamp + focus first item.
    useLayoutEffect(() => {
        if (!state || !menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        const c = clampToViewport(state.left, state.top, rect.width, rect.height, window.innerWidth, window.innerHeight);
        if (c.left !== state.left || c.top !== state.top) setState({ ...state, left: c.left, top: c.top });
        menuRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [state]);

    useEffect(() => () => { controllerRef.current?.onPointerCancel(); pressScrollCleanupRef.current(); }, []);

    const rowHandlers = useCallback((target: T, getRow: () => HTMLElement) => ({
        onContextMenu(e: React.MouseEvent) {
            e.preventDefault();
            const keyboard = e.clientX === 0 && e.clientY === 0;
            const rect = getRow().getBoundingClientRect();
            if (keyboard) open(target, rect.right, rect.bottom, getRow());
            else open(target, e.clientX, e.clientY, getRow());
        },
        onPointerDown(e: React.PointerEvent) {
            if (e.pointerType !== "touch") return;
            didFireRef.current = false;
            pressTargetRef.current = { target, getRow };
            controllerRef.current?.onPointerDown(e.clientX, e.clientY);
            // Cancel a still-PENDING press on any scroll during the 500ms window (mirrors HEAD's
            // room-menu press-scroll cleanup, components.tsx:340). The menu-open scroll-close effect
            // only exists AFTER the menu opens; this covers the pre-open window.
            pressScrollCleanupRef.current();
            const onScroll = () => { controllerRef.current?.onPointerCancel(); pressScrollCleanupRef.current(); };
            document.addEventListener("scroll", onScroll, true);
            pressScrollCleanupRef.current = () => {
                document.removeEventListener("scroll", onScroll, true);
                pressScrollCleanupRef.current = () => undefined;
            };
        },
        onPointerMove(e: React.PointerEvent) {
            if (e.pointerType !== "touch") return;
            controllerRef.current?.onPointerMove(e.clientX, e.clientY);
        },
        onPointerUp(e: React.PointerEvent) {
            if (e.pointerType !== "touch") return;
            controllerRef.current?.onPointerUp();
            pressScrollCleanupRef.current();
        },
        onPointerCancel(e: React.PointerEvent) {
            if (e.pointerType === "touch") { controllerRef.current?.onPointerCancel(); pressScrollCleanupRef.current(); }
        },
    }), [open]);

    const menuKeyDown = useCallback((e: React.KeyboardEvent) => {
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
        const idx = items.findIndex((i) => i === document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            items[nextMenuIndex(idx, e.key === "ArrowDown" ? 1 : -1, items.length)]?.focus();
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            items[idx]?.click();
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close(true);
        }
    }, [close]);

    return { state, menuRef, open, close, rowHandlers, menuKeyDown, didFireRef };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest context-menu-test -i` → PASS. Then `pnpm exec tsc --noEmit` → no type errors.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/context-menu.ts test/unit-tests/journal/context-menu-test.ts
git add src/journal/context-menu.ts test/unit-tests/journal/context-menu-test.ts
git commit -m "feat(timeline): headless useRowContextMenu hook + pure helpers (#471/#476)"
```

### T-1.3: `client.ts` — explicit send target + outbox-authoritative

**Files:**
- Modify: `src/journal/client.ts` (`sendMessage`, ~L464–482)
- Test: `test/unit-tests/journal/client-test.ts` (add cases)

**Interfaces:**
- Produces: `sendMessage(bodyInput: string, targetConvoId?: string): Promise<boolean>` — `targetConvoId` defaults to `this.state.selectedConversationId`; resolves `true` once `addToOutbox` succeeds even if the subsequent refresh throws.

- [ ] **Step 1: Write failing tests** (append to `client-test.ts`) — inspect the existing harness (`fakeDatabase`, `jest.fn()` stubs) first and reuse it.

```ts
test("sendMessage enqueues under an explicit targetConvoId, not selectedConversationId", async () => {
    const { client, db } = makeClientWithConvos(["a", "b"]); // existing helper pattern; selected = "a"
    await client.selectConversation("a");
    await client.sendMessage("hi", "b");
    expect(db.addToOutbox).toHaveBeenCalledWith(expect.objectContaining({ convoId: "b", body: "hi" }));
});

test("sendMessage resolves true when refresh throws after addToOutbox (outbox-authoritative)", async () => {
    const { client, db } = makeClientWithConvos(["a"]);
    await client.selectConversation("a");
    jest.spyOn(client as any, "refreshSelectedConversation").mockRejectedValueOnce(new Error("db read failed"));
    await expect(client.sendMessage("hi")).resolves.toBe(true);
    expect(db.addToOutbox).toHaveBeenCalledTimes(1);
});

test("sendMessage resolves without awaiting a hung refresh (refresh off the critical path)", async () => {
    const { client, db } = makeClientWithConvos(["a"]);
    await client.selectConversation("a");
    jest.spyOn(client as any, "refreshSelectedConversation").mockReturnValue(new Promise(() => {})); // never settles
    await expect(client.sendMessage("hi")).resolves.toBe(true);   // does NOT hang
    expect(db.addToOutbox).toHaveBeenCalledTimes(1);
});

test("default targetConvoId preserves the no-arg call behavior", async () => {
    const { client, db } = makeClientWithConvos(["a"]);
    await client.selectConversation("a");
    await client.sendMessage("hi");
    expect(db.addToOutbox).toHaveBeenCalledWith(expect.objectContaining({ convoId: "a" }));
});
```

> If a `makeClientWithConvos` helper doesn't already exist, build the client the same way the existing `client-test.ts` cases do (construct `MatronJournalClient`, inject `state.database`, seed conversations). Keep the assertion shape; adapt the setup to the existing harness.

- [ ] **Step 2: Run to verify it fails** — `pnpm exec jest client-test -i -t "targetConvoId"` → FAIL.

- [ ] **Step 3: Modify `sendMessage`** (`client.ts` ~L464)

```ts
public async sendMessage(bodyInput: string, targetConvoId?: string): Promise<boolean> {
    const body = bodyInput.trim();
    const conversationId = targetConvoId ?? this.state.selectedConversationId;
    if (!body || !conversationId || !this.database) return false;
    if (this.isChildConvo(conversationId)) return false;
    const message: PendingMessage = {
        localId: crypto.randomUUID(),
        convoId: conversationId,
        body,
        createdAt: Date.now(),
    };
    await this.database.addToOutbox(message); // the ONLY awaited durable step
    // Everything after the durable write is BEST-EFFORT and must never reject sendMessage or
    // delay its resolution — otherwise the composer stays retry-able into a duplicate durable
    // message (no server idempotency), and a hung refresh could wedge the send lock past the
    // watchdog (round-2 B1/M2). sendMessage resolves `true` the instant the outbox write lands.
    void (async () => {
        try {
            await this.refreshSelectedConversation(conversationId);
            if (this.state.selectedConversationId === conversationId) {
                this.patch({ sendTick: this.state.sendTick + 1 });
            }
        } catch (err) {
            console.warn("matron: post-send refresh failed (message still queued)", err);
        }
    })();
    try {
        this.sendPendingMessage(message);
    } catch (err) {
        console.warn("matron: post-send dispatch threw (message still queued)", err);
    }
    return true;
}
```

> **Why refresh moves off the awaited path (round-2 B1 + M2):** the durable `addToOutbox` is the only thing `sendMessage` waits on. A hung or throwing `refreshSelectedConversation` (or a throwing `sendPendingMessage`) can no longer reject `sendMessage` or hold the send lock open — so the watchdog only ever fires when `addToOutbox` itself hangs (message NOT queued → retry is safe). The pending row still appears (refresh runs, just un-awaited); on the rare refresh-throw it self-heals on the next refresh/echo.

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest client-test -i` → PASS (new + existing cases). `pnpm exec tsc --noEmit` clean.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/client.ts test/unit-tests/journal/client-test.ts
git add src/journal/client.ts test/unit-tests/journal/client-test.ts
git commit -m "fix(client): explicit sendMessage target + outbox-authoritative (#478)"
```

### T-1.4: shared `copyText` async clipboard helper

**Files:**
- Modify: `src/journal/components.tsx` (add near the top-level helpers, exported for test)
- Test: `test/unit-tests/journal/components-test.ts` (add a focused case)

**Interfaces:**
- Produces: `export async function copyText(text: string): Promise<boolean>` — awaits `navigator.clipboard.writeText`, falls back to a hidden-`<textarea>` `document.execCommand("copy")`; returns `true` on success, `false` if both paths fail (round-2 B3: an explicit result lets a caller react). Never throws, never leaks an unhandled rejection, and always removes the temp textarea (via `finally`, even if `execCommand` throws).

> **Note (round-2 B3 / round-3 M2):** the journal web client is served over **HTTPS** (`:8443` Tailscale) — a secure context — so `navigator.clipboard` is present. HTTPS is necessary but not strictly sufficient (the Clipboard API still runs a permission check and can reject with `NotAllowedError`), but every Copy here is invoked by a direct user click (a user gesture), under which `writeText` is granted in practice; the `execCommand` fallback + `false` return cover the residual edge. A visible copy-failure toast is deemed unnecessary for this local single-user tool — the boolean return is the accepted surface. Callers (`void copyText(...)`) intentionally don't block on it; wiring visible failure feedback is a documented follow-up if the edge ever proves real.

- [ ] **Step 1: Write the failing test** (append to `components-test.ts`)

```ts
import { copyText } from "../../../src/journal/components";

test("copyText awaits clipboard and returns true", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
});

test("copyText falls back to execCommand on rejection and returns true", async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error("denied")) } });
    const exec = jest.fn().mockReturnValue(true);
    (document as any).execCommand = exec;
    await expect(copyText("hello")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelectorAll("textarea").length).toBe(0); // temp textarea cleaned up
});

test("copyText returns false when both paths fail, without throwing, and cleans up the textarea", async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error("x")) } });
    (document as any).execCommand = jest.fn(() => { throw new Error("nope"); });
    await expect(copyText("hello")).resolves.toBe(false);
    expect(document.querySelectorAll("textarea").length).toBe(0); // cleaned up despite the throw
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec jest components-test -i -t copyText` → FAIL (export missing).

- [ ] **Step 3: Implement `copyText`** in `components.tsx`

```tsx
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through to execCommand */
    }
    const ta = document.createElement("textarea");
    try {
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        return document.execCommand("copy"); // true on success
    } catch {
        return false; // best-effort — never throws into the UI
    } finally {
        ta.remove(); // always clean up, even if execCommand threw
    }
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest components-test -i -t copyText` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/components.tsx test/unit-tests/journal/components-test.ts
git add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git commit -m "feat(timeline): shared async copyText clipboard helper (#471/#476)"
```

---

## Phase 2 — Timeline menu + View Source (#471 Part A + #476)

Depends on Phase 1 (`useRowContextMenu`, `copyText`). Independent of Phase 3.

> **Test-harness note (applies to every `components-test.ts` case in Phases 2–3):** the render helpers must set `internals(client).database = {...}` (the existing pattern at `components-test.ts:~698` / `~895`) BEFORE driving `client.selectConversation(...)` — otherwise `selectConversation` early-returns on the `if (!this.database ...)` guard (`client.ts:331`) and every cross-conversation assertion silently "passes" for the wrong reason (nothing switched). Reuse the existing seeded-client helper; don't hand-roll a bare client.

### T-2.1: Event-row context menu + View Source sheet (atomic)

Merged (round-1 B2): the menu and the sheet are interdependent (the menu's "View source" sets the sheet state), so they land as **one atomic task with one commit** — no intermediate red-test handoff between per-task workers.

**Files:**
- Modify: `src/journal/components.tsx` (add `EventSourceSheet` beside `UploadConfirmDialog`; add `sourceEvent` state + `useRowContextMenu` + menu render in `Timeline`; add `rowHandlers` to `EventRow`)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: `useRowContextMenu<JournalEvent>` (T-1.2), `copyText` (T-1.4), `JournalEvent`/`asString` from `./types`.
- Produces: `function EventSourceSheet({ event, onClose }: { event: JournalEvent; onClose: () => void }): React.ReactElement`; an `mj_HeaderMenu mj_EventRowMenu` rendered by `Timeline`; `rowHandlers` spread onto each `EventRow` `<li>` (via a single new `EventRow` prop `rowHandlers` — `didFireRef` stays internal to the hook, round-3 M3).

- [ ] **Step 1: Write failing tests** — add local helpers `renderAppWithEvents(events, convoIds?)`, `openRowMenu(container, seq)` (dispatch a `contextmenu` on the `[data-event-id="<seq>"]` `<li>` inside `act`), `clickMenuItem(container, label)`, `clickButton(container, label)`, `rightClick(node)` (all wrap `dispatchEvent`/`click` in `act`). Follow the seeded-client harness note above.

```ts
test("right-click a text EventRow opens a menu with Copy and View source", async () => {
    const { container } = renderAppWithEvents([textEvent(5, "hi")]);
    await openRowMenu(container, 5);
    const items = [...container.querySelectorAll('.mj_EventRowMenu [role="menuitem"]')].map((n) => n.textContent);
    expect(items).toEqual(["Copy", "View source"]);
});
test("a non-text event hides Copy, keeps View source", async () => {
    const { container } = renderAppWithEvents([{ seq: 6, convo_id: "c1", ts: 1, sender: "agent", type: "diff", payload: {} }]);
    await openRowMenu(container, 6);
    expect([...container.querySelectorAll('.mj_EventRowMenu [role="menuitem"]')].map((n) => n.textContent)).toEqual(["View source"]);
});
test("a ToolStream / pending placeholder row has no menu on right-click", async () => {
    const { container } = renderAppWithToolStream();
    const row = container.querySelector(".mj_LiveTool")!.closest("li")!;
    await rightClick(row);
    expect(container.querySelector(".mj_EventRowMenu")).toBeNull();
});
test("Copy on a text row calls the clipboard with the body", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = renderAppWithEvents([textEvent(5, "hello")]);
    await openRowMenu(container, 5);
    await clickMenuItem(container, "Copy");
    expect(writeText).toHaveBeenCalledWith("hello");
});
test("View source shows the event DTO JSON; Copy button, Done, Esc, and backdrop all close", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = renderAppWithEvents([textEvent(5, "hi")]);
    await openRowMenu(container, 5);
    await clickMenuItem(container, "View source");
    const pre = container.querySelector(".mj_EventSource_json")!;
    expect(pre.textContent).toContain('"seq": 5');
    expect(pre.textContent).toContain('"body": "hi"');
    await clickButton(container, "Copy");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"seq": 5'));
    await clickButton(container, "Done");
    expect(container.querySelector(".mj_EventSource")).toBeNull();
    // Esc close
    await openRowMenu(container, 5); await clickMenuItem(container, "View source");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".mj_EventSource")).toBeNull();
    // backdrop close (click the scrim, not the panel which stops propagation)
    await openRowMenu(container, 5); await clickMenuItem(container, "View source");
    await act(async () => { (container.querySelector(".mj_EventSource_scrim") as HTMLElement).click(); });
    expect(container.querySelector(".mj_EventSource")).toBeNull();
});
test("long-press opens the menu; a scroll during the press cancels it", async () => {
    jest.useFakeTimers();
    const { container } = renderAppWithEvents([textEvent(5, "hi")]);
    const li = container.querySelector('[data-event-id="5"]') as HTMLElement;
    // press then scroll before 500ms → no menu
    await touchPress(li); await act(async () => { document.dispatchEvent(new Event("scroll", { bubbles: true })); jest.advanceTimersByTime(500); });
    expect(container.querySelector(".mj_EventRowMenu")).toBeNull();
    // press, hold 500ms → menu opens
    await touchPress(li); await act(async () => { jest.advanceTimersByTime(500); });
    expect(container.querySelector(".mj_EventRowMenu")).not.toBeNull();
    jest.useRealTimers();
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec jest components-test -i -t "EventRow|View source|long-press"` → FAIL.

- [ ] **Step 3: Implement `EventSourceSheet`, the hook wiring, and the menu**

```tsx
function EventSourceSheet({ event, onClose }: { event: JournalEvent; onClose: () => void }): React.ReactElement {
    const doneRef = useRef<HTMLButtonElement>(null);
    // Focus-restore (round-4 M3): capture the element focused when the sheet opened (the row/menuitem),
    // focus Done on open, and restore focus on close so keyboard focus never falls through to <body>.
    const restoreRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        restoreRef.current = document.activeElement as HTMLElement | null;
        doneRef.current?.focus();
        return () => { if (restoreRef.current?.isConnected) restoreRef.current.focus(); };
    }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    const json = JSON.stringify(event, null, 2);
    // Reuse the established dialog scrim/panel structure (mirrors UploadConfirmDialog's
    // `mj_UploadConfirm_scrim` + panel at components.tsx:2203; styled in journal.pcss by T-4.1).
    return (
        <div className="mj_EventSource_scrim" role="dialog" aria-modal="true" aria-label="Event source" onClick={onClose}>
            <div className="mj_EventSource" onClick={(e) => e.stopPropagation()}>
                <header className="mj_EventSource_header"><h2>Event source</h2></header>
                <pre className="mj_EventSource_json">{json}</pre>
                <div className="mj_EventSource_actions">
                    <button type="button" onClick={() => void copyText(json)}>Copy</button>
                    <button type="button" ref={doneRef} onClick={onClose}>Done</button>
                </div>
            </div>
        </div>
    );
}
```
In `Timeline`: `const [sourceEvent, setSourceEvent] = useState<JournalEvent | undefined>();` and `const menu = useRowContextMenu<JournalEvent>();`. Pass `rowHandlers={menu.rowHandlers}` to each `EventRow`. In `EventRow`, add a single prop `rowHandlers` (do NOT add `didFireRef` — it stays internal to the hook; the `<li>` has no `onClick` to suppress, round-3 M3) and:
```tsx
const liRef = useRef<HTMLLIElement>(null);
const handlers = rowHandlers(event, () => liRef.current!);
// <li ref={liRef} ...existing... {...handlers}>
```
`ToolStream` / pending placeholder rows do NOT receive `rowHandlers` (scope enforced by construction). Render at the end of `Timeline`:
```tsx
{menu.state && (
    <div className="mj_HeaderMenu mj_EventRowMenu" role="menu" ref={menu.menuRef}
         style={{ position: "fixed", left: menu.state.left, top: menu.state.top }} onKeyDown={menu.menuKeyDown}>
        {menu.state.target.type === "text" && (
            <button className="mj_RoomItemMenu_item" type="button" role="menuitem"
                    onClick={() => { void copyText(asString(menu.state!.target.payload.body)); menu.close(); }}>Copy</button>
        )}
        <button className="mj_RoomItemMenu_item" type="button" role="menuitem"
                onClick={() => { setSourceEvent(menu.state!.target); menu.close(); }}>View source</button>
    </div>
)}
{sourceEvent && <EventSourceSheet event={sourceEvent} onClose={() => setSourceEvent(undefined)} />}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest components-test -i` → PASS (all new + existing). `pnpm exec tsc --noEmit` clean, `pnpm exec prettier --check` clean.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/components.tsx test/unit-tests/journal/components-test.ts
git add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git commit -m "feat(timeline): event-row menu (Copy + View source) + EventSourceSheet (#471/#476)"
```

### T-2.2: Close menu + sheet on conversation switch

**Files:**
- Modify: `src/journal/components.tsx` (`Timeline`)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:** Consumes `menu.close` + `setSourceEvent` (this task adds an effect keyed on `state.selectedConversationId`).

- [ ] **Step 1: Write the failing test**

```ts
test("switching conversations closes an OPEN MENU (menu still open, not via View source)", async () => {
    const { container, client } = renderAppWithEvents([textEvent(5, "hi")], ["c1", "c2"]);
    await openRowMenu(container, 5);
    expect(container.querySelector(".mj_EventRowMenu")).not.toBeNull(); // menu open, sheet not
    await act(async () => { await client.selectConversation("c2"); });
    expect(container.querySelector(".mj_EventRowMenu")).toBeNull();     // closed by the switch effect, NOT by a menu action
});
test("switching conversations closes an open source sheet", async () => {
    const { container, client } = renderAppWithEvents([textEvent(5, "hi")], ["c1", "c2"]);
    await openRowMenu(container, 5);
    await clickMenuItem(container, "View source");
    expect(container.querySelector(".mj_EventSource")).not.toBeNull();
    await act(async () => { await client.selectConversation("c2"); });
    expect(container.querySelector(".mj_EventSource")).toBeNull();
});
```

> The first case is load-bearing (round-2 Maj-1): it leaves the **menu** open (does not click "View source", which would close the menu itself) so the test actually detects a missing `menu.close()` in the switch effect. A test that opens View source first can't distinguish the switch effect from the menu's own close-on-action.

- [ ] **Step 2: Run to verify it fails** — the sheet/menu persist across switch → FAIL.

- [ ] **Step 3: Implement** — in `Timeline`, add:

```tsx
useEffect(() => {
    menu.close();
    setSourceEvent(undefined);
}, [state.selectedConversationId]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest components-test -i -t "switching conversations closes"` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/components.tsx test/unit-tests/journal/components-test.ts
git add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git commit -m "fix(timeline): close event-row menu + source sheet on conversation switch (#476)"
```

---

## Phase 3 — Composer drafts + double-send guard (#471 Part B + #478)

Depends on Phase 1 (`makeDraftStore`, `client.ts`). Independent of Phase 2.

### T-3.1: Composer draft integration (store, refs, switch effect)

**Files:**
- Modify: `src/journal/components.tsx` (`Composer`)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: `makeDraftStore` (T-1.1).
- Produces: within `Composer` — `drafts` (memoized store), `convoIdRef`, `bodyRef`, `setBodyDraft(next)`, a convo-switch effect, and a debounce timer ref (`draftTimerRef`) + `flushDraft()`.

- [ ] **Step 1: Write failing tests**

```ts
test("draft persists per conversation across navigation", async () => {
    const { container, client } = renderComposerApp(["c1", "c2"]);       // helper: signed-in app on c1
    await typeInComposer(container, "draft for one");
    await act(async () => { await client.selectConversation("c2"); });
    expect(composerValue(container)).toBe("");
    await act(async () => { await client.selectConversation("c1"); });
    expect(composerValue(container)).toBe("draft for one");
});
test("a completion pick (folder) is persisted", async () => {
    // Mock the store's matches() so the folder palette actually opens on a real "/workdir <partial>" input.
    jest.spyOn(require("../../../src/journal/slash-palette"), "makeRecentFoldersStore")
        .mockReturnValue({ record: jest.fn(), matches: () => ["work/dir"] });
    const { container, client } = renderComposerApp(["c1", "c2"]);
    await typeInComposer(container, "/workdir wo");                     // single slash + 'workdir' → palette opens (matches → ["work/dir"])
    await selectFirstPaletteItem(container);                           // selectFolder → setBodyDraft(applyFolder(...))
    const composed = composerValue(container);
    expect(composed).not.toBe("/workdir wo");                          // the pick mutated the body via setBodyDraft
    await act(async () => { await client.selectConversation("c2"); });
    await act(async () => { await client.selectConversation("c1"); });
    expect(composerValue(container)).toBe(composed);                   // completion-pick body persisted across nav
});
test("a throwing setItem does not lose the draft on navigation", async () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("q", "QuotaExceededError"); });
    const { container, client } = renderComposerApp(["c1", "c2"]);
    await typeInComposer(container, "kept in memory");
    await act(async () => { await client.selectConversation("c2"); });
    await act(async () => { await client.selectConversation("c1"); });
    expect(composerValue(container)).toBe("kept in memory");
    spy.mockRestore();
});
test("keystroke debounces the localStorage write (no setItem before 250ms, one after)", async () => {
    jest.useFakeTimers();
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    const { container } = renderComposerApp(["c1"]);
    setItem.mockClear();
    await typeInComposer(container, "x");
    expect(setItem).not.toHaveBeenCalled();          // memory-only until the debounce fires
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(setItem).toHaveBeenCalledTimes(1);          // single coalesced persist
    jest.useRealTimers();
});
```

- [ ] **Step 2: Run to verify it fails** — drafts bleed / reset → FAIL.

- [ ] **Step 3: Implement** the draft wiring in `Composer`

```tsx
const drafts = useMemo(() => makeDraftStore(state.session), [state.session]);
const convoId = state.selectedConversationId;
const convoIdRef = useRef(convoId); convoIdRef.current = convoId;
const bodyRef = useRef(body); bodyRef.current = body;
const prevConvoIdRef = useRef(convoId);
const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

// cancelDraftDebounce = clear the pending mirror timer WITHOUT persisting (send uses this so it can
// clear-or-persist exactly once). flushDraft = cancel + persist now (switch/blur/teardown).
const cancelDraftDebounce = useCallback(() => {
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = undefined; }
}, []);
const flushDraft = useCallback(() => { cancelDraftDebounce(); drafts.persist(); }, [cancelDraftDebounce, drafts]);

const setBodyDraft = useCallback((next: string) => {
    setBody(next);
    const cid = convoIdRef.current;
    if (!cid) return;
    drafts.setDraft(cid, next);                 // in-memory update — immediate, cheap, authoritative
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => { drafts.persist(); draftTimerRef.current = undefined; }, 250); // localStorage write coalesced
}, [drafts]);

// Convo switch: flush to storage (do NOT re-stage prev's body — round-3 B2), load new (always assign; ok:false -> empty).
// setBodyDraft already staged every edit into the memory map, so the map is current for prev; re-staging
// bodyRef.current here would resurrect a draft a concurrent send-completion just cleared. Just persist.
// Use setBody directly (NOT setBodyDraft) so loading doesn't schedule a write.
useEffect(() => {
    const prev = prevConvoIdRef.current;
    if (prev && prev !== convoId) flushDraft();  // persist the memory map as-is; no re-stage
    const { text, ok } = convoId ? drafts.read(convoId) : { text: "", ok: true };
    setBody(ok ? text : "");
    setDismissed(null);
    setHighlighted(null);
    if (textarea.current) textarea.current.style.height = "auto";
    prevConvoIdRef.current = convoId;
}, [convoId]); // eslint-disable-line react-hooks/exhaustive-deps
```
Route the textarea `onChange`, `selectCommand`, and `selectFolder` `setBody(...)` calls through `setBodyDraft(...)`.

> **Debounce is now real (round-1 B3 fix):** `setDraft` mutates only the in-memory map (cheap, keeps a memory-first `read` navigation-safe); the expensive `persist()` (whole-map `JSON.stringify` + `setItem`) fires at most once per 250 ms. A single timer is correct because `persist()` writes the *whole* map — no per-convo timer to race. Add a fake-timer test asserting `setItem` is NOT called on a keystroke before 250 ms and IS called once after (see below).

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest components-test -i` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/components.tsx test/unit-tests/journal/components-test.ts
git add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git commit -m "feat(composer): per-conversation draft persistence, navigation-safe (#471)"
```

### T-3.2: Send — per-convo lock, snapshot-guarded completion (no watchdog)

**Files:**
- Modify: `src/journal/components.tsx` (`Composer.send`)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:** Consumes `sendMessage(body, convoId)` (T-1.3), `drafts` + refs (T-3.1). Adds `sendingConvos` ref.

- [ ] **Step 1: Write failing tests** (use `jest.useFakeTimers()` where noted)

```ts
test("two rapid Enters send once", async () => {
    let resolve!: (v: boolean) => void;
    const send = jest.spyOn(client, "sendMessage").mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = renderComposerApp(["c1"], client);
    await typeInComposer(container, "hi");
    await pressEnter(container); await pressEnter(container);
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(true); });
});
test("cross-convo: send in A pending, Enter in B not blocked; A resolve leaves B untouched; A draft cleared", async () => {
    let resolveA!: (v: boolean) => void;
    const sm = jest.spyOn(client, "sendMessage")
        .mockReturnValueOnce(new Promise((r) => (resolveA = r)))  // A: pending
        .mockResolvedValue(true);                                 // B: resolves
    const { container, client: c } = renderComposerApp(["c1", "c2"], client);
    await typeInComposer(container, "X"); await pressEnter(container);        // A send pending, X still in composer
    await act(async () => { await c.selectConversation("c2"); });             // switch to B (c2)
    await typeInComposer(container, "B-msg"); await pressEnter(container);     // B not blocked → its own send
    expect(sm).toHaveBeenNthCalledWith(2, "B-msg", "c2");
    await act(async () => { resolveA(true); });                               // A resolves while B on screen
    expect(composerValue(container)).toBe("");                                // B's composer untouched (already sent B-msg → empty)
    await act(async () => { await c.selectConversation("c1"); });
    expect(composerValue(container)).toBe("");                                // A's draft cleared (X was sent)
});
test("same-convo interleave: follow-up Y typed during a pending send is preserved", async () => {
    let resolveX!: (v: boolean) => void;
    jest.spyOn(client, "sendMessage").mockReturnValueOnce(new Promise((r) => (resolveX = r)));
    const { container } = renderComposerApp(["c1"], client);
    await typeInComposer(container, "X"); await pressEnter(container);        // X pending
    await typeInComposer(container, "Y");                                     // type follow-up while pending
    await act(async () => { resolveX(true); });                              // X resolves
    expect(composerValue(container)).toBe("Y");                              // Y preserved (bodyRef !== submitted)
    expect(makeDraftStore(SESSION).read("c1").text).toBe("Y");             // Y persisted, X's draft not clobbered (SESSION = the file's fixture)
});
test("late resolve after a conversation switch does not resurrect the sent draft", async () => {
    // round-3 B2: X resolves while B is on screen; the switch effect must NOT re-stage A's old body.
    let resolveX!: (v: boolean) => void;
    jest.spyOn(client, "sendMessage").mockReturnValueOnce(new Promise((r) => (resolveX = r)));
    const { container, client: c } = renderComposerApp(["c1", "c2"], client);
    await typeInComposer(container, "X"); await pressEnter(container);        // X pending in c1
    await act(async () => { resolveX(true); await c.selectConversation("c2"); }); // resolve + switch in one flush
    await act(async () => { await c.selectConversation("c1"); });
    expect(composerValue(container)).toBe("");                               // c1 empty — X not resurrected
    expect(makeDraftStore(SESSION).read("c1").text).toBe("");
});
test("recent-folder is recorded on a successful folder-bearing send", async () => {
    const record = jest.fn();
    jest.spyOn(require("../../../src/journal/slash-palette"), "makeRecentFoldersStore")
        .mockReturnValue({ record, matches: () => [] });   // real RecentFoldersStore = { record, matches }
    jest.spyOn(client, "sendMessage").mockResolvedValue(true);
    const { container } = renderComposerApp(["c1"], client);
    await typeInComposer(container, "/start work/dir do it"); await pressEnter(container); // single slash + literal 'start'
    await act(async () => {}); // flush the awaited send completion
    expect(record).toHaveBeenCalledWith("work/dir");  // recentFolderArgument("/start work/dir do it") → first token
});
test("an addToOutbox rejection is caught (no unhandled rejection), text retained, lock released", async () => {
    jest.spyOn(client, "sendMessage").mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    const { container } = renderComposerApp(["c1"], client);
    await typeInComposer(container, "hi");
    await act(async () => { await pressEnter(container); });   // must not throw / reject
    expect(composerValue(container)).toBe("hi");               // text retained for retry
    jest.spyOn(client, "sendMessage").mockResolvedValueOnce(true);
    await act(async () => { await pressEnter(container); });   // lock released → retry succeeds
    expect(composerValue(container)).toBe("");
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (double-send fires twice; completion wipes Y / resurrects X; rejection unhandled).

- [ ] **Step 3: Implement `send()`**

Simple `Set<convoId>` lock (no watchdog — round-3 decision, see note): the lock is added synchronously before the first `await` and released in `finally` on settle. A `catch` (round-3 M1) prevents an `addToOutbox` rejection from becoming a silent unhandled rejection — the text is retained for retry.

```tsx
const sendingConvos = useRef(new Set<string>());
const send = async (): Promise<void> => {
    const cid = convoIdRef.current;
    const submitted = body;
    if (!cid || sendingConvos.current.has(cid)) return;
    sendingConvos.current.add(cid);                            // synchronous → blocks the same-tick 2nd Enter for cid
    try {
        if (await client.sendMessage(submitted, cid)) {
            const folder = recentFolderArgument(submitted);
            if (folder) store.record(folder);
            cancelDraftDebounce();                              // stop the pending mirror; persist exactly once below
            if (drafts.read(cid).text === submitted) drafts.clear(cid); // sent text still the draft → clear (persists)
            else drafts.persist();                             // a follow-up Y was typed → commit it (persists once)
            if (convoIdRef.current === cid && bodyRef.current === submitted) {
                setBody("");
                setDismissed(null);
                if (textarea.current) textarea.current.style.height = "auto";
            }
        }
    } catch (err) {
        // addToOutbox rejected (quota/transaction) → the message was NOT durably queued. Keep the
        // composer text so the operator can retry; log rather than throw an unhandled rejection
        // (round-3 M1). The retained text + failure to send IS the visible signal for this local tool.
        console.warn("matron: message not queued (outbox write failed)", err);
    } finally {
        sendingConvos.current.delete(cid);
    }
};
```

> **No watchdog (round-3 decision — reviewer oscillation resolved with a documented tradeoff).** An earlier revision added a 15 s watchdog to release a lock on a hung local `addToOutbox`. But a *slow-but-successful* write that commits after the watchdog fires would let a retry create a **second durable message** — reintroducing the exact double-send #478 closes. For a double-send-guard feature, **no-dup strictly beats wedge-recovery**: the watchdog is removed. The only residual is a genuinely-hung local IndexedDB `addToOutbox` (pathological — local IndexedDB resolves or throws in milliseconds; it does not hang), which wedges *only that one conversation's* composer until a **page reload** (fully recoverable, no data loss — the text is still on screen). This is the safer choice and eliminates the ABA-lock class entirely (a plain `Set` suffices — no per-attempt token needed).

> **Accepted limitation (spec round-4 B1):** when `refreshSelectedConversation` throws *after* `addToOutbox` succeeds, `sendMessage` still resolves `true` (outbox-authoritative, now off the awaited path) and the composer clears; the durable message may briefly not appear as a pending row until the next refresh/echo. Keeping the text instead would reintroduce the double-send, so clearing is correct; the message is durable and self-heals. Optimistic-pending-row surfacing is a documented follow-up.

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest components-test -i` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/components.tsx test/unit-tests/journal/components-test.ts
git add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git commit -m "fix(composer): per-convo send lock + snapshot-guarded completion + outbox-reject catch (#478)"
```

### T-3.3: Page-teardown draft flush

**Files:**
- Modify: `src/journal/components.tsx` (`Composer`)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:** Adds a `pagehide` + `visibilitychange` listener effect that flushes the pending localStorage mirror write.

- [ ] **Step 1: Write the failing test**

```ts
test("pagehide flushes a pending draft write within the debounce window", async () => {
    jest.useFakeTimers();
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    const { container } = renderComposerApp(["c1"]);
    await typeInComposer(container, "unsaved edit");   // schedules a 250ms debounce
    setItem.mockClear();
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(setItem).toHaveBeenCalled();                // flushed synchronously, before the timer
    jest.useRealTimers();
});
test("unmount (switch to read-only child) within the debounce window flushes the draft (round-4 B1)", async () => {
    jest.useFakeTimers();
    // renderComposerApp with a parent (c1) and a child (child of c1, read-only → Composer unmounts).
    const { container, client } = renderComposerAppWithChild("c1", "c1-child");
    await typeInComposer(container, "edit before unmount");   // 250ms debounce pending, NOT yet persisted
    await act(async () => { await client.selectConversation("c1-child"); }); // Composer unmounts
    await act(async () => { await client.selectConversation("c1"); });       // Composer remounts, new store hydrates
    expect(composerValue(container)).toBe("edit before unmount");            // draft survived the unmount
    jest.useRealTimers();
});
```

> `renderComposerAppWithChild` is a harness helper that seeds a parent conversation plus a running child (`parent_convo_id` set), so selecting the child renders `ReadOnlyHint` (Composer unmounts) per `components.tsx:2424`/`2417`.

- [ ] **Step 2: Run to verify it fails** — no listener → `setItem` not called → FAIL.

- [ ] **Step 3: Implement** — in `Composer`, add:

```tsx
useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") flushDraft(); };
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", onVis);
    // Flush on UNMOUNT too (round-4 B1): the Composer is conditionally unmounted when the operator
    // switches to a read-only child conversation (components.tsx:2424). Without this, an edit made
    // within the 250 ms debounce window is orphaned (the store's useMemo instance is destroyed) and a
    // remount hydrates stale localStorage → lost draft. flushDraft cancels the timer + persists now.
    return () => {
        window.removeEventListener("pagehide", flushDraft);
        document.removeEventListener("visibilitychange", onVis);
        flushDraft();
    };
}, [flushDraft]);
```
Also add `onBlur={flushDraft}` to the textarea. All flush paths just `flushDraft()` (cancel debounce + persist the memory map) — no re-staging of `bodyRef.current` (round-3 B2: `setBodyDraft` already staged every edit into the map, so the map is authoritative; re-staging risks resurrecting a concurrently-cleared draft).

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest components-test -i -t "pagehide flushes"` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/components.tsx test/unit-tests/journal/components-test.ts
git add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git commit -m "feat(composer): flush draft on page teardown + blur (#471)"
```

---

## Phase 4 — Styles + full verification

### T-4.1: Menu + source-sheet styles

**Files:**
- Modify: `src/journal/journal.pcss` (where the dialog styles `mj_UploadConfirm_scrim` / `mj_UploadConfirm` live; the menu classes `mj_HeaderMenu` / `mj_RoomItemMenu` also live here). CSS only — this task owns NO component file (the `EventSourceSheet` scrim/panel class names were fixed in T-2.1, round-3 M4).

**Interfaces:** none (CSS only).

- [ ] **Step 1: Locate the existing menu + dialog rules**

Run: `grep -n "mj_HeaderMenu\|mj_RoomItemMenu\|mj_UploadConfirm_scrim\|mj_UploadConfirm " src/journal/journal.pcss` — the event-row menu reuses `mj_HeaderMenu`/`mj_RoomItemMenu_item` (no new rules needed beyond an optional `mj_EventRowMenu` width tweak); the source sheet's `mj_EventSource_scrim`/`mj_EventSource` mirror the upload dialog's scrim/panel.

- [ ] **Step 2: Add styles** (in `journal.pcss`)

```pcss
.mj_EventRowMenu { /* inherits mj_HeaderMenu; add width tuning only if needed */ }

/* Scrim mirrors mj_UploadConfirm_scrim (fixed, centered, dimmed backdrop). */
.mj_EventSource_scrim {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100;
}
.mj_EventSource {
    display: flex;
    flex-direction: column;
    max-height: 80vh;
    max-width: min(720px, 92vw);
    background: var(--cpd-color-bg-canvas-default, #fff);
    border-radius: 12px;
    overflow: hidden;
}
.mj_EventSource_header { padding: 12px 16px; }
.mj_EventSource_json {
    overflow: auto;
    user-select: text;
    white-space: pre;
    font-family: var(--mj-mono, ui-monospace, monospace);
    font-size: 0.8125rem;
    padding: 12px 16px;
    margin: 0;
    flex: 1 1 auto;
}
.mj_EventSource_actions { display: flex; gap: 8px; justify-content: flex-end; padding: 8px 16px; }
```
Verify the exact background/token variables against the neighbouring `mj_UploadConfirm` rules and reuse them (don't invent new color tokens).

- [ ] **Step 3: Visual smoke** — deferred to T-4.2's build; no unit test for CSS.

- [ ] **Step 4: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/journal.pcss
git add src/journal/journal.pcss
git commit -m "style(timeline): event-row menu + event-source sheet styles (#471/#476)"
```

### T-4.2: Full lint, test, and build verification

**Files:** none (verification only).

- [ ] **Step 1: Lint** — `pnpm lint` → Expected: PASS (tsc clean + prettier clean).

- [ ] **Step 2: Full test suite** — `pnpm test` → Expected: all suites green (new + existing; especially the existing `components-test.ts` regression set).

- [ ] **Step 3: Production build** — `pnpm build` → Expected: `webapp/` produced, no webpack errors.

- [ ] **Step 4: Manual smoke checklist** (record results in the ship notes; not automated):
  - Right-click a text message → Copy + View source; Copy puts the text on the clipboard.
  - Right-click a diff/tool message → View source only.
  - View source → scrollable, selectable JSON; Copy; Done/Esc/backdrop close.
  - Long-press a message on a touch device (or emulate) → menu opens; scroll cancels a pending press.
  - Type in convo A, switch to B and back → A's draft restored; B independent.
  - Rapid double-Enter → one message.
  - Switch conversation with a menu/sheet open → both close.

- [ ] **Step 5: Commit** (if any lint/format fixups were needed)

```bash
git add -u
git commit -m "chore(web): lint + build fixups for composer-rows feature (#471/#476/#478)"
```

---

## Dependency graph

- **Phase 0** (T-0.1) — baseline rebase + grep-confirm + green tests. **Blocks everything** (esp. T-1.3, which patches the upstream-modified `client.ts`).
- **Phase 1** (T-1.1, T-1.2, T-1.3, T-1.4) — all independent leaves; any order / parallelizable (after Phase 0).
- **Phase 2** (T-2.1 → T-2.2) — needs T-1.2 + T-1.4. T-2.1 is the atomic menu+sheet task (one commit); T-2.2 (close-on-switch) needs T-2.1.
- **Phase 3** (T-3.1 → T-3.2 → T-3.3) — needs T-1.1 + T-1.3. Independent of Phase 2.
- **Phase 4** (T-4.1, T-4.2) — needs Phases 2 + 3.

Under `/execute-slim`, Phases 2 and 3 can be built in either order; Phase 4 is the final gate.

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| #471 Part A — timeline event-row menu (triggers, scope, menu items, a11y) | T-1.2, T-2.1 |
| #476 — EventSourceSheet (DTO JSON, scroll/select, Copy/Done/Esc/backdrop) | T-2.1 |
| Close menu/sheet on conversation switch | T-2.2 |
| #471 Part B — draft store (in-memory authoritative, {text,ok}, parse-don't-validate, MAX_DRAFT_BYTES, MAX_DRAFT_ENTRIES recency, clear) | T-1.1 |
| #471 Part B — Composer integration (refs, setBodyDraft capture-by-value, switch effect always-assign, completion-pick persistence) | T-3.1 |
| #471 Part B — write coalescing / teardown flush / blur flush | T-3.1, T-3.3 |
| #478 — per-convo lock (Set), snapshot-guarded decoupled completion, outbox-reject catch, recent-folder preserved (no watchdog — documented tradeoff) | T-3.2 |
| #478 / round-4 B1 — client.ts explicit target + outbox-authoritative | T-1.3 |
| Shared `copyText` async helper | T-1.4 |
| Styles (menu + sheet) | T-4.1 |
| Verification (lint/test/build + manual smoke) | T-4.2 |
| Reviewer overrides (reconnect-replay dedup, session-tuple) | Out of scope — documented follow-ups in spec |

All spec deliverables are covered. The two spec-documented overrides (reconnect-replay dedup → upstream `matron-journal`; full session-tuple binding → pre-existing follow-up) are intentionally not tasked; they are filed as follow-up loops at ship.

## Reviewer overrides + follow-ups (plan-review)

Decisions consciously NOT actioned in this PR, with rationale (per `procedure_codex_review_re_flags_operator_accepted_limitations` + the reviewer-oscillation rule):

- **No send watchdog (round-3 removed it; round-4 re-flagged its absence).** Two opposing flips on one finding: a watchdog dups a slow-successful send (round-3 B1); no watchdog wedges a hung send until reload (round-4 B2). Per the oscillation-stop rule, the documented decision stands: **no-dup beats wedge-recovery** in a double-send-guard feature; the residual (a pathological hung local `addToOutbox` wedging one convo until reload) is rare and reload-recoverable. A true fix needs **idempotent retry** (stable outbox key + observable indeterminate state) — filed as a follow-up alongside the upstream server-idempotency work.
- **Draft persistence is best-effort across reload (round-4 B3 re-flag).** A `setItem` quota/SecurityError is swallowed with a console warn; the draft is **never lost in-session** (in-memory authoritative) — only a reload after a storage failure loses it. For convenience state on a single-user tool, a durable-save-failure toast is disproportionate; the boolean/return-status surfacing is a follow-up if it ever proves needed.
- **Source-sheet focus containment (round-4 M3, partial).** This PR adds focus-Done-on-open + focus-restore-on-close (no fall-through to `<body>`). A full focus-trap + app-level `inert` (matching the staged-uploads modal) is a follow-up — proportionate to a dev-facing JSON viewer, not blocking.
- **Late-resolve B2 test is a documented coverage limitation** (round-4 Claude minor): the shipped switch-effect is flush-only (correct by inspection); the interleave test asserts final state, which can coincide between fixed/buggy variants. The flush-only design is the guarantee, not the test.

---

## Appendix: Verified Claims (research pass 2026-07-22)

> Note: the Tavily research batch tool was unavailable in this environment (`TAVILY_API_KEY` unset). The claims below are established web-platform facts asserted from knowledge, not tool-verified this run; adversarial reviewers should still challenge them.

✓ **jsdom does not implement `document.execCommand`.** The jest `jsdom` test environment has no working `execCommand`, so the T-1.4 `copyText` fallback path is exercised in tests only via an explicit mock (`(document as any).execCommand = jest.fn()`). In real browsers (the :8443 deploy target) `execCommand("copy")` still works as the clipboard fallback.

✓ **`navigator.clipboard.writeText` returns a Promise that rejects** in insecure contexts / on permission denial. A *synchronous* `try/catch` does NOT catch a promise rejection — hence `copyText` must be `async` and `await` the call (round-4 spec fix); otherwise the fallback never fires and an unhandled rejection escapes. Verified against the spec's own round-4 M5 finding.

✓ **`pagehide` + `visibilitychange`→`hidden` are the reliable teardown-flush events** (bfcache-safe, fire where `unload` does not on mobile). Used in T-3.3 to flush the pending draft mirror. `unload` is deliberately not used.
