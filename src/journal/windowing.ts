/*
 * Windowed rendering for the transcript: only the rows near the viewport are mounted. A spacer
 * above and below the mounted rows stands in for the rest, sized from each row's measured height
 * (or an estimate until it has been on screen). A 2,000-event conversation keeps a few dozen rows
 * in the DOM instead of all of them.
 */

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface WindowRange {
    /** First mounted row. */
    start: number;
    /** One past the last mounted row. */
    end: number;
    /** Height of the spacer above the mounted rows. */
    before: number;
    /** Height of the spacer below them. */
    after: number;
}

/** Start offset of every row, plus the total height as the last entry. */
export function rowOffsets(keys: readonly string[], heightOf: (key: string) => number): number[] {
    const offsets = new Array<number>(keys.length + 1);
    let offset = 0;
    for (let index = 0; index < keys.length; index++) {
        offsets[index] = offset;
        offset += heightOf(keys[index]);
    }
    offsets[keys.length] = offset;
    return offsets;
}

/** Index of the row containing `position`; rows.length when position is past the end. */
function rowAt(offsets: readonly number[], position: number): number {
    const count = offsets.length - 1;
    let low = 0;
    let high = count;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (offsets[middle + 1] <= position) low = middle + 1;
        else high = middle;
    }
    return low;
}

/** Index of the first row starting at or after `position`; rows.length when there is none. */
function firstRowFrom(offsets: readonly number[], position: number): number {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (offsets[middle] < position) low = middle + 1;
        else high = middle;
    }
    return low;
}

/**
 * The rows that overlap the viewport, widened by `overscan` pixels on both sides. `top` is the
 * viewport's offset within the rows (scrollTop minus whatever sits above the first row).
 */
export function windowRange(offsets: readonly number[], top: number, height: number, overscan: number): WindowRange {
    const count = offsets.length - 1;
    const total = offsets[count];
    if (count === 0) return { start: 0, end: 0, before: 0, after: 0 };
    const clampedTop = Math.max(0, Math.min(top, total - height));
    const start = Math.min(rowAt(offsets, clampedTop - overscan), count - 1);
    const end = Math.max(start + 1, firstRowFrom(offsets, clampedTop + height + overscan));
    return { start, end, before: offsets[start], after: total - offsets[end] };
}

const OVERSCAN_PX = 1000;
/** Rows mounted before the scroller's size is known (the first render of a conversation). */
const INITIAL_TAIL_ROWS = 30;
/** Within this distance of the bottom, the reader is still following the tail. */
const NEAR_BOTTOM_PX = 80;
/** Layout passes allowed per commit while the measured heights settle. */
const MAX_SETTLE_PASSES = 4;

interface WindowedListOptions {
    scrollRef: RefObject<HTMLElement | null>;
    /** One stable key per row, top to bottom. Each row renders exactly one element. */
    keys: readonly string[];
    estimate: (key: string) => number;
    /** Keep the scroller pinned to the bottom while heights settle. */
    followTail: boolean;
    /**
     * Rows that can hold the reader's place. A row that moves when rows are added around it (a
     * day divider, which sits above the day's oldest loaded row) can't.
     */
    anchorable: (key: string) => boolean;
    /** Changes when the list shows something else entirely (another conversation): start afresh. */
    resetKey?: string;
}

interface WindowedList {
    range: WindowRange;
    /** Spacer refs: the mounted rows are the elements between them. */
    beforeRef: RefObject<HTMLLIElement | null>;
    afterRef: RefObject<HTMLLIElement | null>;
    /** Call from the scroller's scroll handler. */
    onScroll: () => void;
    /** Scroll row `index` into the upper third of the viewport and mount it. */
    reveal: (index: number) => void;
    /** Where the reader is, to come back to later; null at the tail. */
    place: () => ListPlace | null;
    /** Go back to a place from `place()`. False when its row is not in the list. */
    restorePlace: (place: ListPlace) => boolean;
}

/** A reading position: a row, and how far below the viewport's top its top edge sits. */
export interface ListPlace {
    key: string;
    offset: number;
}

