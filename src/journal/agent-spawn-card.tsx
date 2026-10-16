/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The agent spawn consent card: one agent asking to start another session on a box. Drawn in the
 * timeline where the ask was made and, for the tracker item the journal files for the same ask,
 * inside that item's detail. Its own module so both surfaces render the one card.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { JournalApiError } from "./api";
import {
    coordinatorBadgeText,
    type CoordinatorDecision,
    sessionStopState,
    subscribeSessionStops,
} from "./coordinator-consent";
import { ShieldCheckIcon, ShieldXIcon } from "./icons";
import { asString, type EventPayload, type JournalEvent, spawnOutcomeKind, type SpawnOutcomeKind } from "./types";

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

export const PROMPT_REPLY_CONFIRMATION_TIMEOUT_MS = 10_000;

export function PromptTerminalGlyph(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m5 7 5 5-5 5" />
            <path d="M13 17h6" />
        </svg>
    );
}

// A journaled agent_spawn card is unanswerable if the bridge minted a malformed payload
// (non-string/empty request_id or task) — rendered as a read-only AgentSpawnCard rather than
// with Approve/Deny buttons nothing can resolve.
export function isAnswerableAgentSpawn(payload: EventPayload): boolean {
    return (
        typeof payload.request_id === "string" &&
        payload.request_id.length > 0 &&
        typeof payload.task === "string" &&
        payload.task.length > 0
    );
}

const SPAWN_OUTCOME_CARD_LABELS: Record<Exclude<SpawnOutcomeKind, "failed">, string> = {
    started: "Started",
    declined: "Denied",
    expired: "Expired",
    unknown: "Spawn request resolved",
};

// Plain-text labels for the card's resolved-state row (§ design "Resolved states"). Distinct
// from spawnOutcomeSnippet's emoji-prefixed copy, which is for the standalone timeline row.
function spawnOutcomeCardLabel(payload: EventPayload): string {
    const kind = spawnOutcomeKind(payload);
    if (kind === "failed") {
        const errorCode = asString(payload.error_code);
        return errorCode ? `Failed — ${errorCode}` : "Failed";
    }
    return SPAWN_OUTCOME_CARD_LABELS[kind];
}

export type AgentSpawnDecision = "approve" | "deny";
type AgentSpawnLocalPhase = "idle" | "sending" | "retryable" | "already-answered" | "gone";

const noopAgentSpawnAnswer = (_decision: AgentSpawnDecision, _signal?: AbortSignal): Promise<void> => Promise.resolve();
const noopAgentSpawnOpen = (): void => undefined;

// Joins the .mj_PromptCard family (§ design "Kind dispatch and components"): same chrome and
// row order as PromptCard so answering doesn't reflow.
//
// Local state machine (§ design "Resolution state"): idle -> sending -> {resolved via the
// DURABLE spawn_outcome event | retryable after PROMPT_REPLY_CONFIRMATION_TIMEOUT_MS with no
// durable event, mirroring PromptCard's confirmation-timeout treatment}. A tap's own POST can
// also fail synchronously: 409 (already answered elsewhere/expired) and 404 (row gone) resolve
// the card immediately with local copy; any other failure (network/transport) goes straight to
// the retryable state. The `outcome` prop (derived from journaled events, no local persistence)
// always wins over local phase — a durable resolution can arrive from another device at any time.
// The card's "Runs" line: the agent, model and effort the child will start with (journal
// protocol.md "What will run"). A value taken from the target box's defaults is marked "(box
// default)" — once, after the first value, when all of them came from the box; else on each.
const SPAWN_AGENT_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex" };

function spawnRunsLabel(payload: EventPayload): string {
    const parts = (["agent", "model", "effort"] as const).flatMap((key) => {
        const value = asString(payload[key]).trim();
        if (!value) return [];
        const text = key === "agent" ? (SPAWN_AGENT_LABELS[value] ?? value) : value;
        return [{ text, boxDefault: payload[`${key}_source`] === "box_default" }];
    });
    const allBoxDefault = parts.length > 0 && parts.every((part) => part.boxDefault);
    return parts
        .map((part, index) =>
            (allBoxDefault ? index === 0 : part.boxDefault) ? `${part.text} (box default)` : part.text,
        )
        .join(" · ");
}

