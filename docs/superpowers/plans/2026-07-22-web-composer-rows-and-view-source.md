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
- **Constants:** `MAX_DRAFT_BYTES = 64 * 1024`; `MAX_DRAFT_ENTRIES = 50`; `DRAFT_DEBOUNCE_MS = 250`; `SEND_WATCHDOG_MS = 15_000`; `LONG_PRESS_MS = 500`.
- **Menu scope:** the timeline context menu attaches ONLY to `EventRow` rows (settled `JournalEvent`); never to `ToolStream` / pending placeholders.
- **No em-dashes** are irrelevant here (code/comments allowed); this is not operator-voice copy.
- **Verification gate:** `pnpm lint` (tsc + prettier) and `pnpm test` must be green before ship. Run `pnpm exec prettier --write` on touched files before each commit.
- **Deploy target:** static build `webapp/` → nginx :8082 → Tailscale :8443 (NOT the legacy Docker :8420 client). Deploy is out of plan scope (handled at ship).

**Reference:** full design at `docs/superpowers/specs/2026-07-22-web-composer-rows-and-view-source-design.md` (5-round reviewed). Every task's behavior traces to a spec section; consult it for the "why."

---

## Phase 1 — Foundation modules (leaf, no interdependencies)

`composer-drafts.ts`, `context-menu.ts` pure helpers, `client.ts` fixes, and the `copyText` helper are independent; they can be built in any order and are prerequisites for Phases 2–3.

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

- [ ] **Step 1: Write the failing test file** (`composer-drafts-test.ts`)

```ts
/* <license header> */
import { makeDraftStore, MAX_DRAFT_BYTES } from "../../../src/journal/composer-drafts";
import type { Session } from "../../../src/journal/types";

const SESSION: Session = { serverUrl: "https://j.example", token: "t", deviceId: 1, userId: 2, username: "u" };
const KEY = `matron:draft:${encodeURIComponent(SESSION.serverUrl)}:${SESSION.userId}`;

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

test("oversized draft deletes the entry (smaller kept)", () => {
    const s = makeDraftStore(SESSION);
    s.setDraft("c1", "small");
    s.setDraft("c1", "x".repeat(MAX_DRAFT_BYTES + 1));
    expect(s.read("c1").text).toBe("");
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
    const key = `matron:draft:${encodeURIComponent(session.serverUrl)}:${session.userId}`;
    // In-memory map is session-authoritative; localStorage is a best-effort reload mirror.
    const mem = new Map<string, string>();
    let hydrated = false;

    const hydrate = (): boolean => {
        // Returns ok=false only on a storage EXCEPTION; a malformed/absent blob is ok=true (empty).
        try {
            const map = parseMap(localStorage.getItem(key));
            for (const [k, v] of Object.entries(map)) if (!mem.has(k)) mem.set(k, v);
            hydrated = true;
            return true;
        } catch {
            console.warn("matron: draft read failed (storage unavailable)");
            return false;
        }
    };

    const persist = (): void => {
        try {
            localStorage.setItem(key, JSON.stringify(Object.fromEntries(mem)));
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
            if (text.trim() !== "" && utf8Length(text) <= MAX_DRAFT_BYTES) {
                mem.set(convoId, text);
                while (mem.size > MAX_DRAFT_ENTRIES) {
                    const oldest = mem.keys().next().value as string;
                    mem.delete(oldest);
                }
            }
            // NO persist here — memory only; the Composer debounces persist().
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
    await this.database.addToOutbox(message); // durable — from here the message WILL send
    try {
        await this.refreshSelectedConversation(conversationId);
        if (this.state.selectedConversationId === conversationId) {
            this.patch({ sendTick: this.state.sendTick + 1 });
        }
    } catch (err) {
        // Outbox write already succeeded; a refresh failure must not reject (would leave the
        // composer retry-able into a duplicate durable message — no server idempotency).
        console.warn("matron: post-send refresh failed (message still queued)", err);
    }
    this.sendPendingMessage(message);
    return true;
}
```

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
- Produces: `export async function copyText(text: string): Promise<void>` — awaits `navigator.clipboard.writeText`, falls back to a hidden-`<textarea>` `document.execCommand("copy")`, then a silent no-op; never throws, never leaks an unhandled rejection.

- [ ] **Step 1: Write the failing test** (append to `components-test.ts`)

```ts
import { copyText } from "../../../src/journal/components";

test("copyText awaits clipboard and falls back to execCommand on rejection", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const exec = jest.fn().mockReturnValue(true);
    (document as any).execCommand = exec;
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(exec).toHaveBeenCalledWith("copy");
});

test("copyText is a silent no-op when both paths fail", async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error("x")) } });
    (document as any).execCommand = jest.fn(() => { throw new Error("nope"); });
    await expect(copyText("hello")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec jest components-test -i -t copyText` → FAIL (export missing).

