/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot } from "react-dom/client";

import { MatronJournalClient } from "../client";
import { ItemsInbox, spareAllowanceBacklog } from "../tracker/ItemsInbox";
import {
    parseRoutineTrigger,
    routineFormError,
    routineTriggerJson,
    triggerWords,
    triggerThresholdLabel,
} from "../routines";
import type { TrackerItem } from "../types";
import { trackerItem } from "./tracker-fixtures";

const task = (num: number, rank: number, labels: string[], over: Partial<TrackerItem> = {}): TrackerItem =>
    trackerItem({ id: `it_${num}`, num, kind: "task", awaiting: "agent", rank, title: `Task ${num}`, labels, ...over });

describe("spare-allowance backlog", () => {
    const items = [
        task(1, 3, ["spare-allowance"]),
        task(2, 1, ["spare-allowance", "dispatched"]),
        task(3, 2, []),
        task(4, 0, ["spare-allowance"], { state: "closed", resolution: "done" }),
        trackerItem({ id: "it_5", num: 5, kind: "question", labels: ["spare-allowance"] }),
    ];

    it("lists open tasks with the label in task order", () => {
        expect(spareAllowanceBacklog(items).map((item) => item.num)).toEqual([2, 1]);
    });

    it("shows them under the Spare allowance tab", async () => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () =>
            root.render(<ItemsInbox items={items} client={new MatronJournalClient()} onOpenItem={jest.fn()} />),
        );
        const tab = [...container.querySelectorAll<HTMLButtonElement>(".mj_TrackerToggleTab")].find(
            (button) => button.textContent === "Spare allowance",
        )!;
        await act(async () => tab.click());
        const text = container.textContent ?? "";
        expect(text).toContain("Task 2");
        expect(text).toContain("Task 1");
        expect(text.indexOf("Task 2")).toBeLessThan(text.indexOf("Task 1"));
        expect(text).not.toContain("Task 3");
        await act(async () => root.unmount());
        container.remove();
    });
});

describe("allowance_expiring trigger", () => {
    it("parses with the journal's default window and keeps it on the way back", () => {
        const trigger = parseRoutineTrigger({ kind: "allowance_expiring", pct: 70, from_hours: 6, to_hours: 12 })!;
        expect(trigger).toEqual({ kind: "allowance_expiring", threshold: 70, fromHours: 6, toHours: 12 });
        expect(routineTriggerJson({ ...trigger, threshold: 60 })).toEqual({
            kind: "allowance_expiring",
            pct: 60,
            from_hours: 6,
            to_hours: 12,
        });
        expect(routineTriggerJson({ kind: "allowance_expiring", threshold: 60 })).toEqual({
            kind: "allowance_expiring",
            pct: 60,
        });
        expect(triggerWords(trigger)).toBe("When a weekly limit resets within 6–12 h and is under 70%");
        expect(triggerThresholdLabel(trigger)).toBe("Weekly limit under 70%");
        expect(parseRoutineTrigger({ kind: "allowance_expiring" })).toBeNull();
    });

    it("parses tiers and sends them back in the journal's words", () => {
        const raw = {
            kind: "allowance_expiring",
            tiers: [
                { unused_pct: 50, hours_left: 12 },
                { unused_pct: 25, hours_left: 2 },
            ],
        };
        const trigger = parseRoutineTrigger(raw)!;
        expect(trigger.tiers).toEqual([
            { unusedPct: 50, hoursLeft: 12 },
            { unusedPct: 25, hoursLeft: 2 },
        ]);
        expect(routineTriggerJson(trigger)).toEqual(raw);
        expect(triggerWords(trigger)).toBe(
            "When a weekly limit has 50% unused with 12 h left or 25% unused with 2 h left",
        );
        expect(parseRoutineTrigger({ kind: "allowance_expiring", tiers: [] })).toBeNull();
        expect(parseRoutineTrigger({ kind: "allowance_expiring", tiers: [{ unused_pct: 50 }] })).toBeNull();
    });

    it("checks every tier before saving", () => {
        const draft = (tiers: Array<{ unusedPct: number; hoursLeft: number }>) =>
            routineFormError("spare", {
                title: "Spare",
                prompt: "p",
                tz: "Europe/London",
                trigger: { kind: "allowance_expiring", threshold: tiers[0]?.unusedPct ?? 0, tiers },
            });
        expect(draft([{ unusedPct: 50, hoursLeft: 12 }])).toBeNull();
        expect(draft([])).toMatch(/1 to 4 tiers/);
        expect(
            draft([
                { unusedPct: 50, hoursLeft: 12 },
                { unusedPct: 25, hoursLeft: NaN },
            ]),
        ).toMatch(/hours left/);
        expect(draft([{ unusedPct: 50, hoursLeft: 0 }])).toMatch(/hours left/);
        expect(
            draft([
                { unusedPct: 50, hoursLeft: 12 },
                { unusedPct: 100, hoursLeft: 2 },
            ]),
        ).toMatch(/unused share/);
    });
});
