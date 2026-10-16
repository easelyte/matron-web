/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import type { TrackerWorking } from "../types";
import { ItemDetail } from "../tracker/ItemDetail";
import { workingLabel } from "../tracker/working";
import { fakeSeen, trackerComment, trackerItem } from "./tracker-fixtures";

const NOW = 1_700_000_000_000;

function fakeClient(): MatronJournalClient {
    return {
        seen: fakeSeen(),
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
        commentItem: jest.fn().mockResolvedValue(true),
        closeTrackerItem: jest.fn().mockResolvedValue(true),
        reopenTrackerItem: jest.fn().mockResolvedValue(true),
        closeTrackerView: jest.fn(),
        selectConversation: jest.fn().mockResolvedValue(undefined),
        openTrackerLink: jest.fn(),
        openTrackerMission: jest.fn(),
        loadMissions: jest.fn().mockResolvedValue(undefined),
    } as unknown as MatronJournalClient;
}

function detail(working: TrackerWorking | null | undefined, client: MatronJournalClient): React.ReactElement {
    return (
        <ItemDetail
            item={trackerItem({ working })}
            comments={[trackerComment({ id: "ic_1", body: "On it" })]}
            client={client}
            onBack={jest.fn()}
        />
    );
}

async function mount(working: TrackerWorking | null | undefined): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(detail(working, fakeClient()));
    });
    return { container, root };
}

/** jsdom lays nothing out: give the scrolling region a size, and record what is written to its
 *  scrollTop. `overflow` is how far the reader is from the foot of the thread. */
function fakeScroll(node: Element, overflow: number): { writes: number[] } {
    const writes: number[] = [];
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(node, "scrollTop", {
        configurable: true,
        get: () => 600 - overflow,
        set: (value: number) => void writes.push(value),
    });
    return { writes };
}

const indicator = (container: HTMLElement): HTMLElement | null => container.querySelector(".mj_TrackerWorking");

describe("workingLabel", () => {
    it("names a running session and a queued one, and nothing else", () => {
        expect(workingLabel({ state: "running", since: NOW, until: null }, NOW)).toBe("Working");
        expect(workingLabel({ state: "queued", since: NOW, until: NOW + 1000 }, NOW)).toBe("Starting");
        expect(workingLabel(null, NOW)).toBeNull();
        expect(workingLabel(undefined, NOW)).toBeNull();
        // A state a newer journal might send is not guessed at.
        expect(workingLabel({ state: "paused" as "running", since: NOW, until: null }, NOW)).toBeNull();
    });

    it("lets a queued state lapse at `until`", () => {
        const queued: TrackerWorking = { state: "queued", since: NOW, until: NOW + 1000 };
        expect(workingLabel(queued, NOW + 999)).toBe("Starting");
        expect(workingLabel(queued, NOW + 1000)).toBeNull();
        // A running state with no `until` never lapses on the clock.
        expect(workingLabel({ state: "running", since: NOW, until: null }, NOW + 86_400_000)).toBe("Working");
    });
});

describe("ItemDetail working indicator", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
    });
    afterEach(() => {
        jest.useRealTimers();
        document.body.innerHTML = "";
    });

    it("shows the chat's indicator at the foot of the thread while the session is running", async () => {
        const { container, root } = await mount({ state: "running", since: NOW - 5000, until: null });
        const row = indicator(container);
        expect(row).not.toBeNull();
        expect(row!.textContent).toBe("Working");
        expect(row!.getAttribute("role")).toBe("status");
        expect(row!.querySelectorAll("span[aria-hidden='true']")).toHaveLength(3);
        // After the thread, inside the scrolling region.
        const scroll = container.querySelector(".mj_TrackerDetail_scroll")!;
        expect(scroll.lastElementChild).toBe(row);
        act(() => root.unmount());
    });

    it("shows nothing for an idle session, or a journal that does not send the field", async () => {
        for (const working of [null, undefined]) {
            const { container, root } = await mount(working);
            expect(indicator(container)).toBeNull();
            act(() => root.unmount());
        }
    });

    it("shows a queued turn as starting, and drops it by itself at `until`", async () => {
        const { container, root } = await mount({ state: "queued", since: NOW, until: NOW + 60_000 });
        expect(indicator(container)!.textContent).toBe("Starting");
        await act(async () => {
            jest.advanceTimersByTime(59_000);
        });
        expect(indicator(container)).not.toBeNull();
        await act(async () => {
            jest.advanceTimersByTime(1_100);
        });
        expect(indicator(container)).toBeNull();
        act(() => root.unmount());
    });

    it("does not show a queued state that had already lapsed when it arrived", async () => {
        const { container, root } = await mount({ state: "queued", since: NOW - 120_000, until: NOW - 1 });
        expect(indicator(container)).toBeNull();
        act(() => root.unmount());
    });

    it("leaves an item opened mid-turn at the top of its thread", async () => {
        const spy = jest.spyOn(Element.prototype, "scrollTop", "set");
        const { root } = await mount({ state: "running", since: NOW - 5000, until: null });
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        act(() => root.unmount());
    });

    it("brings an indicator that appears into view for a reader near the foot, and no other", async () => {
        const client = fakeClient();
        const running: TrackerWorking = { state: "running", since: NOW, until: null };
        for (const [overflow, moved] of [
            [40, true],
            [500, false],
        ] as const) {
            const { container, root } = await mount(null);
            const { writes } = fakeScroll(container.querySelector(".mj_TrackerDetail_scroll")!, overflow);
            await act(async () => root.render(detail(running, client)));
            expect(writes).toEqual(moved ? [1000] : []);
            act(() => root.unmount());
        }
    });
});
