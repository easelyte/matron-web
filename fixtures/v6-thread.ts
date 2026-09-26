/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Redesign-v6 visual fixture: the design's six-turn thread (docs/design/redesign-v6/src/model.js
 * → fixtures) rebuilt from REAL journal shapes — Bash tool_output finalizes, Edit diffs, agent
 * text — so the harness renders it through the live grouping + card code. Selected with
 * `?v6=<scenario>` on the fixtures page.
 */

import type { JournalEvent, ToolStreamState } from "../src/journal/types";

export type V6Scenario = "full" | "t1" | "run" | "slow" | "wait" | "t5" | "t210";

const BASE = Date.UTC(2026, 8, 25, 10, 6, 0);
let seq = 1000;
function at(sec: number, sender: string, type: string, payload: Record<string, unknown>): JournalEvent {
    seq += 1;
    return { seq, convo_id: "c1", ts: BASE + sec * 1000, sender, type, payload };
}
const op = (sec: number, body: string): JournalEvent => at(sec, "user:operator", "text", { body });
const say = (sec: number, body: string): JournalEvent => at(sec, "agent:claude", "text", { body, from: "assistant" });
const cmd = (sec: number, command: string, exit_code: number | null, snippet: string): JournalEvent =>
    at(sec, "agent:claude", "tool_output", { command, exit_code, snippet, message_ref: `toolu_${seq + 1}` });
const edit = (sec: number, path: string, added: number, removed: number, diff: string): JournalEvent =>
    at(sec, "agent:claude", "diff", {
        tool: "Edit",
        file_path: `/repo/${path}`,
        display_path: path,
        added,
        removed,
        diff,
        from: "assistant",
    });

const TSC_FAIL =
    "src/journal/components.tsx(231,17): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\n\nFound 1 error in src/journal/components.tsx:231";
const TEST_OK =
    " ✓ src/journal/__tests__/new-session-sheet.test.tsx (6 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)";
const TEST_MAIN_FAIL =
    " ✗ src/journal/__tests__/conversation-order.test.ts (4 failed)\n ✗ src/journal/__tests__/work-view-pane.test.tsx (3 failed)\n\n Test Files  2 failed | 26 passed (28)";
const DIFF_SHEET = [
    "@@ -212,14 +212,26 @@ function NewSessionSheet",
    '   <div className="mj_NewSessionSheet_field">',
    '-    <input type="text" value={folder} onChange={setFolder} />',
    "-    <label>Folder path</label>",
    '+    <label htmlFor="ns-folder">Folder</label>',
    '+    <FolderPicker id="ns-folder" recent={recentFolders}',
    "+      defaultPath={box.defaultFolder} value={folder} onChange={setFolder} />",
    "   </div>",
].join("\n");
const DIFF_CLIENT = [
    "@@ -1180,7 +1180,13 @@ async startSession(opts)",
    '-    const model = opts.model ?? "claude-opus";',
    "+    const model = opts.model ?? this.box?.default_model;",
    '+    if (!model) throw new StartError("no_default_model");',
    "     return this.rpc.startSessionRpc({ ...opts, model });",
].join("\n");

function turn1(): JournalEvent[] {
    return [
        op(0, "why is the new-session sheet cryptic?"),
        say(2, "Let me read the sheet component first."),
        cmd(3, "sed -n '1,200p' src/journal/components.tsx", 0, "…"),
        cmd(4, "cat src/journal/client.ts", 0, "…"),
        cmd(5, "rg -n startSessionRpc src", 0, "src/journal/client.ts:578"),
        cmd(6, "cat src/bridge/journal-rpc.js", 0, "…"),
        cmd(7, "rg -n default_model src", 0, "src/bridge/journal-rpc.js:190"),
        cmd(8, "git log --oneline -8 -- src/journal/components.tsx", 0, "a41c2e9 new-session sheet: themed inputs"),
        cmd(9, "sed -n '200,260p' src/journal/components.tsx", 0, "…"),
        edit(11, "src/journal/components.tsx", 18, 6, DIFF_SHEET),
        cmd(17, "pnpm vitest run src/journal/__tests__/new-session-sheet.test.tsx", 0, TEST_OK),
        cmd(21, "pnpm tsc --noEmit", 2, TSC_FAIL),
        cmd(25, "pnpm tsc --noEmit", 0, "(no output — 0 errors)"),
        say(
            192,
            "The sheet reads as cryptic for two reasons. Each label sits closer to the field above it than to the one it names, so “Folder path” looks like it belongs to the workspace box. And the model field shows a raw placeholder, “Agent default”, instead of the model the box will actually use.\n\nI moved every label onto the field below it, replaced the placeholder with the box’s real default, and marked the default folder in the recent list. The change is in `src/journal/components.tsx`.\n\nTests pass and the type check is clean. I didn’t touch the Codex path, which still ignores the model field; that is a separate fix.",
        ),
    ];
}

