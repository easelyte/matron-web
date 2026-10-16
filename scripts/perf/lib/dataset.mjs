/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Deterministic synthetic content shaped like a heavy real account: agent prose with markdown
 * and code fences, tool cards, diffs and user messages, in the proportions a long coding
 * session produces. Everything is generated from a seed, so two runs see the same data.
 */

export function rng(seed) {
    let s = seed >>> 0 || 1;
    const next = () => {
        // mulberry32
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    const pick = (list) => list[Math.floor(next() * list.length)];
    const chance = (p) => next() < p;
    return { next, int, pick, chance };
}

const WORDS = (
    "the a to of and in is it that for on with as this be are we was not by at from or have can will an " +
    "build test branch commit deploy journal bridge session conversation tracker item mission milestone " +
    "render cache index query timeout retry token stream socket replay cursor snapshot event payload " +
    "component state layout sidebar header composer scroll viewport bundle module import export config " +
    "check pass fail error warning merge review change fix update remove add keep move rename handle " +
    "server client device agent user request response status queue worker job schedule budget profile"
).split(" ");

const FILES = [
    "src/journal/client.ts",
    "src/journal/components.tsx",
    "src/journal/tracker/ItemDetail.tsx",
    "src/server.js",
    "src/ws.js",
    "lib/agent-chat.js",
    "app/models/order.rb",
    "app/controllers/books_controller.rb",
    "test/unit/client-test.ts",
    "README.md",
];

const COMMANDS = [
    "pnpm test",
    "pnpm lint",
    "git status --short",
    "git log --oneline -20",
    "rg -n useEffect src/journal",
    "node --test test/journal.test.js",
    "ls -la src/journal",
    "gh pr checks 42",
    "docker compose ps",
    "cat package.json",
];

const LANGS = ["ts", "js", "bash", "json", "ruby", "diff"];

export function words(r, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.pick(WORDS));
    const s = out.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function sentence(r) {
    return `${words(r, r.int(6, 18))}.`;
}

function paragraph(r) {
    const n = r.int(2, 6);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(sentence(r));
    return parts.join(" ");
}

function codeBlock(r) {
    const lang = r.pick(LANGS);
    const lines = [];
    for (let i = 0, n = r.int(4, 30); i < n; i++) {
        lines.push(`${"    ".repeat(r.int(0, 3))}const ${r.pick(WORDS)}_${i} = ${r.pick(WORDS)}(${r.int(0, 999)});`);
    }
    return `\`\`\`${lang}\n${lines.join("\n")}\n\`\`\``;
}

function table(r) {
    const cols = r.int(2, 5);
    const head = Array.from({ length: cols }, () => r.pick(WORDS));
    const rows = Array.from({ length: r.int(2, 10) }, () =>
        Array.from({ length: cols }, () => (r.chance(0.5) ? String(r.int(0, 9999)) : r.pick(WORDS))),
    );
    return [head, head.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function list(r) {
    return Array.from({ length: r.int(2, 8) }, () => `- ${words(r, r.int(4, 14))}`).join("\n");
}

/** Agent prose: a few paragraphs, sometimes a list, a code fence or a table, inline code and links. */
export function agentText(r) {
    const blocks = [paragraph(r)];
    for (let i = 0, n = r.int(0, 4); i < n; i++) {
        const k = r.next();
        if (k < 0.35) blocks.push(paragraph(r));
        else if (k < 0.6) blocks.push(list(r));
        else if (k < 0.85) blocks.push(codeBlock(r));
        else blocks.push(table(r));
    }
    if (r.chance(0.4)) blocks.push(`See \`${r.pick(FILES)}\` and https://example.com/pr/${r.int(1, 999)}.`);
    return blocks.join("\n\n");
}

export function userText(r) {
    return r.chance(0.7) ? sentence(r) : `${paragraph(r)}\n\n${list(r)}`;
}

export function toolOutput(r) {
    const command = r.pick(COMMANDS);
    const lines = Array.from({ length: r.int(1, 40) }, (_, i) => `${i + 1}: ${words(r, r.int(3, 12))}`);
    const exit = r.chance(0.1) ? 1 : 0;
    return {
        tool_name: "Bash",
        command,
        exit_code: exit,
        snippet: lines.join("\n").slice(0, 2000),
        truncated: lines.length > 30,
    };
}

export function diff(r) {
    const file = r.pick(FILES);
    const out = [`--- a/${file}`, `+++ b/${file}`];
    let added = 0;
    let removed = 0;
    for (let h = 0, hunks = r.int(1, 6); h < hunks; h++) {
        const start = r.int(1, 2000);
        const body = [];
        for (let i = 0, n = r.int(3, 40); i < n; i++) {
            const k = r.next();
            const text = `    ${r.pick(WORDS)}(${r.pick(WORDS)}, ${r.int(0, 99)});`;
            if (k < 0.25) {
                body.push(`-${text}`);
                removed++;
            } else if (k < 0.55) {
                body.push(`+${text}`);
                added++;
            } else body.push(` ${text}`);
        }
        out.push(`@@ -${start},${body.length} +${start},${body.length} @@`, ...body);
    }
    return { diff: out.join("\n"), file_path: file, tool: "Edit", added, removed };
}

/**
 * One conversation's events in order: `{ by: "user" | "agent", type, payload }`. The mix follows
 * a coding session: roughly a third prose, a third tool cards, a fifth diffs, the rest the user.
 */
export function conversationEvents(r, count) {
    const events = [];
    while (events.length < count) {
        events.push({ by: "user", type: "text", payload: { body: userText(r) } });
        for (let i = 0, n = r.int(2, 12); i < n && events.length < count; i++) {
            const k = r.next();
            if (k < 0.35) events.push({ by: "agent", type: "text", payload: { body: agentText(r) } });
            else if (k < 0.75) events.push({ by: "agent", type: "tool_output", payload: toolOutput(r) });
            else events.push({ by: "agent", type: "diff", payload: diff(r) });
        }
    }
    return events.slice(0, count);
}

/** Bump when the generated data changes shape, so a kept --data directory is re-seeded. */
export const DATASET_VERSION = 3;

/** Dataset sizes. "full" is shaped on a heavy account; "ci" is small enough for a CI runner. */
export const SCALES = {
    full: {
        boxes: 6,
        conversations: 1200,
        eventsPerConversation: [10, 60],
        longConversations: [8000, 3000, 3000, 1500],
        subchats: 150,
        projects: 120,
        missions: 600,
        milestonesPerMission: [0, 10],
        items: 4000,
        commentsPerItem: [0, 6],
        openItemShare: 0.3,
    },
    ci: {
        boxes: 3,
        conversations: 600,
        eventsPerConversation: [5, 30],
        longConversations: [2000],
        subchats: 60,
        projects: 20,
        missions: 80,
        milestonesPerMission: [0, 6],
        items: 600,
        commentsPerItem: [0, 3],
        openItemShare: 0.3,
    },
};
