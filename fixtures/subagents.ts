/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Subagent visual fixture (`?sub=<scenario>` on the fixtures page): a parent Claude session
 * that spawned Claude subagents (the Agent / Task tool) and ran a Codex exec, built from the
 * REAL shapes the bridge publishes today:
 *
 *   - the parent's Task indicator is a `text` event `🔀 Subtask: {description}`;
 *   - each subagent is a child conversation (`parent_convo_id`) whose tool calls arrive as
 *     `text` events (`🔧 \`cmd\``, `📖 path`, `🔍 pattern`) and whose edits are `diff` events;
 *   - a Codex exec child reports commands as `tool_output` events;
 *   - the sidebar snippet is the server's first 120 characters of the last message, which is
 *     how raw commands reach the preview line today (operator screenshot IMG_1516).
 *
 * Scenarios: `thread` (parent selected), `child` (a running Claude subagent selected),
 * `codex` (the finished Codex child selected).
 */

import type { Conversation, JournalEvent } from "../src/journal/types";

export type SubagentScenario = "thread" | "child" | "codex";

const BASE = Date.UTC(2026, 8, 26, 14, 0, 0);
let seq = 5000;

function at(convo: string, sec: number, sender: string, type: string, payload: Record<string, unknown>): JournalEvent {
    seq += 1;
    return { seq, convo_id: convo, ts: BASE + sec * 1000, sender, type, payload };
}
const op = (convo: string, sec: number, body: string): JournalEvent => at(convo, sec, "user:operator", "text", { body });
const say = (convo: string, sec: number, body: string): JournalEvent =>
    at(convo, sec, "agent:claude", "text", { body, from: "assistant" });
const cmd = (convo: string, sec: number, command: string, exit_code: number | null, snippet: string): JournalEvent =>
    at(convo, sec, "agent:claude", "tool_output", { command, exit_code, snippet, message_ref: `toolu_${seq + 1}` });
const edit = (convo: string, sec: number, path: string, added: number, removed: number): JournalEvent =>
    at(convo, sec, "agent:claude", "diff", {
        tool: "Edit",
        file_path: `/root/.openclaw/workspace/${path}`,
        display_path: path,
        added,
        removed,
        diff: "@@ -1,3 +1,3 @@\n-WORKSPACE = '/root/.openclaw/workspace'\n+WORKSPACE = paths.workspace_root()\n",
        from: "assistant",
    });

const PARENT = "p1";
const S_UNITS = "p1:sub:units";
const S_LEAKS = "p1:sub:leaks";
const S_PREMISE = "p1:sub:premise";
const S_CODEX = "p1:codex:review";

function parentEvents(): JournalEvent[] {
    return [
        op(PARENT, 0, "premise-check #791 and have codex review the retention diff"),
        say(PARENT, 2, "I'll hand the premise check to a helper and ask Codex for the review."),
        at(PARENT, 5, "agent:claude", "text", { body: "🔀 Subtask: Premise-check loop #791", from: "assistant" }),
        cmd(PARENT, 300, "codex exec --json 'review the retention diff on feat/785'", 1, "codex exited 1"),
        say(
            PARENT,
            420,
            "The premise holds, so #791 is ready to build. Codex found two type errors in the retention diff; I'll fix them in the next wave.",
        ),
        op(PARENT, 1000, "go: run wave 2 for #785"),
        say(PARENT, 1003, "Starting wave 2 with two helpers."),
        cmd(PARENT, 1006, "git -C /tmp/wt-785 status --short", 0, " M anton/core/paths.py"),
        at(PARENT, 1010, "agent:claude", "text", {
            body: "🔀 Subtask: Wave 2: #785 units + docs + script",
            from: "assistant",
        }),
        at(PARENT, 1012, "agent:claude", "text", {
            body: "🔀 Subtask: Wave 2: #785 test leaks + retention",
            from: "assistant",
        }),
    ];
}

