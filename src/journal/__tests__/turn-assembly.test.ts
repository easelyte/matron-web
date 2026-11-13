/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { assembleTurns, bridgeTextKind, eventToStep, liveTurnOf, threadRows } from "../turn-assembly";
import { groupRowText, groupTurn, stepsOf } from "../turn-grouping";
import { type JournalEvent } from "../types";

let seq = 0;
const T0 = 1_790_000_000_000;
function ev(type: string, payload: Record<string, unknown>, o: Partial<JournalEvent> = {}): JournalEvent {
    seq += 1;
    return { seq, convo_id: "c1", ts: T0 + seq * 1000, sender: "agent:box", type, payload, ...o };
}
const user = (body: string): JournalEvent => ev("text", { body }, { sender: "user:op" });
const say = (body: string): JournalEvent => ev("text", { body, from: "assistant" });
const cmd = (command: string, exit_code: number | null = 0): JournalEvent =>
    ev("tool_output", { command, exit_code, snippet: "" });
const diff = (path: string, added = 1, removed = 0, tool = "Edit"): JournalEvent =>
    ev("diff", { tool, display_path: path, file_path: `/repo/${path}`, added, removed, diff: "" });

beforeEach(() => {
    seq = 0;
});

describe("assembleTurns: room sides", () => {
    const theirs = (body: string): JournalEvent =>
        ev("text", { body, person: { name: "dan@peer.example" }, via: "agent" }, { sender: "person:dan@peer.example" });
    const notice = (body: string): JournalEvent =>
        ev("text", { body, notice: { kind: "agent_chat", icon: "💬", summary: "You are now in a room" } });

    it("never puts the other person's messages and ours in one turn", () => {
        const turns = assembleTurns([
            say("Here is the list."),
            theirs("Thanks, it arrived."),
            theirs("One more thing."),
            say("Noted."),
        ]);
        expect(turns.map((turn) => turn.events.map((event) => event.sender))).toEqual([
            ["agent:box"],
            ["person:dan@peer.example", "person:dan@peer.example"],
            ["agent:box"],
        ]);
    });

    it("keeps a bridge notice that lands mid-run inside the running turn", () => {
        const turns = assembleTurns([
            user("go"),
            say("Running tests."),
            cmd("ls"),
            notice("Spawn outcome"),
            say("ok"),
            cmd("pytest"),
        ]);
        expect(turns).toHaveLength(1);
        expect(turns[0].items.some((item) => item.kind === "narration" && item.text === "Running tests.")).toBe(true);
    });

    it("splits two sessions on one box that a bridge stamped apart", () => {
        const stamped = (body: string, id: string): JournalEvent =>
            ev("text", { body, from: "agent", from_session: { convo_id: id } });
        const turns = assembleTurns([stamped("one", "s1"), stamped("two", "s1"), stamped("three", "s2")]);
        expect(turns.map((turn) => turn.events.length)).toEqual([2, 1]);
    });

    it("splits a stamped session from earlier unstamped messages, and ignores an unstamped notice", () => {
        const stamped = (body: string, id: string): JournalEvent =>
            ev("text", { body, from: "agent", from_session: { convo_id: id } });
        const turns = assembleTurns([say("old"), stamped("one", "s1"), notice("n"), stamped("two", "s2")]);
        expect(turns.map((turn) => turn.events.length)).toEqual([1, 2, 1]);
    });

    it("keeps one sender's work in one turn", () => {
        const turns = assembleTurns([user("go"), say("Looking."), cmd("ls"), say("Done.")]);
        expect(turns).toHaveLength(1);
    });
});

