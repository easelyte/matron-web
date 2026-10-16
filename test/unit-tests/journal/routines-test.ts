/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    cronWords,
    normalizeRoutinePrompt,
    parseRoutine,
    parseRoutineList,
    type Routine,
    routineErrorMessage,
    routineFormError,
    routineLastFireFailed,
    routineOutcomeWords,
    routineRequestBody,
    routineRunMessage,
    routineSchedulePreview,
    routineStatusLines,
    routineWhenWords,
    triggerThresholdLabel,
    triggerWords,
} from "../../../src/journal/routines";

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();

function routine(over: Partial<Routine> = {}): Routine {
    return {
        id: "rt_1",
        name: "daily-sweep",
        title: "Daily sweep",
        schedule: "5 7 * * *",
        trigger: null,
        tz: "Europe/London",
        prompt: "Run the daily sweep.",
        enabled: true,
        origin: "seed",
        next_at: null,
        last_fired_at: null,
        last_outcome: null,
        created_at: 1,
        updated_at: 2,
        ...over,
    };
}

describe("cronWords", () => {
    it.each([
        ["5 7 * * *", "Every day at 07:05"],
        ["0 8,17 * * *", "Every day at 08:00 and 17:00"],
        ["0 */2 * * *", "Every 2 hours, on the hour"],
        ["15 */3 * * *", "Every 3 hours, at 15 past"],
        ["30 18 * * 1-5", "Monday to Friday at 18:30"],
        ["0 9 * * 1", "Every Monday at 09:00"],
        ["0 9 * * 1,3", "Every Monday and Wednesday at 09:00"],
        ["0 10 1 * *", "On day 1 of the month at 10:00"],
        ["0 10 1 1,7 *", "On day 1 of the month in January and July at 10:00"],
        ["*/30 * * * *", "Every 30 minutes"],
        ["0 * * * *", "Every hour, on the hour"],
        ["0 9 1 * 1", null],
        ["0 9 * *", null],
        ["0 9 L * *", null],
    ])("%s → %s", (cron, words) => {
        expect(cronWords(cron)).toBe(words);
    });
});

describe("routine words", () => {
    it("says what sets a trigger off", () => {
        expect(triggerWords({ kind: "context_over", threshold: 40 })).toBe(
            "When a session passes 40% of its context window",
        );
        expect(triggerWords({ kind: "stalled", threshold: 120 })).toBe(
            "When a session stalls on a usage limit with no reset within 2 h",
        );
        expect(triggerWords({ kind: "stalled", threshold: 90 })).toBe(
            "When a session stalls on a usage limit with no reset within 1 h 30 min",
        );
        expect(triggerWords({ kind: "stalled", threshold: 0 })).toBe("When a session stalls on a usage limit");
        expect(triggerWords({ kind: "disk_under", threshold: 20 })).toBe("When a box drops under 20% free disk");
        expect(triggerThresholdLabel({ kind: "stalled", threshold: 0 })).toBe("Any reset time");
    });

    it("names the zone after a schedule, and falls back to the raw cron", () => {
        expect(routineWhenWords(routine({ schedule: "30 18 * * 1-5", tz: "America/New_York" }))).toBe(
            "Monday to Friday at 18:30 (America/New_York)",
        );
        expect(routineWhenWords(routine({ schedule: "0 9 1 * 1" }))).toBe("Cron 0 9 1 * 1 (Europe/London)");
    });

    it("words the last outcome and flags the ones that did not arrive", () => {
        expect(routineOutcomeWords("applied now")).toBe("Delivered");
        expect(routineOutcomeWords("failed agent_unreachable")).toBe("Failed: agent_unreachable");
        expect(routineOutcomeWords(null)).toBeNull();
        expect(routineLastFireFailed("failed timeout")).toBe(true);
        expect(routineLastFireFailed("missed")).toBe(true);
        expect(routineLastFireFailed("applied deferred")).toBe(false);
    });

    it("shows the next fire only for an active schedule, then the last", () => {
        const next = new Date(2026, 9, 14, 18, 30).getTime();
        expect(routineStatusLines(routine({ next_at: next }), NOW)[0]).toMatch(/^Next: today at (18:30|0?6:30\sPM)$/);
        expect(routineStatusLines(routine({ next_at: next, enabled: false }), NOW)).toEqual(["Never fired"]);
        expect(
            routineStatusLines(routine({ last_fired_at: NOW - 2 * 3_600_000, last_outcome: "applied now" }), NOW),
        ).toEqual(["Last: 2h ago · Delivered"]);
        // A failed outcome gets its own line in the row, not a suffix here.
        expect(routineStatusLines(routine({ last_fired_at: NOW - 60_000, last_outcome: "missed" }), NOW)).toEqual([
            "Last: 1m ago",
        ]);
    });
});

