/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { sameTimelineSection } from "../system-notice";
import { type JournalEvent } from "../types";

const text = (seq: number, convoId?: string): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: seq,
    sender: "agent:box",
    type: "text",
    payload: { body: "x", ...(convoId ? { from_session: { convo_id: convoId } } : {}) },
});

describe("sameTimelineSection", () => {
    it("shares a section only for the same stamped session", () => {
        expect(sameTimelineSection(text(1, "s1"), text(2, "s1"))).toBe(true);
        expect(sameTimelineSection(text(1, "s1"), text(2, "s2"))).toBe(false);
        expect(sameTimelineSection(text(1), text(2))).toBe(true);
    });
});
