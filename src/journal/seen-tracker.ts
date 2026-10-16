/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Read state (journal protocol "Read state"): which messages and tracker items were actually on
// the user's screen. Separate from `read_marker` and the unread badge, which this never touches.
//
// A message counts as seen once its row has been visible for SEEN_DWELL_MS while the page is
// visible and focused. Visible means at least half the row is inside the timeline's scroll
// viewport, or the row covers at least half the viewport (a row taller than two screens can never
// be half visible). Seen seqs are batched into ranges and flushed about every SEEN_FLUSH_MS, and
// at once when the page loses focus or a timeline goes away. An item counts as seen when its
// detail is open, through the newest comment rendered in its thread.

export const SEEN_DWELL_MS = 1_000;
export const SEEN_FLUSH_MS = 2_000;
/** The journal's cap on ranges per `seen` op. */
export const SEEN_MAX_RANGES_PER_OP = 64;
/** The row attribute holding a timeline row's journal seq. */
export const SEEN_ROW_ATTRIBUTE = "data-event-id";

export type SeenOp = { op: "seen"; convo_id: string; ranges: Array<[number, number]> };
export type ItemSeenOp = { op: "item_seen"; item_id: string; through_comment_at: number };
/** Sends one op over the journal socket; false when it could not be sent (offline). */
export type SeenSend = (op: SeenOp | ItemSeenOp) => boolean;

/** A view showing a timeline. The same chat in two views dwells independently. */
export type SeenSurface = symbol;

export const newSeenSurface = (): SeenSurface => Symbol("seen-surface");

/** Whether a row's vertical extent counts as visible in the viewport's (same coordinate space). */
export function isRowVisible(row: { top: number; bottom: number }, viewport: { top: number; bottom: number }): boolean {
    const viewportHeight = viewport.bottom - viewport.top;
    const rowHeight = row.bottom - row.top;
    if (viewportHeight <= 0 || rowHeight <= 0) return false;
    const shown = Math.min(row.bottom, viewport.bottom) - Math.max(row.top, viewport.top);
    if (shown <= 0) return false;
    return shown >= rowHeight / 2 || shown >= viewportHeight / 2;
}

/** A timeline row attribute value as a journal seq; pending, streaming and separator rows have none. */
export function seqFromRowAttribute(value: string | null): number | undefined {
    if (value === null || value === "") return undefined;
    const seq = Number(value);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

/** Sorted, with runs of consecutive seqs merged. */
export function seqRanges(seqs: Iterable<number>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const seq of [...seqs].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last && last[1] + 1 === seq) last[1] = seq;
        else if (!last || last[1] < seq) out.push([seq, seq]);
    }
    return out;
}

interface Surface {
    convoId: string;
    /** Visible seq → when its current dwell started (reset whenever the page becomes active again). */
    since: Map<number, number>;
}

/** The pure state behind SeenTracker: dwell timing, pending seqs and range batching. Time is
 *  passed in (ms), so tests drive it with synthetic instants. */
export class SeenLedger {
    private readonly surfaces = new Map<SeenSurface, Surface>();
    /** Seen, not yet sent, per conversation. */
    private readonly pending = new Map<string, Set<number>>();
    /** Already sent (or queued) per conversation, so a row that stays on screen isn't reported on
     *  every flush. */
    private readonly reported = new Map<string, Set<number>>();

    public constructor(
        public readonly dwellMs = SEEN_DWELL_MS,
        private active = true,
    ) {}

    public get isActive(): boolean {
        return this.active;
    }

    public get hasPending(): boolean {
        return this.pending.size > 0;
    }

    /** `surface` now shows `seqs` of `convoId`. Seqs still visible keep their dwell start; new ones
     *  start now; the rest stop counting. Rows that already dwelt long enough are promoted first, so
     *  one scrolled away before its (possibly late) dwell timer fired still counts. */
    public setVisible(surface: SeenSurface, convoId: string, seqs: Iterable<number>, now: number): void {
        this.promote(now);
        const previous = this.surfaces.get(surface);
        const kept = previous?.convoId === convoId ? previous.since : undefined;
        const reported = this.reported.get(convoId);
        const since = new Map<number, number>();
        for (const seq of seqs) {
            if (reported?.has(seq)) continue;
            since.set(seq, kept?.get(seq) ?? now);
        }
        this.surfaces.set(surface, { convoId, since });
    }

