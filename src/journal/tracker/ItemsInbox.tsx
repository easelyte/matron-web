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
 * tap closes it, so it leaves "Needs you" (and the rail badge) as soon as the write lands.
 */

import React, { useMemo, useState } from "react";

import type { MatronJournalClient } from "../client";
import type { TrackerItem } from "../types";
import { itemOriginTitle, needsUser } from "./format";
import { ItemRow } from "./ItemRow";

type InboxFilter = "needs-you" | "all-open";

export function ItemsInbox({
    items,
    client,
    onOpenItem,
}: {
    items: TrackerItem[];
    client: MatronJournalClient;
    onOpenItem: (num: number) => void;
}): React.ReactElement {
    const [filter, setFilter] = useState<InboxFilter>("needs-you");
    // Notices whose Seen tap is in flight, so a double tap cannot post twice.
    const [seenBusy, setSeenBusy] = useState<ReadonlySet<number>>(() => new Set());
    const markSeen = async (num: number): Promise<void> => {
        if (seenBusy.has(num)) return;
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
    };

    // Keyed on the conversation list itself, not the client: the client replaces the list when a
    // conversation is renamed or loaded, and the rows must pick that up without a remount.
    const conversations = client.getSnapshot().conversations;
    const originTitles = useMemo(() => {
        const map = new Map<string, string>();
        for (const convo of conversations) map.set(convo.id, convo.title.trim() || convo.id);
        return map;
    }, [conversations]);

    const shown = useMemo(() => {
        if (filter === "needs-you") {
            return items.filter(needsUser).sort((a, b) => b.updated_at - a.updated_at);
        }
        return items.filter((item) => item.state === "open").sort((a, b) => b.updated_at - a.updated_at);
    }, [items, filter]);

    return (
        <div className="mj_TrackerList">
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
            </div>

            {shown.length === 0 ? (
                filter === "needs-you" ? (
                    <div className="mj_TrackerEmpty">
                        <p className="mj_TrackerEmpty_title">Nothing needs you</p>
                        <p className="mj_TrackerEmpty_hint">
                            Questions, things to read and secret requests from every conversation appear here.
                        </p>
                    </div>
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
                            originTitle={
                                originTitles.get(item.origin_convo_id) ?? itemOriginTitle(item) ?? "Another chat"
                            }
                            currentConvoId={client.getSnapshot().selectedConversationId}
                            onOpen={onOpenItem}
                            onSeen={(num) => void markSeen(num)}
                            seenBusy={seenBusy.has(item.num)}
                        />
                    ))}
                </section>
            )}
        </div>
    );
}
