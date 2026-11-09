/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { formatClockTime } from "../date-format";
import { formatMessageTime, journalHost, roomSenderLabel } from "../room-sender";

const ours = { username: "alice", host: "journal.example" };

describe("roomSenderLabel", () => {
    it("names the other person's side with its journal host", () => {
        expect(
            roomSenderLabel({ sender: "person:dan@peer.example", type: "text", payload: { via: "agent" } }, ours),
        ).toEqual({ side: "theirs", name: "dan@peer.example", detail: "their agent" });
    });

    it("names our agent with our user and host, and the box it runs on", () => {
        expect(roomSenderLabel({ sender: "agent:box-a", type: "text", payload: {} }, ours)).toEqual({
            side: "ours",
            name: "alice@journal.example",
            detail: "our agent · box-a",
        });
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