- [ ] **Step 3: Implement `copyText`** in `components.tsx`

```tsx
export async function copyText(text: string): Promise<void> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch {
        /* fall through to execCommand */
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    } catch {
        /* silent no-op — copy is best-effort, never throws into the UI */
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
- Produces: `function EventSourceSheet({ event, onClose }: { event: JournalEvent; onClose: () => void }): React.ReactElement`; an `mj_HeaderMenu mj_EventRowMenu` rendered by `Timeline`; `rowHandlers` spread onto each `EventRow` `<li>` (via new `EventRow` props `rowHandlers` + `didFireRef`).

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
    // backdrop close
    await openRowMenu(container, 5); await clickMenuItem(container, "View source");
    await act(async () => { (container.querySelector(".mj_EventSource") as HTMLElement).click(); });
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
    useEffect(() => { doneRef.current?.focus(); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    const json = JSON.stringify(event, null, 2);
    return (
        <div className="mj_ModalOverlay mj_EventSource" role="dialog" aria-label="Event source" onClick={onClose}>
            <div className="mj_EventSource_panel" onClick={(e) => e.stopPropagation()}>
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
In `Timeline`: `const [sourceEvent, setSourceEvent] = useState<JournalEvent | undefined>();` and `const menu = useRowContextMenu<JournalEvent>();`. Pass `rowHandlers={menu.rowHandlers}` to each `EventRow`. In `EventRow`, add props `{ rowHandlers, didFireRef }` and:
```tsx
const liRef = useRef<HTMLLIElement>(null);
const handlers = rowHandlers(event, () => liRef.current!);
// <li ref={liRef} ...existing... {...handlers}>
```
`ToolStream` / pending placeholder rows do NOT receive `rowHandlers` (scope enforced by construction). The `<li>` has no `onClick` nav, so `didFireRef` is currently reserved (reset per touch press in the hook) — no click to suppress today. Render at the end of `Timeline`:
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
test("switching conversations closes an open menu and source sheet", async () => {
    const { container, client } = renderAppWithEvents([textEvent(5, "hi")], ["c1", "c2"]);
    await openRowMenu(container, 5);
    await clickMenuItem(container, "View source");
    expect(container.querySelector(".mj_EventSource")).not.toBeNull();
    await act(async () => { await client.selectConversation("c2"); });
    expect(container.querySelector(".mj_EventRowMenu")).toBeNull();
    expect(container.querySelector(".mj_EventSource")).toBeNull();
});
```

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
test("a completion pick (folder/command) is persisted", async () => {
    const { container, client } = renderComposerApp(["c1", "c2"]);
    await typeInComposer(container, "//wo");                            // triggers folder palette
    await selectFirstPaletteItem(container);                           // setBody(applyFolder(...))
    const composed = composerValue(container);
    await act(async () => { await client.selectConversation("c2"); });
    await act(async () => { await client.selectConversation("c1"); });
    expect(composerValue(container)).toBe(composed);
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

// flushDraft = cancel the pending debounce AND persist now (used on switch/blur/teardown/send).
const flushDraft = useCallback(() => {
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = undefined; }
    drafts.persist();
}, [drafts]);

const setBodyDraft = useCallback((next: string) => {
    setBody(next);
    const cid = convoIdRef.current;
    if (!cid) return;
    drafts.setDraft(cid, next);                 // in-memory update — immediate, cheap, authoritative
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => { drafts.persist(); draftTimerRef.current = undefined; }, 250); // localStorage write coalesced
}, [drafts]);

