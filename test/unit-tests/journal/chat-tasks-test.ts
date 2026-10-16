/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { trackerItem } from "../../../src/journal/__tests__/tracker-fixtures";
import { chatTaskSections, planTaskMove } from "../../../src/journal/tracker/chat-tasks";

describe("chatTaskSections", () => {
    it("splits the items into Needs you, Tasks, Decisions and Done", () => {
        const sections = chatTaskSections([
            trackerItem({ id: "q", num: 1, kind: "question", awaiting: "user", updated_at: 5 }),
            trackerItem({ id: "t2", num: 2, kind: "task", awaiting: null, rank: 20 }),
            trackerItem({ id: "t3", num: 3, kind: "task", awaiting: "user", rank: 10, updated_at: 9 }),
            trackerItem({ id: "d", num: 4, kind: "decision", awaiting: null }),
            trackerItem({ id: "c1", num: 5, kind: "task", state: "closed", awaiting: null, closed_at: 1 }),
            trackerItem({ id: "c2", num: 6, kind: "question", state: "closed", awaiting: null, closed_at: 2 }),
            // An open question waiting on the agent is in no section, as on the Mac.
            trackerItem({ id: "q2", num: 7, kind: "question", awaiting: "agent" }),
        ]);
        expect(sections.needsYou.map((i) => i.id)).toEqual(["t3", "q"]);
        expect(sections.tasks.map((i) => i.id)).toEqual(["t3", "t2"]);
        expect(sections.decisions.map((i) => i.id)).toEqual(["d"]);
        expect(sections.done.map((i) => i.id)).toEqual(["c2", "c1"]);
    });

    it("orders tasks of equal rank by number", () => {
        const sections = chatTaskSections([
            trackerItem({ id: "b", num: 9, kind: "task", rank: 0 }),
            trackerItem({ id: "a", num: 3, kind: "task", rank: 0 }),
        ]);
        expect(sections.tasks.map((i) => i.id)).toEqual(["a", "b"]);
    });
});

describe("planTaskMove", () => {
    const tasks = [
        trackerItem({ id: "a", num: 1, kind: "task", rank: 100 }),
        trackerItem({ id: "b", num: 2, kind: "task", rank: 200 }),
        trackerItem({ id: "c", num: 3, kind: "task", rank: 300 }),
    ];

    it("sends top for a move to the start", () => {
        const plan = planTaskMove(tasks, "c", 0);
        expect(plan?.change).toEqual({ position: "top" });
        expect(plan?.moved.rank).toBeLessThan(100);
    });

    it("sends bottom for a move to the end", () => {
        const plan = planTaskMove(tasks, "a", 2);
        expect(plan?.change).toEqual({ position: "bottom" });
        expect(plan?.moved.rank).toBeGreaterThan(300);
    });

    it("names the new neighbours for a move between two tasks", () => {
        const plan = planTaskMove(tasks, "a", 1);
        expect(plan?.change).toEqual({ after: "b", before: "c" });
        expect(plan?.moved.rank).toBe(250);
    });

    it("is null for a drop in the same place or an unknown task", () => {
        expect(planTaskMove(tasks, "b", 1)).toBeNull();
        expect(planTaskMove(tasks, "zz", 0)).toBeNull();
        expect(planTaskMove(tasks.slice(0, 1), "a", 0)).toBeNull();
    });

    it("clamps an index past either end", () => {
        expect(planTaskMove(tasks, "b", 99)?.change).toEqual({ position: "bottom" });
        expect(planTaskMove(tasks, "b", -3)?.change).toEqual({ position: "top" });
    });
});
