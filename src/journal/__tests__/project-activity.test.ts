/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { ProjectDetail } from "../types";
import {
    activityDays,
    activityEvents,
    activityHasMore,
    activityHorizon,
    activityNote,
    activityRows,
    appendFeedPage,
    canOpen,
    decisionMark,
    headlineCaption,
    headlineText,
    kindsWithMore,
    missionParts,
    sessionsLine,
    showsAboutFold,
} from "../tracker/projectActivity";
import { trackerProjectDetail, trackerProjectDetailWithFeed } from "./tracker-fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("project activity feed", () => {
    it("merges milestones, decisions, files and the questions for you, newest first", () => {
        const detail = trackerProjectDetailWithFeed();
        const events = activityEvents(detail);
        expect(events.map((event) => event.kind)).toEqual([
            "milestone", // 1h ago
            "decision", // the answered question, when it closed: 2h ago
            "file", // 4h ago
            "milestone", // your input, 26h ago
            "file", // 2d ago
            "decision", // recorded 3d ago
            "decision", // the reversed one, recorded 4d ago
            "item", // the question for you, at its last update
        ]);
        const ats = events.map((event) => event.at);
        expect([...ats].sort((a, b) => b - a)).toEqual(ats);
        expect(events.at(-1)?.kind).toBe("item");
    });

    it("without the roll-up, the feed is the recent milestones and the needs-you questions", () => {
        const detail = trackerProjectDetail();
        expect(activityEvents(detail).map((event) => event.id)).toEqual(["milestone:ml_1", "item:it_3939"]);
        expect(activityHorizon(detail)).toBeNull();
        expect(kindsWithMore(detail)).toEqual([]);
        expect(activityHasMore(detail, 12)).toBe(false);
    });

    it("leaves tasks out and keeps notices in", () => {
        const detail = trackerProjectDetail({
            needs_you: [
                { ...trackerProjectDetail().needs_you[0], id: "t", num: 1, kind: "task" },
                { ...trackerProjectDetail().needs_you[0], id: "n", num: 2, kind: "notice" },
            ],
        });
        expect(activityEvents(detail).map((event) => event.id)).toEqual(["milestone:ml_1", "item:n"]);
    });

    it("holds back rows older than the newest kind that still has pages to load", () => {
        const detail = trackerProjectDetailWithFeed();
        // Milestones are loaded back 26h with more to come; decisions back 3d with more; files complete.
        const horizon = activityHorizon(detail);
        expect(horizon).toBe(detail.milestones!.rows[1].created_at);
        const shown = activityRows(detail, null);
        expect(shown.every((event) => event.at >= horizon!)).toBe(true);
        expect(shown.map((event) => event.id)).not.toContain("decision:it_40");
        expect(activityHasMore(detail, null)).toBe(true);
        expect(kindsWithMore(detail)).toEqual(["milestones", "decisions"]);
    });

    it("cuts the first page to the limit and says there is more", () => {
        const now = Date.now();
        const rows = Array.from({ length: 20 }, (_, i) => ({
            ...trackerProjectDetail().recent_milestones[0],
            id: `ml_${i}`,
            created_at: now - i * 60_000,
        }));
        const detail = trackerProjectDetail({ milestones: { total: 20, rows, next_before: null }, needs_you: [] });
        expect(activityRows(detail, 12)).toHaveLength(12);
        expect(activityHasMore(detail, 12)).toBe(true);
        expect(activityHasMore(detail, null)).toBe(false);
    });

    it("appends a page of a kind, skipping rows already there, and takes its cursor", () => {
        const detail = trackerProjectDetailWithFeed();
        const older = {
            total: 9,
            rows: [detail.decisions!.rows[2], { ...detail.decisions!.rows[2], id: "it_30", num: 30, title: "Older" }],
            next_before: null,
        };
        const next = appendFeedPage(detail, "decisions", older);
        expect(next.decisions!.rows.map((row) => row.id)).toEqual(["it_41", "it_40", "it_39", "it_30"]);
        expect(next.decisions!.next_before).toBeNull();
        expect(kindsWithMore(next)).toEqual(["milestones"]);
        const plain = trackerProjectDetail();
        expect(appendFeedPage(plain, "files", older as never)).toBe(plain);
    });

    it("leaves an undated file out of the feed and out of the horizon", () => {
        const detail = trackerProjectDetailWithFeed({
            files: {
                total: 1,
                rows: [{ blob_id: "b9", name: "Undated.pdf", source: { item_num: 41 }, posted_at: null }],
                next_before: "f-cursor",
            },
            decisions: undefined,
            milestones: undefined,
        });
        expect(activityEvents(detail).some((event) => event.kind === "file")).toBe(false);
        expect(activityHorizon(detail)).toBeNull();
        expect(kindsWithMore(detail)).toEqual(["files"]);
    });

    it("knows which rows open something, and a reversed decision's mark", () => {
        const events = activityEvents(trackerProjectDetailWithFeed());
        const byId = Object.fromEntries(events.map((event) => [event.id, event]));
        expect(canOpen(byId["milestone:ml_1"])).toBe(true);
        expect(canOpen({ ...byId["milestone:ml_1"], missionNum: null })).toBe(false);
        expect(canOpen(byId["file:item:41:b1"])).toBe(true);
        expect(canOpen(byId["file:chat:c1:12"])).toBe(false);
        expect(canOpen(byId["decision:it_39"])).toBe(true);
        expect(decisionMark({ kind: "question", resolution: "answered" })).toBe("answered");
        expect(decisionMark({ kind: "decision", resolution: "reversed" })).toBe("reversed");
        expect(decisionMark({ kind: "decision", resolution: null })).toBe("decided");
    });

    it("says what each row is", () => {
        const events = activityEvents(trackerProjectDetailWithFeed());
        const notes = Object.fromEntries(events.map((event) => [event.id, activityNote(event)]));
        expect(notes["milestone:ml_1"]).toBeNull();
        expect(notes["milestone:ml_0"]).toBe("Your input");
        expect(notes["decision:it_41"]).toBe("Answered: “Yes, both together.”");
        expect(notes["decision:it_40"]).toBe("Decision");
        expect(notes["decision:it_39"]).toBe("Decision reversed");
        expect(notes["file:item:41:b1"]).toBe("Image on #41");
        expect(notes["file:chat:c1:12"]).toBe("File in chat");
        expect(notes["item:it_3939"]).toBe("Question for you");
    });

    it("groups the rows by day, newest first, labelled Today and Yesterday", () => {
        const now = new Date(2026, 9, 13, 10, 5).getTime();
        const at = (offset: number): number => now - offset;
        const milestone = trackerProjectDetail().recent_milestones[0];
        const detail = trackerProjectDetail({
            needs_you: [],
            milestones: {
                total: 3,
                rows: [
                    { ...milestone, id: "a", created_at: at(HOUR) },
                    { ...milestone, id: "b", created_at: at(20 * HOUR) },
                    { ...milestone, id: "c", created_at: at(3 * DAY) },
                ],
                next_before: null,
            },
        });
        const days = activityDays(activityRows(detail, null), now, "en-GB");
        expect(days.map((day) => [day.label, day.events.length])).toEqual([
            ["Today", 1],
            ["Yesterday", 1],
            ["10 Oct", 1],
        ]);
    });
});

