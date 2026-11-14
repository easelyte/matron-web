/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { formatClockTime } from "../date-format";
import { formatMessageTime, isPersonSender, journalHost, roomSenderLabel } from "../room-sender";
import { sameTimelineSection } from "../system-notice";
import { type JournalEvent } from "../types";

const ours = { username: "alice", host: "journal.example" };

describe("roomSenderLabel", () => {
    it("names the other person's side with its journal host", () => {
        expect(
            roomSenderLabel({ sender: "person:bob@peer.example", type: "text", payload: { via: "agent" } }, ours),
        ).toEqual({ side: "theirs", name: "bob@peer.example", detail: "their agent" });
    });

    it("names our agent with our user and host, and the box it runs on", () => {
        expect(roomSenderLabel({ sender: "agent:box-a", type: "text", payload: {} }, ours)).toEqual({
            side: "ours",
            name: "alice@journal.example",
            detail: "our agent · box-a",
        });
    });

    it("leaves the journal's own cards out of the side labelling", () => {
        expect(roomSenderLabel({ sender: "journal", type: "item", payload: {} }, ours).side).toBe("other");
    });

    it("marks a bridge notice as system, whoever journaled it", () => {
        const payload = { body: "x", notice: { kind: "agent_chat", icon: "💬", summary: "You are now in a room" } };
        expect(roomSenderLabel({ sender: "agent:box-a", type: "text", payload }, ours).side).toBe("system");
    });
});

describe("journalHost", () => {
    it("reads the host, or nothing for a bad URL", () => {
        expect(journalHost("https://journal.example/")).toBe("journal.example");
        expect(journalHost("not a url")).toBe("");
        expect(journalHost(undefined)).toBe("");
    });
});

describe("formatMessageTime", () => {
    const now = new Date(2026, 10, 9, 15, 0).getTime();

    it("shows only the clock time today", () => {
        const today = new Date(2026, 10, 9, 9, 5).getTime();
        expect(formatMessageTime(today, now)).toBe(formatClockTime(today));
    });

    it("puts the date in front on another day", () => {
        const earlier = new Date(2026, 10, 7, 9, 5).getTime();
        const text = formatMessageTime(earlier, now);
        expect(text).not.toBe(formatClockTime(earlier));
        expect(text.endsWith(formatClockTime(earlier))).toBe(true);
        expect(text).toMatch(/7/);
    });

    it("adds the year for an earlier year", () => {
        expect(formatMessageTime(new Date(2025, 0, 2, 9, 5).getTime(), now)).toMatch(/2025/);
    });
});

describe("room sections", () => {
    const event = (sender: string): JournalEvent => ({ sender, type: "text", payload: {} }) as unknown as JournalEvent;

    it("recognises the other person's side by its sender", () => {
        expect(isPersonSender("person:bob@peer.example")).toBe(true);
        expect(isPersonSender("agent:box-a")).toBe(false);
        expect(isPersonSender("user:alice")).toBe(false);
    });

    it("keeps the other person's messages out of our agent's section", () => {
        expect(sameTimelineSection(event("agent:box-a"), event("person:bob@peer.example"))).toBe(false);
        expect(sameTimelineSection(event("person:bob@peer.example"), event("person:bob@peer.example"))).toBe(true);
    });

    it("labels a bare user message as ours", () => {
        expect(roomSenderLabel({ sender: "user:alice", type: "text", payload: {} }, ours)).toEqual({
            side: "ours",
            name: "alice@journal.example",
        });
    });
});
