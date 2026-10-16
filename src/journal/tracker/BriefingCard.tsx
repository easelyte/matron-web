/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Coordinator's latest briefing (journal spec 2026-10-04 latest briefing): a card heading
 * the Projects dashboard — "Latest briefing · 5m ago", a two-line plain-text preview and a
 * ↻ button that asks the Coordinator for a fresh one — and the full briefing, opened from the card,
 * in the tracker pane's detail shell. Hidden when the journal predates briefings or the user has
 * no Coordinator. All fetching lives on the client (loadBriefing / requestBriefingRefresh).
 */

import React, { useEffect, useMemo, useState } from "react";

import type { MatronJournalClient } from "../client";
import { RefreshIcon } from "../icons";
import { MarkdownBody, markdownToPlainText } from "../markdown";
import type { Briefing, BriefingState, TrackerLinkHandler } from "../types";
import { formatRelativeTime } from "./format";

const MINUTE = 60_000;

/** Whole minutes until `at`, at least 1 (for "Try again in N min"). */
function minutesUntil(at: number, now: number): number {
    return Math.max(1, Math.ceil((at - now) / MINUTE));
}

/**
 * The card preview: the briefing as plain text (markdownToPlainText, the Copy action's reducer:
 * markers dropped, a link's text kept), first lines only, blank lines skipped.
 */
export function briefingPreviewLines(markdown: string, count = 2): string[] {
    return markdownToPlainText(markdown)
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, count);
}

/**
 * Re-render on the minute (the relative time) and just after the next moment the card's state
 * turns on (a cooldown ending, a pending refresh expiring), so the button re-enables on time.
 */
function useNow(boundaries: Array<number | null | undefined>): number {
    const [now, setNow] = useState(() => Date.now());
    const key = boundaries.join(",");
    useEffect(() => {
        const current = Date.now();
        const next = boundaries
            .filter((at): at is number => typeof at === "number" && at > current)
            .map((at) => at - current + 50);
        const timer = window.setTimeout(() => setNow(Date.now()), Math.min(MINUTE, ...next));
        return () => window.clearTimeout(timer);
        // `key` stands in for the boundaries array, which is new on every render.
    }, [now, key]);
    return now;
}

