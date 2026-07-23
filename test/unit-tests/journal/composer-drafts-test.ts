/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { makeDraftStore, MAX_DRAFT_BYTES, MAX_DRAFT_ENTRIES } from "../../../src/journal/composer-drafts";
import type { Session } from "../../../src/journal/types";
import { TextEncoder as NodeTextEncoder } from "node:util";

Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });

const SESSION: Session = {
    serverUrl: "https://j.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "u",
};
const NS = `${encodeURIComponent(SESSION.serverUrl)}:${SESSION.userId}`;
const LEGACY_KEY = `matron:draft:v1:${NS}`;
const v2Key = (convoId: string): string => `matron:draft:v2:${NS}:${encodeURIComponent(convoId)}`;

beforeEach(() => localStorage.clear());

test("setDraft updates memory but does NOT touch localStorage; persist(convoId) writes the per-key value", () => {
    const s = makeDraftStore(SESSION);
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    s.setDraft("c1", "hello");
    expect(s.read("c1")).toEqual({ text: "hello", ok: true });
    expect(setItem).not.toHaveBeenCalled();
    s.persist("c1");
    expect(localStorage.getItem(v2Key("c1"))).toBe("hello");
    setItem.mockRestore();
});

test("undefined session is a full no-op, read ok:true empty, durability ok", () => {
    const s = makeDraftStore(undefined);
    s.setDraft("c1", "x");
    s.persist("c1");
    expect(s.read("c1")).toEqual({ text: "", ok: true });
    expect(s.durability("c1")).toBe("ok");
});

test("per-key writes cannot clobber another conversation's draft (the #486 bug)", () => {
    // Two tabs sharing origin+user each hold their own store; persisting one convo
    // must never touch another convo's key.
    const tabA = makeDraftStore(SESSION);
    const tabB = makeDraftStore(SESSION);
    tabA.setDraft("c1", "draft one");
    tabA.persist("c1");
    tabB.setDraft("c2", "draft two");
    tabB.persist("c2");
    expect(localStorage.getItem(v2Key("c1"))).toBe("draft one");
    expect(localStorage.getItem(v2Key("c2"))).toBe("draft two");
});

test("empty/whitespace persist is a logical delete of the per-key value", () => {
    const s = makeDraftStore(SESSION);
    s.setDraft("c1", "hi");
    s.persist("c1");
    s.setDraft("c1", "   ");
    s.persist("c1");
    expect(s.read("c1").text).toBe("");
    expect(localStorage.getItem(v2Key("c1"))).toBeNull();
});

test("clear removes memory + per-key value and resets durability to ok", () => {
    const s = makeDraftStore(SESSION);
    s.setDraft("c1", "x");
    s.persist("c1");
    s.clear("c1");
    expect(s.read("c1").text).toBe("");
    expect(localStorage.getItem(v2Key("c1"))).toBeNull();
    expect(s.durability("c1")).toBe("ok");
});

test("oversized draft stays in memory (navigation-safe) but is not persisted; durability non-durable", () => {
    const s = makeDraftStore(SESSION);
    const big = "x".repeat(MAX_DRAFT_BYTES + 1);
    s.setDraft("c1", big);
    expect(s.read("c1").text).toBe(big);
    s.persist("c1");
    expect(localStorage.getItem(v2Key("c1"))).toBeNull();
    expect(s.durability("c1")).toBe("non-durable");
});

test("in-memory value survives a throwing setItem and flips durability non-durable", () => {
    const s = makeDraftStore(SESSION);
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    s.setDraft("c1", "kept");
    expect(() => s.persist("c1")).not.toThrow();
    expect(s.read("c1")).toEqual({ text: "kept", ok: true });
    expect(s.durability("c1")).toBe("non-durable");
    spy.mockRestore();
});

test("durability recovers to ok after a failed persist followed by a successful one", () => {
    const s = makeDraftStore(SESSION);
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    s.setDraft("c1", "text");
    s.persist("c1"); // fails → non-durable
    expect(s.durability("c1")).toBe("non-durable");
    spy.mockRestore();
    s.persist("c1"); // succeeds → ok
    expect(s.durability("c1")).toBe("ok");
});

test("read falls through mem -> v2 key -> legacy v1 -> empty", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ fromV1: "legacy text" }));
    localStorage.setItem(v2Key("fromV2"), "v2 text");
    const s = makeDraftStore(SESSION);
    // migration removes the v1 blob when everything is durable; seed a case where v1 is retained
    // by forcing a partial failure below. Here migration succeeds, so read comes from v2.
    expect(s.read("fromV2").text).toBe("v2 text");
});

test("throwing getItem on a memory-miss read returns ok:false (no crash)", () => {
    const s = makeDraftStore(SESSION);
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
    });
    expect(s.read("never-written")).toEqual({ text: "", ok: false });
    spy.mockRestore();
});

test("per-session key isolation", () => {
    const a = makeDraftStore(SESSION);
    a.setDraft("c1", "a");
    a.persist("c1");
    const other: Session = { ...SESSION, userId: 99 };
    expect(makeDraftStore(other).read("c1").text).toBe("");
});

