/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * One-line timeline notices for the Coordinator's journal events: `coordinator` (this chat gained
 * or lost the role), `routine` (a routine was saved, deleted or fired) and `consent_decision` (the
 * Coordinator answered a consent card). They are quiet rows in the MissionNotice family, but not
 * buttons: there is nowhere to navigate to. A payload that will not parse renders nothing, and the
 * timeline drops it in lock-step (isUnrenderableNoticeEvent), so it can never leave a ghost row or
 * fall through to the raw-JSON fallback.
 */

import React from "react";

import { oneLineConsentReason } from "./coordinator-consent";
import { AlarmIcon, PersonCheckIcon, ShieldCheckIcon, ShieldXIcon, WarningTriangleIcon } from "./icons";
import { asString, type EventPayload, type JournalEvent } from "./types";

export type NoticeGlyph = "coordinator" | "routine" | "warning" | "approved" | "declined";

export interface NoticeLine {
    text: string;
    /** Glyph shown before the text. */
    glyph: NoticeGlyph;
}

const GLYPHS: Readonly<Record<NoticeGlyph, (props: React.SVGProps<SVGSVGElement>) => React.ReactElement>> = {
    coordinator: PersonCheckIcon,
    routine: AlarmIcon,
    warning: WarningTriangleIcon,
    approved: ShieldCheckIcon,
    declined: ShieldXIcon,
};

/** `coordinator` marker: `{ role: "assigned" | "released" }`. */
export function coordinatorNotice(payload: EventPayload): NoticeLine | null {
    const role = asString(payload.role);
    if (role === "assigned") return { text: "This chat is now the Coordinator", glyph: "coordinator" };
    if (role === "released") return { text: "This chat is no longer the Coordinator", glyph: "coordinator" };
    return null;
}

const ROUTINE_ACTIONS: ReadonlySet<string> = new Set(["saved", "deleted", "fired"]);

/**
 * `routine` marker: `{ routine_id, name, action: "saved" | "deleted" | "fired", created?, by?,
 * outcome? }`. A fire that did not reach the Coordinator (missed, no Coordinator, failed) leaves no
 * other trace in the transcript, so its row says so and swaps the alarm for a warning.
 */
export function routineNotice(payload: EventPayload): NoticeLine | null {
    const routineId = asString(payload.routine_id);
    const name = asString(payload.name).trim();
    const action = asString(payload.action);
    if (!routineId || !name || !ROUTINE_ACTIONS.has(action)) return null;

    if (action === "saved" || action === "deleted") {
        const who = asString(payload.by) === "user" ? "You" : "Coordinator";
        const verb = action === "deleted" ? "deleted" : payload.created === true ? "created" : "updated";
        return { text: `${who} ${verb} a routine · ${name}`, glyph: "routine" };
    }

    const rawOutcome = typeof payload.outcome === "string" ? payload.outcome : null;
    const undelivered =
        rawOutcome !== null &&
        (rawOutcome === "missed" || rawOutcome === "no_coordinator" || rawOutcome.startsWith("failed"));
    const glyph: NoticeGlyph = undelivered ? "warning" : "routine";
    const outcome = (rawOutcome ?? "").trim();
    if (outcome === "missed") return { text: `Routine missed · ${name}`, glyph };
    if (outcome === "no_coordinator") return { text: `Routine not delivered · ${name} — no Coordinator box`, glyph };
    if (outcome.startsWith("failed")) {
        const code = outcome.slice("failed".length).trim();
        return { text: `Routine not delivered · ${name}${code ? ` — ${code}` : ""}`, glyph };
    }
    if (outcome === "applied deferred") {
        return { text: `Routine fired · ${name} — queued for the next idle point`, glyph };
    }
    return { text: `Routine fired · ${name}`, glyph };
}

/**
 * `consent_decision` event: `{ kind: "chat" | "spawn", decision: "approve" | "decline", reason? }`.
 * "Coordinator approved the spawn request — <reason>" / "Coordinator declined the chat request".
 */
export function consentDecisionNotice(payload: EventPayload): NoticeLine | null {
    const kind = asString(payload.kind);
    const decision = asString(payload.decision);
    if ((kind !== "chat" && kind !== "spawn") || (decision !== "approve" && decision !== "decline")) return null;
    const verb = decision === "approve" ? "approved" : "declined";
    const what = kind === "spawn" ? "spawn request" : "chat request";
    // Every run of line breaks becomes one space, blank lines included (Mac: split on isNewline,
    // empty pieces dropped).
    const reason = oneLineConsentReason(payload.reason);
    const line = `Coordinator ${verb} the ${what}`;
    return { text: reason ? `${line} — ${reason}` : line, glyph: decision === "approve" ? "approved" : "declined" };
}

const NOTICE_PARSERS: ReadonlyMap<string, (payload: EventPayload) => NoticeLine | null> = new Map([
    ["coordinator", coordinatorNotice],
    ["routine", routineNotice],
    ["consent_decision", consentDecisionNotice],
]);

/** The notice line for a Coordinator event, or null for any other type or an unparseable payload. */
export function coordinatorEventNotice(event: JournalEvent): NoticeLine | null {
    const parse = NOTICE_PARSERS.get(event.type);
    return parse ? parse(event.payload) : null;
}

/** True for a Coordinator event type whose payload renders no notice, so it must not occupy a row. */
export function isUnrenderableNoticeEvent(event: JournalEvent): boolean {
    return NOTICE_PARSERS.has(event.type) && coordinatorEventNotice(event) === null;
}

export function CoordinatorEventNotice({ event }: { event: JournalEvent }): React.ReactElement | null {
    const notice = coordinatorEventNotice(event);
    if (!notice) return null;
    const Glyph = GLYPHS[notice.glyph];
    return (
        <div
            className={`mj_TrackerMissionNotice mj_CoordinatorNotice${event.type === "consent_decision" ? " mj_CoordinatorNotice_twoLines" : ""}`}
            data-notice={event.type}
            title={notice.text}
        >
            <Glyph className="mj_CoordinatorNotice_glyph" />
            <span className="mj_CoordinatorNotice_text">{notice.text}</span>
        </div>
    );
}
