/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The strip pinned under the chat header once a session's context passes
 * COMPACT_NUDGE_TOKENS, offering to compact it, as the Mac and iOS clients do. Clicking sends a
 * bare `/compact` as an ordinary message, so the command and the agent's reply land in the
 * transcript. It is not dismissable: it stays while the conversation is large and goes away
 * by itself once a compact brings the gauge back under the threshold.
 */

import React, { useRef, useState } from "react";

import { CompactIcon } from "./icons";
import { compactNudgeTitle, shouldNudgeCompact, spokenTokens } from "./status";
import { type SessionStatus } from "./types";

export function CompactNudge({
    context,
    send,
}: {
    context: SessionStatus["context"];
    send: (command: string) => Promise<unknown>;
}): React.ReactElement | null {
    // In-flight latch: repeated clicks while a /compact is still sending must not each queue
    // another one.
    const sendingRef = useRef(false);
    const [sending, setSending] = useState(false);
    if (!context || !shouldNudgeCompact(context)) return null;

    const compact = (event: React.MouseEvent): void => {
        // The latch only spans the outbox write, which finishes long before a double-click's
        // second click lands, so that click is dropped here: a double-click sends one /compact.
        if (event.detail > 1 || sendingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        void send("/compact")
            .catch((error) => console.warn("Compact command failed to send:", error))
            .finally(() => {
                sendingRef.current = false;
                setSending(false);
            });
    };

    return (
        <button
            type="button"
            className="mj_CompactNudge"
            aria-label={`Large conversation, ${spokenTokens(context.tokens)} tokens, compact it`}
            aria-busy={sending || undefined}
            title="Compact the conversation — sends /compact"
            onClick={compact}
        >
            <span className="mj_CompactNudge_title">{compactNudgeTitle(context.tokens)}</span>
            <span className="mj_CompactNudge_action">
                <CompactIcon aria-hidden />
                Compact
            </span>
        </button>
    );
}