    /** The surface went away. Rows that already dwelt long enough are promoted first. */
    public removeSurface(surface: SeenSurface, now: number): void {
        this.promote(now);
        this.surfaces.delete(surface);
    }

    /** Page active state. Going inactive promotes what already dwelt and pauses the rest; becoming
     *  active restarts every visible row's dwell from `now`. */
    public setActive(active: boolean, now: number): void {
        if (active === this.active) return;
        if (!active) this.promote(now);
        this.active = active;
        if (active) {
            for (const surface of this.surfaces.values()) {
                for (const seq of surface.since.keys()) surface.since.set(seq, now);
            }
        }
    }

    /** Marks a seq seen outright, without dwell. */
    public markSeen(convoId: string, seq: number): void {
        const reported = this.reported.get(convoId) ?? new Set<number>();
        if (reported.has(seq)) return;
        reported.add(seq);
        this.reported.set(convoId, reported);
        const pending = this.pending.get(convoId) ?? new Set<number>();
        pending.add(seq);
        this.pending.set(convoId, pending);
    }

    /** Moves every visible seq whose dwell is complete into pending. */
    public promote(now: number): void {
        if (!this.active) return;
        for (const surface of this.surfaces.values()) {
            for (const [seq, start] of [...surface.since]) {
                if (now - start < this.dwellMs) continue;
                surface.since.delete(seq);
                this.markSeen(surface.convoId, seq);
            }
        }
    }

    /** When the next dwell completes, or undefined when nothing is dwelling. */
    public get nextDeadline(): number | undefined {
        if (!this.active) return undefined;
        let earliest: number | undefined;
        for (const surface of this.surfaces.values()) {
            for (const start of surface.since.values()) {
                if (earliest === undefined || start < earliest) earliest = start;
            }
        }
        return earliest === undefined ? undefined : earliest + this.dwellMs;
    }

    /** Takes everything pending as `seen` ops: consecutive seqs merged into ranges, at most
     *  SEEN_MAX_RANGES_PER_OP ranges per op. */
    public drain(): SeenOp[] {
        const ops: SeenOp[] = [];
        for (const convoId of [...this.pending.keys()].sort()) {
            const ranges = seqRanges(this.pending.get(convoId)!);
            for (let start = 0; start < ranges.length; start += SEEN_MAX_RANGES_PER_OP) {
                ops.push({
                    op: "seen",
                    convo_id: convoId,
                    ranges: ranges.slice(start, start + SEEN_MAX_RANGES_PER_OP),
                });
            }
        }
        this.pending.clear();
        return ops;
    }

    /** A drained op failed to send; its seqs go back into pending. */
    public restore(op: SeenOp): void {
        const pending = this.pending.get(op.convo_id) ?? new Set<number>();
        for (const [from, to] of op.ranges) {
            for (let seq = from; seq <= to; seq += 1) pending.add(seq);
        }
        this.pending.set(op.convo_id, pending);
    }
}

/** Where the tracker learns whether the page counts as in front of the user. */
export interface SeenActivity {
    isActive(): boolean;
    /** Calls `onChange` whenever isActive may have changed; returns the unsubscribe. */
    subscribe(onChange: () => void): () => void;
}

/** Active while the document is visible and focused: a background tab, a minimised window or
 *  another app in front shows nothing to the user. */
export function documentActivity(doc: Document = document, win: Window = window): SeenActivity {
    return {
        isActive: () => doc.visibilityState === "visible" && doc.hasFocus(),
        subscribe(onChange) {
            doc.addEventListener("visibilitychange", onChange);
            win.addEventListener("focus", onChange);
            win.addEventListener("blur", onChange);
            return () => {
                doc.removeEventListener("visibilitychange", onChange);
                win.removeEventListener("focus", onChange);
                win.removeEventListener("blur", onChange);
            };
        },
    };
}