describe("routine rules", () => {
    const error = (over: Partial<Parameters<typeof routineFormError>[1]> & { name?: string } = {}): string | null => {
        const { name = "weekly", ...draft } = over;
        return routineFormError(name, {
            title: "Weekly",
            prompt: "Do it",
            tz: "Europe/London",
            schedule: "0 9 * * 1",
            ...draft,
        });
    };

    it("refuses what the journal would refuse", () => {
        expect(error()).toBeNull();
        expect(error({ name: "Weekly" })).not.toBeNull();
        expect(error({ name: "-weekly" })).not.toBeNull();
        expect(error({ title: "  " })).not.toBeNull();
        expect(error({ title: "two\nlines" })).not.toBeNull();
        expect(error({ prompt: "" })).not.toBeNull();
        expect(error({ prompt: "x".repeat(2001) })).not.toBeNull();
        expect(error({ tz: "Mars/Olympus" })).not.toBeNull();
        expect(error({ schedule: "0 9 * *" })).not.toBeNull();
        expect(error({ schedule: "*/5 * * * *" })).not.toBeNull();
        expect(error({ schedule: "* 9 * * *" })).not.toBeNull();
        expect(error({ schedule: "*/15 * * * *" })).toBeNull();
        expect(
            error({ tz: "Mars/Olympus", schedule: undefined, trigger: { kind: "disk_under", threshold: 20 } }),
        ).toBeNull();
        expect(error({ schedule: undefined, trigger: { kind: "context_over", threshold: 100 } })).not.toBeNull();
        expect(error({ schedule: undefined, trigger: { kind: "stalled", threshold: 20_000 } })).not.toBeNull();
        expect(error({ schedule: undefined, trigger: { kind: "stalled", threshold: 0 } })).toBeNull();
    });

    it("refuses fires under 15 minutes apart however the minute and hour fields spell them", () => {
        expect(error({ schedule: "0,5 9 * * 1" })).not.toBeNull();
        expect(error({ schedule: "0-59/10 9 * * *" })).not.toBeNull();
        expect(error({ schedule: "0,50 9-10 * * *" })).not.toBeNull(); // 09:50 then 10:00
        expect(error({ schedule: "5,55 0,23 * * *" })).not.toBeNull(); // 23:55 then 00:05
        expect(error({ schedule: "0,30 * * * *" })).toBeNull();
        expect(error({ schedule: "5-59/20 * * * *" })).toBeNull();
        expect(error({ schedule: "0 */2 * * *" })).toBeNull();
        expect(error({ schedule: "5,55 0,23 * * 1" })).toBeNull(); // Mondays only: 23:55 is never followed by 00:05
        expect(error({ schedule: "0 9 L * *" })).toBeNull(); // the journal's call
    });

    it("counts and cleans the title and prompt as the journal does", () => {
        expect(error({ title: "tab\there" })).not.toBeNull();
        expect(error({ title: "line\u2028break" })).not.toBeNull();
        // UTF-16 code units, not characters: 101 emoji are 202 units.
        expect(error({ title: "\u{1F600}".repeat(100) })).toBeNull();
        expect(error({ title: "\u{1F600}".repeat(101) })).not.toBeNull();
        expect(error({ prompt: "\u0001\u0002 " })).not.toBeNull();
        expect(error({ prompt: `${"x".repeat(2000)}\u0001` })).toBeNull();
        expect(normalizeRoutinePrompt(" one\r\ntwo\rthree\u2028four\u0007 ")).toBe("one\ntwo\nthree\nfour");
    });

    it("previews the schedule, or why it can't be sent", () => {
        expect(routineSchedulePreview("0 9 * * 1-5")).toBe("Monday to Friday at 09:00");
        expect(routineSchedulePreview("*/5 * * * *")).toBe("A routine fires at most every 15 minutes.");
        expect(routineSchedulePreview("0 9 L * *")).toBe("Runs on the cron schedule 0 9 L * *.");
    });
});

