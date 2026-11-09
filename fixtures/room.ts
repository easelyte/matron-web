/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * An agent-chat room with another person's agent on another journal, in the journal's real
 * shapes: our agent's lines are `agent:<box>`, theirs `person:<name>@<host>`, and a bridge notice
 * carries `payload.notice`. Selected with `?room=1` on the fixtures page. The first messages are
 * from yesterday so the dated timestamps show.
 */

import type { JournalEvent } from "../src/journal/types";

export const ROOM_TITLE = "A:1f ↔️ 👤 dan@peer.example — Fork changes for upstream review";

export function roomFixture(now: number = Date.now()): JournalEvent[] {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(16, 2, 0, 0);
    const today = new Date(now);
    today.setHours(9, 14, 0, 0);
    let seq = 5000;
    const at = (base: number, minutes: number, sender: string, payload: Record<string, unknown>): JournalEvent => {
        seq += 1;
        return { seq, convo_id: "c1", ts: base + minutes * 60_000, sender, type: "text", payload };
    };
    const ours = (base: number, minutes: number, body: string): JournalEvent =>
        at(base, minutes, "agent:box-a", { body, from: "agent" });
    const theirs = (base: number, minutes: number, body: string): JournalEvent =>
        at(base, minutes, "person:dan@peer.example", { body, person: { name: "dan@peer.example" }, via: "agent" });
    const y = yesterday.getTime();
    const t = today.getTime();
    return [
        ours(
            y,
            0,
            "Here is a short list of fork changes we think are worth a look upstream. Each item has the problem, the change and the PR.",
        ),
        at(y, 1, "agent:box-a", {
            body: "You are now in a room with dan@peer.example's agent.",
            notice: { kind: "agent_chat", icon: "💬", summary: "You are now in a room with dan@peer.example's agent" },
        }),
        theirs(
            y,
            3,
            "Thanks, the list arrived complete and readable. The picks are Dan's, so I'll pass his answers on once he has replied.",
        ),
        theirs(
            y,
            4,
            "One small thing for your federation test: the join notice reached me after your first message, not before it.",
        ),
        ours(
            y,
            5,
            "Thanks for both. We'll pass the ordering detail on as a bug, and hold everything until Dan answers.",
        ),
        theirs(
            t,
            0,
            "Dan's picks: 1. Workflow child rows, yes after small changes. 2. Extras in status, yes. 3. Comment wakes owner, yes after a rebase.",
        ),
        ours(t, 2, "Thanks, that's clear. Here is my read-back so we're aligned."),
        theirs(t, 3, "That read-back matches the picks I posted. No need to reply to this."),
    ];
}
