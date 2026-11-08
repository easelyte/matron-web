/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * An agent's ask for a contact invite link, answered on its chat card (people-card.tsx): Decline /
 * Approve, then the link the journal minted, shown this once. It loads in its own chunk with
 * People (deferred-ui.tsx).
 */

import React, { useEffect, useState } from "react";

import { JournalApiError } from "./api";
import {
    ASK_LINK_NOTE,
    refusalCode,
    refusalText,
    shareableInviteLink,
    type InviteAskAnswer,
    type InviteAskDecision,
} from "./contacts";
import { InviteLinkView } from "./PeopleSettings";
import type { TrackerItem } from "./types";

type InviteAskPhase =
    | { kind: "checking" }
    | { kind: "open"; error?: string }
    | { kind: "sending"; decision: InviteAskDecision }
    | { kind: "approved"; link: string }
    | { kind: "declined" }
    | { kind: "closed"; message: string };

/** The invite ask's own answer: Decline / Approve, then the minted link, shown this once. */
export function InviteAskSection({
    askId,
    answerInviteAsk,
    onSettled,
    loadMirror,
}: {
    askId: string;
    answerInviteAsk: (askId: string, decision: InviteAskDecision) => Promise<InviteAskAnswer>;
    /** The ask's mirror item, to tell an ask answered elsewhere (or expired) from an open one. */
    loadMirror?: () => Promise<TrackerItem | null>;
    /** The ask is answered (here or elsewhere): its mirror item has nothing left to do. */
    onSettled: () => void;
}): React.ReactElement {
    const [phase, setPhase] = useState<InviteAskPhase>(() => (loadMirror ? { kind: "checking" } : { kind: "open" }));
    useEffect(() => {
        if (!loadMirror) return;
        let live = true;
        const open = { kind: "open" } as const;
        loadMirror().then(
            (item) => {
                if (!live) return;
                if (!item || item.state === "open") setPhase((now) => (now.kind === "checking" ? open : now));
                else
                    setPhase({
                        kind: "closed",
                        message:
                            item.resolution === "cancelled"
                                ? "Expired — nobody answered within 24 hours"
                                : "Already answered.",
                    });
            },
            () => {
                if (live) setPhase((now) => (now.kind === "checking" ? open : now));
            },
        );
        return () => {
            live = false;
        };
        // loadMirror is a fresh closure each render; the lookup depends only on the ask.
    }, [askId]);
    const settled = phase.kind === "approved" || phase.kind === "declined" || phase.kind === "closed";
    useEffect(() => {
        if (settled) onSettled();
        // onSettled is a fresh closure each render; only the answer matters.
    }, [settled]);
    const send = async (decision: InviteAskDecision): Promise<void> => {
        if (phase.kind !== "open") return;
        setPhase({ kind: "sending", decision });
        try {
            const answer = await answerInviteAsk(askId, decision);
            const link = shareableInviteLink(answer);
            if (decision === "approve" && link) setPhase({ kind: "approved", link });
            else if (decision === "approve") setPhase({ kind: "closed", message: "Approved" });
            else setPhase({ kind: "declined" });
        } catch (error) {
            // An answer on the item, another device or an expiry already settled it; anything
            // else leaves the buttons up to try again.
            // too_many_invites or federation_off leave the ask waiting: say why and keep the buttons.
            const code = refusalCode(error);
            const settled =
                error instanceof JournalApiError &&
                (error.status === 404 || code === "not_pending" || code === "expired");
            setPhase(
                settled ? { kind: "closed", message: refusalText(error) } : { kind: "open", error: refusalText(error) },
            );
        }
    };
    if (phase.kind === "approved") return <InviteLinkView link={phase.link} note={ASK_LINK_NOTE} />;
    if (phase.kind === "declined" || phase.kind === "closed") {
        return (
            <div
                className={`mj_PromptResolved ${phase.kind === "declined" ? "mj_PromptResolved_declined" : "mj_PromptResolved_expired"}`}
                role="status"
            >
                <span className="mj_PromptGlyph" aria-hidden="true" />
                <span className="mj_Answered">{phase.kind === "declined" ? "Declined" : phase.message}</span>
            </div>
        );
    }
    if (phase.kind === "checking") return <></>;
    const sending = phase.kind === "sending";
    return (
        <>
            {phase.kind === "open" && phase.error ? (
                <div className="mj_PromptResolved mj_PromptResolved_expired" role="alert">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">{phase.error}</span>
                </div>
            ) : null}
            <div className="mj_PromptOptions mj_HandoverOptions">
                <button type="button" disabled={sending} onClick={() => void send("decline")}>
                    Decline
                </button>
                <button
                    type="button"
                    className="mj_PromptOption_affirmative"
                    data-action="approve-invite-ask"
                    disabled={sending}
                    onClick={() => void send("approve")}
                >
                    Approve
                </button>
            </div>
        </>
    );
}
