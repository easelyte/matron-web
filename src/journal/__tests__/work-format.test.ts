/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    applyFilters,
    compactAge,
    compareLoops,
    DEFAULT_WORK_FILTERS,
    matchesQuery,
    openedMs,
    ownerLabel,
    plainText,
    spokenAge,
    statusFilterLabel,
} from "../tracker/work-format";
import type { WorkViewGroup, WorkViewLoop } from "../work-view";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-26T12:00:00Z");

function loop(over: Partial<WorkViewLoop> = {}): WorkViewLoop {
    return {
        id: 1,
        title: "t",
        repo: "matron-web",
        domain: "infra",
        priority: 3,
        description: "",
        status: "active",
        claim: null,
        ...over,
    };
}

describe("work-format", () => {
    it("formats a compact age a backlog can be scanned by", () => {
        expect(compactAge(null, NOW)).toBe("");
        expect(compactAge(NOW - 3_600_000, NOW)).toBe("today");
        expect(compactAge(NOW - 3 * DAY, NOW)).toBe("3d");
        expect(compactAge(NOW - 13 * DAY, NOW)).toBe("13d");
        expect(compactAge(NOW - 21 * DAY, NOW)).toBe("3w");
        expect(compactAge(NOW - 90 * DAY, NOW)).toBe("3mo");
        expect(compactAge(NOW - 800 * DAY, NOW)).toBe("2y");
        // A clock-skewed future timestamp never renders a negative age.
        expect(compactAge(NOW + 5 * DAY, NOW)).toBe("today");
    });

    it("speaks the age for accessible names", () => {
        expect(spokenAge(NOW - DAY, NOW)).toBe("opened 1 day ago");
        expect(spokenAge(NOW - 21 * DAY, NOW)).toBe("opened 3 weeks ago");
        expect(spokenAge(NOW, NOW)).toBe("opened today");
        expect(spokenAge(null, NOW)).toBe("");
    });

    it("parses opened only when it is a real timestamp", () => {
        expect(openedMs(loop({ opened: "2026-09-01T00:00:00Z" }))).toBe(Date.parse("2026-09-01T00:00:00Z"));
        expect(openedMs(loop())).toBeNull();
        expect(openedMs(loop({ opened: "garbage" }))).toBeNull();
    });

    it("labels owners and status filters for display", () => {
        expect(ownerLabel("operator")).toBe("Operator");
        expect(ownerLabel("  ")).toBe("");
        expect(ownerLabel(undefined)).toBe("");
        expect(statusFilterLabel("open")).toBe("In play");
        expect(statusFilterLabel("all")).toBe("All statuses");
        expect(statusFilterLabel("blocked")).toBe("Blocked");
    });

    it("strips inline markdown and block markers from preview text", () => {
        expect(plainText("## Heading")).toBe("Heading");
        expect(plainText("- bullet with **bold**")).toBe("bullet with bold");
        expect(plainText("1. step with `code`")).toBe("step with code");
        expect(plainText("see [the spec](https://x.test/a_b)")).toBe("see the spec");
        expect(plainText("an *emphasised* word")).toBe("an emphasised word");
        expect(plainText("keep snake_case_names intact")).toBe("keep snake_case_names intact");
    });

    it("orders by priority (P1 = most urgent first), then oldest first, then id", () => {
        const loops = [
            loop({ id: 5, priority: 3 }),
            loop({ id: 4, priority: 3, opened: "2026-09-10T00:00:00Z" }),
            loop({ id: 3, priority: 3, opened: "2026-09-01T00:00:00Z" }),
            loop({ id: 2, priority: 5 }),
            loop({ id: 1, priority: 1 }),
        ];
        expect([...loops].sort(compareLoops).map((item) => item.id)).toEqual([1, 3, 4, 5, 2]);
    });

    it("is a total order when dated and undated loops are mixed, whatever the input order", () => {
        const a = loop({ id: 1, opened: "2026-09-10T00:00:00Z" });
        const b = loop({ id: 2 });
        const c = loop({ id: 3, opened: "2026-09-01T00:00:00Z" });
        const orders = [
            [a, b, c],
            [c, b, a],
            [b, a, c],
            [b, c, a],
        ].map((input) => [...input].sort(compareLoops).map((item) => item.id));
        for (const order of orders) expect(order).toEqual([3, 1, 2]);
    });

    it("matches every search term, case-insensitively, across the loop's text", () => {
        const subject = loop({
            id: 42,
            title: "Retire the fork hook",
            description: "After the upstream merge.",
            next_action: "Wait on review",
            owner: "claude",
        });
        expect(matchesQuery(subject, "")).toBe(true);
        expect(matchesQuery(subject, "#42")).toBe(true);
        expect(matchesQuery(subject, "FORK upstream")).toBe(true);
        expect(matchesQuery(subject, "review claude")).toBe(true);
        expect(matchesQuery(subject, "fork portal")).toBe(false);
    });

    it("filters, sorts and drops emptied groups without mutating the wire payload", () => {
        const groups: WorkViewGroup[] = [
            {
                key: "a",
                loops: [loop({ id: 2, priority: 1 }), loop({ id: 1, priority: 4 })] as [
                    WorkViewLoop,
                    ...WorkViewLoop[],
                ],
            },
            { key: "b", loops: [loop({ id: 3, status: "parked" })] as [WorkViewLoop, ...WorkViewLoop[]] },
        ];
        const shown = applyFilters(groups, DEFAULT_WORK_FILTERS);
        expect(shown.map((group) => group.key)).toEqual(["a"]);
        expect(shown[0].loops.map((item) => item.id)).toEqual([2, 1]);
        expect(groups[0].loops.map((item) => item.id)).toEqual([2, 1]);
        expect(applyFilters(groups, { ...DEFAULT_WORK_FILTERS, status: "all" })).toHaveLength(2);
    });
});