describe("project headline", () => {
    it("counts the missions with a dot each and says who is on it", () => {
        const detail = trackerProjectDetail();
        expect(missionParts(detail.project.missions).map((part) => part.text)).toEqual([
            "1 running",
            "1 waiting",
            "1 closed",
        ]);
        expect(sessionsLine(detail, () => "6m ago")).toBe("2 sessions on 2 boxes · last activity 6m ago");
        expect(sessionsLine({ ...detail, sessions_by_box: {} }, () => "6m ago")).toBe(
            "no sessions on it now · last activity 6m ago",
        );
    });

    it("leads with the status, else the description", () => {
        const project = trackerProjectDetail().project;
        expect(headlineCaption(project)).toBe("Status");
        expect(headlineText(project)).toBe(project.status);
        expect(showsAboutFold(project)).toBe(true);
        const noStatus = { ...project, status: null };
        expect(headlineCaption(noStatus)).toBe("About");
        expect(headlineText(noStatus)).toBe(project.body);
        expect(showsAboutFold(noStatus)).toBe(false);
        expect(headlineText({ status: null, body: "" })).toBe("No written status yet");
    });
});

// The fixture's shape, so a test above cannot pass on a stale detail.
const typed: ProjectDetail = trackerProjectDetailWithFeed();
void typed;
