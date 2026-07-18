/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { effectiveUnread, makeIdSetStore } from "../../../src/journal/conversation-flags";
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
