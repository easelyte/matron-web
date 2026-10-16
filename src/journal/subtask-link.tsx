/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * A bridge "🔀 Subtask: …" line, drawn as a card that opens the subagent it started. Until the
 * child conversation is known the line stays the plain text it always was; the card appears as
 * soon as the child arrives. Only the row's content changes, never the row around it.
 */

import React, { useSyncExternalStore } from "react";

import type { MatronJournalClient } from "./client";
import { BranchIcon, CheckCircleIcon, ChevronRightIcon } from "./icons";
import { displayTitle } from "./SessionTag";
import { resolveSubtaskTarget, subtaskCandidates } from "./subtask";
import type { Conversation } from "./types";

/** The resolved child, as a stable string so the row re-renders only when the match changes. */
function useSubtaskTarget(client: MatronJournalClient, convoId: string, description: string): Conversation | undefined {
    const key = useSyncExternalStore(client.subscribe, () => {
        const child = resolveSubtaskTarget(description, subtaskCandidates(client.getSnapshot().conversations, convoId));
        return child ? `${child.id}\n${child.session_state}\n${child.title}` : "";
    });
    if (!key) return undefined;
    return client.getSnapshot().conversations.find((conversation) => conversation.id === key.split("\n", 1)[0]);
}

export function SubtaskLine({
    client,
    convoId,
    description,
    children,
}: {
    client: MatronJournalClient;
    /** The conversation the line was posted in. */
    convoId: string;
    description: string;
    /** What the line shows while no subagent matches: the message as plain text. */
    children: React.ReactNode;
}): React.ReactElement {
    const child = useSubtaskTarget(client, convoId, description);
    if (!child) return <>{children}</>;
    const running = child.session_state === "running";
    const title = displayTitle(child);
    return (
        <button
            type="button"
            className="mj_SubtaskCard"
            aria-label={`Open subagent ${title}, ${running ? "running" : "finished"}`}
            // Beside its parent this opens (or switches) the side pane; see client.openSubChat.
            onClick={() => client.openSubChat(child.id)}
        >
            <BranchIcon className="mj_SubtaskCard_icon" aria-hidden />
            <span className="mj_SubtaskCard_text">
                <span className="mj_SubtaskCard_title">{title}</span>
                <span className="mj_SubtaskCard_state">Subagent · {running ? "running" : "finished"}</span>
            </span>
            {running ? (
                <span className="mj_Spinner mj_SubtaskCard_spinner" aria-hidden="true" />
            ) : (
                <CheckCircleIcon className="mj_SubtaskCard_done" aria-hidden />
            )}
            <ChevronRightIcon className="mj_SubtaskCard_chevron" aria-hidden />
        </button>
    );
}
