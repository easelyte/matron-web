/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    isRowVisible,
    observeSeenRows,
    type SeenActivity,
    SeenLedger,
    type SeenSend,
    seqFromRowAttribute,
    seqRanges,
    SeenTracker,
    newSeenSurface,
} from "../../../src/journal/seen-tracker";

describe("isRowVisible", () => {
    const viewport = { top: 0, bottom: 100 };

    it("counts a row at least half on screen", () => {
        expect(isRowVisible({ top: 80, bottom: 120 }, viewport)).toBe(true);
        expect(isRowVisible({ top: 81, bottom: 121 }, viewport)).toBe(false);
        expect(isRowVisible({ top: -20, bottom: 20 }, viewport)).toBe(true);
    });

    it("counts a row taller than the viewport once it covers half of it", () => {
        expect(isRowVisible({ top: 50, bottom: 450 }, viewport)).toBe(true);
        expect(isRowVisible({ top: 51, bottom: 451 }, viewport)).toBe(false);
        expect(isRowVisible({ top: -300, bottom: 300 }, viewport)).toBe(true);
    });

    it("never counts an off-screen, empty or unmeasured row", () => {
        expect(isRowVisible({ top: 100, bottom: 140 }, viewport)).toBe(false);
        expect(isRowVisible({ top: 10, bottom: 10 }, viewport)).toBe(false);
        expect(isRowVisible({ top: 10, bottom: 20 }, { top: 0, bottom: 0 })).toBe(false);
    });
});

describe("seqFromRowAttribute", () => {
    it("reads positive integer seqs only", () => {
        expect(seqFromRowAttribute("42")).toBe(42);
        expect(seqFromRowAttribute(null)).toBeUndefined();
        expect(seqFromRowAttribute("")).toBeUndefined();
        expect(seqFromRowAttribute("0")).toBeUndefined();
        expect(seqFromRowAttribute("-3")).toBeUndefined();
        expect(seqFromRowAttribute("1.5")).toBeUndefined();
        expect(seqFromRowAttribute("local-1")).toBeUndefined();
    });
});

describe("seqRanges", () => {
    it("sorts and merges runs of consecutive seqs", () => {
        expect(seqRanges([7, 3, 4, 5, 10, 9, 4])).toEqual([
            [3, 5],
            [7, 7],
            [9, 10],
        ]);
        expect(seqRanges([])).toEqual([]);
    });
});

describe("SeenLedger", () => {
    const surface = newSeenSurface();

    it("promotes a row only after it has dwelt for the full second", () => {
        const ledger = new SeenLedger(1_000, true);
        ledger.setVisible(surface, "c1", [1, 2], 0);
        expect(ledger.nextDeadline).toBe(1_000);
        ledger.promote(999);
        expect(ledger.hasPending).toBe(false);
        ledger.setVisible(surface, "c1", [2, 3], 500);
        ledger.promote(1_000);
        expect(ledger.drain()).toEqual([{ op: "seen", convo_id: "c1", ranges: [[2, 2]] }]);
        expect(ledger.nextDeadline).toBe(1_500);
    });

    it("keeps a row that dwelt in full even when it scrolls away before the timer runs", () => {
        const ledger = new SeenLedger(1_000, true);
        ledger.setVisible(surface, "c1", [1], 0);
        ledger.setVisible(surface, "c1", [2], 1_500);
        expect(ledger.drain()).toEqual([{ op: "seen", convo_id: "c1", ranges: [[1, 1]] }]);
        expect(ledger.nextDeadline).toBe(2_500);
    });

    it("reports a row once while it stays on screen", () => {
        const ledger = new SeenLedger(1_000, true);
        ledger.setVisible(surface, "c1", [1], 0);
        ledger.promote(1_000);
        expect(ledger.drain()).toHaveLength(1);
        ledger.setVisible(surface, "c1", [1], 2_000);
        ledger.promote(5_000);
        expect(ledger.drain()).toEqual([]);
        expect(ledger.nextDeadline).toBeUndefined();
    });

    it("restarts dwell when the surface switches conversation", () => {
        const ledger = new SeenLedger(1_000, true);
        ledger.setVisible(surface, "c1", [1], 0);
        ledger.setVisible(surface, "c2", [1], 800);
        ledger.promote(1_000);
        expect(ledger.hasPending).toBe(false);
        ledger.promote(1_800);
        expect(ledger.drain()).toEqual([{ op: "seen", convo_id: "c2", ranges: [[1, 1]] }]);
    });

    it("pauses while inactive and restarts every dwell on becoming active", () => {
        const ledger = new SeenLedger(1_000, true);
        ledger.setVisible(surface, "c1", [1], 0);
        ledger.setVisible(newSeenSurface(), "c1", [5], 600);
        ledger.setActive(false, 1_200);
        // 1 dwelt before the page went inactive; 5 had not.
        expect(ledger.drain()).toEqual([{ op: "seen", convo_id: "c1", ranges: [[1, 1]] }]);
        expect(ledger.nextDeadline).toBeUndefined();
        ledger.promote(10_000);
        expect(ledger.hasPending).toBe(false);
        ledger.setActive(true, 20_000);
        ledger.promote(20_999);
        expect(ledger.hasPending).toBe(false);
        ledger.promote(21_000);
        expect(ledger.drain()).toEqual([{ op: "seen", convo_id: "c1", ranges: [[5, 5]] }]);
    });

    it("promotes what dwelt when a surface goes away", () => {
        const ledger = new SeenLedger(1_000, true);
        ledger.setVisible(surface, "c1", [1, 2], 0);
        ledger.removeSurface(surface, 1_000);
        expect(ledger.drain()).toEqual([{ op: "seen", convo_id: "c1", ranges: [[1, 2]] }]);
        expect(ledger.nextDeadline).toBeUndefined();
    });

    it("splits more than 64 ranges across ops and groups by conversation", () => {
        const ledger = new SeenLedger(1_000, true);
        for (let index = 0; index < 70; index += 1) ledger.markSeen("c2", index * 2 + 1);
        ledger.markSeen("c1", 4);
        const ops = ledger.drain();
        expect(ops.map((op) => [op.convo_id, op.ranges.length])).toEqual([
            ["c1", 1],
            ["c2", 64],
            ["c2", 6],
        ]);
        expect(ops[2].ranges[5]).toEqual([139, 139]);
        expect(ledger.hasPending).toBe(false);
    });

    it("puts a failed op's seqs back", () => {
        const ledger = new SeenLedger(1_000, true);
        ledger.markSeen("c1", 3);
        ledger.markSeen("c1", 4);
        const [op] = ledger.drain();
        ledger.restore(op);
        expect(ledger.drain()).toEqual([{ op: "seen", convo_id: "c1", ranges: [[3, 4]] }]);
    });
});