describe("assembleTurns", () => {
    it("keeps the final text as the answer when a late tool event trails it", () => {
        const turns = assembleTurns([
            user("fix it"),
            say("Looking."),
            cmd("ls"),
            say("All done: the fix is in."),
            cmd("git status"),
        ]);
        expect(turns[0].answer.map((event) => event.payload.body)).toEqual(["All done: the fix is in."]);
        expect(turns[0].items.map((item) => (item.kind === "narration" ? item.text : item.id))).toEqual([
            "Looking.",
            "e3",
            "e5",
        ]);
    });

    it("splits on operator messages and separates narration from the answer", () => {
        const events = [
            user("why is the sheet cryptic?"),
            say("Let me read the sheet component first."),
            cmd("cat src/journal/components.tsx"),
            cmd("git log --oneline -8"),
            say("Found it; fixing the labels."),
            diff("src/journal/components.tsx", 18, 6),
            cmd("pnpm tsc --noEmit", 2),
            cmd("pnpm tsc --noEmit", 0),
            say("The sheet reads as cryptic for two reasons."),
            say("Tests pass and the type check is clean."),
            user("thanks"),
            say("Any time."),
        ];
        const turns = assembleTurns(events);
        expect(turns).toHaveLength(2);
        const [first, second] = turns;
        expect(first.operator?.payload.body).toBe("why is the sheet cryptic?");
        expect(first.items.map((item) => (item.kind === "narration" ? `“${item.text}”` : item.id))).toEqual([
            "“Let me read the sheet component first.”",
            "e3",
            "e4",
            "“Found it; fixing the labels.”",
            "e6",
            "e7",
            "e8",
        ]);
        expect(first.answer.map((event) => event.payload.body)).toEqual([
            "The sheet reads as cryptic for two reasons.",
            "Tests pass and the type check is clean.",
        ]);
        expect(
            groupTurn(first.items).flatMap((entry) => (entry.type === "group" ? [groupRowText(entry)] : [])),
        ).toEqual([
            "Read components.tsx",
            "Checked the history",
            "Changed 1 file",
            "Checked the types: failed once, then passed",
        ]);
        // Duration runs from the operator message (decision §7.5).
        expect(first.endTs - first.startTs).toBe(9000);
        // A turn with no steps has no card content; its text is all answer.
        expect(second.items).toEqual([]);
        expect(second.answer.map((event) => event.payload.body)).toEqual(["Any time."]);
    });

    it("keeps break-throughs, notices, errors out of the card", () => {
        const events = [
            user("ship it"),
            cmd("pnpm vitest run", 1),
            ev("permission_request", { question: "Allow: push?" }),
            ev("image", { blob_ref: "img1" }),
            say("🗜️ Context compacted — conversation history was summarized to free up space"),
            say("[Session ended (exit 1)]"),
        ];
        const [turn] = assembleTurns(events);
        expect(stepsOf(turn.items)).toHaveLength(1);
        expect(turn.breaks.map((event) => event.type)).toEqual(["permission_request", "image"]);
        expect(turn.notices).toHaveLength(1);
        expect(turn.errors.map((event) => event.payload.body)).toEqual(["[Session ended (exit 1)]"]);
        expect(turn.answer).toEqual([]);
        expect(threadRows([turn]).map((row) => row.kind)).toEqual(["operator", "turn", "notice"]);
    });

    it("keeps an answer to the agent's question inside the same turn", () => {
        const events = [
            user("push it when green"),
            cmd("pnpm vitest run"),
            ev("prompt", { question: "Open a PR as well?", options: ["Open PR", "Not yet"] }),
            ev("prompt_reply", { target_seq: 3, choice: "Open PR" }, { sender: "user:op" }),
            cmd("gh pr create --fill"),
            say("Opened the PR."),
        ];
        const turns = assembleTurns(events);
        expect(turns).toHaveLength(1);
        const [turn] = turns;
        expect(stepsOf(turn.items)).toHaveLength(2);
        expect(turn.replies.map((event) => event.type)).toEqual(["prompt_reply"]);
        expect(turn.breaks.map((event) => event.type)).toEqual(["prompt"]);
        expect(turn.answer.map((event) => event.payload.body)).toEqual(["Opened the PR."]);
    });

    it("treats agent events before the first operator message as their own turn", () => {
        const [turn] = assembleTurns([say("Session started."), cmd("ls")]);
        expect(turn.operator).toBeUndefined();
        expect(turn.items.map((item) => item.kind)).toEqual(["narration", "step"]);
    });

    it("omits the agent tile when a turn holds only notices", () => {
        const rows = threadRows(assembleTurns([user("/restart --browser"), say("🔄 Restarting Claude session...")]));
        expect(rows.map((row) => row.kind)).toEqual(["operator", "notice"]);
    });
});

describe("liveTurnOf", () => {
    it("skips a trailing slash command so the working turn stays live", () => {
        const turns = assembleTurns([
            user("fix it"),
            cmd("ls"),
            user("/restart --browser"),
            say("🔄 Restarting Claude session..."),
        ]);
        expect(turns).toHaveLength(2);
        expect(liveTurnOf(turns)).toBe(turns[0]);
    });

    it("keeps a normal message, or a slash command that started work, as the live turn", () => {
        const normal = assembleTurns([user("fix it"), cmd("ls"), user("also the docs")]);
        expect(liveTurnOf(normal)).toBe(normal[1]);
        const skill = assembleTurns([user("fix it"), cmd("ls"), user("/doc-review"), cmd("cat spec.md")]);
        expect(liveTurnOf(skill)).toBe(skill[1]);
    });

    it("treats a skill slash command as its own live turn before it has any events", () => {
        const turns = assembleTurns([user("fix it"), cmd("ls"), user("/doc-review")]);
        expect(liveTurnOf(turns)).toBe(turns[1]);
    });

    it("returns the only turn when it is a slash command", () => {
        const turns = assembleTurns([user("/status")]);
        expect(liveTurnOf(turns)).toBe(turns[0]);
        expect(liveTurnOf([])).toBeUndefined();
    });
});