function turn2(running: boolean): JournalEvent[] {
    const events = [
        op(480, "Can the model default come from the box instead of being hard-coded?"),
        say(482, "Checking where the default model is decided."),
        cmd(483, "cat src/journal/client.ts", 0, "…"),
        cmd(484, "cat src/bridge/journal-rpc.js", 0, "…"),
        cmd(485, "rg -n default_model src", 0, "src/bridge/journal-rpc.js:190"),
        cmd(486, "cat src/bridge/config.ts", 0, "…"),
        edit(488, "src/journal/client.ts", 9, 3, DIFF_CLIENT),
        edit(490, "src/bridge/journal-rpc.js", 4, 1, DIFF_CLIENT),
    ];
    if (running) return events;
    return [
        ...events,
        cmd(534, "pnpm vitest run src/journal", 0, TEST_OK),
        say(
            546,
            "Yes. The box now reports its default model and folder when the client connects, and the sheet preselects both. If the box doesn’t report a default, starting a session fails with a clear message instead of silently picking Opus.",
        ),
    ];
}

function turn3(waiting: boolean): JournalEvent[] {
    const events = [
        op(780, "Looks good. Push it when the tests are green."),
        cmd(801, "pnpm vitest run src/journal", 0, TEST_OK),
        cmd(
            802,
            "git switch -c fix/new-session-sheet && git commit -am 'sheet: labels bind below'",
            0,
            "[fix 9c1e7a2]",
        ),
    ];
    const ask = at(803, "agent:claude", "permission_request", {
        question: "Allow: push the fix branch?",
        description: "git push -u origin fix/new-session-sheet",
        options: ["Allow", "Deny"],
    });
    events.push(ask);
    if (waiting) return events;
    events.push(at(810, "user:operator", "prompt_reply", { target_seq: ask.seq, choice: "Allow" }));
    events.push(cmd(813, "git push -u origin fix/new-session-sheet", 0, " * [new branch] fix/new-session-sheet"));
    const question = at(815, "agent:claude", "prompt", {
        question: "Open a pull request against main as well?",
        options: ["Open PR", "Not yet"],
    });
    events.push(question);
    events.push(at(820, "user:operator", "prompt_reply", { target_seq: question.seq, choice: "Open PR" }));
    events.push(say(828, "Pushed `fix/new-session-sheet` and opened PR #311 against main."));
    return events;
}

function turn4(): JournalEvent[] {
    return [
        op(1080, "Show me what it looks like now."),
        say(1082, "Starting the dev server and taking a screenshot."),
        cmd(1085, "pnpm dev --port 5173 &", 0, "  VITE ready in 812 ms"),
        cmd(1100, "pnpm print:pdf --theme both --out new-session-sheet.pdf", 0, "wrote new-session-sheet.pdf (184 KB)"),
        at(1110, "agent:claude", "image", {
            blob_ref: "img-sheet",
            caption: "new-session-sheet.png",
            dims: { w: 1280, h: 800 },
            content_type: "image/png",
        }),
        at(1111, "agent:claude", "file", {
            blob_ref: "file-sheet",
            filename: "new-session-sheet.pdf",
            size: 188_416,
            content_type: "application/pdf",
        }),
        at(1112, "agent:claude", "item", {
            action: "created",
            item_id: "it_302",
            num: 302,
            kind: "question",
            title: "Which design session first?",
            awaiting: "user",
        }),
        say(
            1154,
            "Here is the sheet as it renders now, plus a PDF with both themes. I also filed #302 so we can decide which design session to run first.",
        ),
    ];
}

