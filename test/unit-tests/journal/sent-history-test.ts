/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { SENT_HISTORY_CAP, SentMessageHistory } from "../../../src/journal/sent-history";

describe("SentMessageHistory", () => {
    test("Up walks from the newest to the oldest, then stops", () => {
        const history = new SentMessageHistory();
        history.record("one", "c1");
        history.record("two", "c1");
        expect(history.recallOlder("c1", "")).toBe("two");
        expect(history.isNavigating).toBe(true);
        expect(history.recallOlder("c1", "")).toBe("one");
        expect(history.recallOlder("c1", "")).toBeUndefined();
        expect(history.isNavigating).toBe(true);
    });

    test("Down walks back toward the newest and finally restores the stashed draft", () => {
        const history = new SentMessageHistory();
        history.record("one", "c1");
        history.record("two", "c1");
        history.recallOlder("c1", "draft");
        history.recallOlder("c1", "ignored");
        expect(history.recallNewer("c1")).toBe("two");
        expect(history.recallNewer("c1")).toBe("draft");
        expect(history.isNavigating).toBe(false);
        expect(history.recallNewer("c1")).toBeUndefined();
    });

    test("nothing to recall in a conversation with no sends", () => {
        const history = new SentMessageHistory();
        history.record("one", "c1");
        expect(history.recallOlder("c2", "")).toBeUndefined();
        expect(history.isNavigating).toBe(false);
        expect(history.recallNewer("c2")).toBeUndefined();
    });

    test("each conversation keeps its own history", () => {
        const history = new SentMessageHistory();
        history.record("in one", "c1");
        history.record("in two", "c2");
        expect(history.recallOlder("c2", "")).toBe("in two");
        expect(history.recallOlder("c2", "")).toBeUndefined();
        // Walking in another conversation starts a fresh walk there.
        expect(history.recallOlder("c1", "")).toBe("in one");
        expect(history.recallNewer("c2")).toBeUndefined();
    });

    test("consecutive duplicates collapse into one entry", () => {
        const history = new SentMessageHistory();
        history.record("same", "c1");
        history.record("same", "c1");
        expect(history.recallOlder("c1", "")).toBe("same");
        expect(history.recallOlder("c1", "")).toBeUndefined();
    });

    test("keeps only the most recent entries per conversation", () => {
        const history = new SentMessageHistory();
        for (let index = 0; index < SENT_HISTORY_CAP + 5; index++) history.record(`m${index}`, "c1");
        let oldest: string | undefined;
        let steps = 0;
        for (let text = history.recallOlder("c1", ""); text !== undefined; text = history.recallOlder("c1", "")) {
            oldest = text;
            steps++;
        }
        expect(steps).toBe(SENT_HISTORY_CAP);
        expect(oldest).toBe("m5");
    });

    test("recording or ending a walk drops it", () => {
        const history = new SentMessageHistory();
        history.record("one", "c1");
        history.recallOlder("c1", "draft");
        history.record("two", "c1");
        expect(history.isNavigating).toBe(false);

        history.recallOlder("c1", "draft");
        history.endRecall();
        expect(history.isNavigating).toBe(false);
        expect(history.recallNewer("c1")).toBeUndefined();
    });
});