describe("eventToStep", () => {
    it("maps a Claude Bash tool_output to a shell step with its exit status", () => {
        expect(eventToStep(cmd("pnpm tsc --noEmit", 2))).toMatchObject({
            tool: "Bash",
            input: { command: "pnpm tsc --noEmit" },
            status: "failed",
            exit: 2,
        });
        expect(eventToStep(cmd("sleep 999", null))).toMatchObject({ status: "stopped", exit: null });
        expect(eventToStep(ev("tool_output", { command: "rm -rf x", denied: true }))).toMatchObject({
            status: "failed",
        });
    });

    it("maps Codex apply_patch diffs and legacy file_change output to change steps", () => {
        expect(eventToStep(diff("src/a.ts", 3, 1, "apply_patch"))).toMatchObject({
            tool: "apply_patch",
            input: { path: "src/a.ts" },
            added: 3,
            removed: 1,
        });
        expect(eventToStep(ev("tool_output", { command: "file_change", output: "update src/a.ts" }))).toMatchObject({
            tool: "file_change",
        });
        expect(eventToStep(ev("tool_output", { command: "pnpm test", status: "failed" }))).toMatchObject({
            status: "failed",
        });
    });

    it("maps a Codex generic completed item line to a step", () => {
        expect(eventToStep(say("`Web search`"))).toMatchObject({ tool: "WebSearch" });
        expect(eventToStep(say("`Mcp tool call`"))).toMatchObject({ tool: "Mcp tool call" });
        expect(eventToStep(say("`not a step` with prose"))).toBeNull();
    });

    it("approximates duration from the previous event", () => {
        const step = eventToStep({ ...cmd("pnpm build"), ts: T0 + 5000 }, T0 + 2000);
        expect(step?.ms).toBe(3000);
    });
});

// Payload shapes copied from the bridge producers (matron-bridge): Claude's
// finalizeToolStreamEntry, the Codex exec formatter (command_execution / file_change), the Codex
// app-server finalize, and buildEditDiffPayload / publishChanges for diffs.
describe("bridge producer payloads", () => {
    it("reads a Claude Bash finalize", () => {
        const step = eventToStep(
            ev("tool_output", {
                message_ref: "toolu_1",
                command: "pnpm tsc --noEmit",
                exit_code: 2,
                denied: false,
                truncated: false,
                snippet: "error TS2322",
                blob_ref: "m1",
                live_log: true,
            }),
        );
        expect(step).toMatchObject({
            tool: "Bash",
            status: "failed",
            exit: 2,
            input: { command: "pnpm tsc --noEmit" },
        });
    });

    it("reads a Codex exec command_execution and file_change", () => {
        expect(
            eventToStep(
                ev("tool_output", {
                    tool_use_id: "item_1",
                    command: "bash -lc 'pnpm vitest run'",
                    output: "ok",
                    exit_code: 0,
                    status: "completed",
                }),
            ),
        ).toMatchObject({ tool: "Bash", status: "ok", exit: 0 });
        expect(
            eventToStep(
                ev("tool_output", {
                    tool_use_id: "item_2",
                    command: "file_change",
                    output: "update src/a.ts",
                    status: "completed",
                }),
            ),
        ).toMatchObject({ tool: "file_change", status: "ok", exit: undefined });
    });

    it("reads a Claude Edit diff and a Codex apply_patch diff", () => {
        const claude = eventToStep(
            ev("diff", {
                file_path: "/repo/src/a.ts",
                display_path: "src/a.ts",
                viewer_url: null,
                tool: "Write",
                label: null,
                diff: "+x",
                added: 1,
                removed: 0,
                truncated: false,
                new_file: true,
                from: "assistant",
            }),
        );
        expect(claude).toMatchObject({ tool: "Write", input: { path: "src/a.ts" }, newFile: true, added: 1 });
        const codex = eventToStep(
            ev("diff", {
                file_path: "/repo/src/b.ts",
                display_path: "src/b.ts",
                viewer_url: null,
                tool: "apply_patch",
                label: null,
                diff: "-a\n+b",
                from: "assistant",
                added: 1,
                removed: 1,
                truncated: false,
                new_file: false,
            }),
        );
        expect(codex).toMatchObject({ tool: "apply_patch", newFile: false, removed: 1 });
    });
});

describe("bridgeTextKind", () => {
    it.each([
        "🗜️ Context compacted — conversation history was summarized to free up space",
        "✅ Compacted — context now 3.7k/1m",
        "⏳ Session was idle — auto-resuming it now. Your message will be delivered as soon as it's ready.",
        "⏳ A restart is pending for this session — queued messages go to the restarted session instead.",
        "⚡ Sending 1 queued message",
        "🔄 Restarting Claude session...",
        "Claude session restarted.\nSession: 1234abcd...\nWorkdir: /repo\nExtras: browser",
        "Waiting for turn to finish before restarting. Send again with --force to restart immediately.",
        "[Session ended (exit 0)]",
    ])("recognises the notice %#", (body) => {
        expect(bridgeTextKind(body)).toBe("notice");
    });

    it.each([
        "[Session ended (exit 1)]",
        "[Session ended (exit 137)]",
        "⚠️ That conversation can no longer be found or resumed.",
        "The session couldn’t resume. Send a message to start fresh.",
    ])("recognises the turn-ending error %#", (body) => {
        expect(bridgeTextKind(body)).toBe("error");
    });

    it("leaves agent prose alone", () => {
        expect(bridgeTextKind("Restarting the dev server now.")).toBeNull();
        expect(bridgeTextKind("The session couldn't be simpler.")).toBeNull();
        expect(bridgeTextKind("")).toBeNull();
    });
});
