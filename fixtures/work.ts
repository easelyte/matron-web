/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Work-tab fixture: a canned loop store the visual harness renders through the REAL WorkView (the
 * fake client's `work()` is replaced, so the list, filters and detail all run their production
 * code). The loops cover every row state the tab has to hold: each status, every priority, a
 * claim of each liveness, a long title, a structured markdown description, an empty one, and a
 * payload from an older server without the optional fields. Ages are relative to load time so
 * the screenshots read the same whenever they are taken.
 */

import type { WorkViewEnvelope, WorkViewGroup, WorkViewGroupBy, WorkViewLoop } from "../src/journal/work-view";

const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

export const WORK_FIXTURE_LOOPS: WorkViewLoop[] = [
    {
        id: 108,
        title: "Replace the source-text pin tests with behavioural tests",
        repo: "matron-bridge",
        domain: "process",
        priority: 4,
        status: "active",
        owner: "claude",
        opened: ago(3),
        next_action: "Extract the queued-release transitions into lib/ with behavioural tests, then delete the pins.",
        claim: {
            convo_id: "a1b2c3d4-0000",
            holder_label: "bridge tests wave",
            claimed_at: ago(0),
            liveness: "live",
        },
        description: [
            "Replace the bridge source-text pin tests we keep breaking with behavioural tests, in two clusters, and leave the rest alone.",
            "",
            "**Why.** Pins check how the code is spelled, not what it does. Most breakages in the last month were a rename, not a regression.",
            "",
            "**Scope**",
            "- Cluster A: session-status and busy-queue pins",
            "- Cluster B: queued-release and `session_state` transitions",
            "",
            "**Out of scope**",
            "- Pins that guard a wire format (they are doing their job)",
            "",
            "**Reference**",
            "- [Pin inventory](https://example.com/pins.md)",
            "- `test/session-status.test.js`",
        ].join("\n"),
    },
    {
        id: 102,
        title: "Rework the permission classifier so the bridge is the deciding layer",
        repo: "matron-bridge",
        domain: "infra",
        priority: 2,
        status: "blocked",
        owner: "claude",
        opened: ago(34),
        next_action: "Waiting on the upstream review. Respond to the next round of comments.",
        claim: null,
        description: [
            "Make the bridge the layer that decides, not a second evaluator the CLI has already pre-empted.",
            "",
            "**The gap.** Sessions start with the CLI's own allowlist, so the bridge only ever sees what the CLI let through.",
            "",
            "**Plan**",
            "1. Start sessions with an empty CLI allowlist",
            "2. Route every tool call through the bridge classifier",
            "3. Keep the audit log format unchanged",
        ].join("\n"),
    },
    {
        id: 104,
        title: "Retire the fork-only permission hook after the upstream merge",
        repo: "matron-bridge",
        domain: "infra",
        priority: 4,
        status: "blocked",
        owner: "operator",
        opened: ago(6),
        next_action: "Once the upstream change merges and is synced, delete the fork-only registry and hook path.",
        claim: {
            convo_id: "deadbeef0000",
            holder_label: null,
            claimed_at: ago(9),
            liveness: "stale",
        },
        description:
            "Our fork runs two permission systems at once, and the fork-only one is live, so the running bridge carries a few hundred lines that will fight upstream.",
    },
    {
        id: 105,
        title: "Design a toggleable plain chat view next to the full developer view",
        repo: "matron-web",
        domain: "process",
        priority: 3,
        status: "active",
        owner: "operator",
        opened: ago(12),
        next_action: "Brainstorm with the operator, then the upstream maintainer.",
        claim: null,
        description:
            "Design a plain chat view for matron-web that can be toggled, next to today's full developer view with every tool card.\n\n**The idea**\nOne collapsed card between turns plus a plain-English live status line.",
    },
    {
        id: 106,
        title: "Make creating a new session from the button obvious",
        repo: "matron-web",
        domain: "process",
        priority: 3,
        status: "active",
        owner: "claude",
        opened: ago(4),
        claim: {
            convo_id: "feedface0000",
            holder_label: "new-session sheet",
            claimed_at: ago(1),
            liveness: "unknown",
        },
        description: "",
    },
    {
        id: 103,
        title: "Usage dashboard across accounts and machines",
        repo: "matron-web",
        domain: "infra",
        priority: 3,
        status: "parked",
        owner: "claude",
        opened: ago(62),
        next_action: "Scope a shared dashboard of usage allowances, resets and host vitals.",
        claim: null,
        description:
            "Build a central usage dashboard showing quota resets across accounts and machines. Parked on purpose: buildable, just not now.",
    },
    {
        id: 107,
        title: "Extract the fidelity harness as a standalone open-source repo",
        repo: "unassigned",
        domain: "process",
        priority: 5,
        status: "paused",
        owner: "claude",
        opened: ago(37),
        claim: null,
        description:
            "Consider extracting the contact-sheet fidelity harness as its own repo, but only after it has proven itself internally a few more times.",
    },
    {
        id: 101,
        title: "Move the account name to an organisation",
        repo: "unassigned",
        domain: "infra",
        priority: 3,
        status: "parked",
        owner: "operator",
        opened: ago(61),
        next_action: "Plan and execute the rename and transfer",
        claim: null,
        description:
            "Move the account name from a personal account to an organisation, then rename the personal account.",
    },
];

/** Strip the optional fields, as a journal that predates them would. */
export function legacyLoops(): WorkViewLoop[] {
    return WORK_FIXTURE_LOOPS.map(({ opened: _o, next_action: _n, owner: _w, ...rest }) => rest);
}

function envelopeFor(groupBy: WorkViewGroupBy, loops: WorkViewLoop[]): WorkViewEnvelope {
    const byKey = new Map<string, WorkViewLoop[]>();
    for (const loop of loops) {
        const key = loop[groupBy];
        byKey.set(key, [...(byKey.get(key) ?? []), loop]);
    }
    const groups = [...byKey.keys()].sort().map((key) => ({ key, loops: byKey.get(key)! }) as WorkViewGroup) as [
        WorkViewGroup,
        ...WorkViewGroup[],
    ];
    return { schema_version: 1, status: "ok", group_by: groupBy, groups };
}

export type WorkFixtureMode = "ok" | "legacy" | "empty" | "error" | "loading";

export function workFixture(mode: WorkFixtureMode, groupBy: WorkViewGroupBy): Promise<WorkViewEnvelope> {
    switch (mode) {
        case "loading":
            return new Promise(() => {});
        case "empty":
            return Promise.resolve({ schema_version: 1, status: "empty", group_by: groupBy, groups: [] });
        case "error":
            return Promise.resolve({
                schema_version: 1,
                status: "error",
                group_by: groupBy,
                groups: [],
                error: { code: "store_corrupt", message: "The canonical loop store could not be parsed." },
            });
        case "legacy":
            return Promise.resolve(envelopeFor(groupBy, legacyLoops()));
        case "ok":
            return Promise.resolve(envelopeFor(groupBy, WORK_FIXTURE_LOOPS));
    }
}
