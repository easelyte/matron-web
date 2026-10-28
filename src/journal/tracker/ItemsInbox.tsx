/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The app-wide For you inbox — every open item across conversations. A toggle switches between
 * "Needs you" (open && awaiting user, the default) and "All open". Rows use the full ItemRow with
 * an "all" scope so the origin conversation is named. The origin title is resolved best-effort from
 * the client's conversation list, then from the title the journal carries on the item
 * (origin_convo_title); an unresolved origin reads "Another chat". Rows filed from the conversation
 * being viewed carry no origin note. An open notice carries a one-tap Seen button on its row; the
 * tap closes it, so it leaves "Needs you" (and the rail badge) as soon as the write lands. A consent
 * request (a chat, join, spawn or file transfer waiting on the user) carries its own Approve and
 * Decline under its row: the journal answers the tap exactly as the request card, and closes the
 * item, so the row leaves "Needs you" the same way.
 *
 * "Done" is where it goes next: questions, decisions and notices that are closed or that the user
 * has answered, the one they last acted on first, so something answered or read can be found
 * again. It is loaded when the tab is first
 * opened and a page at a time after that; tasks stay out, as they are the agents' work list.
 *
 * "Spare allowance" is the backlog of heavy, non-urgent tasks (open tasks labelled
 * `spare-allowance`) that the Coordinator's spare-allowance routine starts on a box whose weekly
 * limit is about to reset with room left. It is in the task list's own order, the next one first;
 * a task already started carries the `dispatched` label.
 *
 * A search field above the toggle filters whichever tab is showing, the way the Conversations
 * search filters that list: every word typed must appear in the item's number, title, text or the
 * name of the conversation it came from. The query survives a tab switch.
 */

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import type { MatronJournalClient } from "../client";
import { SearchField } from "../search-field";
import type { InboxDone, TrackerItem } from "../types";
import { itemOriginTitle, needsUser } from "./format";
import { ItemRow } from "./ItemRow";

type InboxFilter = "needs-you" | "all-open" | "done" | "spare";

/** The label that puts a task in the spare-allowance backlog (journal `BACKLOG_LABEL`). */
export const SPARE_ALLOWANCE_LABEL = "spare-allowance";

export function spareAllowanceBacklog(items: TrackerItem[]): TrackerItem[] {
    return items
        .filter((item) => item.state === "open" && item.kind === "task" && item.labels.includes(SPARE_ALLOWANCE_LABEL))
        .sort((a, b) => a.rank - b.rank);
}

// Lowercased search text per item, so a keystroke doesn't lowercase every body again. Keyed on the
// item object: the client replaces an item's object when it changes, which drops the entry.
const haystacks = new WeakMap<TrackerItem, { originTitle: string; text: string }>();
function itemHaystack(item: TrackerItem, originTitle: string): string {
    const cached = haystacks.get(item);
    if (cached && cached.originTitle === originTitle) return cached.text;
    const text = `#${item.num} ${item.title} ${item.body} ${originTitle}`.toLowerCase();
    haystacks.set(item, { originTitle, text });
    return text;
}

/** Whether every word of `query` appears in the item's number, title, text or origin title. */
export function itemMatchesQuery(item: TrackerItem, query: string, originTitle: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const haystack = itemHaystack(item, originTitle);
    return words.every((word) => haystack.includes(word));
}