export interface SeenTrackerOptions {
    send: SeenSend;
    dwellMs?: number;
    flushMs?: number;
    now?: () => number;
    activity?: SeenActivity;
}

/** Drives a SeenLedger on real time and sends through the journal connection. One per client. */
export class SeenTracker {
    private ledger: SeenLedger;
    private readonly send: SeenSend;
    private readonly dwellMs: number;
    private readonly flushMs: number;
    private readonly now: () => number;
    private readonly activity: SeenActivity;
    private unsubscribe?: () => void;
    private dwellTimer?: ReturnType<typeof setTimeout>;
    private flushTimer?: ReturnType<typeof setTimeout>;
    /** Item details on screen → the newest rendered comment (ms, 0 = none). */
    private readonly itemsOnScreen = new Map<string, number>();
    /** The newest comment already reported per item (the op is monotonic server-side, so
     *  re-sending an older value is only wasted bytes). */
    private readonly itemsReported = new Map<string, number>();

    public constructor(options: SeenTrackerOptions) {
        this.send = options.send;
        this.dwellMs = options.dwellMs ?? SEEN_DWELL_MS;
        this.flushMs = options.flushMs ?? SEEN_FLUSH_MS;
        this.now = options.now ?? (() => Date.now());
        this.activity = options.activity ?? documentActivity();
        this.ledger = new SeenLedger(this.dwellMs, false);
    }

    // Messages

    /** The seqs `surface` currently shows as visible (see isRowVisible). */
    public setVisible(surface: SeenSurface, convoId: string, seqs: Iterable<number>): void {
        this.watchActivity();
        const deadline = this.ledger.nextDeadline;
        this.ledger.setVisible(surface, convoId, seqs, this.now());
        // Scroll ticks mostly leave the next deadline where it was.
        if (this.ledger.nextDeadline !== deadline) this.schedule();
    }

    /** The surface closed or stopped showing a chat: flush what it saw. */
    public removeSurface(surface: SeenSurface): void {
        this.ledger.removeSurface(surface, this.now());
        this.schedule();
        this.flush();
    }

    // Items

    /** An item's detail is on screen, `newestCommentAt` the newest comment rendered in its thread
     *  (ms, 0 when it has none). Sent at once while active, and again whenever a newer comment
     *  renders. */
    public setItemOnScreen(itemId: string, newestCommentAt: number): void {
        this.watchActivity();
        this.itemsOnScreen.set(itemId, newestCommentAt);
        if (this.ledger.isActive) this.reportItem(itemId, newestCommentAt);
    }

    public removeItem(itemId: string): void {
        this.itemsOnScreen.delete(itemId);
    }

    /** Sends everything pending now. Failed sends are kept for the next flush. */
    public flush(): void {
        if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        const failed = this.ledger.drain().filter((op) => !this.send(op));
        if (failed.length === 0) return;
        for (const op of failed) this.ledger.restore(op);
        // Offline: the retry rides the next scheduled flush (or the next state change), not a
        // tight loop.
        if (this.ledger.isActive) this.schedule();
    }

    /** Signed out: drop everything, unsent seqs included, and stop listening. */
    public reset(): void {
        if (this.dwellTimer !== undefined) clearTimeout(this.dwellTimer);
        if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
        this.dwellTimer = undefined;
        this.flushTimer = undefined;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.ledger = new SeenLedger(this.dwellMs, false);
        this.itemsOnScreen.clear();
        this.itemsReported.clear();
    }

    private watchActivity(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = this.activity.subscribe(() => this.setActive(this.activity.isActive()));
        this.setActive(this.activity.isActive());
    }