class FakeActivity implements SeenActivity {
    public active = true;
    private listener?: () => void;
    public isActive(): boolean {
        return this.active;
    }
    public subscribe(onChange: () => void): () => void {
        this.listener = onChange;
        return () => (this.listener = undefined);
    }
    public set(active: boolean): void {
        this.active = active;
        this.listener?.();
    }
    public get subscribed(): boolean {
        return this.listener !== undefined;
    }
}

describe("SeenTracker", () => {
    let activity: FakeActivity;
    let send: jest.MockedFunction<SeenSend>;
    let tracker: SeenTracker;

    beforeEach(() => {
        jest.useFakeTimers();
        activity = new FakeActivity();
        send = jest.fn<boolean, Parameters<SeenSend>>().mockReturnValue(true);
        tracker = new SeenTracker({ send, activity });
    });

    afterEach(() => {
        tracker.reset();
        jest.useRealTimers();
    });

    it("sends rows that stayed on screen for a second, batched about two seconds later", () => {
        const surface = newSeenSurface();
        tracker.setVisible(surface, "c1", [10, 11, 13]);
        jest.advanceTimersByTime(999);
        expect(send).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        // Dwelt, now pending; the batch goes out on the flush timer.
        expect(send).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1_999);
        expect(send).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({
            op: "seen",
            convo_id: "c1",
            ranges: [
                [10, 11],
                [13, 13],
            ],
        });
        jest.advanceTimersByTime(60_000);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("still sends a row whose dwell timer ran late", () => {
        const surface = newSeenSurface();
        const now = jest.spyOn(Date, "now");
        now.mockReturnValue(0);
        tracker.setVisible(surface, "c1", [1]);
        // The page was busy: 1.5 s pass before anything runs, and the next event is a scroll.
        now.mockReturnValue(1_500);
        tracker.setVisible(surface, "c1", [2]);
        now.mockRestore();
        tracker.flush();
        expect(send).toHaveBeenCalledWith({ op: "seen", convo_id: "c1", ranges: [[1, 1]] });
    });

    it("ignores rows scrolled past in under a second", () => {
        const surface = newSeenSurface();
        tracker.setVisible(surface, "c1", [1]);
        jest.advanceTimersByTime(600);
        tracker.setVisible(surface, "c1", [2]);
        jest.advanceTimersByTime(600);
        tracker.setVisible(surface, "c1", []);
        jest.advanceTimersByTime(10_000);
        expect(send).not.toHaveBeenCalled();
    });

    it("counts nothing while the page is hidden or unfocused", () => {
        activity.active = false;
        tracker.setVisible(newSeenSurface(), "c1", [1]);
        jest.advanceTimersByTime(10_000);
        expect(send).not.toHaveBeenCalled();
        activity.set(true);
        jest.advanceTimersByTime(999);
        activity.set(false);
        jest.advanceTimersByTime(10_000);
        expect(send).not.toHaveBeenCalled();
        activity.set(true);
        jest.advanceTimersByTime(3_000);
        expect(send).toHaveBeenCalledWith({ op: "seen", convo_id: "c1", ranges: [[1, 1]] });
    });

    it("flushes at once when the page loses focus", () => {
        tracker.setVisible(newSeenSurface(), "c1", [1]);
        jest.advanceTimersByTime(1_000);
        activity.set(false);
        expect(send).toHaveBeenCalledWith({ op: "seen", convo_id: "c1", ranges: [[1, 1]] });
    });

    it("flushes at once when a timeline goes away", () => {
        const surface = newSeenSurface();
        tracker.setVisible(surface, "c1", [1, 2]);
        jest.advanceTimersByTime(1_000);
        tracker.removeSurface(surface);
        expect(send).toHaveBeenCalledWith({ op: "seen", convo_id: "c1", ranges: [[1, 2]] });
    });

    it("keeps what could not be sent and retries on the next flush", () => {
        send.mockReturnValue(false);
        tracker.setVisible(newSeenSurface(), "c1", [1]);
        jest.advanceTimersByTime(3_000);
        expect(send).toHaveBeenCalledTimes(1);
        send.mockReturnValue(true);
        jest.advanceTimersByTime(2_000);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({ op: "seen", convo_id: "c1", ranges: [[1, 1]] });
        jest.advanceTimersByTime(10_000);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it("reports an open item at once, again for a newer comment, never for an older one", () => {
        tracker.setItemOnScreen("it_1", 0);
        expect(send).toHaveBeenLastCalledWith({ op: "item_seen", item_id: "it_1", through_comment_at: 0 });
        tracker.setItemOnScreen("it_1", 0);
        tracker.setItemOnScreen("it_1", 5_000);
        tracker.setItemOnScreen("it_1", 4_000);
        expect(send.mock.calls.map(([op]) => op)).toEqual([
            { op: "item_seen", item_id: "it_1", through_comment_at: 0 },
            { op: "item_seen", item_id: "it_1", through_comment_at: 5_000 },
        ]);
    });

    it("holds an item opened while unfocused until the page is focused", () => {
        activity.active = false;
        tracker.setItemOnScreen("it_1", 7);
        expect(send).not.toHaveBeenCalled();
        activity.set(true);
        expect(send).toHaveBeenCalledWith({ op: "item_seen", item_id: "it_1", through_comment_at: 7 });
    });

    it("forgets a closed item, and re-reports one that failed to send on the next focus", () => {
        tracker.setItemOnScreen("it_1", 1);
        tracker.removeItem("it_1");
        send.mockReturnValueOnce(false);
        tracker.setItemOnScreen("it_2", 2);
        activity.set(false);
        activity.set(true);
        expect(send.mock.calls.map(([op]) => op)).toEqual([
            { op: "item_seen", item_id: "it_1", through_comment_at: 1 },
            { op: "item_seen", item_id: "it_2", through_comment_at: 2 },
            { op: "item_seen", item_id: "it_2", through_comment_at: 2 },
        ]);
    });

    it("drops unsent state and stops listening on reset", () => {
        tracker.setVisible(newSeenSurface(), "c1", [1]);
        jest.advanceTimersByTime(1_000);
        expect(activity.subscribed).toBe(true);
        tracker.reset();
        expect(activity.subscribed).toBe(false);
        jest.advanceTimersByTime(10_000);
        expect(send).not.toHaveBeenCalled();
    });
});

// ── DOM binding: a mocked IntersectionObserver and hand-set row rects ──────────────────────────────

class MockIntersectionObserver {
    public static instances: MockIntersectionObserver[] = [];
    public readonly observed = new Set<Element>();
    public disconnected = false;
    public constructor(
        private readonly callback: IntersectionObserverCallback,
        public readonly options?: IntersectionObserverInit,
    ) {
        MockIntersectionObserver.instances.push(this);
    }
    public observe(target: Element): void {
        this.observed.add(target);
    }
    public unobserve(target: Element): void {
        this.observed.delete(target);
    }
    public disconnect(): void {
        this.disconnected = true;
        this.observed.clear();
    }
    public takeRecords(): IntersectionObserverEntry[] {
        return [];
    }
    /** Fires the callback with `targets` intersecting (true) or leaving (false). */
    public fire(targets: Array<[Element, boolean]>): void {
        const entries = targets.map(
            ([target, isIntersecting]) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry,
        );
        this.callback(entries, this as unknown as IntersectionObserver);
    }
}

function setRect(element: Element, top: number, bottom: number): void {
    element.getBoundingClientRect = () => ({ top, bottom, height: bottom - top }) as DOMRect;
}

function row(seq?: number): HTMLLIElement {
    const li = document.createElement("li");
    if (seq !== undefined) li.setAttribute("data-event-id", String(seq));
    return li;
}

describe("observeSeenRows", () => {
    let root: HTMLDivElement;
    let list: HTMLOListElement;
    let tracker: { setVisible: jest.Mock; removeSurface: jest.Mock };
    let originalObserver: typeof IntersectionObserver | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
        originalObserver = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
        MockIntersectionObserver.instances = [];
        Object.defineProperty(globalThis, "IntersectionObserver", {
            value: MockIntersectionObserver,
            configurable: true,
            writable: true,
        });
        root = document.createElement("div");
        list = document.createElement("ol");
        root.append(list);
        document.body.append(root);
        setRect(root, 0, 100);
        tracker = { setVisible: jest.fn(), removeSurface: jest.fn() };
    });

    afterEach(() => {
        root.remove();
        Object.defineProperty(globalThis, "IntersectionObserver", {
            value: originalObserver,
            configurable: true,
            writable: true,
        });
        jest.useRealTimers();
    });

    const observe = (): (() => void) =>
        observeSeenRows({ tracker: tracker as unknown as SeenTracker, convoId: "c1", root, list });

    it("observes seq rows only, in the scroll viewport, and reports the visible ones", () => {
        const [first, second, third, divider] = [row(1), row(2), row(3), row()];
        list.append(divider, first, second, third);
        setRect(first, -40, 10); // a fifth on screen
        setRect(second, 10, 60);
        setRect(third, 60, 300); // tall, covers 40 of the 100 viewport
        const stop = observe();
        const observer = MockIntersectionObserver.instances[0];
        expect(observer.options?.root).toBe(root);
        expect([...observer.observed]).toEqual([first, second, third]);

        observer.fire([
            [first, true],
            [second, true],
            [third, true],
        ]);
        expect(tracker.setVisible).toHaveBeenLastCalledWith(expect.any(Symbol), "c1", [2]);
        stop();
    });

    it("re-measures on scroll, once per frame, and only reports a changed set", async () => {
        const [first, second] = [row(1), row(2)];
        list.append(first, second);
        setRect(first, 0, 50);
        setRect(second, 51, 400);
        const stop = observe();
        MockIntersectionObserver.instances[0].fire([
            [first, true],
            [second, true],
        ]);
        expect(tracker.setVisible).toHaveBeenLastCalledWith(expect.any(Symbol), "c1", [1]);

        setRect(first, -50, 0);
        setRect(second, 0, 350);
        root.dispatchEvent(new Event("scroll"));
        root.dispatchEvent(new Event("scroll"));
        expect(tracker.setVisible).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(16);
        expect(tracker.setVisible).toHaveBeenCalledTimes(2);
        expect(tracker.setVisible).toHaveBeenLastCalledWith(expect.any(Symbol), "c1", [2]);

        root.dispatchEvent(new Event("scroll"));
        jest.advanceTimersByTime(16);
        expect(tracker.setVisible).toHaveBeenCalledTimes(2);
        stop();
    });

    it("picks up rows as they are added and drops them when removed", async () => {
        const stop = observe();
        const observer = MockIntersectionObserver.instances[0];
        const late = row(9);
        setRect(late, 10, 50);
        list.append(late, row());
        await Promise.resolve();
        expect([...observer.observed]).toEqual([late]);
        observer.fire([[late, true]]);
        expect(tracker.setVisible).toHaveBeenLastCalledWith(expect.any(Symbol), "c1", [9]);

        late.remove();
        await Promise.resolve();
        expect(observer.observed.size).toBe(0);
        expect(tracker.setVisible).toHaveBeenLastCalledWith(expect.any(Symbol), "c1", []);
        stop();
    });

    it("tears down the observers and flushes the surface", () => {
        list.append(row(1));
        const stop = observe();
        stop();
        expect(MockIntersectionObserver.instances[0].disconnected).toBe(true);
        expect(tracker.removeSurface).toHaveBeenCalledWith(expect.any(Symbol));
        root.dispatchEvent(new Event("scroll"));
        jest.advanceTimersByTime(16);
        expect(tracker.setVisible).not.toHaveBeenCalled();
    });

    it("does nothing where IntersectionObserver is missing", () => {
        Object.defineProperty(globalThis, "IntersectionObserver", { value: undefined, configurable: true });
        const stop = observe();
        stop();
        expect(tracker.setVisible).not.toHaveBeenCalled();
        expect(tracker.removeSurface).not.toHaveBeenCalled();
    });
});
