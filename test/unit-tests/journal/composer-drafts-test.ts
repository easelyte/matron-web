/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { makeDraftStore, MAX_DRAFT_BYTES } from "../../../src/journal/composer-drafts";
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
const KEY = `matron:draft:v1:${encodeURIComponent(SESSION.serverUrl)}:${SESSION.userId}`;

beforeEach(() => localStorage.clear());

test("setDraft updates memory but does NOT touch localStorage; persist writes it", () => {
    const s = makeDraftStore(SESSION);
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    s.setDraft("c1", "hello");
    expect(s.read("c1")).toEqual({ text: "hello", ok: true });
    expect(setItem).not.toHaveBeenCalled();
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
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    s.setDraft("c1", "kept");
    expect(() => s.persist()).not.toThrow();
    expect(s.read("c1")).toEqual({ text: "kept", ok: true });
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
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
    });
    expect(s.read("never-written")).toEqual({ text: "", ok: false });
    spy.mockRestore();
});

test("oversized draft stays in memory (navigation-safe) but is omitted from localStorage", () => {
    const s = makeDraftStore(SESSION);
    const big = "x".repeat(MAX_DRAFT_BYTES + 1);
    s.setDraft("c1", big);
    s.setDraft("c2", "small");
    expect(s.read("c1").text).toBe(big);
    s.persist();
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.c1).toBeUndefined();
    expect(stored.c2).toBe("small");
});

test("per-session key isolation", () => {
    const a = makeDraftStore(SESSION);
    a.setDraft("c1", "a");
    a.persist();
    const other: Session = { ...SESSION, userId: 99 };
    expect(makeDraftStore(other).read("c1").text).toBe("");
});

test("entry cap evicts by recency (re-write refreshes position)", () => {
    const s = makeDraftStore(SESSION);
    for (let i = 0; i < 50; i++) s.setDraft(`k${i}`, `v${i}`);
    s.setDraft("k0", "refreshed");
    s.setDraft("k50", "new");
    expect(s.read("k0").text).toBe("refreshed");
    expect(s.read("k1").text).toBe("");
});

test("hydration from a >50-entry blob is capped to MAX_DRAFT_ENTRIES", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 60; i++) big[`k${i}`] = `v${i}`;
    localStorage.setItem(KEY, JSON.stringify(big));
    const s = makeDraftStore(SESSION);
    s.read("k59");
    expect(s.read("k0").text).toBe("");
    expect(s.read("k59").text).toBe("v59");
});

test("clear removes the entry from memory and persists immediately", () => {
    const s = makeDraftStore(SESSION);
    s.setDraft("c1", "x");
    s.persist();
    s.clear("c1");
    expect(s.read("c1").text).toBe("");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({});
});