export function LatestBriefingCard({
    client,
    briefing,
}: {
    client: MatronJournalClient;
    briefing: BriefingState | undefined;
}): React.ReactElement | null {
    const latest = briefing?.latest;
    const refresh = latest?.refresh ?? null;
    const now = useNow([latest?.next_refresh_at, refresh?.expires_at, briefing?.retryAt]);
    const body = latest?.briefing?.body ?? "";
    const preview = useMemo(() => briefingPreviewLines(body), [body]);

    // Nothing until the first load lands (no flash), and never on a journal without briefings or
    // for a user without a Coordinator. A first load that failed says so and offers a retry, so
    // the card never just vanishes.
    if (!briefing || briefing.unsupported) return null;
    if (!latest) {
        // The error stays up while a retry is in flight (its button disabled), so the card never
        // blinks out between the tap and the answer.
        if (!briefing.error) return null;
        return (
            <section className="mj_BriefingCard mj_BriefingCard_empty" aria-label="Latest briefing">
                <div className="mj_BriefingCard_body">
                    <span className="mj_BriefingCard_title">Latest briefing</span>
                    <p className="mj_BriefingCard_status mj_BriefingCard_status_error" role="alert">
                        Couldn't load the latest briefing.
                    </p>
                </div>
                <button
                    type="button"
                    className="mj_TrackerTextButton mj_BriefingCard_ask"
                    disabled={briefing.loading}
                    onClick={() => void client.loadBriefing()}
                >
                    {briefing.loading ? "Trying…" : "Try again"}
                </button>
            </section>
        );
    }
    if (!latest.has_coordinator) return null;

    const current = latest.briefing;
    const pending = refresh?.state === "pending" && (refresh.expires_at === undefined || refresh.expires_at > now);
    const unanswered = refresh !== null && !pending;
    const coolingUntil = latest.next_refresh_at !== null && latest.next_refresh_at > now ? latest.next_refresh_at : 0;
    const rateLimitedUntil = briefing.retryAt !== undefined && briefing.retryAt > now ? briefing.retryAt : 0;
    const blockedUntil = Math.max(coolingUntil, rateLimitedUntil);
    const disabled = Boolean(briefing.requesting) || pending || blockedUntil > 0;
    const buttonTitle = pending
        ? "The Coordinator is writing a briefing"
        : blockedUntil > 0
          ? `You can ask again in ${minutesUntil(blockedUntil, now)} min`
          : "Ask the Coordinator for a new briefing";

    const ask = (): void => {
        void client.requestBriefingRefresh();
    };

    let status: React.ReactElement | null = null;
    if (pending || briefing.requesting) {
        status = (
            <p className="mj_BriefingCard_status" role="status">
                <span className="mj_TrackerPane_spinner mj_BriefingCard_spinner" aria-hidden="true" />
                Refreshing…
            </p>
        );
    } else if (rateLimitedUntil > 0) {
        status = (
            <p className="mj_BriefingCard_status" role="status">
                Try again in {minutesUntil(rateLimitedUntil, now)} min
            </p>
        );
    } else if (briefing.refreshError) {
        status = (
            <p className="mj_BriefingCard_status mj_BriefingCard_status_error" role="alert">
                {briefing.refreshError}
            </p>
        );
    } else if (unanswered) {
        status = (
            <p className="mj_BriefingCard_status mj_BriefingCard_status_error" role="alert">
                The Coordinator hasn't answered. Try again.
            </p>
        );
    }

    if (!current) {
        return (
            <section className="mj_BriefingCard mj_BriefingCard_empty" aria-label="Latest briefing">
                <div className="mj_BriefingCard_body">
                    <span className="mj_BriefingCard_title">Latest briefing</span>
                    <span className="mj_BriefingCard_preview">No briefing yet</span>
                    {status}
                </div>
                <button
                    type="button"
                    className="mj_TrackerTextButton mj_BriefingCard_ask"
                    disabled={disabled}
                    title={buttonTitle}
                    onClick={ask}
                >
                    Ask for one
                </button>
            </section>
        );
    }

    const age = formatRelativeTime(current.created_at, now);
    return (
        <section className="mj_BriefingCard" aria-label="Latest briefing">
            <button
                type="button"
                className="mj_BriefingCard_body mj_BriefingCard_open"
                aria-label={`Latest briefing${age ? `, ${age}` : ""}. Open it in full`}
                onClick={() => client.openBriefing()}
            >
                <span className="mj_BriefingCard_title">
                    Latest briefing
                    {age ? <span className="mj_BriefingCard_age"> · {age}</span> : null}
                </span>
                {preview.map((line, index) => (
                    <span key={index} className="mj_BriefingCard_preview">
                        {line}
                    </span>
                ))}
            </button>
            <button
                type="button"
                className="mj_IconButton mj_BriefingCard_refresh"
                aria-label="Ask the Coordinator for a new briefing"
                title={buttonTitle}
                disabled={disabled}
                onClick={ask}
            >
                <RefreshIcon />
            </button>
            {status ? <div className="mj_BriefingCard_footer">{status}</div> : null}
        </section>
    );
}

/** The full briefing: markdown with working matron:// links, its timestamp, and "Open in chat". */
export function BriefingDetail({
    briefing,
    client,
    onBack,
}: {
    briefing: Briefing;
    client: MatronJournalClient;
    onBack: () => void;
}): React.ReactElement {
    const onTrackerLink: TrackerLinkHandler = (kind, target) => client.openTrackerLink(kind, target);
    const created = new Date(briefing.created_at);
    return (
        <div className="mj_TrackerDetail">
            <div className="mj_TrackerDetail_head">
                {/* The project page's back idiom: a text button naming where it goes. */}
                <button type="button" className="mj_TrackerTextButton" onClick={onBack}>
                    ‹ Projects
                </button>
            </div>
            <div className="mj_TrackerDetail_scroll">
                <header className="mj_TrackerMissionHead mj_BriefingHead">
                    <div className="mj_TrackerMissionHead_title">
                        <h1 className="mj_TrackerMissionHead_name">Briefing</h1>
                    </div>
                    <div className="mj_BriefingHead_meta">
                        <time className="mj_BriefingHead_time" dateTime={created.toISOString()}>
                            {created.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
                        </time>
                        <button
                            type="button"
                            className="mj_TrackerButton"
                            onClick={() => client.openBriefingInChat(briefing.convo_id, briefing.seq)}
                        >
                            Open in chat
                        </button>
                    </div>
                </header>
                <div className="mj_TrackerProse">
                    {/* The memo comparator ignores onTrackerLink; the label is keyed to the briefing,
                        so a new briefing (or this handler's first render) always renders afresh. */}
                    <MarkdownBody
                        text={briefing.body}
                        label={`briefing-${briefing.id}`}
                        onTrackerLink={onTrackerLink}
                    />
                </div>
            </div>
        </div>
    );
}