test("refuse-not-evict cap: a 51st NEW convo is refused and existing keys are untouched", () => {
    const s = makeDraftStore(SESSION);
    for (let i = 0; i < MAX_DRAFT_ENTRIES; i += 1) {
        s.setDraft(`k${i}`, `v${i}`);
        s.persist(`k${i}`);
    }
    s.setDraft("overflow", "nope");
    s.persist("overflow");
    expect(localStorage.getItem(v2Key("overflow"))).toBeNull();
    expect(s.durability("overflow")).toBe("non-durable");
    // No existing draft was evicted.
    expect(localStorage.getItem(v2Key("k0"))).toBe("v0");
    expect(localStorage.getItem(v2Key("k49"))).toBe("v49");
});

test("refuse-not-evict cap: updating an existing key at the cap still succeeds", () => {
    const s = makeDraftStore(SESSION);
    for (let i = 0; i < MAX_DRAFT_ENTRIES; i += 1) {
        s.setDraft(`k${i}`, `v${i}`);
        s.persist(`k${i}`);
    }
    s.setDraft("k0", "updated");
    s.persist("k0");
    expect(localStorage.getItem(v2Key("k0"))).toBe("updated");
    expect(s.durability("k0")).toBe("ok");
});

test("migration: all-success moves v1 entries to per-key v2 and removes the v1 blob", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: "one", b: "two" }));
    const s = makeDraftStore(SESSION);
    expect(localStorage.getItem(v2Key("a"))).toBe("one");
    expect(localStorage.getItem(v2Key("b"))).toBe("two");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(s.read("a").text).toBe("one");
});

test("migration: a pre-existing v2 key is NOT overwritten by the stale v1 copy (v2-precedence)", () => {
    localStorage.setItem(v2Key("a"), "newer v2");
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: "stale v1" }));
    const s = makeDraftStore(SESSION);
    expect(localStorage.getItem(v2Key("a"))).toBe("newer v2");
    expect(s.read("a").text).toBe("newer v2");
});

test("migration: a failed entry retains the v1 blob and stays readable via the v1 fallback", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: "one", b: "two" }));
    // Fail only the write for entry "b"'s v2 target; "a" migrates fine.
    const realSet = Storage.prototype.setItem;
    const guard = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
    ) {
        if (key === v2Key("b")) throw new DOMException("quota", "QuotaExceededError");
        return realSet.call(this, key, value);
    });
    const s = makeDraftStore(SESSION);
    guard.mockRestore();
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull(); // v1 retained
    expect(s.read("a").text).toBe("one"); // migrated to v2
    expect(s.read("b").text).toBe("two"); // still readable via v1 fallback
    expect(s.durability("b")).toBe("non-durable");
});

test("migration: an over-cap v1 blob (>50) migrates up to the cap, refuses the rest, retains v1", () => {
    const blob: Record<string, string> = {};
    for (let i = 0; i < MAX_DRAFT_ENTRIES + 10; i += 1) blob[`k${i}`] = `v${i}`;
    localStorage.setItem(LEGACY_KEY, JSON.stringify(blob));
    makeDraftStore(SESSION);
    let v2Count = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
        if (localStorage.key(i)?.startsWith(`matron:draft:v2:${NS}:`)) v2Count += 1;
    }
    expect(v2Count).toBe(MAX_DRAFT_ENTRIES);
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull(); // v1 retained (some refused)
});

test("empty-persist while v1 retained does not resurrect a deleted draft on reload", () => {
    // Force a retained-v1 state: seed v1 with two entries and fail one migration write.
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: "one", b: "two" }));
    const realSet = Storage.prototype.setItem;
    const guard = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
    ) {
        if (key === v2Key("b")) throw new DOMException("quota", "QuotaExceededError");
        return realSet.call(this, key, value);
    });
    const s = makeDraftStore(SESSION);
    guard.mockRestore();
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull(); // v1 retained, holds a + b
    // Delete-all-text (empty persist) on the migrated convo "a".
    s.setDraft("a", "");
    s.persist("a");
    // A fresh store (reload) must NOT resurrect "a" from the retained v1 blob.
    expect(makeDraftStore(SESSION).read("a").text).toBe("");
});

test("clear does not throw when removeItem fails and flips durability non-durable (accepted edge)", () => {
    // Documented accepted edge (spec FIX 3 / round-6 Major-2): a storage throw during clear leaves a
    // stale copy that read() can surface — clear must NOT crash, and durability flips to the P3 signal.
    const s = makeDraftStore(SESSION);
    s.setDraft("c1", "x");
    s.persist("c1");
    const spy = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
    });
    expect(() => s.clear("c1")).not.toThrow();
    expect(s.durability("c1")).toBe("non-durable");
    spy.mockRestore();
    // The un-removed v2 key remains (the accepted stale-copy edge); it is not silent draft LOSS.
    expect(s.read("c1").text).toBe("x");
});