describe("routine wire", () => {
    const row = {
        id: "rt_2",
        name: "disk-low",
        title: "Disk low",
        schedule: null,
        trigger: { kind: "disk_under", pct: 20 },
        tz: "Europe/London",
        prompt: "Look at the box.",
        enabled: false,
        origin: "seed",
        next_at: null,
        last_fired_at: 5,
        last_outcome: "applied now",
        created_at: 1,
        updated_at: 2,
    };

    it("parses a triggered row and drops ones it can't read", () => {
        expect(parseRoutine(row)).toMatchObject({ trigger: { kind: "disk_under", threshold: 20 }, enabled: false });
        expect(parseRoutine({ ...row, trigger: { kind: "moon_phase" } })).toBeNull();
        expect(parseRoutine({ ...row, schedule: "0 9 * * *" })).toBeNull();
        expect(parseRoutine({ ...row, created_at: undefined })).toBeNull();
        expect(parseRoutine({ ...row, trigger: { kind: "stalled" } })?.trigger).toEqual({
            kind: "stalled",
            threshold: 120,
        });
    });

    it("sorts the list by name and refuses a body without one", () => {
        const list = parseRoutineList({ routines: [row, { ...row, id: "rt_3", name: "context-over" }, { bad: 1 }] });
        expect(list?.map((entry) => entry.name)).toEqual(["context-over", "disk-low"]);
        expect(parseRoutineList({})).toBeNull();
    });

    it("sends the zone with a schedule only, and the trigger in wire shape", () => {
        expect(
            routineRequestBody({ title: " Weekly ", prompt: "Go\n", tz: "Europe/Paris", schedule: "0  9 * * 1" }),
        ).toEqual({ title: "Weekly", prompt: "Go", schedule: "0 9 * * 1", tz: "Europe/Paris" });
        expect(
            routineRequestBody({
                title: "Stalled",
                prompt: "Look",
                tz: "Europe/London",
                trigger: { kind: "stalled", threshold: 60 },
                enabled: false,
            }),
        ).toEqual({
            title: "Stalled",
            prompt: "Look",
            trigger: { kind: "stalled", reset_minutes: 60 },
            enabled: false,
        });
    });

    it("words the journal's refusals and run answers", () => {
        expect(routineErrorMessage(404, undefined, true)).toMatch(/doesn't have routines/);
        expect(routineErrorMessage(404, undefined, false)).toMatch(/no longer exists/);
        expect(routineErrorMessage(409, { blocked_by: "cap" }, true)).toMatch(/50 routines/);
        expect(routineErrorMessage(409, { blocked_by: "name" }, true)).toMatch(/already exists/);
        expect(routineErrorMessage(500, undefined, true)).toBeNull();
        expect(routineRunMessage({ accepted: true })).toBeNull();
        expect(routineRunMessage({ delivered: false, reason: "no_coordinator" })).toMatch(/no Coordinator/);
        expect(routineRunMessage({ delivered: false, reason: "busy" })).toMatch(/busy/);
        expect(routineRunMessage({ delivered: false, reason: "no_firer" })).toBe("Not sent (no_firer).");
    });
});