// Convo switch: stage prev's current body, flush to storage, load new (always assign; ok:false -> empty).
// Use setBody directly (NOT setBodyDraft) so loading doesn't schedule a write.
useEffect(() => {
    const prev = prevConvoIdRef.current;
    if (prev && prev !== convoId) { drafts.setDraft(prev, bodyRef.current); flushDraft(); }
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

### T-3.2: Send — per-convo lock, watchdog, snapshot-guarded completion

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
test("cross-convo: send in A pending, Enter in B is not blocked; A resolve leaves B untouched; A draft cleared", async () => {
    // send X in c1 (slow), switch to c2, type + Enter in c2 (own send), resolve c1
    // assert: c2 body sends its own message; return to c1 -> empty composer (X's draft cleared)
});
test("same-convo interleave: follow-up Y typed during pending send is preserved", async () => {
    // send X in c1 (slow), type Y, resolve X -> composer still shows Y, Y persisted, X not re-sendable
});
test("recent-folder is recorded on a successful folder-bearing send", async () => {
    const record = jest.fn();
    // spy makeRecentFoldersStore().record; send "//work/dir prompt"; assert record called with the folder
});
test("send watchdog releases a hung lock after the interval", async () => {
    jest.useFakeTimers();
    jest.spyOn(client, "sendMessage").mockReturnValue(new Promise(() => {})); // never settles
    const { container } = renderComposerApp(["c1"], client);
    await typeInComposer(container, "hi"); await pressEnter(container);
    (client.sendMessage as jest.Mock).mockResolvedValueOnce(true);
    jest.advanceTimersByTime(15_000);
    await typeInComposer(container, "again"); await pressEnter(container);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
});
test("ABA: a hung send X's finally does not free a newer send Y's lock", async () => {
    jest.useFakeTimers();
    let resolveX!: (v: boolean) => void;
    const sm = jest.spyOn(client, "sendMessage")
        .mockReturnValueOnce(new Promise((r) => (resolveX = r)))  // X: settles late (after watchdog)
        .mockReturnValue(new Promise(() => {}));                  // Y and later: still pending
    const { container } = renderComposerApp(["c1"], client);
    await typeInComposer(container, "X"); await pressEnter(container);        // X locks c1
    await act(async () => { jest.advanceTimersByTime(15_000); });            // watchdog frees c1 (X's token)
    await typeInComposer(container, "Y"); await pressEnter(container);        // Y re-locks c1 (new token)
    await act(async () => { resolveX(true); });                              // X's finally runs — must NOT free Y
    await typeInComposer(container, "Z"); await pressEnter(container);        // Z must be blocked (Y still owns lock)
    expect(sm).toHaveBeenCalledTimes(2);                                     // X + Y only, never Z
    jest.useRealTimers();
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (double-send fires twice; no watchdog; completion wipes Y).

- [ ] **Step 3: Implement `send()`**

Use a **per-attempt token** (round-1 M1): the lock is a `Map<convoId, token>`; the watchdog and `finally` release ONLY when their own token still owns the entry, so a stale hung send can't delete a newer send's lock (ABA fix).

```tsx
const sendingConvos = useRef(new Map<string, symbol>());
const send = async (): Promise<void> => {
    const cid = convoIdRef.current;
    const submitted = body;
    if (!cid || sendingConvos.current.has(cid)) return;
    const token = Symbol("send");
    sendingConvos.current.set(cid, token);
    const releaseIfMine = () => { if (sendingConvos.current.get(cid) === token) sendingConvos.current.delete(cid); };
    const watchdog = setTimeout(releaseIfMine, 15_000);
    try {
        if (await client.sendMessage(submitted, cid)) {
            const folder = recentFolderArgument(submitted);
            if (folder) store.record(folder);
            flushDraft();                                       // cancel debounce + persist current map
            if (drafts.read(cid).text === submitted) drafts.clear(cid); // clear the sent convo's draft (any view)
            if (convoIdRef.current === cid && bodyRef.current === submitted) {
                setBody("");
                setDismissed(null);
                if (textarea.current) textarea.current.style.height = "auto";
            }
        }
    } finally {
        clearTimeout(watchdog);
        releaseIfMine();                                        // only release if still my token
    }
};
```

> **Note — `sendingConvos.current.has(cid)` guard:** with the `Map`, `has(cid)` is `true` while any attempt for `cid` is in flight (matching the round-4 spec's per-convo lock). The three-send interleave test (below) asserts a stale hung send's `finally` cannot free a newer pending send's lock.

> **Accepted limitation (round-1 M2 / spec round-4 B1):** when `refreshSelectedConversation` throws *after* `addToOutbox` succeeds, `sendMessage` still resolves `true` (outbox-authoritative) and the composer clears, but the durable message may not appear as a pending row until the next successful refresh/echo — a brief invisible window in a rare local-storage-read failure. Keeping the composer text instead would reintroduce the double-send this whole feature closes, so clearing is correct. Surfacing an optimistic "queued" row on that partial failure is a documented **follow-up**, not in scope; the message is durable and self-heals on the next refresh.

- [ ] **Step 4: Run to verify it passes** — `pnpm exec jest components-test -i` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/components.tsx test/unit-tests/journal/components-test.ts
git add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git commit -m "fix(composer): per-convo send lock + watchdog + snapshot-guarded completion (#478)"
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
```

- [ ] **Step 2: Run to verify it fails** — no listener → `setItem` not called → FAIL.

- [ ] **Step 3: Implement** — in `Composer`, add:

```tsx
useEffect(() => {
    const flush = () => {
        const cid = convoIdRef.current;
        if (cid) { drafts.setDraft(cid, bodyRef.current); flushDraft(); } // stage current body, cancel debounce, persist now
    };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
        window.removeEventListener("pagehide", flush);
        document.removeEventListener("visibilitychange", onVis);
    };
}, [drafts, flushDraft]);
```
Also add a textarea `onBlur={() => { const cid = convoIdRef.current; if (cid) { drafts.setDraft(cid, bodyRef.current); flushDraft(); } }}` for the blur-flush path.

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
- Modify: `src/journal/shell.pcss` (or `journal.pcss` — match where `mj_HeaderMenu` / `mj_RoomItemMenu` / dialog styles live)

**Interfaces:** none (CSS only).

- [ ] **Step 1: Locate existing menu + modal classes**

Run: `grep -rn "mj_HeaderMenu\|mj_RoomItemMenu\|mj_ModalOverlay\|UploadConfirm" src/journal/*.pcss` — reuse `mj_HeaderMenu`/`mj_RoomItemMenu_item` for the event-row menu; base the source-sheet overlay/panel on the existing upload-dialog modal classes.

- [ ] **Step 2: Add styles**

```pcss
.mj_EventRowMenu { /* inherits mj_HeaderMenu; nothing extra needed unless width tuning */ }

.mj_EventSource_panel {
    display: flex;
    flex-direction: column;
    max-height: 80vh;
    max-width: min(720px, 92vw);
}
.mj_EventSource_json {
    overflow: auto;
    user-select: text;
    white-space: pre;
    font-family: var(--mj-mono, ui-monospace, monospace);
    font-size: 0.8125rem;
    padding: 12px;
    margin: 0;
    flex: 1 1 auto;
}
.mj_EventSource_actions { display: flex; gap: 8px; justify-content: flex-end; padding: 8px 12px; }
```
Match the existing modal's overlay class (`mj_ModalOverlay` or the upload dialog's) so `EventSourceSheet` centers correctly; if the upload dialog uses a different overlay class name, use that instead and rename in `EventSourceSheet`.

- [ ] **Step 3: Visual smoke** — build and eyeball (deferred to T-4.2's build; no unit test for CSS).

- [ ] **Step 4: Prettier + commit**

```bash
pnpm exec prettier --write src/journal/shell.pcss
git add src/journal/shell.pcss
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

- **Phase 1** (T-1.1, T-1.2, T-1.3, T-1.4) — all independent leaves; any order / parallelizable.
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
| #478 — per-convo lock, snapshot-guarded decoupled completion, watchdog, recent-folder preserved | T-3.2 |
| #478 / round-4 B1 — client.ts explicit target + outbox-authoritative | T-1.3 |
| Shared `copyText` async helper | T-1.4 |
| Styles (menu + sheet) | T-4.1 |
| Verification (lint/test/build + manual smoke) | T-4.2 |
| Reviewer overrides (reconnect-replay dedup, session-tuple) | Out of scope — documented follow-ups in spec |

All spec deliverables are covered. The two spec-documented overrides (reconnect-replay dedup → upstream `matron-journal`; full session-tuple binding → pre-existing follow-up) are intentionally not tasked; they are filed as follow-up loops at ship.

---

## Appendix: Verified Claims (research pass 2026-07-22)

> Note: the Tavily research batch tool was unavailable in this environment (`TAVILY_API_KEY` unset). The claims below are established web-platform facts asserted from knowledge, not tool-verified this run; adversarial reviewers should still challenge them.

✓ **jsdom does not implement `document.execCommand`.** The jest `jsdom` test environment has no working `execCommand`, so the T-1.4 `copyText` fallback path is exercised in tests only via an explicit mock (`(document as any).execCommand = jest.fn()`). In real browsers (the :8443 deploy target) `execCommand("copy")` still works as the clipboard fallback.

✓ **`navigator.clipboard.writeText` returns a Promise that rejects** in insecure contexts / on permission denial. A *synchronous* `try/catch` does NOT catch a promise rejection — hence `copyText` must be `async` and `await` the call (round-4 spec fix); otherwise the fallback never fires and an unhandled rejection escapes. Verified against the spec's own round-4 M5 finding.

✓ **`pagehide` + `visibilitychange`→`hidden` are the reliable teardown-flush events** (bfcache-safe, fire where `unload` does not on mobile). Used in T-3.3 to flush the pending draft mirror. `unload` is deliberately not used.