function unitsEvents(): JournalEvent[] {
    return [
        say(S_UNITS, 1011, "I'll start with the paths module."),
        at(S_UNITS, 1014, "agent:claude", "text", {
            body: "🔧 `sed -n 1,60p anton/core/paths.py | grep -n WORKSPACE`",
            from: "assistant",
        }),
        at(S_UNITS, 1016, "agent:claude", "text", {
            body: "📖 /root/.openclaw/workspace/anton/core/paths.py",
            from: "assistant",
        }),
        at(S_UNITS, 1018, "agent:claude", "text", { body: "🔍 WORKSPACE_ROOT", from: "assistant" }),
        edit(S_UNITS, 1030, "anton/core/paths.py", 6, 2),
        edit(S_UNITS, 1034, "docs/filesystem-layout.md", 4, 1),
        at(S_UNITS, 1040, "agent:claude", "text", {
            body: "🔧 `python3 -m pytest tests/test_paths.py -q`",
            from: "assistant",
        }),
        at(S_UNITS, 1052, "agent:claude", "text", {
            body: "🔧 `sed -n 1,60p anton/core/paths.py | grep -n PATHS`",
            from: "assistant",
        }),
    ];
}

function leaksEvents(): JournalEvent[] {
    return [
        say(S_LEAKS, 1013, "Looking for the leaking temp dirs first."),
        at(S_LEAKS, 1015, "agent:claude", "text", { body: "🔍 tmp_path", from: "assistant" }),
        at(S_LEAKS, 1020, "agent:claude", "text", {
            body: "🔧 `cat docs/filesystem-layout.md /root/.claude/CLAUDE.md`",
            from: "assistant",
        }),
    ];
}

function premiseEvents(): JournalEvent[] {
    return [
        say(S_PREMISE, 6, "Checking #791 against the current code."),
        at(S_PREMISE, 8, "agent:claude", "text", { body: "📖 /root/.openclaw/workspace/anton/core/paths.py", from: "assistant" }),
        at(S_PREMISE, 12, "agent:claude", "text", { body: "🔍 hardcoded workspace", from: "assistant" }),
        at(S_PREMISE, 20, "agent:claude", "text", {
            body: "🔧 `rg -n '/root/.openclaw/workspace' anton scripts | wc -l`",
            from: "assistant",
        }),
        at(S_PREMISE, 40, "agent:claude", "text", {
            body: "🔧 `git log --oneline -5 -- anton/core/paths.py`",
            from: "assistant",
        }),
        at(S_PREMISE, 60, "agent:claude", "text", { body: "📖 /root/.openclaw/workspace/docs/filesystem-layout.md", from: "assistant" }),
        say(
            S_PREMISE,
            244,
            "**The premise holds.** `anton/core/paths.py` still hardcodes the workspace root in 3 places, and nothing on main has touched it since the loop was filed.\n\nRecommend implementing: about 40 lines plus a test.\n\n```python\nWORKSPACE = '/root/.openclaw/workspace'\n```",
        ),
    ];
}

function codexEvents(): JournalEvent[] {
    const codexCmd = (sec: number, command: string, exit: number, snippet: string): JournalEvent => ({
        ...cmd(S_CODEX, sec, command, exit, snippet),
        sender: "agent:codex",
    });
    return [
        codexCmd(301, "/bin/bash -lc 'git diff main...feat/785 --stat'", 0, " 4 files changed, 61 insertions(+)"),
        codexCmd(305, "/bin/bash -lc 'rg -n retention scripts/lib'", 0, "scripts/lib/retention.py:12"),
        codexCmd(320, "/bin/bash -lc 'pnpm tsc --noEmit'", 2, "src/retention.ts(40,7): error TS2322"),
        {
            ...say(
                S_CODEX,
                392,
                "Two type errors in `src/retention.ts` (lines 40 and 58): the cutoff is a `string | undefined` passed where a `Date` is required. Otherwise the diff looks right.",
            ),
            sender: "agent:codex",
        },
    ];
}

const SNIPPET_UNITS = "🔧 `sed -n 1,60p anton/core/paths.py | grep -n PATHS`";
const SNIPPET_LEAKS = "🔧 `cat docs/filesystem-layout.md /root/.claude/CLAUDE.md`";

export interface SubagentFixture {
    conversations: Conversation[];
    selected: string;
    events: JournalEvent[];
    childEvents: Record<string, JournalEvent[]>;
    activity?: { state: "thinking" | "tool" | "idle"; detail?: string };
}

