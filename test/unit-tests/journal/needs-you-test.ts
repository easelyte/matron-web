/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    isAgentRoomTitle,
    isStartCommand,
    needsYouByConversation,
    projectsNeedsYou,
    startedSessionIntents,
} from "../../../src/journal/needs-you";
import type { Mission, TrackerItem } from "../../../src/journal/types";

function item(overrides: Partial<TrackerItem>): TrackerItem {
    return {
        id: "it_1",
        num: 1,
        kind: "question",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        title: "Pick one",
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
        ...overrides,
    } as TrackerItem;
}

function mission(id: string, state: Mission["state"]): Mission {
    return { id, num: 1, state, needs_you: 0 } as Mission;
}

describe("needsYouByConversation", () => {
    it("counts open items awaiting the user per origin conversation", () => {
        const counts = needsYouByConversation([
            item({ id: "a", origin_convo_id: "c1" }),
            item({ id: "b", origin_convo_id: "c1" }),
            item({ id: "c", origin_convo_id: "c2" }),
            item({ id: "d", origin_convo_id: "c2", awaiting: "agent" }),
            item({ id: "e", origin_convo_id: "c3", awaiting: null }),
            item({ id: "f", origin_convo_id: "c3", state: "closed" }),
        ]);
        expect([...counts]).toEqual([
            ["c1", 2],
            ["c2", 1],
        ]);
    });

    it("is empty before the inbox has loaded", () => {
        expect(needsYouByConversation(undefined).size).toBe(0);
    });
});

describe("projectsNeedsYou", () => {
    it("counts items awaiting the user that sit on a mission", () => {
        const items = [
            item({ id: "a", mission_id: "m1" }),
            item({ id: "b", mission_id: "m2" }),
            item({ id: "c", mission_id: null }),
            item({ id: "d", mission_id: "m1", awaiting: "agent" }),
        ];
        expect(projectsNeedsYou(items, undefined)).toBe(2);
    });

    it("leaves out items on a mission known to be closed", () => {
        const items = [item({ id: "a", mission_id: "m1" }), item({ id: "b", mission_id: "m2" })];
        expect(projectsNeedsYou(items, [mission("m1", "open"), mission("m2", "closed")])).toBe(1);
    });

    it("is zero before the inbox has loaded", () => {
        expect(projectsNeedsYou(undefined, undefined)).toBe(0);
    });
});

describe("isAgentRoomTitle", () => {
    it("knows an agent-chat room by its marker or by the arrow between its two sides", () => {
        expect(isAgentRoomTitle("↔️ [ab] box-a ↔ box-b")).toBe(true);
        expect(isAgentRoomTitle("🔗 box-a and box-b")).toBe(true);
        expect(isAgentRoomTitle("A:0b ↔️ B:26 — topic")).toBe(true);
        expect(isAgentRoomTitle("A:0b ↔ B:26 — topic")).toBe(true);
    });

    it("never takes a session's own title for a room", () => {
        expect(isAgentRoomTitle("[ab] Fix the build")).toBe(false);
        expect(isAgentRoomTitle("🐣 [ab] Compare a ↔ b")).toBe(false);
        expect(isAgentRoomTitle("[ab] Compare a ↔ b")).toBe(false);
        expect(isAgentRoomTitle("New session")).toBe(false);
    });
});

describe("startedSessionIntents", () => {
    it("says whether an ask is waiting on a particular box, until its window passes", () => {
        const intents = startedSessionIntents();
        intents.noteBox(null, 0);
        expect(intents.awaitsKnownBox(0)).toBe(false);
        intents.noteBox(4, 0);
        expect(intents.awaitsKnownBox(30_000)).toBe(true);
        expect(intents.awaitsKnownBox(61_000)).toBe(false);
    });

    it("claims a conversation a start named, once", () => {
        const intents = startedSessionIntents();
        intents.noteBox(4, 0);
        intents.noteConversation("c9", 4);
        expect(intents.claim({ id: "c9", agent_device_id: 4, title: "" }, 0)).toBe(true);
        expect(intents.claim({ id: "c9", agent_device_id: 4, title: "" }, 0)).toBe(false);
        // The answer settled the box's ask: another session born there is not this device's.
        expect(intents.claim({ id: "c10", agent_device_id: 4, title: "" }, 0)).toBe(false);
    });

    it("claims the first conversation born on a box a start was sent to, while it is fresh", () => {
        const intents = startedSessionIntents();
        intents.noteBox(4, 1_000);
        expect(intents.claim({ id: "c8", agent_device_id: 5, title: "" }, 2_000)).toBe(false);
        expect(intents.claim({ id: "c9", agent_device_id: 4, title: "" }, 2_000)).toBe(true);
        expect(intents.claim({ id: "c10", agent_device_id: 4, title: "" }, 2_000)).toBe(false);

        intents.noteBox(4, 1_000);
        expect(intents.claim({ id: "c11", agent_device_id: 4, title: "" }, 1_000 + 3 * 60_000)).toBe(false);
    });

    it("never lets a session another agent started answer a start sent to its box", () => {
        const intents = startedSessionIntents();
        intents.noteBox(4, 1_000);
        expect(intents.claim({ id: "c9", agent_device_id: 4, title: "🐣 [ab] Spawned" }, 2_000)).toBe(false);
    });
});

describe("isStartCommand", () => {
    it("knows the bridge's start command in either spelling, with or without arguments", () => {
        expect(isStartCommand("/start")).toBe(true);
        expect(isStartCommand("  !START ~/code --browser")).toBe(true);
        expect(isStartCommand("/restart")).toBe(false);
        expect(isStartCommand("/started")).toBe(false);
        expect(isStartCommand("please /start")).toBe(false);
    });
});
