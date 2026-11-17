/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { TrackerComment } from "../types";

/**
 * `comments` without the replies a later comment `replaces`: the user cancelled a reply before it
 * reached the agent and sent an edited one in its place, so the thread shows the edit alone. Only
 * the user's own plain replies are ever left out, whatever a `replaces` names.
 */
export function hidingReplacedComments(comments: readonly TrackerComment[]): TrackerComment[] {
    const replaced = new Set<string>();
    for (const comment of comments) {
        if (comment.replaces) replaced.add(comment.replaces);
    }
    if (replaced.size === 0) return [...comments];
    return comments.filter((comment) => !(isOwnPlainReply(comment) && replaced.has(comment.id)));
}

/** The user's own reply: not a status line, and not written by another person (a contributor, or a
 *  comment copied in by a hand-over), even though those also carry `author: "user"`. */
function isOwnPlainReply(comment: TrackerComment): boolean {
    return comment.author === "user" && comment.kind === "comment" && !comment.contributor && !comment.attribution;
}
