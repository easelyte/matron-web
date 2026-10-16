/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Coordinator routines (journal "Coordinator routines", GET/POST/PATCH/DELETE /routines and
 * POST /routines/:key/run): prompts the journal fires into the user's Coordinator conversation on
 * a schedule, or when a trigger trips. This module is the pure half of the Routines sheet, after
 * the Mac's Routine model: parsing, the plain-words schedule and trigger, the last fire's outcome,
 * and the journal's field rules restated so the editor refuses a bad value with a reason before
 * any request goes out (the journal answers a bare 400 for every one of them).
 */

import { dateTimeFormat } from "./date-format";
import { formatRelativeTime } from "./tracker/format";

export type RoutineTriggerKind = "context_over" | "stalled" | "disk_under";

/** What a triggered routine fires on instead of a clock; `threshold` is `pct` or `reset_minutes`. */
export interface RoutineTrigger {
    kind: RoutineTriggerKind;
    threshold: number;
}

export interface Routine {
    id: string;
    /** Slug, unique per user, not editable. */
    name: string;
    title: string;
    /** Five cron fields evaluated in `tz`; null for a triggered routine. */
    schedule: string | null;
    trigger: RoutineTrigger | null;
    tz: string;
    prompt: string;
    enabled: boolean;
    /** `seed`, `user` or `agent`. */
    origin: string;
    /** The next scheduled fire (ms); null while paused, and always for a triggered routine. */
    next_at: number | null;
    last_fired_at: number | null;
    /** `applied now`, `applied deferred`, `failed <code>`, `no_coordinator` or `missed`. */
    last_outcome: string | null;
    created_at: number;
    updated_at: number;
}

/** What a create or edit sends. On an edit an absent key leaves the field alone. */
export interface RoutineDraft {
    title: string;
    prompt: string;
    tz: string;
    schedule?: string;
    trigger?: RoutineTrigger;
    enabled?: boolean;
}

export const ROUTINE_TRIGGER_KINDS: ReadonlyArray<{ kind: RoutineTriggerKind; label: string; initial: number }> = [
    { kind: "context_over", label: "Session context", initial: 40 },
    { kind: "stalled", label: "Stalled session", initial: 120 },
    { kind: "disk_under", label: "Low disk", initial: 20 },
];

/** The journal's routine rules (`src/routines.js`). */
export const RoutineRules = {
    maxRoutines: 50,
    titleMaxLength: 200,
    promptMaxLength: 2000,
    stalledMaxMinutes: 7 * 24 * 60,
    defaultZone: "Europe/London",
    /** Consecutive fires at least this far apart. */
    minGapMinutes: 15,
} as const;

export const ROUTINES_CAPTION =
    "Prompts the journal sends your Coordinator on a schedule, or when something needs a look. Pause one to stop it without losing it.";

const TRIGGER_KINDS = new Set<string>(ROUTINE_TRIGGER_KINDS.map(({ kind }) => kind));

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseRoutineTrigger(raw: unknown): RoutineTrigger | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const kind = value.kind;
    if (typeof kind !== "string" || !TRIGGER_KINDS.has(kind)) return null;
    if (kind === "stalled") return { kind, threshold: finite(value.reset_minutes) ?? 120 };
    const pct = finite(value.pct);
    return pct === null ? null : { kind: kind as RoutineTriggerKind, threshold: pct };
}

export function routineTriggerJson(trigger: RoutineTrigger): Record<string, unknown> {
    return trigger.kind === "stalled"
        ? { kind: "stalled", reset_minutes: trigger.threshold }
        : { kind: trigger.kind, pct: trigger.threshold };
}

/**
 * One row of `GET /routines`, or null when a field the list needs is missing or the row has
 * neither a schedule nor a trigger this build understands: the caller drops it rather than guess.
 */
