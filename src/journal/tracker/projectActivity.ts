/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// The project page's merged "Latest" feed and headline words, pure so each is a plain test and
// the web page says them the way the Mac and iOS pages do: milestones, decisions and answered
// questions, files, and the questions or notices posted for the user, in one newest-first list.

import { dateTimeFormat } from "../date-format";
import type {
    Milestone,
    MissionItemRef,
    Project,
    ProjectDecisionRow,
    ProjectDetail,
    ProjectFeedKind,
    ProjectFeedPage,
    ProjectFileRow,
} from "../types";
import { oneLine } from "./format";

export type ActivityEvent =
    | { kind: "milestone"; id: string; at: number; missionNum: number | null; milestone: Milestone }
    | { kind: "decision"; id: string; at: number; missionNum: number | null; decision: ProjectDecisionRow }
    | { kind: "file"; id: string; at: number; missionNum: number | null; file: ProjectFileRow }
    | {
          kind: "item";
          id: string;
          at: number;
          missionNum: number | null;
          item: MissionItemRef & { mission_num: number };
      };

/** Rows shown before the first "Show more". */
export const FIRST_PAGE_LIMIT = 12;
/** Rows each "Show more" adds while rows are already loaded. */
export const SHOW_MORE_STEP = 24;

const KIND_RANK: Record<ActivityEvent["kind"], number> = { milestone: 0, decision: 1, item: 2, file: 3 };

/** A file's row id: one blob can be posted twice (two comments, or a chat image and a comment). */
export function fileRowId(file: ProjectFileRow): string {
    return "item_num" in file.source
        ? `item:${file.source.item_num}:${file.blob_id}`
        : `chat:${file.source.convo_id}:${file.source.seq}`;
}

/** When a decision entered the roll-up: an answered question when it closed, a decision when
 *  it was recorded. */
export function decisionAt(decision: ProjectDecisionRow): number {
    return decision.kind === "question" ? (decision.closed_at ?? decision.created_at) : decision.created_at;
}

/** Whether an item belongs in the feed: a question or a notice (something posted for the user).
 *  Tasks stay out (they doubled up with the milestones that report them) and decisions have the
 *  roll-up. */
export function isFeedItem(item: Pick<MissionItemRef, "kind">): boolean {
    return item.kind === "question" || item.kind === "notice";
}

/** The milestones the feed draws on: the roll-up's page, else the detail's latest few. */
function feedMilestones(detail: ProjectDetail): Array<Milestone & { mission_num: number | null }> {
    return detail.milestones ? detail.milestones.rows : detail.recent_milestones;
}

/** Every event the detail holds, newest first; at the same instant by kind, then by id. The
 *  detail's items are the needs-you rows, which carry only `updated_at`, so that is their time. */
// (Undated files are left out below; the horizon ignores them too.)
export function activityEvents(detail: ProjectDetail): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    for (const milestone of feedMilestones(detail)) {
        events.push({
            kind: "milestone",
            id: `milestone:${milestone.id}`,
            at: milestone.created_at,
            missionNum: milestone.mission_num ?? null,
            milestone,
        });
    }
    for (const decision of detail.decisions?.rows ?? []) {
        events.push({
            kind: "decision",
            id: `decision:${decision.id}`,
            at: decisionAt(decision),
            missionNum: decision.mission_num ?? null,
            decision,
        });
    }
    // A file the journal sent no posted_at for has no place in time: it stays in the Files fold.
    for (const file of detail.files?.rows ?? []) {
        if (!file.posted_at) continue;
        events.push({
            kind: "file",
            id: `file:${fileRowId(file)}`,
            at: file.posted_at,
            missionNum: file.mission_num ?? null,
            file,
        });
    }
    for (const item of detail.needs_you) {
        if (!isFeedItem(item)) continue;
        events.push({ kind: "item", id: `item:${item.id}`, at: item.updated_at, missionNum: item.mission_num, item });
    }
    return events.sort((a, b) => b.at - a.at || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id));
}

/** The instant the feed is complete back to: the newest "oldest loaded row" among the kinds that
 *  still have pages to load. Older rows of the other kinds wait for those pages, so the list never
 *  shows a month of decisions beside a day of milestones. Null when every kind is fully loaded. */
