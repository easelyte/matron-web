/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Shared builders for the tracker component tests — minimal, wire-shaped items/comments.

import type { TrackerComment, TrackerItem } from "../types";

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