export function parseRoutine(raw: unknown): Routine | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const { id, name, title, prompt } = value;
    const created = finite(value.created_at);
    const updated = finite(value.updated_at);
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) return null;
    if (typeof title !== "string" || typeof prompt !== "string" || created === null || updated === null) return null;
    const schedule = typeof value.schedule === "string" && value.schedule ? value.schedule : null;
    const trigger = parseRoutineTrigger(value.trigger);
    if ((schedule === null) === (trigger === null)) return null;
    return {
        id,
        name,
        title,
        schedule,
        trigger,
        tz: typeof value.tz === "string" && value.tz ? value.tz : RoutineRules.defaultZone,
        prompt,
        enabled: typeof value.enabled === "boolean" ? value.enabled : true,
        origin: typeof value.origin === "string" ? value.origin : "user",
        next_at: finite(value.next_at),
        last_fired_at: finite(value.last_fired_at),
        last_outcome: typeof value.last_outcome === "string" ? value.last_outcome : null,
        created_at: created,
        updated_at: updated,
    };
}

/** `{routines}` sorted by name (the journal's order); null for a malformed answer. */
export function parseRoutineList(raw: unknown): Routine[] | null {
    const rows = raw && typeof raw === "object" ? (raw as { routines?: unknown }).routines : undefined;
    if (!Array.isArray(rows)) return null;
    return sortRoutines(rows.map(parseRoutine).filter((routine): routine is Routine => routine !== null));
}