function turn5(): JournalEvent[] {
    return [
        op(1500, "The tests on main are failing. Can you look?"),
        cmd(1519, "pnpm vitest run", 1, TEST_MAIN_FAIL),
        at(1522, "journal", "spawn_outcome", {
            request_id: "spawn-v6",
            outcome: "started",
            room_id: "s1",
            child_convo_id: "s1",
        }),
        say(1538, "The session couldn’t resume. Send a message to start fresh."),
        say(1540, "✅ Compacted — context now 3.7k/1m"),
        say(1541, "⏳ Session was idle — auto-resuming it now. Your message will be delivered as soon as it's ready."),
    ];
}

function turn6(): JournalEvent[] {
    return [
        op(2280, "What’s the practical difference between Opus and Sonnet for this repo?"),
        say(
            2290,
            "For this repo, Opus is better at the long, cross-file changes: the client, the bridge and the journal components move together, and Opus keeps more of that in view at once.\n\nSonnet is faster and cheaper, and it is plenty for single-file fixes, copy changes and test updates.",
        ),
    ];
}

const PEER = (): JournalEvent =>
    at(1260, "peer:triage", "peer_message", {
        from_convo: "peer-triage",
        from_name: "test-triage",
        from_kind: "codex",
        body: "3 flaky tests on main are quarantined; the other 7 fail for real. Details in #298.",
    });

function turn210(): JournalEvent[] {
    const events: JournalEvent[] = [
        op(3000, "Move every caller onto the new JournalClient and delete the old RPC helpers."),
    ];
    events.push(say(3001, "I’ll map every caller of the RPC layer before changing anything."));
    let t = 3002;
    for (let i = 0; i < 140; i++)
        events.push(cmd((t += 1), `cat src/journal/module-${String((i % 96) + 1).padStart(2, "0")}.ts`, 0, "…"));
    for (let i = 0; i < 30; i++) events.push(cmd((t += 1), "rg -n rpc.call src", 0, "…"));
    events.push(say((t += 1), "Now moving the calls onto the new client."));
    for (let i = 0; i < 12; i++)
        events.push(
            edit((t += 2), `src/journal/module-${String(((i * 7) % 96) + 1).padStart(2, "0")}.ts`, 6, 2, DIFF_CLIENT),
        );
    events.push(say((t += 1), "Running everything to be sure."));
    for (let i = 0; i < 8; i++) events.push(cmd((t += 20), "pnpm vitest run", i === 1 || i === 4 ? 1 : 0, TEST_OK));
    for (let i = 0; i < 6; i++) events.push(cmd((t += 4), "pnpm tsc --noEmit", i === 0 ? 2 : 0, ""));
    events.push(
        say(
            5890,
            "Done. All 38 callers now go through `JournalClient`, the old helpers are deleted, and the full suite passes.",
        ),
    );
    return events;
}

export interface V6FixtureState {
    events: JournalEvent[];
    sessionState: string;
    toolStreams: Record<string, ToolStreamState>;
    activity?: { state: "thinking" | "tool" | "idle"; detail?: string };
}

export function v6Fixture(scenario: V6Scenario): V6FixtureState {
    seq = 1000;
    const idle = { sessionState: "idle", toolStreams: {} };
    switch (scenario) {
        case "t1":
            return { events: turn1(), ...idle };
        case "run":
        case "slow": {
            const events = [...turn1(), ...turn2(true)];
            const command = "pnpm vitest run src/journal";
            return {
                events,
                sessionState: "running",
                toolStreams: {
                    toolu_live: {
                        messageRef: "toolu_live",
                        command,
                        tool: "Bash",
                        content: "",
                        offset: 0,
                        headTruncated: false,
                    },
                },
                activity: { state: "tool", detail: command },
            };
        }
        case "wait":
            return { events: [...turn2(false), ...turn3(true)], sessionState: "running", toolStreams: {} };
        case "t5":
            return { events: turn5(), ...idle };
        case "t210":
            return { events: turn210(), ...idle };
        case "full":
        default:
            return {
                events: [...turn1(), ...turn2(false), ...turn3(false), ...turn4(), PEER(), ...turn5(), ...turn6()].sort(
                    (left, right) => left.seq - right.seq,
                ),
                ...idle,
            };
    }
}
