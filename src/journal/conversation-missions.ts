/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// The chat header's mission chip, after the Mac's: which mission the chip names, its "+n", and the
// Current / Also on / Earlier split of its list. Pure, so each rule is a plain test.

import { splitTitle } from "./boxes";
import type { ConversationMissionLink, Mission } from "./types";

/** History: a link the conversation ended, or any link to a closed mission. */
export function isEarlierLink(link: Pick<ConversationMissionLink, "active" | "state">): boolean {
    return !link.active || link.state === "closed";
}

export interface ConversationMissionSections {
    current: ConversationMissionLink | null;
    /** Active links to open missions other than the current one, newest joined first. */
    alsoOn: ConversationMissionLink[];
    /** Ended links and links to closed missions, most recently ended first. */
    earlier: ConversationMissionLink[];
}

export function missionSections(links: readonly ConversationMissionLink[]): ConversationMissionSections {
    const live = links.filter((link) => !isEarlierLink(link));
    const current = live.find((link) => link.current) ?? null;
    const alsoOn = live
        .filter((link) => link.id !== current?.id)
        .sort((a, b) => (b.joined_at ?? 0) - (a.joined_at ?? 0));
    const earlier = links
        .filter(isEarlierLink)
        .sort((a, b) => (b.ended_at ?? b.closed_at ?? 0) - (a.ended_at ?? a.closed_at ?? 0));
    return { current, alsoOn, earlier };
}

/** What the chip names: the current mission, else the newest active one, else the most recent
 *  earlier one. Null when the conversation has never been on a mission (the chip is hidden). */
export function chipHeadline(sections: ConversationMissionSections): ConversationMissionLink | null {
    return sections.current ?? sections.alsoOn[0] ?? sections.earlier[0] ?? null;
}

/** The chip's "+n": every other mission the conversation touched. */
export function chipOthers(sections: ConversationMissionSections): number {
    const total = (sections.current ? 1 : 0) + sections.alsoOn.length + sections.earlier.length;
    return Math.max(0, total - 1);
}

const collapse = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");

/**
 * Whether the conversation's shown title already names the mission: equal to its name or title
 * once the `[xx]` short and any marker are peeled off and whitespace is collapsed, or the
 * journal's cut of the title (ending "…"), which the full label then starts with. A conversation
 * on a mission is titled after it, so the chip then drops the name rather than say it twice.
 */
export function titleNamesMission(
    mission: Pick<Mission, "title" | "name">,
    conversationTitle: string | null | undefined,
): boolean {
    if (!conversationTitle) return false;
    const shown = collapse(splitTitle(conversationTitle).title);
    if (!shown) return false;
    const stem = shown.endsWith("…") ? collapse(shown.slice(0, -1)) : null;
    return [mission.name, mission.title]
        .filter((label): label is string => typeof label === "string")
        .map(collapse)
        .some((label) => label !== "" && (label === shown || (!!stem && label.startsWith(stem))));
}

/** "#12 Ship the docs +2", or "#12 +2" when the conversation title already names the mission. */
export function chipLabel(
    links: readonly ConversationMissionLink[],
    conversationTitle?: string | null,
): { number: string; name: string | null; others: number } | null {
    const sections = missionSections(links);
    const headline = chipHeadline(sections);
    if (!headline) return null;
    return {
        number: `#${headline.num}`,
        name: titleNamesMission(headline, conversationTitle) ? null : headline.title,
        others: chipOthers(sections),
    };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "29 Sep", in the viewer's time zone. */
export function shortDate(ms: number): string {
    const date = new Date(ms);
    return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** A list row's second line: "Current · since 29 Sep", "Also on · joined 29 Sep",
 *  "29 Sep → 30 Sep" for an earlier one. */
export function linkLine(link: ConversationMissionLink): string {
    const joined = link.joined_at ? shortDate(link.joined_at) : null;
    if (isEarlierLink(link)) {
        const endMs = link.ended_at ?? link.closed_at;
        const end = endMs ? shortDate(endMs) : null;
        if (joined && end) return `${joined} → ${end}`;
        if (end) return `until ${end}`;
        if (joined) return `since ${joined}`;
        return "Earlier";
    }
    if (link.current) return joined ? `Current · since ${joined}` : "Current";
    return joined ? `Also on · joined ${joined}` : "Also on";
}