export function ItemsInbox({
    items,
    done,
    client,
    onOpenItem,
    onSearchEverything,
}: {
    items: TrackerItem[];
    /** The Done tab's rows; undefined until the tab is first opened. */
    done?: InboxDone;
    client: MatronJournalClient;
    onOpenItem: (num: number) => void;
    /** "Search everything for …" under a search: opens the Search page with the same text. */
    onSearchEverything?: (query: string) => void;
}): React.ReactElement {
    const [filter, setFilter] = useState<InboxFilter>("needs-you");
    const [query, setQuery] = useState("");
    // Notices whose Seen tap is in flight, so a double tap cannot post twice.
    const [seenBusy, setSeenBusy] = useState<ReadonlySet<number>>(() => new Set());
    // Stable across renders (it reads the busy set through a ref), so memoised rows skip a
    // re-render on every keystroke in the search field.
    const seenBusyRef = useRef(seenBusy);
    seenBusyRef.current = seenBusy;
    const markSeen = useCallback(
        async (num: number): Promise<void> => {
            if (seenBusyRef.current.has(num)) return;
            setSeenBusy((current) => new Set(current).add(num));
            try {
                await client.markItemSeen(num);
            } finally {
                setSeenBusy((current) => {
                    const next = new Set(current);
                    next.delete(num);
                    return next;
                });
            }
        },
        [client],
    );
    const onSeen = useCallback((num: number) => void markSeen(num), [markSeen]);

    // Consent requests whose answer is in flight, so a double tap cannot answer twice. A retry of
    // the same answer reuses its idempotency key.
    const [answerBusy, setAnswerBusy] = useState<ReadonlySet<number>>(() => new Set());
    const answerBusyRef = useRef(answerBusy);
    answerBusyRef.current = answerBusy;
    const answerKeys = useRef(new Map<string, string>());
    const answer = useCallback(
        async (num: number, label: string): Promise<void> => {
            if (answerBusyRef.current.has(num)) return;
            const slot = `${num}\n${label}`;
            const key = answerKeys.current.get(slot) ?? crypto.randomUUID();
            answerKeys.current.set(slot, key);
            setAnswerBusy((current) => new Set(current).add(num));
            try {
                if (await client.answerConsentItem(num, label, key)) answerKeys.current.delete(slot);
            } finally {
                setAnswerBusy((current) => {
                    const next = new Set(current);
                    next.delete(num);
                    return next;
                });
            }
        },
        [client],
    );
    const onAnswer = useCallback((num: number, label: string) => void answer(num, label), [answer]);

    // Keyed on the conversation list itself, not the client: the client replaces the list when a
    // conversation is renamed or loaded, and the rows must pick that up without a remount.
    const conversations = client.getSnapshot().conversations;
    const originTitles = useMemo(() => {
        const map = new Map<string, string>();
        for (const convo of conversations) map.set(convo.id, convo.title.trim() || convo.id);
        return map;
    }, [conversations]);

    // Every visit to the tab refreshes it: a notice seen a moment ago must already be there.
    useEffect(() => {
        if (filter === "done") void client.loadInboxDone();
    }, [client, filter]);

    const originTitle = (item: TrackerItem): string =>
        originTitles.get(item.origin_convo_id) ?? itemOriginTitle(item) ?? "Another chat";

    const tabItems = useMemo(() => {
        if (filter === "done") return done?.items ?? [];
        if (filter === "spare") return spareAllowanceBacklog(items);
        if (filter === "needs-you") {
            return items.filter(needsUser).sort((a, b) => b.updated_at - a.updated_at);
        }
        return items.filter((item) => item.state === "open").sort((a, b) => b.updated_at - a.updated_at);
    }, [items, done, filter]);
    // The field shows each key at once; the list follows the deferred query, so filtering and
    // redrawing rows never hold up typing.
    const deferredQuery = useDeferredValue(query);
    const searching = deferredQuery.trim() !== "";
    const shown = useMemo(
        () =>
            searching ? tabItems.filter((item) => itemMatchesQuery(item, deferredQuery, originTitle(item))) : tabItems,
        // originTitle is rebuilt each render but only reads originTitles.
        [tabItems, deferredQuery, searching, originTitles],
    );

    return (
        <div className="mj_TrackerList">
            <div className="mj_TrackerInboxSearch" role="search">
                <SearchField
                    id="for-you-search-input"
                    testId="for-you-search"
                    value={query}
                    onChange={setQuery}
                    placeholder="Search For you"
                    label="Search For you"
                    maxLength={256}
                />
            </div>
            <div className="mj_Seg mj_TrackerInboxToggle" role="tablist" aria-label="Inbox filter">
                <button
                    type="button"
                    role="tab"
                    aria-selected={filter === "needs-you"}
                    className={`mj_Seg_item mj_TrackerToggleTab${filter === "needs-you" ? " mj_Seg_item_on mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setFilter("needs-you")}
                >
                    Needs you
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={filter === "all-open"}
                    className={`mj_Seg_item mj_TrackerToggleTab${filter === "all-open" ? " mj_Seg_item_on mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setFilter("all-open")}
                >
                    All open
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={filter === "done"}
                    className={`mj_TrackerToggleTab${filter === "done" ? " mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setFilter("done")}
                >
                    Done
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={filter === "spare"}
                    className={`mj_TrackerToggleTab${filter === "spare" ? " mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setFilter("spare")}
                >
                    Spare allowance
                </button>
            </div>

            {filter === "done" && done?.error ? (
                <p className="mj_TrackerStaleNotice" role="alert">
                    Couldn't load the Done list: {done.error}
                </p>
            ) : null}

            {shown.length === 0 ? (
                searching && tabItems.length > 0 ? (
                    <div className="mj_TrackerEmpty">
                        <p className="mj_TrackerEmpty_title">No matches</p>
                        <p className="mj_TrackerEmpty_hint">Nothing in this list matches your search.</p>
                    </div>
                ) : filter === "needs-you" ? (
                    <div className="mj_TrackerEmpty">
                        <p className="mj_TrackerEmpty_title">Nothing needs you</p>
                        <p className="mj_TrackerEmpty_hint">
                            Questions, things to read and secret requests from every conversation appear here.
                        </p>
                    </div>
                ) : filter === "spare" ? (
                    <div className="mj_TrackerEmpty">
                        <p className="mj_TrackerEmpty_title">The backlog is empty</p>
                        <p className="mj_TrackerEmpty_hint">
                            Tasks labelled spare-allowance run on a box whose weekly limit is about to reset with room
                            left, in this order.
                        </p>
                    </div>
                ) : filter === "done" ? (
                    done && !done.loading && !done.error ? (
                        <div className="mj_TrackerEmpty">
                            <p className="mj_TrackerEmpty_title">Nothing done yet</p>
                            <p className="mj_TrackerEmpty_hint">
                                Questions and decisions move here once they are closed, and notices once you have seen
                                them.
                            </p>
                        </div>
                    ) : done?.error ? null : (
                        <div className="mj_TrackerEmpty">
                            <p className="mj_TrackerEmpty_hint">Loading…</p>
                        </div>
                    )
                ) : (
                    <div className="mj_TrackerEmpty">
                        <p className="mj_TrackerEmpty_title">No open items</p>
                    </div>
                )
            ) : (
                <section className="mj_TrackerSection">
                    {shown.map((item) => (
                        <ItemRow
                            key={item.id}
                            item={item}
                            scope="all"
                            originTitle={originTitle(item)}
                            currentConvoId={client.getSnapshot().selectedConversationId}
                            onOpen={onOpenItem}
                            onSeen={onSeen}
                            seenBusy={seenBusy.has(item.num)}
                            onAnswer={onAnswer}
                            answerBusy={answerBusy.has(item.num)}
                        />
                    ))}
                    {filter === "done" && done?.nextCursor ? (
                        <button
                            type="button"
                            className="mj_TrackerShowMore"
                            disabled={done.loading}
                            onClick={() => void client.loadMoreInboxDone()}
                        >
                            {done.loading ? "Loading…" : "Show more"}
                        </button>
                    ) : null}
                </section>
            )}
            {searching && onSearchEverything ? (
                <button
                    type="button"
                    className="mj_TrackerTextButton mj_TrackerInboxSearchAll"
                    onClick={() => onSearchEverything(query.trim())}
                >
                    Search everything for “{query.trim()}” →
                </button>
            ) : null}
        </div>
    );
}
