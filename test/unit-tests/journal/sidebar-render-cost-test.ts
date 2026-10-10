/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

import { formatRelativeDay, makeRelativeDayFormatter } from "../../../src/journal/components";
import { childrenOf, groupChildrenByParent, type Conversation } from "../../../src/journal/types";

function convo(id: string, parent: string | null, created: number): Conversation {
    return {
        id,
        title: id,
        session_state: "running",
        last_seq: 0,
        unread_count: 0,
        snippet: "",
        created_at: created,
        parent_convo_id: parent,
        read_up_to_seq: 0,
    };
}

describe("groupChildrenByParent", () => {
    it("matches childrenOf for every parent, including order, self-parents and empty ids", () => {
        const list = [
            convo("p1", null, 1),
            convo("b", "p1", 5),
            convo("a", "p1", 5),
            convo("c", "p1", 2),
            convo("p2", null, 3),
            convo("d", "p2", 9),
            convo("self", "self", 4),
            convo("orphan", "missing", 6),
            convo("blank", "", 7),
        ];
        const grouped = groupChildrenByParent(list);
        for (const parent of ["p1", "p2", "self", "missing", "a", "nope"]) {
            expect(grouped.get(parent) ?? []).toEqual(childrenOf(list, parent));
        }
        expect(grouped.has("")).toBe(false);
    });
});

describe("makeRelativeDayFormatter", () => {
    it("labels exactly like formatRelativeDay across today, this week, this year and older", () => {
        const now = new Date(2026, 8, 26, 15, 0).getTime();
        const format = makeRelativeDayFormatter();
        const day = 86_400_000;
        const samples = [
            now,
            now - 3_600_000,
            now + 60_000,
            now - day,
            now - 6 * day,
            now - 7 * day,
            now - 200 * day,
            now - 400 * day,
            now + 3 * day,
            Number.NaN,
            Number.POSITIVE_INFINITY,
        ];
        for (const timestamp of samples) {
            expect(format(timestamp, now)).toBe(formatRelativeDay(timestamp, now));
        }
    });

    it("builds each Intl formatter at most once per instance", () => {
        const spy = jest.spyOn(Intl, "DateTimeFormat");
        const now = new Date(2026, 8, 26, 15, 0).getTime();
        const format = makeRelativeDayFormatter();
        for (let i = 0; i < 500; i++) format(now - i * 3_600_000, now);
        expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
        spy.mockRestore();
    });
});
