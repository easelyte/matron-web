/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../client";
import type { ClientState } from "../types";

function client(phase: ClientState["phase"] = "signed-in"): MatronJournalClient {
    const instance = new MatronJournalClient();
    (instance as unknown as { state: ClientState }).state = { ...instance.getSnapshot(), phase };
    return instance;
}

afterEach(() => {
    window.location.hash = "";
});

describe("client.applyWorkDeepLink", () => {
    it("opens a loop's detail on the Work tab from #work=<id> and clears the hash", () => {
        const subject = client();
        subject.openFilesView("/tmp");
        window.location.hash = "#work=665";
        subject.applyWorkDeepLink();
        expect(subject.getSnapshot().trackerView).toEqual({ open: true, view: "work", selectedLoopId: 665 });
        // One main-region surface at a time.
        expect(subject.getSnapshot().filesView).toBeUndefined();
        expect(window.location.hash).toBe("");
    });

    it("opens the Work list from a bare #work, clearing any stale loop selection", () => {
        const subject = client();
        subject.openTrackerLoop(12);
        window.location.hash = "#work";
        subject.applyWorkDeepLink();
        expect(subject.getSnapshot().trackerView).toEqual({ open: true, view: "work" });
    });

    it("ignores hashes that are not a Work link, and malformed ids", () => {
        const subject = client();
        for (const hash of [
            "#files=%2Ftmp%2Fa",
            "#work=abc",
            "#work=12x",
            "#workshop",
            "#work=-1",
            "#work=0",
            "#work=99999999999999999999",
        ]) {
            window.location.hash = hash;
            subject.applyWorkDeepLink();
            expect(subject.getSnapshot().trackerView).toBeUndefined();
            // A malformed Work link is left in place for inspection, not silently consumed.
            if (hash.startsWith("#work=")) expect(window.location.hash).toBe(hash);
        }
    });

    it("accepts any positive safe-integer loop id", () => {
        const subject = client();
        window.location.hash = "#work=1000000000";
        subject.applyWorkDeepLink();
        expect(subject.getSnapshot().trackerView?.selectedLoopId).toBe(1_000_000_000);
    });

    it("no-ops before sign-in and keeps the hash for later", () => {
        const subject = client("signed-out");
        window.location.hash = "#work=5";
        subject.applyWorkDeepLink();
        expect(subject.getSnapshot().trackerView).toBeUndefined();
        expect(window.location.hash).toBe("#work=5");
    });

    it("applyDeepLinks dispatches to the Work link", () => {
        const subject = client();
        window.location.hash = "#work=9";
        subject.applyDeepLinks();
        expect(subject.getSnapshot().trackerView?.selectedLoopId).toBe(9);
    });
});

describe("client loop selection", () => {
    it("selecting an item or mission leaves the view off Work, and a view switch keeps the state shape", () => {
        const subject = client();
        subject.openTrackerLoop(4);
        expect(subject.getSnapshot().trackerView).toEqual({ open: true, view: "work", selectedLoopId: 4 });
        subject.openTrackerLoop(null);
        expect(subject.getSnapshot().trackerView).toEqual({ open: true, view: "work" });
        expect(Object.keys(subject.getSnapshot().trackerView ?? {})).not.toContain("selectedLoopId");
    });
});