export function AgentSpawnCard({
    event,
    outcome,
    coordinatorDecision,
    isReadOnly = false,
    settled = false,
    onAnswer = noopAgentSpawnAnswer,
    onOpen = noopAgentSpawnOpen,
    onStopSession,
}: {
    event: JournalEvent;
    outcome: EventPayload | null;
    /** The Coordinator's answer to this card, when it gave one. */
    coordinatorDecision?: CoordinatorDecision;
    isReadOnly?: boolean;
    /**
     * The ask has stopped waiting for an answer although no `spawn_outcome` is here yet: the
     * consent item the journal filed for it is closed. The journal closes that item the moment the
     * ask is answered, which for an approval is before the session starts (a sleeping box is woken
     * first), so the outcome can be minutes behind. An answer this card sent and saw accepted then
     * says what the user did; anything else reads as answered elsewhere. A durable outcome still
     * wins over both.
     */
    settled?: boolean;
    onAnswer?: (decision: AgentSpawnDecision, signal?: AbortSignal) => Promise<void>;
    onOpen?: (roomId: string) => void;
    /** Stops the session a Coordinator-approved spawn started. Omitted: no Stop session button. */
    onStopSession?: (convoId: string) => void;
}): React.ReactElement {
    const payload = event.payload;
    const task = asString(payload.task);
    const topic = asString(payload.topic);
    const headline = topic || task.split("\n")[0] || "Agent spawn request";
    const fromConvoTitle = asString(payload.from_convo_title);
    const fromName = asString(payload.from_name);
    const targetName = asString(payload.target_name);
    const workdir = asString(payload.workdir);
    const runs = spawnRunsLabel(payload);
    const resolved = outcome !== null;
    const kind = resolved ? spawnOutcomeKind(outcome) : undefined;
    const roomId = resolved ? asString(outcome.room_id) : "";
    // Answered by the Coordinator, the session not started yet: the card is answered, so it must
    // not offer Approve / Deny again. The decision says how, which is more than `settled` knows, so
    // it outranks it. The spawn_outcome, once it lands, still says how it ended.
    const coordinatorAnswered = !resolved && coordinatorDecision !== undefined;
    // Stop session: only for a session the Coordinator let start, once the journal names it.
    const childConvoId = resolved && kind === "started" ? asString(outcome.child_convo_id) : "";
    const stoppableConvoId =
        !isReadOnly && onStopSession && coordinatorDecision?.approved && childConvoId ? childConvoId : undefined;

    const [phase, setPhase] = useState<AgentSpawnLocalPhase>("idle");
    // The decision of the latest attempt the server accepted, if any. Only `settled` reads it.
    const [accepted, setAccepted] = useState<AgentSpawnDecision | null>(null);
    const phaseRef = useRef(phase);
    // Bugbot/CodeRabbit finding on #23: attempt A's POST can still be in flight when the user
    // retries (attempt B) after A's own confirmation timeout. Every phase transition below is
    // gated on "is my attemptId still the current one?" so a late-settling A can never clobber
    // B's `sending` with a stale `retryable`/`already-answered`/`gone` — which would otherwise
    // re-enable Approve/Deny while B is still pending and invite a duplicate POST. mountedRef
    // additionally guards the promise-settlement handlers (not the setTimeout below, whose
    // cleanup already cancels it on unmount) — mirrors the new-session sheet's
    // agentsRequestIdRef/mountedRef pattern above.
    const attemptIdRef = useRef(0);
    const mountedRef = useRef(false);
    // Aborting the previous attempt's POST before the buttons re-enable narrows the
    // Deny-races-Approve window: without it, a stalled Approve can still be in flight when the
    // confirmation timeout re-enables the row, and a user's corrective Deny then loses the
    // server-side first-arrival race to their own abandoned tap. The abort can't recall bytes the
    // server already received — the durable outcome event stays authoritative for that case.
    const abortRef = useRef<AbortController | null>(null);
    const setLocalPhase = (next: AgentSpawnLocalPhase): void => {
        phaseRef.current = next;
        setPhase(next);
    };

    useEffect(() => {
        mountedRef.current = true;
        return (): void => {
            mountedRef.current = false;
            abortRef.current?.abort();
        };
    }, []);

    const handleAnswer = (decision: AgentSpawnDecision): void => {
        if (resolved || settled || coordinatorAnswered || phaseRef.current === "sending") return;
        const attemptId = ++attemptIdRef.current;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setLocalPhase("sending");
        setAccepted(null);
        void onAnswer(decision, controller.signal).then(
            // Ack received; wait for the durable event (or the timeout effect below).
            () => {
                if (mountedRef.current && attemptId === attemptIdRef.current) setAccepted(decision);
            },
            (error: unknown) => {
                // A newer attempt (retry, or another tab) has already moved the phase on —
                // this settlement is stale and must not touch state.
                if (!mountedRef.current || attemptId !== attemptIdRef.current) return;
                if (error instanceof JournalApiError && error.status === 409) setLocalPhase("already-answered");
                else if (error instanceof JournalApiError && error.status === 404) setLocalPhase("gone");
                else setLocalPhase("retryable"); // transport/other error -> back to answerable
            },
        );
    };

    useEffect(() => {
        if (phase !== "sending" || resolved || settled || coordinatorAnswered) return;
        const attemptId = attemptIdRef.current;
        const timer = setTimeout(() => {
            if (attemptId !== attemptIdRef.current) return; // superseded by a newer attempt
            if (phaseRef.current === "sending") {
                abortRef.current?.abort(); // kill the stalled POST before re-enabling the buttons
                setLocalPhase("retryable");
            }
        }, PROMPT_REPLY_CONFIRMATION_TIMEOUT_MS);
        return (): void => clearTimeout(timer);
    }, [phase, resolved, settled, coordinatorAnswered]);

    // Still waiting on this card: neither a durable outcome, the item flow, nor the Coordinator
    // has answered it.
    const open = !resolved && !settled && !coordinatorAnswered;
    const pending = open && phase === "sending";
    const retryable = open && phase === "retryable";
    const gone = !resolved && !coordinatorAnswered && phase === "gone";
    // Settled with no outcome: this card's own accepted answer stands; otherwise the ask was
    // answered elsewhere (or expired), the same fact a 409 reports. An in-flight send never
    // survives a settled ask, so it cannot spin on after the item closed.
    // A Coordinator decision outranks both: it names who answered and how.
    const answeredHere = !resolved && !coordinatorAnswered && settled && accepted !== null && !gone;
    const alreadyAnswered =
        !resolved && !coordinatorAnswered && !gone && !answeredHere && (phase === "already-answered" || settled);
    // Hides the action row for the same reasons a durable resolution does — nothing more to
    // tap — even though these are local-only, never journaled.
    const pseudoResolved = resolved || coordinatorAnswered || alreadyAnswered || gone || answeredHere;

    return (
        <div className="mj_PromptCard mj_PromptCard_spawn">
            <div className="mj_PromptHeader">
                <span className="mj_PromptLabel">Agent spawn request</span>
                <time className="mj_PromptTime" dateTime={new Date(event.ts).toISOString()}>
                    {formatTime(event.ts)}
                </time>
            </div>
            <div className="mj_PromptBody">
                <span className="mj_PromptGlyph" aria-hidden="true">
                    <PromptTerminalGlyph />
                </span>
                <span className="mj_SpawnHeadline">{headline}</span>
            </div>
            <div className="mj_SpawnDetails">
                <div className="mj_SpawnDetail mj_SpawnDetail_from">
                    <span className="mj_SpawnDetail_label">From</span>
                    <span className="mj_SpawnDetail_value">
                        {fromConvoTitle}
                        {fromConvoTitle && fromName ? " · " : ""}
                        {fromName}
                    </span>
                </div>
                <div className="mj_SpawnDetail mj_SpawnDetail_target">
                    <span className="mj_SpawnDetail_label">Target</span>
                    <span className="mj_SpawnDetail_value">{targetName}</span>
                </div>
                <div className="mj_SpawnDetail mj_SpawnDetail_folder">
                    <span className="mj_SpawnDetail_label">Folder</span>
                    <span className="mj_SpawnDetail_value">{workdir}</span>
                </div>
                {runs && (
                    <div className="mj_SpawnDetail mj_SpawnDetail_runs">
                        <span className="mj_SpawnDetail_label">Runs</span>
                        <span className="mj_SpawnDetail_value">{runs}</span>
                    </div>
                )}
            </div>
            <pre className="mj_SpawnTask">{task}</pre>
            {coordinatorDecision && (
                <CoordinatorConsentBadge
                    decision={coordinatorDecision}
                    stoppableConvoId={stoppableConvoId}
                    onStopSession={onStopSession}
                />
            )}
            {/* A read-only card (sub-chat transcript viewer) never shows live Approve/Deny — it
                mirrors PromptCard's own isReadOnly gate (§ Task-1-review scope A). */}
            {!isReadOnly && !pseudoResolved && (
                <div className="mj_PromptOptions">
                    <button type="button" disabled={pending} onClick={() => handleAnswer("deny")}>
                        Deny
                    </button>
                    <button
                        type="button"
                        className="mj_PromptOption_affirmative"
                        disabled={pending}
                        onClick={() => handleAnswer("approve")}
                    >
                        Approve
                    </button>
                </div>
            )}
            {pending && (
                <div className="mj_PromptResolved mj_PromptResolved_pending">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Muted">Sending…</span>
                </div>
            )}
            {retryable && (
                <div className="mj_PromptResolved mj_PromptResolved_retryable">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Muted">Reply not confirmed — tap to retry</span>
                </div>
            )}
            {alreadyAnswered && (
                <div className="mj_PromptResolved mj_PromptResolved_expired">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">Already answered or expired</span>
                </div>
            )}
            {gone && (
                <div className="mj_PromptResolved mj_PromptResolved_gone">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">That request is no longer on the server.</span>
                </div>
            )}
            {coordinatorAnswered && (
                <div
                    className={`mj_PromptResolved ${coordinatorDecision.approved ? "mj_PromptResolved_approved" : "mj_PromptResolved_declined"}`}
                >
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">
                        {coordinatorDecision.approved
                            ? "Approved — starting the session"
                            : SPAWN_OUTCOME_CARD_LABELS.declined}
                    </span>
                </div>
            )}
            {answeredHere && (
                <div
                    className={`mj_PromptResolved ${
                        accepted === "approve" ? "mj_PromptResolved_approved" : "mj_PromptResolved_declined"
                    }`}
                >
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">
                        {accepted === "approve"
                            ? "Approved — starting the session"
                            : SPAWN_OUTCOME_CARD_LABELS.declined}
                    </span>
                </div>
            )}
            {resolved && (
                <div className={`mj_PromptResolved mj_PromptResolved_${kind}`}>
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered">{spawnOutcomeCardLabel(outcome)}</span>
                    {kind === "started" && roomId && (
                        <button type="button" className="mj_SpawnOpenButton" onClick={() => onOpen(roomId)}>
                            Open
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

// "Approved by the Coordinator — <reason>" on a spawn card the Coordinator answered, with Stop
// session once the session it let start is running: the one tap that overrules the Coordinator.
function CoordinatorConsentBadge({
    decision,
    stoppableConvoId,
    onStopSession,
}: {
    decision: CoordinatorDecision;
    stoppableConvoId?: string;
    onStopSession?: (convoId: string) => void;
}): React.ReactElement {
    const stop = useSyncExternalStore(subscribeSessionStops, () =>
        stoppableConvoId ? sessionStopState(stoppableConvoId) : undefined,
    );
    const text = coordinatorBadgeText(decision);
    return (
        <div className="mj_CoordinatorBadge" data-decision={decision.approved ? "approve" : "decline"}>
            <span className="mj_CoordinatorBadge_line" title={text}>
                {decision.approved ? (
                    <ShieldCheckIcon className="mj_CoordinatorBadge_glyph" aria-hidden="true" />
                ) : (
                    <ShieldXIcon className="mj_CoordinatorBadge_glyph" aria-hidden="true" />
                )}
                <span className="mj_CoordinatorBadge_text">{text}</span>
            </span>
            {stoppableConvoId && onStopSession && stop && (
                <div className="mj_CoordinatorBadge_stop">
                    {stop.kind === "idle" || stop.kind === "failed" ? (
                        <>
                            <button
                                type="button"
                                className="mj_CoordinatorBadge_stopButton"
                                data-action="stop-session"
                                onClick={() => onStopSession(stoppableConvoId)}
                            >
                                Stop session
                            </button>
                            {stop.kind === "failed" && (
                                <span className="mj_CoordinatorBadge_error" role="alert">
                                    {stop.message}
                                </span>
                            )}
                        </>
                    ) : stop.kind === "sending" ? (
                        <span className="mj_Muted">Stopping…</span>
                    ) : (
                        <span className="mj_CoordinatorBadge_sent">Stop sent to the session</span>
                    )}
                </div>
            )}
        </div>
    );
}
