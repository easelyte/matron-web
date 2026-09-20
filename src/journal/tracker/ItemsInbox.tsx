/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The app-wide Decisions inbox — every open item across conversations. A toggle switches between
 * "Needs you" (open && awaiting user, the default) and "All open". Rows use the full ItemRow with
 * an "all" scope so the origin conversation is named. The origin title is resolved best-effort from
 * the client's conversation list; an unresolved origin reads "Another chat".
 */

import React, { useMemo, useState } from "react";

import type { MatronJournalClient } from "../client";
import type { TrackerItem } from "../types";
import { needsUser } from "./format";
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

    const originTitles = useMemo(() => {
        const map = new Map<string, string>();
        for (const convo of client.getSnapshot().conversations) map.set(convo.id, convo.title.trim() || convo.id);
        return map;
    }, [client]);

    const shown = useMemo(() => {
        if (filter === "needs-you") {
            return items.filter(needsUser).sort((a, b) => b.updated_at - a.updated_at);
        }
        return items.filter((item) => item.state === "open").sort((a, b) => b.updated_at - a.updated_at);
    }, [items, filter]);

    return (
        <div className="mj_TrackerList">
            <div className="mj_TrackerInboxToggle" role="tablist" aria-label="Inbox filter">
                <button
                    type="button"
                    role="tab"
                    aria-selected={filter === "needs-you"}
                    className={`mj_TrackerToggleTab${filter === "needs-you" ? " mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setFilter("needs-you")}
                >
                    Needs you
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={filter === "all-open"}
                    className={`mj_TrackerToggleTab${filter === "all-open" ? " mj_TrackerToggleTab_active" : ""}`}
                    onClick={() => setFilter("all-open")}
                >
                    All open
                </button>
            </div>

            {shown.length === 0 ? (
                filter === "needs-you" ? (
                    <div className="mj_TrackerEmpty">
                        <p className="mj_TrackerEmpty_title">Nothing needs you</p>
                        <p className="mj_TrackerEmpty_hint">Questions and decisions waiting on you appear here.</p>
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
                            originTitle={originTitles.get(item.origin_convo_id) ?? "Another chat"}
                            currentConvoId={client.getSnapshot().selectedConversationId}
                            onOpen={onOpenItem}
                        />
                    ))}
                </section>
            )}
        </div>
    );
}