export function activityHorizon(detail: ProjectDetail): number | null {
    const oldest: number[] = [];
    const milestones = detail.milestones;
    if (milestones?.next_before && milestones.rows.length)
        oldest.push(milestones.rows[milestones.rows.length - 1].created_at);
    const decisions = detail.decisions;
    if (decisions?.next_before && decisions.rows.length)
        oldest.push(decisionAt(decisions.rows[decisions.rows.length - 1]));
    const files = detail.files;
    const lastFile = files?.rows[files.rows.length - 1];
    if (files?.next_before && lastFile?.posted_at) oldest.push(lastFile.posted_at);
    return oldest.length ? Math.max(...oldest) : null;
}

/** The feed as the page shows it: the events at or after the horizon, cut to `limit` when set. */
export function activityRows(detail: ProjectDetail, limit: number | null): ActivityEvent[] {
    const horizon = activityHorizon(detail);
    const visible = activityEvents(detail).filter((event) => horizon == null || event.at >= horizon);
    return limit == null ? visible : visible.slice(0, limit);
}

/** The kinds "Show more" fetches another page of: every kind with a cursor left. */
export function kindsWithMore(detail: ProjectDetail): ProjectFeedKind[] {
    const kinds: ProjectFeedKind[] = [];
    if (detail.milestones?.next_before) kinds.push("milestones");
    if (detail.decisions?.next_before) kinds.push("decisions");
    if (detail.files?.next_before) kinds.push("files");
    return kinds;
}

/** Whether "Show more" has anything to do: rows held back by the fold or the horizon, or pages
 *  still to load. */
export function activityHasMore(detail: ProjectDetail, limit: number | null): boolean {
    return activityRows(detail, limit).length < activityEvents(detail).length || kindsWithMore(detail).length > 0;
}

/** The detail with one more page of `kind` appended (rows already there are skipped). */
export function appendFeedPage(
    detail: ProjectDetail,
    kind: ProjectFeedKind,
    page: ProjectFeedPage<unknown>,
): ProjectDetail {
    switch (kind) {
        case "decisions": {
            const have = detail.decisions;
            if (!have) return detail;
            const next = page as ProjectFeedPage<ProjectDecisionRow>;
            const seen = new Set(have.rows.map((row) => row.id));
            return {
                ...detail,
                decisions: {
                    total: have.total,
                    rows: [...have.rows, ...next.rows.filter((row) => !seen.has(row.id))],
                    next_before: next.next_before,
                },
            };
        }
        case "files": {
            const have = detail.files;
            if (!have) return detail;
            const next = page as ProjectFeedPage<ProjectFileRow>;
            const seen = new Set(have.rows.map(fileRowId));
            return {
                ...detail,
                files: {
                    total: have.total,
                    rows: [...have.rows, ...next.rows.filter((row) => !seen.has(fileRowId(row)))],
                    next_before: next.next_before,
                },
            };
        }
        case "milestones": {
            const have = detail.milestones;
            if (!have) return detail;
            const next = page as ProjectFeedPage<Milestone & { mission_num: number | null }>;
            const seen = new Set(have.rows.map((row) => row.id));
            return {
                ...detail,
                milestones: {
                    total: have.total,
                    rows: [...have.rows, ...next.rows.filter((row) => !seen.has(row.id))],
                    next_before: next.next_before,
                },
            };
        }
    }
}

// ── Words ──

export function activityTitle(event: ActivityEvent): string {
    switch (event.kind) {
        case "milestone":
            return event.milestone.title;
        case "decision":
            return event.decision.title;
        case "file":
            return fileName(event.file);
        case "item":
            return event.item.title;
    }
}

/** A file's name, falling back to its caption, then its kind. */
export function fileName(file: ProjectFileRow): string {
    if (file.name?.trim()) return file.name;
    if (file.caption?.trim()) return oneLine(file.caption);
    return isImage(file) ? "Image" : "File";
}

export function isImage(file: Pick<ProjectFileRow, "content_type">): boolean {
    return !!file.content_type?.startsWith("image/");
}

/** The line under the title that says what kind of thing it is; null for an ordinary milestone. */
export function activityNote(event: ActivityEvent): string | null {
    switch (event.kind) {
        case "milestone":
            return event.milestone.kind === "user_input" ? "Your input" : null;
        case "decision": {
            const { decision } = event;
            if (decision.kind === "question") {
                const answer = decision.answer?.trim() ?? "";
                return answer ? `Answered: “${oneLine(answer)}”` : "Answered";
            }
            return decision.resolution === "reversed" ? "Decision reversed" : "Decision";
        }
        case "file": {
            const what = isImage(event.file) ? "Image" : "File";
            return "item_num" in event.file.source ? `${what} on #${event.file.source.item_num}` : `${what} in chat`;
        }
        case "item":
            if (event.item.kind === "question") return event.item.awaiting === "user" ? "Question for you" : "Question";
            return event.item.awaiting === "user" ? "For you to read" : "Notice";
    }
}