    private setActive(active: boolean): void {
        if (active === this.ledger.isActive) return;
        this.ledger.setActive(active, this.now());
        if (active) {
            for (const [itemId, through] of this.itemsOnScreen) this.reportItem(itemId, through);
        } else {
            this.flush();
        }
        this.schedule();
    }

    private reportItem(itemId: string, through: number): void {
        const last = this.itemsReported.get(itemId);
        if (last !== undefined && last >= through) return;
        // Offline: not remembered as sent, so the next open or focus reports it again.
        if (this.send({ op: "item_seen", item_id: itemId, through_comment_at: through })) {
            this.itemsReported.set(itemId, through);
        }
    }

    /** Arms the dwell timer for the next row to finish dwelling, and the flush timer when
     *  something is pending. */
    private schedule(): void {
        if (this.dwellTimer !== undefined) clearTimeout(this.dwellTimer);
        this.dwellTimer = undefined;
        const deadline = this.ledger.nextDeadline;
        if (deadline !== undefined) {
            this.dwellTimer = setTimeout(
                () => {
                    this.dwellTimer = undefined;
                    this.ledger.promote(this.now());
                    this.schedule();
                },
                Math.max(0, deadline - this.now()),
            );
        }
        if (this.ledger.hasPending && this.flushTimer === undefined) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = undefined;
                this.flush();
            }, this.flushMs);
        }
    }
}

/** Feeds `tracker` the rows of one timeline that are on screen: an IntersectionObserver finds the
 *  rows inside the scroll viewport `root`, and their rects decide which count as visible (a
 *  threshold alone can't, since it is a fraction of the row and a very tall row never reaches
 *  it). Rows are the children of `list` carrying SEEN_ROW_ATTRIBUTE; rows added or removed later
 *  are picked up as they come and go. Returns the teardown, which flushes what was seen. */
export function observeSeenRows({
    tracker,
    convoId,
    root,
    list,
}: {
    tracker: SeenTracker;
    convoId: string;
    root: HTMLElement;
    list: HTMLElement;
}): () => void {
    if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return () => {};
    const surface = newSeenSurface();
    const intersecting = new Set<Element>();
    let lastReported = "";
    let frame: number | undefined;

    const report = (): void => {
        const viewport = root.getBoundingClientRect();
        const seqs: number[] = [];
        for (const row of intersecting) {
            const seq = seqFromRowAttribute(row.getAttribute(SEEN_ROW_ATTRIBUTE));
            if (seq !== undefined && isRowVisible(row.getBoundingClientRect(), viewport)) seqs.push(seq);
        }
        seqs.sort((a, b) => a - b);
        const key = seqs.join(",");
        if (key === lastReported) return;
        lastReported = key;
        tracker.setVisible(surface, convoId, seqs);
    };
    const scheduleReport = (): void => {
        if (frame !== undefined) return;
        frame = requestAnimationFrame(() => {
            frame = undefined;
            report();
        });
    };

    const intersection = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) intersecting.add(entry.target);
                else intersecting.delete(entry.target);
            }
            report();
        },
        { root, threshold: [0, 0.5] },
    );
    const isRow = (node: Node): node is Element => node instanceof Element && node.hasAttribute(SEEN_ROW_ATTRIBUTE);
    const mutations = new MutationObserver((records) => {
        let removed = false;
        for (const record of records) {
            record.addedNodes.forEach((node) => {
                if (isRow(node)) intersection.observe(node);
            });
            record.removedNodes.forEach((node) => {
                if (!isRow(node)) return;
                intersection.unobserve(node);
                removed = intersecting.delete(node) || removed;
            });
        }
        if (removed) report();
    });

    for (const row of Array.from(list.children)) if (isRow(row)) intersection.observe(row);
    mutations.observe(list, { childList: true });
    root.addEventListener("scroll", scheduleReport, { passive: true });
    window.addEventListener("resize", scheduleReport);

    return () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        root.removeEventListener("scroll", scheduleReport);
        window.removeEventListener("resize", scheduleReport);
        mutations.disconnect();
        intersection.disconnect();
        tracker.removeSurface(surface);
    };
}