/**
 * Windowing for a bottom-anchored list. When the scroller has no layout (jsdom, a hidden pane)
 * every row is mounted, so behaviour without a layout engine is unchanged.
 */
export function useWindowedList({
    scrollRef,
    keys,
    estimate,
    followTail,
    anchorable,
    resetKey,
}: WindowedListOptions): WindowedList {
    const heights = useRef(new Map<string, number>());
    const beforeRef = useRef<HTMLLIElement>(null);
    const afterRef = useRef<HTMLLIElement>(null);
    const viewport = useRef<{ top: number; height: number } | null>(null);
    // The caller learns that the reader left the tail a frame after the scroll; until then a
    // re-render would still pin to the bottom and undo the reader's scroll. Track it here too.
    const scrolledAway = useRef(false);
    const anchor = useRef<{ key: string; offset: number; scrollTop: number } | null>(null);
    // A new list starts unmeasured at its tail, not windowed around the previous list's offset.
    const previousResetKey = useRef(resetKey);
    if (resetKey !== previousResetKey.current) {
        previousResetKey.current = resetKey;
        viewport.current = null;
        anchor.current = null;
        scrolledAway.current = false;
    }
    const previousFollowTail = useRef(followTail);
    // The caller going back to the tail (jump to bottom, sending a message) overrides it.
    if (followTail && !previousFollowTail.current) scrolledAway.current = false;
    previousFollowTail.current = followTail;
    const following = followTail && !scrolledAway.current;
    const followTailRef = useRef(following);
    const [, setTick] = useState(0);
    const rerender = useCallback(() => setTick((tick) => tick + 1), []);

    const heightOf = (key: string): number => heights.current.get(key) ?? estimate(key);
    const offsets = rowOffsets(keys, heightOf);
    const total = offsets[keys.length];

    let range: WindowRange;
    if (viewport.current === null) {
        // Not laid out yet: mount the tail, which is where a conversation opens.
        const start = Math.max(0, keys.length - INITIAL_TAIL_ROWS);
        range = { start, end: keys.length, before: offsets[start], after: 0 };
    } else if (viewport.current.height === 0) {
        range = { start: 0, end: keys.length, before: 0, after: 0 };
    } else {
        const top = following ? total : viewport.current.top;
        range = windowRange(offsets, top, viewport.current.height, OVERSCAN_PX);
    }
    // What the DOM shows: updated when a render commits, never during one. A scroll event can
    // arrive between a render and its commit, and must see the rows that are actually mounted.
    const rendered = useRef(range);
    const renderedKeys = useRef(keys);
    useLayoutEffect(() => {
        rendered.current = range;
        renderedKeys.current = keys;
        followTailRef.current = following;
    });

    /**
     * Whether the rows are laid out. Not when the scroller is hidden, nor without a layout engine
     * (jsdom), where every offset reads 0 even if a test gives the scroller a height.
     */
    const hasLayout = useCallback((): boolean => {
        const scroller = scrollRef.current;
        const before = beforeRef.current;
        const after = afterRef.current;
        if (!scroller || !before || !after || scroller.clientHeight === 0) return false;
        return rendered.current.end === rendered.current.start || after.offsetTop > before.offsetTop;
    }, [scrollRef]);

    /** Viewport position relative to the first row. The scroller is the rows' offsetParent. */
    const readViewport = useCallback((): { top: number; height: number } | null => {
        const scroller = scrollRef.current;
        const before = beforeRef.current;
        if (!scroller || !before) return null;
        return { top: scroller.scrollTop - before.offsetTop, height: hasLayout() ? scroller.clientHeight : 0 };
    }, [scrollRef, hasLayout]);

    /** The mounted row elements, or null when they don't line up with the rendered range. */
    const mountedRows = useCallback((): HTMLElement[] | null => {
        const before = beforeRef.current;
        const after = afterRef.current;
        if (!before || !after) return null;
        const rows: HTMLElement[] = [];
        for (let node = before.nextElementSibling; node && node !== after; node = node.nextElementSibling) {
            rows.push(node as HTMLElement);
        }
        return rows.length === rendered.current.end - rendered.current.start ? rows : null;
    }, []);

    /** Record the real height of every mounted row. Returns whether any height changed. */
    const measure = useCallback((): boolean => {
        const rows = mountedRows();
        if (!rows || !hasLayout()) return false;
        rows.push(afterRef.current!);
        let changed = false;
        for (let index = 0; index < rows.length - 1; index++) {
            const key = renderedKeys.current[rendered.current.start + index];
            const height = rows[index + 1].offsetTop - rows[index].offsetTop;
            if (height === (heights.current.get(key) ?? estimate(key))) continue;
            heights.current.set(key, height);
            changed = true;
        }
        return changed;
    }, [mountedRows, hasLayout, estimate]);

    // The row the reader is looking at and its distance from the viewport's top: the first row that
    // starts inside the viewport, so a row above it changing height (older history arriving next to
    // it, an image loading) doesn't move what the reader sees. A row taller than the viewport, with
    // none starting inside it, is used when there is nothing else. Mounting rows, measuring them and prepending history all move the
    // content; restoring the anchor keeps the reader's place. Scroll anchoring is off on the
    // scroller, because the browser would otherwise correct the same shift a second time.
    const captureAnchor = useCallback((): void => {
        const scroller = scrollRef.current;
        const rows = mountedRows();
        if (!scroller || !rows || !hasLayout()) {
            anchor.current = null;
            return;
        }
        const scrollTop = scroller.scrollTop;
        const viewportBottom = scrollTop + scroller.clientHeight;
        anchor.current = null;
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            if (row.offsetTop >= viewportBottom) return;
            if (row.offsetTop + row.offsetHeight <= scrollTop) continue;
            const key = renderedKeys.current[rendered.current.start + index];
            if (!anchorable(key)) continue;
            const partial = row.offsetTop < scrollTop;
            if (partial && anchor.current) continue;
            anchor.current = { key, offset: row.offsetTop - scrollTop, scrollTop };
            if (!partial) return;
        }
    }, [scrollRef, mountedRows, hasLayout, anchorable]);

    /**
     * `scrollTop` is where the scroller was before this commit moved anything. If the reader has
     * scrolled since the anchor was taken (the browser fires the scroll event a frame later, so a
     * commit can land in between), the reader wins: the anchor is stale, and restoring it would
     * pull them back.
     */
    const restoreAnchor = useCallback(
        (scrollTop: number | undefined): void => {
            const scroller = scrollRef.current;
            const before = beforeRef.current;
            if (!scroller || !before || !hasLayout()) return;
            if (followTailRef.current) {
                scroller.scrollTop = scroller.scrollHeight;
                return;
            }
            const current = anchor.current;
            if (!current) return;
            if (scrollTop !== undefined && Math.abs(scrollTop - current.scrollTop) >= 1) return;
            const index = renderedKeys.current.indexOf(current.key);
            if (index < 0) return;
            const { start, end } = rendered.current;
            let rowTop: number;
            if (index >= start && index < end) {
                const rows = mountedRows();
                if (!rows) return;
                rowTop = rows[index - start].offsetTop;
            } else {
                // Not mounted: place it from the recorded heights; the next pass mounts it.
                const offsets = rowOffsets(renderedKeys.current, (key) => heights.current.get(key) ?? estimate(key));
                rowTop = before.offsetTop + before.offsetHeight + offsets[index] - offsets[start];
            }
            const target = rowTop - current.offset;
            if (Math.abs(scroller.scrollTop - target) >= 1) scroller.scrollTop = target;
            current.scrollTop = scroller.scrollTop;
        },
        [scrollRef, mountedRows, hasLayout, estimate],
    );

    const sameRange = (left: WindowRange, right: WindowRange): boolean =>
        left.start === right.start && left.end === right.end;

    /** Recompute the range from the scroller; re-render when the mounted rows would change. */
    const settle = useCallback((): boolean => {
        const current = readViewport();
        if (!current) return false;
        const changedViewport =
            viewport.current === null ||
            (viewport.current.height === 0) !== (current.height === 0) ||
            viewport.current.top !== current.top ||
            viewport.current.height !== current.height;
        viewport.current = current;
        if (current.height === 0)
            return changedViewport && rendered.current.end - rendered.current.start !== renderedKeys.current.length;
        const next = windowRange(
            rowOffsets(renderedKeys.current, (key) => heights.current.get(key) ?? estimate(key)),
            followTailRef.current ? Number.MAX_SAFE_INTEGER : current.top,
            current.height,
            OVERSCAN_PX,
        );
        return !sameRange(next, rendered.current);
    }, [readViewport, estimate]);

    // Read while rendering, before this commit's layout effects move anything.
    const scrollTopAtRender = scrollRef.current?.scrollTop;
    const passes = useRef(0);
    useLayoutEffect(() => {
        measure();
        restoreAnchor(scrollTopAtRender);
        if (settle() && passes.current < MAX_SETTLE_PASSES) {
            passes.current++;
            rerender();
            return;
        }
        passes.current = 0;
        captureAnchor();
    });

    // Rows that change height after mounting (an image loading, a card expanding, the pane
    // resizing) are re-measured on the next frame.
    useLayoutEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller || typeof ResizeObserver === "undefined") return;
        let frame: number | undefined;
        const observer = new ResizeObserver(() => {
            if (frame !== undefined) return;
            frame = requestAnimationFrame(() => {
                frame = undefined;
                if (measure()) restoreAnchor(scrollRef.current?.scrollTop);
                if (settle()) rerender();
                else captureAnchor();
            });
        });
        const list = beforeRef.current?.parentElement;
        observer.observe(scroller);
        if (list) observer.observe(list);
        return () => {
            observer.disconnect();
            if (frame !== undefined) cancelAnimationFrame(frame);
        };
    }, [scrollRef, measure, restoreAnchor, settle, captureAnchor, rerender]);

    const onScroll = useCallback((): void => {
        const scroller = scrollRef.current;
        if (scroller) {
            scrolledAway.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > NEAR_BOTTOM_PX;
            followTailRef.current = followTailRef.current && !scrolledAway.current;
        }
        captureAnchor();
        if (settle()) rerender();
    }, [scrollRef, captureAnchor, settle, rerender]);

    const reveal = useCallback(
        (index: number): void => {
            const scroller = scrollRef.current;
            const before = beforeRef.current;
            if (!scroller || !before) return;
            const rowOffsetsNow = rowOffsets(renderedKeys.current, (key) => heights.current.get(key) ?? estimate(key));
            const offset = Math.round(scroller.clientHeight / 3);
            scroller.scrollTop = Math.max(0, before.offsetTop + rowOffsetsNow[index] - offset);
            anchor.current = { key: renderedKeys.current[index], offset, scrollTop: scroller.scrollTop };
            if (settle()) rerender();
        },
        [scrollRef, estimate, settle, rerender],
    );

    const place = useCallback((): ListPlace | null => {
        if (followTailRef.current || !anchor.current) return null;
        return { key: anchor.current.key, offset: anchor.current.offset };
    }, []);

    const restorePlace = useCallback(
        ({ key, offset }: ListPlace): boolean => {
            const scroller = scrollRef.current;
            const before = beforeRef.current;
            const index = renderedKeys.current.indexOf(key);
            if (!scroller || !before || index < 0) return false;
            // Placed from the recorded heights; once the row is mounted, the anchor puts it exactly.
            const rowOffsetsNow = rowOffsets(renderedKeys.current, (row) => heights.current.get(row) ?? estimate(row));
            const { start } = rendered.current;
            const rowTop = before.offsetTop + before.offsetHeight + rowOffsetsNow[index] - rowOffsetsNow[start];
            scroller.scrollTop = Math.max(0, rowTop - offset);
            anchor.current = { key, offset, scrollTop: scroller.scrollTop };
            if (settle()) rerender();
            else restoreAnchor(scroller.scrollTop);
            return true;
        },
        [scrollRef, estimate, settle, rerender, restoreAnchor],
    );

    return { range, beforeRef, afterRef, onScroll, reveal, place, restorePlace };
}