/** A reversed decision's title is struck through. */
export function isStruck(event: ActivityEvent): boolean {
    return event.kind === "decision" && event.decision.resolution === "reversed";
}

/** The glyph's state for a decision row: answered, reversed, else decided (in force). */
export function decisionMark(
    decision: Pick<ProjectDecisionRow, "kind" | "resolution">,
): "answered" | "reversed" | "decided" {
    if (decision.kind === "question") return "answered";
    return decision.resolution === "reversed" ? "reversed" : "decided";
}

/** Whether a click on the row goes somewhere: a milestone to its mission, a decision or item to
 *  the item, a file to the item it is on. A chat file and a milestone of an unknown mission have
 *  nowhere to go on this page, so their rows are not buttons. */
export function canOpen(event: ActivityEvent): boolean {
    switch (event.kind) {
        case "milestone":
            return event.missionNum != null;
        case "file":
            return "item_num" in event.file.source;
        default:
            return true;
    }
}

/** "09:54": the row's time within its day. */
export function timeOfDay(ms: number, locale?: string): string {
    return dateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** "Today", "Yesterday", else "26 Sep". */
export function dayLabel(ms: number, now: number = Date.now(), locale?: string): string {
    const day = new Date(ms);
    const today = new Date(now);
    const sameDay = (a: Date, b: Date): boolean =>
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(day, today)) return "Today";
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(day, yesterday)) return "Yesterday";
    return dateTimeFormat(locale, { day: "numeric", month: "short" }).format(day);
}

export interface ActivityDay {
    key: string;
    label: string;
    events: ActivityEvent[];
}

/** The events grouped by calendar day in their own (newest-first) order. */
export function activityDays(events: ActivityEvent[], now: number = Date.now(), locale?: string): ActivityDay[] {
    const days: ActivityDay[] = [];
    for (const event of events) {
        const date = new Date(event.at);
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        const last = days[days.length - 1];
        if (last && last.key === key) last.events.push(event);
        else days.push({ key, label: dayLabel(event.at, now, locale), events: [event] });
    }
    return days;
}

// ── Headline ──

export interface PulsePart {
    /** The mission activity the dot shows; null for the closed count. */
    activity: "running" | "waiting" | "idle" | "quiet" | null;
    text: string;
}

/** "2 running · 1 waiting · 1 idle · 1 closed": the counts that are not zero. */
export function missionParts(counts: Project["missions"]): PulsePart[] {
    const parts: PulsePart[] = [];
    const add = (activity: PulsePart["activity"], n: number, word: string): void => {
        if (n > 0) parts.push({ activity, text: `${n} ${word}` });
    };
    add("running", counts.running, "running");
    add("waiting", counts.waiting, "waiting");
    add("idle", counts.idle, "idle");
    add("quiet", counts.quiet, "quiet");
    add(null, counts.closed, "closed");
    return parts;
}

/** "4 sessions on 3 boxes · last activity 4m ago"; "no sessions on it now" when there are none. */
export function sessionsLine(detail: ProjectDetail, relative: (ms: number) => string): string {
    const boxes = Object.values(detail.sessions_by_box);
    const sessions = boxes.reduce((total, count) => total + count, 0);
    const parts: string[] = [];
    if (sessions === 0) parts.push("no sessions on it now");
    else parts.push(`${plural(sessions, "session")} on ${plural(boxes.length, "box", "boxes")}`);
    if (detail.project.last_activity_at) parts.push(`last activity ${relative(detail.project.last_activity_at)}`);
    return parts.join(" · ");
}

function plural(count: number, noun: string, nounPlural = `${noun}s`): string {
    return `${count} ${count === 1 ? noun : nounPlural}`;
}

/** The headline card's caption: "Status" over the status, "About" over the description when there
 *  is no status. */
export function headlineCaption(project: Pick<Project, "status">): string {
    return project.status ? "Status" : "About";
}

/** The headline's text: the status, else the description, else a line saying there is neither. */
export function headlineText(project: Pick<Project, "status" | "body">): string {
    if (project.status?.trim()) return project.status;
    if (project.body?.trim()) return project.body;
    return "No written status yet";
}

/** Whether the description gets its own "About this project" fold: only when the headline shows
 *  the status instead of it. */
export function showsAboutFold(project: Pick<Project, "status" | "body">): boolean {
    return !!project.status?.trim() && !!project.body?.trim();
}
