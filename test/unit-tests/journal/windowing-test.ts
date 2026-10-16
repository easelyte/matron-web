/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { rowOffsets, useWindowedList, windowRange } from "../../../src/journal/windowing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("rowOffsets", () => {
    it("gives each row's start and the total last", () => {
        expect(rowOffsets(["a", "b", "c"], (key) => (key === "b" ? 50 : 10))).toEqual([0, 10, 60, 70]);
        expect(rowOffsets([], () => 10)).toEqual([0]);
    });
});

describe("windowRange", () => {
    const offsets = rowOffsets(
        Array.from({ length: 100 }, (_, index) => `r${index}`),
        () => 100,
    );

    it("covers the viewport plus the overscan on both sides", () => {
        // Viewport 2,000–2,500 px with 300 px overscan: rows 17 (1,700 px) to 27 (2,800 px).
        expect(windowRange(offsets, 2000, 500, 300)).toEqual({ start: 17, end: 28, before: 1700, after: 7200 });
    });

    it("clamps a viewport past the end to the tail", () => {
        const range = windowRange(offsets, 1e9, 500, 0);
        expect(range.end).toBe(100);
        expect(range.after).toBe(0);
        expect(range.start).toBe(95);
    });

    it("starts at the first row at the top", () => {
        expect(windowRange(offsets, 0, 500, 0)).toMatchObject({ start: 0, before: 0 });
    });

    it("mounts nothing for no rows", () => {
        expect(windowRange([0], 0, 500, 300)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
    });
});

/** A bottom-anchored list of fixed-height rows using the hook. */
function List({
    keys,
    followTail,
    resetKey,
    onWindowed,
}: {
    keys: string[];
    followTail: boolean;
    resetKey?: string;
    onWindowed?: (windowed: ReturnType<typeof useWindowedList>) => void;
}): React.ReactElement {
    const scrollRef = useRef<HTMLDivElement>(null);
    const windowed = useWindowedList({
        scrollRef,
        keys,
        estimate: () => 50,
        followTail,
        anchorable: () => true,
        resetKey,
    });
    onWindowed?.(windowed);
    return React.createElement(
        "div",
        { ref: scrollRef, className: "scroller", onScroll: windowed.onScroll },
        React.createElement(
            "ol",
            null,
            React.createElement("li", {
                className: "spacer",
                ref: windowed.beforeRef,
                style: { height: windowed.range.before },
            }),
            keys
                .slice(windowed.range.start, windowed.range.end)
                .map((key) => React.createElement("li", { key, "data-key": key }, key)),
            React.createElement("li", {
                className: "spacer",
                ref: windowed.afterRef,
                style: { height: windowed.range.after },
            }),
        ),
    );
}

const ROW_HEIGHT = 100;
const VIEWPORT = 500;

describe("useWindowedList", () => {
    let container: HTMLDivElement;
    let root: Root;
    const restore: Array<() => void> = [];

    const define = (target: object, name: string, descriptor: PropertyDescriptor): void => {
        const previous = Object.getOwnPropertyDescriptor(target, name);
        Object.defineProperty(target, name, { configurable: true, ...descriptor });
        restore.push(() => {
            if (previous) Object.defineProperty(target, name, previous);
            else delete (target as Record<string, unknown>)[name];
        });
    };

    const rows = (count: number, prefix = "r"): string[] =>
        Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    const mounted = (): string[] =>
        Array.from(container.querySelectorAll<HTMLElement>("li[data-key]"), (li) => li.dataset.key!);
    const scroller = (): HTMLElement => container.querySelector<HTMLElement>(".scroller")!;
    const topOf = (key: string): number =>
        container.querySelector<HTMLElement>(`li[data-key="${key}"]`)!.offsetTop - scroller().scrollTop;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        while (restore.length) restore.pop()!();
    });

    /** A minimal layout: rows are 100 px, spacers their style height, the scroller 500 px tall. */
    const withLayout = (): void => {
        const heightOf = (element: HTMLElement): number =>
            element.classList.contains("spacer") ? parseFloat(element.style.height) || 0 : ROW_HEIGHT;
        define(HTMLElement.prototype, "offsetHeight", {
            get(this: HTMLElement) {
                return this.tagName === "LI" ? heightOf(this) : 0;
            },
        });
        define(HTMLElement.prototype, "offsetTop", {
            get(this: HTMLElement) {
                let top = 0;
                for (let node = this.previousElementSibling; node; node = node.previousElementSibling) {
                    top += heightOf(node as HTMLElement);
                }
                return top;
            },
        });
        let scrollTop = 0;
        const contentHeight = (element: HTMLElement): number =>
            Array.from(element.querySelectorAll<HTMLElement>("ol > li"), heightOf).reduce((sum, h) => sum + h, 0);
        define(HTMLElement.prototype, "clientHeight", {
            get(this: HTMLElement) {
                return this.classList.contains("scroller") ? VIEWPORT : 0;
            },
        });
        define(HTMLElement.prototype, "scrollHeight", {
            get(this: HTMLElement) {
                return this.classList.contains("scroller") ? contentHeight(this) : 0;
            },
        });
        define(HTMLElement.prototype, "scrollTop", {
            get(this: HTMLElement) {
                return this.classList.contains("scroller") ? scrollTop : 0;
            },
            set(this: HTMLElement, value: number) {
                if (!this.classList.contains("scroller")) return;
                scrollTop = Math.max(0, Math.min(value, contentHeight(this) - VIEWPORT));
            },
        });
    };

    it("mounts every row when there is no layout", () => {
        act(() => root.render(React.createElement(List, { keys: rows(200), followTail: true })));
        expect(mounted()).toHaveLength(200);
    });

    it("mounts only the rows near the bottom when following the tail", () => {
        withLayout();
        act(() => root.render(React.createElement(List, { keys: rows(1000), followTail: true })));
        const keys = mounted();
        expect(keys.length).toBeLessThan(30);
        expect(keys.at(-1)).toBe("r999");
        expect(scroller().scrollTop).toBe(scroller().scrollHeight - VIEWPORT);
    });

    it("mounts the rows at the new position after a scroll", () => {
        withLayout();
        act(() => root.render(React.createElement(List, { keys: rows(1000), followTail: true })));
        act(() => {
            scroller().scrollTop = 0;
            scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        act(() => root.render(React.createElement(List, { keys: rows(1000), followTail: false })));
        expect(mounted()[0]).toBe("r0");
        expect(mounted().length).toBeLessThan(20);
    });

    it("keeps the row the reader is looking at in place when older rows are prepended", () => {
        withLayout();
        const keys = rows(300);
        act(() => root.render(React.createElement(List, { keys, followTail: true })));
        act(() => {
            scroller().scrollTop = scroller().scrollHeight / 2 + 30;
            scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        act(() => root.render(React.createElement(List, { keys, followTail: false })));
        // The first row reaching into the viewport.
        const reading = mounted().find((key) => topOf(key) + ROW_HEIGHT > 0)!;
        expect(reading).toBeDefined();
        const before = topOf(reading);
        act(() => root.render(React.createElement(List, { keys: [...rows(80, "old"), ...keys], followTail: false })));
        expect(topOf(reading)).toBe(before);
    });

    it("opens a new list at its tail even though the reader had scrolled away in the last one", () => {
        withLayout();
        act(() => root.render(React.createElement(List, { keys: rows(1000), followTail: true, resetKey: "a" })));
        // Scrolled away; the owner has not caught up yet and still asks to follow the tail.
        act(() => {
            scroller().scrollTop = 30_000;
            scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        expect(mounted()).not.toContain("r999");
        act(() => root.render(React.createElement(List, { keys: rows(1000, "b"), followTail: true, resetKey: "b" })));
        expect(mounted().at(-1)).toBe("b999");
        expect(scroller().scrollTop).toBe(scroller().scrollHeight - VIEWPORT);
    });

    it("goes back to a remembered place after showing another list", () => {
        withLayout();
        let windowed: ReturnType<typeof useWindowedList> | undefined;
        const onWindowed = (latest: ReturnType<typeof useWindowedList>): void => {
            windowed = latest;
        };
        const keys = rows(300);
        act(() => root.render(React.createElement(List, { keys, followTail: true, onWindowed })));
        act(() => {
            scroller().scrollTop = 12_345;
            scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        act(() => root.render(React.createElement(List, { keys, followTail: false, onWindowed })));
        const place = windowed!.place();
        expect(place).not.toBeNull();
        const before = topOf(place!.key);

        act(() => root.render(React.createElement(List, { keys: rows(50, "other"), followTail: true, onWindowed })));
        expect(windowed!.place()).toBeNull();
        expect(mounted()).not.toContain(place!.key);

        act(() => root.render(React.createElement(List, { keys, followTail: false, onWindowed })));
        act(() => {
            expect(windowed!.restorePlace(place!)).toBe(true);
        });
        expect(topOf(place!.key)).toBe(before);
        expect(windowed!.restorePlace({ key: "missing", offset: 0 })).toBe(false);
    });
});
