/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Shared builders for the tracker component tests — minimal, wire-shaped items/missions/comments.

import type { Mission, MissionDetail, Project, ProjectDetail, TrackerComment, TrackerItem } from "../types";

export function trackerItem(over: Partial<TrackerItem> = {}): TrackerItem {
    return {
        id: "it_1",
        num: 1,
        kind: "question",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        title: "Pick a brand colour",
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        origin_convo_title: "Brand chat",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
        ...over,
    };
}

export function trackerComment(over: Partial<TrackerComment> = {}): TrackerComment {
    return {
        id: "cm_1",
        item_id: "it_1",
        author: "user",
        device_id: 1,
        kind: "comment",
        body: "here is my reply",
        attachments: [],
        meta: null,
        created_at: 2,
        ...over,
    };
}

export function trackerMission(over: Partial<Mission> = {}): Mission {
    return {
        id: "ms_1",
        num: 5,
        state: "open",
        title: "Ship the tracker",
        body: "",
        close_summary: null,
        closed_by: null,
        closed_over_open_items: 0,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
        last_milestone_at: null,
        closed_at: null,
        open_items: 0,
        needs_you: 0,
        conversations: 0,
        milestones: 0,
        last_milestone: null,
        ...over,
    };
}

export function trackerMissionDetail(over: Partial<MissionDetail> = {}): MissionDetail {
    return {
        mission: trackerMission(),
        milestones: [],
        items: [],
        conversations: [],
        ...over,
    };
}

export function trackerProject(over: Partial<Project> = {}): Project {
    return {
        id: "pj_1",
        num: 2645,
        state: "open",
        title: "Web/Mac design unification",
        body: "Audit, then the Mac app leads.",
        status: "Phase 2 running: tokens merged, sign-in waiting on review.",
        status_by: "agent",
        status_updated_at: Date.now() - 20 * 60_000,
        created_at: 1,
        updated_at: 1,
        missions: { running: 1, waiting: 1, idle: 0, quiet: 0, closed: 1 },
        needs_you: 2,
        open_items: 5,
        last_activity_at: Date.now() - 6 * 60_000,
        ...over,
    };
}

export function trackerProjectDetail(over: Partial<ProjectDetail> = {}): ProjectDetail {
    return {
        project: trackerProject(),
        missions: [
            {
                ...trackerMission({ num: 1706, title: "Unify matron-web and the Mac app", needs_you: 1 }),
                status: "Step 7 in progress.",
                activity: "running",
            },
            {
                ...trackerMission({ id: "ms_2", num: 1594, title: "Deploy matron-web", needs_you: 0 }),
                status: null,
                activity: "quiet",
            },
        ],
        needs_you: [
            {
                id: "it_3939",
                num: 3939,
                kind: "question",
                state: "open",
                awaiting: "user",
                title: "Merge unify step 2?",
                origin_convo_id: "c1",
                updated_at: 1,
                mission_id: "ms_1",
                mission_num: 1706,
            },
        ],
        recent_milestones: [
            {
                id: "ml_1",
                mission_id: "ms_1",
                num: 3946,
                kind: "progress",
                title: "Token PR merged",
                body: "",
                convo_id: "c1",
                seq: 1,
                device_id: 1,
                created_by: "agent",
                created_at: Date.now() - 3_600_000,
                mission_num: 1706,
            },
        ],
        sessions_by_box: { ash: 1, "build-box": 1 },
        ...over,
    };
}