export function sortRoutines(routines: Routine[]): Routine[] {
    return [...routines].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The request body. A triggered routine sends no zone on an edit: it has no clock. */
export function routineRequestBody(draft: RoutineDraft): Record<string, unknown> {
    const body: Record<string, unknown> = { title: draft.title.trim(), prompt: normalizeRoutinePrompt(draft.prompt) };
    if (draft.schedule !== undefined) {
        body.schedule = draft.schedule.trim().split(/\s+/).join(" ");
        body.tz = draft.tz;
    }
    if (draft.trigger) body.trigger = routineTriggerJson(draft.trigger);
    if (draft.enabled !== undefined) body.enabled = draft.enabled;
    return body;
}

/** "45 min", "2 h", "1 h 30 min", "3 d". */
export function routineDuration(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;
    if (minutes % 1440 === 0) return `${minutes / 1440} d`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function triggerWords(trigger: RoutineTrigger): string {
    switch (trigger.kind) {
        case "context_over":
            return `When a session passes ${trigger.threshold}% of its context window`;
        case "stalled":
            return trigger.threshold > 0
                ? `When a session stalls on a usage limit with no reset within ${routineDuration(trigger.threshold)}`
                : "When a session stalls on a usage limit";
        case "disk_under":
            return `When a box drops under ${trigger.threshold}% free disk`;
    }
}

/** The editor's label for a trigger's one number. */
export function triggerThresholdLabel(trigger: RoutineTrigger): string {
    switch (trigger.kind) {
        case "context_over":
            return `${trigger.threshold}% of the context window`;
        case "disk_under":
            return `${trigger.threshold}% free disk`;
        case "stalled":
            return trigger.threshold === 0 ? "Any reset time" : `No reset within ${routineDuration(trigger.threshold)}`;
    }
}

export function triggerThresholdRange(kind: RoutineTriggerKind): { min: number; max: number; step: number } {
    return kind === "stalled"
        ? { min: 0, max: RoutineRules.stalledMaxMinutes, step: 30 }
        : { min: 1, max: 99, step: 1 };
}

// ── Plain words for the five-field cron ───────────────────────────────────────────────────────
// Enough for the shapes people write ("5 7 * * *", "0 */2 * * *", "30 18 * * 1-5"); null for
// anything it can't say plainly, and the caller shows the raw fields instead.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

function joinWords(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? "";
    return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function intField(text: string): number | null {
    return /^\d+$/.test(text) ? Number(text) : null;
}

/** "5", "8,17", "1-3", "8,12-14" → the sorted numbers; null for steps, names or out of range. */
function numberList(field: string, min: number, max: number): number[] | null {
    const out = new Set<number>();
    for (const part of field.split(",")) {
        const bounds = part.split("-");
        const a = intField(bounds[0]);
        if (bounds.length === 1 && a !== null && a >= min && a <= max) {
            out.add(a);
            continue;
        }
        const b = bounds.length === 2 ? intField(bounds[1]) : null;
        if (a === null || b === null || a < min || b > max || a > b || b - a >= 24) return null;
        for (let n = a; n <= b; n++) out.add(n);
    }
    return out.size ? [...out].sort((x, y) => x - y) : null;
}

function stepOf(field: string): number | null {
    if (!field.startsWith("*/")) return null;
    const step = intField(field.slice(2));
    return step !== null && step > 0 ? step : null;
}

function timeWords(minute: string, hour: string): { text: string; interval: boolean } | null {
    const minuteStep = stepOf(minute);
    if (minuteStep !== null && hour === "*") return { text: `every ${minuteStep} minutes`, interval: true };
    const minutes = numberList(minute, 0, 59);
    if (!minutes) return null;
    if (hour === "*") {
        if (minutes.length !== 1) return null;
        return {
            text: minutes[0] === 0 ? "every hour, on the hour" : `every hour at ${minutes[0]} past`,
            interval: true,
        };
    }
    const hourStep = stepOf(hour);
    if (hourStep !== null && minutes.length === 1) {
        const at = minutes[0] === 0 ? "on the hour" : `at ${minutes[0]} past`;
        return { text: hourStep === 1 ? `every hour, ${at}` : `every ${hourStep} hours, ${at}`, interval: true };
    }
    const hours = numberList(hour, 0, 23);
    if (!hours) return null;
    const pad = (n: number): string => String(n).padStart(2, "0");
    const times = hours.flatMap((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`));
    if (times.length > 6) return null;
    return { text: `at ${joinWords(times)}`, interval: false };
}

function weekdayWords(field: string): string | null {
    if (field === "1-5") return "Monday to Friday";
    if (field === "0,6" || field === "6,0" || field === "6-7") return "Saturday and Sunday";
    const range = field.split("-");
    if (range.length === 2) {
        const a = intField(range[0]);
        const b = intField(range[1]);
        if (a !== null && b !== null && a <= 7 && b <= 7 && a < b) return `${DAY_NAMES[a % 7]} to ${DAY_NAMES[b % 7]}`;
    }
    const days = numberList(field, 0, 7);
    return days ? `Every ${joinWords(days.map((day) => DAY_NAMES[day % 7]))}` : null;
}

export function cronWords(schedule: string): string | null {
    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const [minute, hour, dom, month, dow] = fields;
    const time = timeWords(minute, hour);
    if (!time) return null;
    let days: string;
    if (dom === "*" && dow === "*") {
        days = "Every day";
    } else if (dom === "*") {
        const words = weekdayWords(dow);
        if (!words) return null;
        days = words;
    } else if (dow === "*") {
        const list = numberList(dom, 1, 31);
        if (!list) return null;
        days = `On day ${joinWords(list.map(String))} of the month`;
    } else {
        return null;
    }
    if (month !== "*") {
        const months = numberList(month, 1, 12);
        if (!months) return null;
        days += ` in ${joinWords(months.map((m) => MONTH_NAMES[m - 1]))}`;
    }
    // "Every 2 hours, every day" reads badly: drop "every day" there.
    if (days === "Every day" && time.interval) return time.text.charAt(0).toUpperCase() + time.text.slice(1);
    return `${days} ${time.text}`;
}

/** What sets it off: "Every day at 07:05 (Europe/London)", or the trigger's sentence. */
export function routineWhenWords(routine: Pick<Routine, "schedule" | "trigger" | "tz">): string {
    if (routine.trigger) return triggerWords(routine.trigger);
    if (!routine.schedule) return "";
    return `${cronWords(routine.schedule) ?? `Cron ${routine.schedule}`} (${routine.tz})`;
}

/** The last fire's outcome in words: "Delivered", "Missed", "Failed: agent_unreachable"… */
export function routineOutcomeWords(outcome: string | null | undefined): string | null {
    const value = outcome?.trim();
    if (!value) return null;
    switch (value) {
        case "applied now":
            return "Delivered";
        case "applied deferred":
            return "Queued for the next idle point";
        case "missed":
            return "Missed";
        case "no_coordinator":
            return "Not delivered: no Coordinator box";
    }
    if (value.startsWith("failed")) {
        const code = value.slice("failed".length).trim();
        return code ? `Failed: ${code}` : "Failed";
    }
    return value;
}

/** Whether the last fire did not reach the Coordinator. */
export function routineLastFireFailed(outcome: string | null | undefined): boolean {
    if (!outcome) return false;
    return outcome === "missed" || outcome === "no_coordinator" || outcome.startsWith("failed");
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "today at 18:30", "tomorrow at 07:05", "Mon 20 Oct at 08:00" (the browser's zone). */
export function routineWhen(ms: number, now: number): string {
    const date = new Date(ms);
    const time = dateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
    const today = new Date(now);
    if (sameDay(date, today)) return `today at ${time}`;
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (sameDay(date, tomorrow)) return `tomorrow at ${time}`;
    const day = dateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(date);
    return `${day} at ${time}`;
}

/** "Next: today at 18:30" (scheduled and active), then "Last: 2h ago · Delivered" or "Never fired". */
export function routineStatusLines(routine: Routine, now: number): string[] {
    const lines: string[] = [];
    if (routine.next_at !== null && routine.enabled && !routine.trigger) {
        lines.push(`Next: ${routineWhen(routine.next_at, now)}`);
    }
    if (routine.last_fired_at !== null) {
        let line = `Last: ${formatRelativeTime(routine.last_fired_at, now)}`;
        const outcome = routineOutcomeWords(routine.last_outcome);
        // A failed outcome gets its own warning line instead.
        if (outcome && !routineLastFireFailed(routine.last_outcome)) line += ` · ${outcome}`;
        lines.push(line);
    } else {
        lines.push("Never fired");
    }
    return lines;
}

// ── Field rules ───────────────────────────────────────────────────────────────────────────────

export function isValidRoutineName(name: string): boolean {
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

export function isValidZone(tz: string): boolean {
    if (!tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * A minute or hour field as the sorted values it matches: "5", "8,17", "1-3", "*", and steps on
 * "*" or a range ("10-50/20"). Null for anything else (names, "?", "L"): the journal then has the last word.
 */
function cronValues(field: string, min: number, max: number): number[] | null {
    const out = new Set<number>();
    for (const part of field.split(",")) {
        const [range, stepText, extra] = part.split("/");
        if (extra !== undefined) return null;
        const step = stepText === undefined ? 1 : intField(stepText);
        if (step === null || step < 1) return null;
        let from: number | null;
        let to: number | null;
        if (range === "*") {
            from = min;
            to = max;
        } else {
            const bounds = range.split("-");
            if (bounds.length > 2) return null;
            // croner refuses a step on a bare start ("5/20"): left to the journal's 400.
            if (bounds.length === 1 && stepText !== undefined) return null;
            from = intField(bounds[0]);
            to = bounds.length === 2 ? intField(bounds[1]) : from;
        }
        if (from === null || to === null || from < min || to > max || from > to) return null;
        for (let n = from; n <= to; n += step) out.add(n);
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
}

/**
 * Whether two fires of this schedule can land under `minGapMinutes` apart within a day (and
 * across midnight when it runs every day). Null when a field is beyond `cronValues`.
 */
function firesTooClose(fields: string[]): boolean | null {
    const minutes = cronValues(fields[0], 0, 59);
    const hours = cronValues(fields[1], 0, 23);
    if (!minutes || !hours) return null;
    const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
    const gap = RoutineRules.minGapMinutes;
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < gap) return true;
    const everyDay = fields[2] === "*" && fields[4] === "*";
    return everyDay && times.length > 1 && 1440 - times[times.length - 1] + times[0] < gap;
}

/**
 * Why this schedule can't be sent, or null. The journal refuses a schedule whose consecutive
 * fires come under 15 minutes apart: this checks the minute and hour fields for that, and the
 * journal still has the last word (a date that never comes, a field it can't read).
 */
export function routineScheduleError(schedule: string): string | null {
    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5 || !fields[0]) {
        return "A schedule is five cron fields: minute, hour, day of month, month and day of week.";
    }
    const minute = fields[0];
    const step = stepOf(minute);
    if (minute === "*" || (step !== null && step < RoutineRules.minGapMinutes) || firesTooClose(fields)) {
        return `A routine fires at most every ${RoutineRules.minGapMinutes} minutes.`;
    }
    return null;
}

// The journal's own normalising (src/routines.js): a title is one line with no control
// characters; a prompt keeps its line breaks (CR, CRLF, NEL, U+2028/9 folded to \n) and loses
// every other control character. Both count UTF-16 code units, as the journal does.
// eslint-disable-next-line no-control-regex -- the control range is the point
const TITLE_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex -- the control range is the point
const PROMPT_BAD = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;

/** The prompt as the journal stores it. */
export function normalizeRoutinePrompt(prompt: string): string {
    return prompt
        .replace(/\r\n|\r|\u0085|\u2028|\u2029/g, "\n")
        .replace(PROMPT_BAD, "")
        .trim();
}

/** Why this form can't be saved, or null. */
export function routineFormError(name: string, draft: RoutineDraft): string | null {
    if (!isValidRoutineName(name)) {
        return "The name must be lowercase letters, digits and dashes, start with a letter or digit, and be at most 64 characters.";
    }
    const title = draft.title.trim();
    if (!title) return "Give the routine a title.";
    if (title.length > RoutineRules.titleMaxLength) {
        return `The title can be at most ${RoutineRules.titleMaxLength} characters.`;
    }
    if (TITLE_BAD.test(title)) return "The title must be one line, with no control characters.";
    const prompt = normalizeRoutinePrompt(draft.prompt);
    if (!prompt) return "Write the prompt the Coordinator receives.";
    if (prompt.length > RoutineRules.promptMaxLength) {
        return `The prompt can be at most ${RoutineRules.promptMaxLength} characters.`;
    }
    if (draft.schedule !== undefined) {
        if (!isValidZone(draft.tz)) return `"${draft.tz}" is not a time zone. Use a name such as Europe/London.`;
        const problem = routineScheduleError(draft.schedule);
        if (problem) return problem;
    }
    if (draft.trigger) {
        const { min, max } = triggerThresholdRange(draft.trigger.kind);
        const value = draft.trigger.threshold;
        if (!Number.isInteger(value) || value < min || value > max) {
            return draft.trigger.kind === "stalled"
                ? `The reset window is 0 to ${max} minutes.`
                : `The threshold is a percentage from ${min} to ${max}.`;
        }
    }
    return null;
}

/** The plain-words preview under the editor's cron fields. */
export function routineSchedulePreview(schedule: string): string {
    return routineScheduleError(schedule) ?? cronWords(schedule) ?? `Runs on the cron schedule ${schedule.trim()}.`;
}

// ── Journal answers in words ──────────────────────────────────────────────────────────────────

export const ROUTINES_UNSUPPORTED = "This journal doesn't have routines yet. Update the journal server to use them.";

/**
 * A failed routines request in the words the sheet shows. `collection` is the list/create route,
 * where 404 means the journal predates routines; on one routine it means deleted elsewhere.
 */
export function routineErrorMessage(status: number, body: Record<string, unknown> | undefined, collection: boolean) {
    if (status === 404) {
        return collection
            ? ROUTINES_UNSUPPORTED
            : "That routine no longer exists. It may have been deleted on another device.";
    }
    if (status === 409 && body?.blocked_by === "cap") {
        return `You already have ${RoutineRules.maxRoutines} routines, the most the journal keeps. Delete one first.`;
    }
    if (status === 409) return "A routine with that name already exists. Choose another name.";
    if (status === 400) {
        return `The journal refused that routine. A schedule must fire at least ${RoutineRules.minGapMinutes} minutes apart and keep firing, the zone must be a real time zone, and a routine has either a schedule or a trigger, never both.`;
    }
    return null;
}

/** `POST /routines/:key/run`'s answer: null once accepted, otherwise why it was not sent. */
export function routineRunMessage(raw: unknown): string | null {
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (value.accepted === true) return null;
    const reason = typeof value.reason === "string" ? value.reason : "unknown";
    if (reason === "no_coordinator") return "Not sent: there is no Coordinator to run it.";
    if (reason === "busy") return "Not sent: the journal is busy firing other routines. Try again in a moment.";
    return `Not sent (${reason}).`;
}