export function subagentFixture(scenario: SubagentScenario): SubagentFixture {
    seq = 5000;
    const parent = parentEvents();
    const childEvents: Record<string, JournalEvent[]> = {
        [S_UNITS]: unitsEvents(),
        [S_LEAKS]: leaksEvents(),
        [S_PREMISE]: premiseEvents(),
        [S_CODEX]: codexEvents(),
    };
    const lastTs = (events: JournalEvent[]): number => events.at(-1)!.ts;
    const conversations: Conversation[] = [
        {
            id: "alerts",
            title: "Anton · alerts",
            session_state: "idle",
            last_seq: 10,
            unread_count: 0,
            snippet: "**P1 — BRIDGE_DOWN** Operator bridge service not responding on :8420 for 3m (auto-restart armed)",
            created_at: BASE - 86_400_000 * 3,
            last_ts: BASE - 86_400_000 * 3,
            read_up_to_seq: 10,
        },
        {
            id: PARENT,
            title: "[96] son-of-anton · Workspace cleanup",
            session_state: "running",
            last_seq: parent.at(-1)!.seq,
            unread_count: 40,
            snippet: "The first wave is finished. #779 and #783 shipped and the loop store is updated.",
            created_at: BASE - 3_600_000,
            last_ts: lastTs(parent),
            read_up_to_seq: 0,
            agent_kind: "claude",
        },
        {
            id: S_UNITS,
            title: "Wave 2: #785 units + docs + script",
            session_state: "running",
            last_seq: childEvents[S_UNITS].at(-1)!.seq,
            unread_count: 7,
            snippet: SNIPPET_UNITS,
            created_at: BASE + 1011_000,
            last_ts: lastTs(childEvents[S_UNITS]),
            parent_convo_id: PARENT,
            read_up_to_seq: 0,
            agent_kind: "claude",
        },
        {
            id: S_LEAKS,
            title: "Wave 2: #785 test leaks + retention",
            session_state: "running",
            last_seq: childEvents[S_LEAKS].at(-1)!.seq,
            unread_count: 2,
            snippet: SNIPPET_LEAKS,
            created_at: BASE + 1013_000,
            last_ts: lastTs(childEvents[S_LEAKS]),
            parent_convo_id: PARENT,
            read_up_to_seq: 0,
            agent_kind: "claude",
        },
        {
            id: S_PREMISE,
            title: "Premise-check loop #791",
            session_state: "done",
            session_outcome: "completed",
            last_seq: childEvents[S_PREMISE].at(-1)!.seq,
            unread_count: 0,
            snippet: "**The premise holds.** `anton/core/paths.py` still hardcodes the workspace root in 3 places, and nothing on main has…",
            created_at: BASE + 6_000,
            last_ts: lastTs(childEvents[S_PREMISE]),
            parent_convo_id: PARENT,
            read_up_to_seq: childEvents[S_PREMISE].at(-1)!.seq,
            agent_kind: "claude",
        },
        {
            id: S_CODEX,
            title: "codex · review the retention diff",
            session_state: "done",
            session_outcome: "failed",
            last_seq: childEvents[S_CODEX].at(-1)!.seq,
            unread_count: 0,
            snippet: "src/retention.ts(40,7): error TS2322: Type 'string | undefined' is not assignable to type 'Date'.",
            created_at: BASE + 300_500,
            last_ts: lastTs(childEvents[S_CODEX]),
            parent_convo_id: PARENT,
            read_up_to_seq: childEvents[S_CODEX].at(-1)!.seq,
            agent_kind: "codex",
        },
        {
            id: "snafu",
            title: "[17] easelyte/snafu-studio · Prep briefs and invoices",
            session_state: "idle",
            last_seq: 4,
            unread_count: 1,
            snippet: '📌 Needs you — task #147 "generate-recurring-invoices"',
            created_at: BASE - 86_400_000 * 3,
            last_ts: BASE - 86_400_000 * 3 + 60_000,
            read_up_to_seq: 3,
        },
        {
            id: "bridge",
            title: "[ca] bridge-journal · Opus 5.5 default upgrade",
            session_state: "idle",
            last_seq: 9,
            unread_count: 11,
            snippet: "Pushed. Session closed. ## Session summary **Done:** bumped the default model and restarted the bridge…",
            created_at: BASE - 86_400_000 * 3,
            last_ts: BASE - 86_400_000 * 3 + 120_000,
            read_up_to_seq: 0,
            agent_kind: "claude",
        },
    ];
    if (scenario === "child") {
        return {
            conversations,
            selected: S_UNITS,
            events: childEvents[S_UNITS],
            childEvents,
            activity: { state: "tool", detail: SNIPPET_UNITS },
        };
    }
    if (scenario === "codex") {
        return { conversations, selected: S_CODEX, events: childEvents[S_CODEX], childEvents };
    }
    return {
        conversations,
        selected: PARENT,
        events: parent,
        childEvents,
        activity: { state: "thinking", detail: "Waiting on the two helpers." },
    };
}
