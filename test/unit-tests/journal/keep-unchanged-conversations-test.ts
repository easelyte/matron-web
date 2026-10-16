/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { keepUnchangedConversations } from "../../../src/journal/client";
import { relativeDayLabel, formatRelativeDay } from "../../../src/journal/components";
import type { Conversation } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const conversation = (id: string, fields: Partial<Conversation> = {}): Conversation => ({
    id,
    title: id,
    session_state: "idle",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 1,
    ...fields,
});

describe("keepUnchangedConversations", () => {
    it("returns the previous list when every conversation is unchanged", () => {
        const previous = [conversation("a"), conversation("b")];
        expect(keepUnchangedConversations(previous, [conversation("a"), conversation("b")])).toBe(previous);
    });

    it("keeps the unchanged objects and takes the changed one", () => {
        const previous = [conversation("a"), conversation("b")];
        const changed = conversation("b", { unread_count: 2 });
        const next = keepUnchangedConversations(previous, [conversation("a"), changed]);
        expect(next).not.toBe(previous);
        expect(next[0]).toBe(previous[0]);
        expect(next[1]).toBe(changed);
    });

    it("takes the new order and new conversations", () => {
        const previous = [conversation("a"), conversation("b")];
        const added = conversation("c");
        const next = keepUnchangedConversations(previous, [conversation("b"), added, conversation("a")]);
        expect(next).toEqual([previous[1], added, previous[0]]);
        expect(next[0]).toBe(previous[1]);
    });

    it("treats a field that appears or disappears as a change", () => {
        const previous = [conversation("a")];
        const next = keepUnchangedConversations(previous, [conversation("a", { last_ts: 5 })]);
        expect(next[0]).not.toBe(previous[0]);
        expect(next[0].last_ts).toBe(5);
    });
});

describe("relativeDayLabel", () => {
    it("matches formatRelativeDay, including after the day changes", () => {
        const now = new Date(2026, 5, 10, 12).getTime();
        const morning = new Date(2026, 5, 10, 9, 30).getTime();
        expect(relativeDayLabel(morning, now)).toBe(formatRelativeDay(morning, now));
        const tomorrow = new Date(2026, 5, 11, 12).getTime();
        expect(relativeDayLabel(morning, tomorrow)).toBe(formatRelativeDay(morning, tomorrow));
        expect(relativeDayLabel(morning, tomorrow)).not.toBe(relativeDayLabel(morning, now));
    });
});
