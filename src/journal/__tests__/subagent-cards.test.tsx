/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Helpers (Claude subagents + Codex runs), 2026-09-26: plain-English activity from the bridge's
 * tool-indicator lines, the subagent card in the parent thread, and the sidebar child row.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { indicatorStep, payloadStep, plainLine, previewLine } from "../activity-text";
import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import { helperForStep, helpersByTurn, subagentStatus, subagentView } from "../subagent-card";
import { resetShowTheWorkForTests, SHOW_THE_WORK_KEY } from "../show-the-work";
import { assembleTurns, eventToStep } from "../turn-assembly";
import { liveLine, type Step, stepSentence } from "../turn-grouping";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: Session = { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 2, username: "op" };
const T0 = 1_790_000_000_000;

let seq = 0;
function ev(
    convo: string,
    type: string,
    payload: Record<string, unknown>,
    sender = "agent:box",
    sec = 0,
): JournalEvent {
    seq += 1;
    return { seq, convo_id: convo, ts: T0 + sec * 1000, sender, type, payload };
}
const text = (convo: string, body: string, sec: number, extra: Record<string, unknown> = {}): JournalEvent =>
    ev(convo, "text", { body, from: "assistant", ...extra }, "agent:box", sec);

function convo(id: string, extra: Partial<Conversation> = {}): Conversation {
    return {
        id,
        title: id,
        session_state: "running",
        session_outcome: null,
        last_seq: 1,
        unread_count: 0,
        snippet: "",
        created_at: T0,
        parent_convo_id: null,
        read_up_to_seq: 0,
        ...extra,
    };
}

describe("tool-indicator lines → steps", () => {
    it("reads each of the bridge's fixed wordings", () => {
        expect(indicatorStep("🔧 `sed -n 1,60p a/paths.py | grep -n X`")).toMatchObject({
            tool: "Bash",
            input: { command: "sed -n 1,60p a/paths.py | grep -n X" },
        });
        expect(indicatorStep("🔧 TaskUpdate")).toMatchObject({ tool: "TaskUpdate", input: {} });
        expect(indicatorStep("📖 /repo/src/paths.py")).toMatchObject({
            tool: "Read",
            input: { path: "/repo/src/paths.py" },
        });
        expect(indicatorStep("🔍 WORKSPACE_ROOT")).toMatchObject({
            tool: "Grep",
            input: { pattern: "WORKSPACE_ROOT" },
        });
        expect(indicatorStep("🌐 https://example.com/a")).toMatchObject({ tool: "WebFetch" });
        // A web search's query is free text: only the structured payload.step can mark it.
        expect(indicatorStep("🌐 matron release notes")).toBeNull();
        expect(indicatorStep("🔀 Subtask: Premise-check loop #791")).toMatchObject({
            tool: "Task",
            input: { description: "Premise-check loop #791" },
        });
        expect(indicatorStep("🔀 Nested subtask: dig deeper")).toMatchObject({ tool: "Task" });
    });

    it("never swallows prose, a to-do list, or a command cut short (unless reading a snippet)", () => {
        expect(indicatorStep("I'll start with the paths module.")).toBeNull();
        expect(indicatorStep("🔧 fixed the build, then ran the tests")).toBeNull();
        expect(indicatorStep("🔍 Found the root cause in the migration")).toBeNull();
        expect(indicatorStep("📖 Read the whole spec twice")).toBeNull();
        expect(indicatorStep("🌐 the docs say otherwise")).toBeNull();
        expect(indicatorStep("🔍 hardcoded workspace|WORKSPACE_ROOT")).toMatchObject({ tool: "Grep" });
        expect(indicatorStep("📋 Todos:\n✅ one\n⬚ two")).toBeNull();
        expect(indicatorStep("🔧 `sed -n 1,60p anton/core/paths.py | grep -n…")).toBeNull();
        expect(indicatorStep("🔧 `sed -n 1,60p anton/core/paths.py | grep -n…", "s", true)).toMatchObject({
            tool: "Bash",
        });
    });

    it("prefers the structured payload.step a newer bridge attaches", () => {
        expect(payloadStep({ tool: "Read", path: "/a/b.ts" })).toMatchObject({
            tool: "Read",
            input: { path: "/a/b.ts" },
        });
        expect(payloadStep({ tool: "rm -rf /", command: "x" })).toBeNull();
        expect(payloadStep("nope")).toBeNull();
        const event = text("c", "🔧 `cat a`", 1, { step: { tool: "Grep", pattern: "needle" } });
        expect(eventToStep(event)).toMatchObject({ tool: "Grep", input: { pattern: "needle" } });
    });

    it("turns a subagent's indicator lines into card steps, not narration", () => {
        const events = [
            text("c", "Looking first.", 1),
            text("c", "🔧 `cat docs/layout.md`", 2),
            text("c", "📖 /repo/a.ts", 3),
            text("c", "Done: it holds.", 4),
        ];
        const [turn] = assembleTurns(events);
        expect(turn.items.map((item) => item.kind)).toEqual(["narration", "step", "step"]);
        expect(turn.answer.map((event) => event.payload.body)).toEqual(["Done: it holds."]);
    });

    it("reads a piped read by its first stage, and web searches as searches", () => {
        const step = indicatorStep("🔧 `sed -n 1,60p anton/core/paths.py | grep -n PATHS`")!;
        expect(liveLine(step)).toBe("Reading paths.py…");
        expect(stepSentence(payloadStep({ tool: "WebSearch", pattern: "matron release notes" })!)).toBe(
            "Searched the web for matron release notes",
        );
    });
});

describe("sidebar preview (Developer view off)", () => {
    const row = (snippet: string, session_state = "running", last_step: Conversation["last_step"] = undefined) => ({
        snippet,
        session_state,
        last_step,
    });

    it("reads a tool call as its activity: progressive while running, past once done", () => {
        expect(previewLine(row("🔧 `sed -n 1,60p anton/core/paths.py | grep -n PATHS`"))).toBe("Reading paths.py…");
        expect(previewLine(row("🔧 `cat docs/filesystem-layout.md /root/.claud", "running"))).toBe("Reading .claud…");
        expect(previewLine(row("🔍 WORKSPACE_ROOT", "done"))).toBe("Searched for WORKSPACE_ROOT");
        expect(previewLine(row("$ pnpm vitest run", "running"))).toBe("Running the tests…");
    });

    it("prefers the client-recorded last step (a Codex run's snippet is command output)", () => {
        expect(
            previewLine(
                row("src/x.ts(40,7): error TS2322", "running", {
                    tool: "Bash",
                    input: { command: "pnpm tsc --noEmit" },
                }),
            ),
        ).toBe("Checking the types…");
    });

    it("never prints a running Codex run's output snippet when its step is unknown", () => {
        const codex = { ...row("src/x.ts(40,7): error TS2322", "running"), worker: "codex" as const };
        expect(previewLine(codex)).toBe("Working…");
        expect(previewLine(row("[diff]", "running"))).toBe("Changing a file…");
        expect(previewLine(row("[tool_output]", "done"))).toBe("Ran a command");
        // A finished session restored from a snapshot, last message a diagnostic: described.
        const doneCodex = {
            ...row("src/retention.ts(40,7): error TS2322: Type 'string'", "done"),
            worker: "codex" as const,
        };
        expect(previewLine(doneCodex)).toBe("Ran a command");
        expect(
            previewLine({ ...row("error TS2322: Type 'string' is not assignable", "done"), worker: "codex" as const }),
        ).toBe("Ran a command");
        expect(
            previewLine({ ...row("scripts/lib/retention.py:12:    cutoff = now()", "idle"), worker: "codex" as const }),
        ).toBe("Ran a command");
        expect(previewLine(row('{"type":"item.started","item":{"type":"web_search"}}', "idle"))).toBe("Ran a command");
        // Prose stays prose, including a Codex final answer that names a file.
        expect(
            previewLine({
                ...row("Two type errors in src/retention.ts, lines 40 and 58.", "done"),
                worker: "codex" as const,
            }),
        ).toBe("Two type errors in src/retention.ts, lines 40 and 58.");
        expect(
            previewLine({
                ...row("Fixed src/journal/client.ts:775 and verified retry behavior", "done"),
                worker: "codex" as const,
            }),
        ).toBe("Fixed src/journal/client.ts:775 and verified retry behavior");
        expect(previewLine(row("Deployed; the probe returned exit code 0 on every host.", "idle"))).toBe(
            "Deployed; the probe returned exit code 0 on every host.",
        );
        expect(previewLine(row("The first wave is finished. #779 and #783 shipped.", "idle"))).toBe(
            "The first wave is finished. #779 and #783 shipped.",
        );
    });

    it("drops markdown from prose instead of showing its source", () => {
        expect(previewLine(row("**P1 — BRIDGE_DOWN** Operator bridge", "idle"))).toBe(
            "P1 — BRIDGE_DOWN Operator bridge",
        );
        expect(previewLine(row("Pushed. Session closed. ## Session summary **Do", "idle"))).toBe(
            "Pushed. Session closed. Session summary Do",
        );
        expect(plainLine("Fixed `paths.py`.\n\n```py\nX = 1\n```\nDone.")).toBe("Fixed paths.py. Done.");
    });
});

describe("subagent card model", () => {
    const child = convo("p:sub:a", { parent_convo_id: "p", created_at: T0 + 10_000, title: "Wave 2: units" });

    it("maps state and outcome to one status", () => {
        expect(subagentStatus({ session_state: "running" })).toBe("running");
        expect(subagentStatus({ session_state: "done", session_outcome: "completed" })).toBe("done");
        expect(subagentStatus({ session_state: "done", session_outcome: null })).toBe("done");
        expect(subagentStatus({ session_state: "done", session_outcome: "failed" })).toBe("failed");
        expect(subagentStatus({ session_state: "done", session_outcome: "interrupted" })).toBe("stopped");
        expect(subagentStatus({ session_state: "done", session_outcome: "cancelled" })).toBe("idle");
        expect(subagentStatus({ session_state: "waiting" })).toBe("idle");
    });

    it("treats a running Claude helper's trailing call as the step running now", () => {
        const events = [
            text(child.id, "Starting.", 11),
            text(child.id, "📖 /r/a.ts", 12),
            text(child.id, "🔧 `pnpm jest`", 14),
        ];
        const view = subagentView(child, events, "claude", T0 + 40_000);
        expect(view.steps).toHaveLength(1);
        expect(view.running).toMatchObject({ tool: "Bash", status: "running" });
        expect(view.durationMs).toBe(30_000);
        expect(view.result).toBe("");
    });

    it("keeps a Codex helper's last command as done (Codex reports a command when it ends)", () => {
        const events = [ev(child.id, "tool_output", { command: "rg x", exit_code: 0 }, "agent:codex", 12)];
        const view = subagentView(child, events, "codex", T0 + 40_000);
        expect(view.running).toBeNull();
        expect(view.steps).toHaveLength(1);
    });

    it("takes the final message as the result once finished", () => {
        const done = { ...child, session_state: "done", session_outcome: "completed", last_ts: T0 + 70_000 };
        const events = [text(child.id, "🔍 x", 12), text(child.id, "**The premise holds.**", 70)];
        const view = subagentView(done, events, "claude", T0 + 99_000);
        expect(view.result).toBe("**The premise holds.**");
        expect(view.durationMs).toBe(60_000);
    });

    it("matches a helper step to the child titled from its description", () => {
        const a = convo("p:sub:1", { title: "Premise-check loop #791" });
        const b = convo("p:sub:2", { title: "Review the RPC migration diff for mi…" });
        const step = (description: string): Step => ({
            kind: "step",
            id: "s",
            tool: "Task",
            input: { description },
            status: "ok",
        });
        expect(helperForStep(step("Premise-check loop #791"), [a, b])).toBe(a);
        expect(helperForStep(step("Review the RPC migration diff for missed callers"), [a, b])).toBe(b);
        expect(helperForStep(step("Something else"), [a, b])).toBeUndefined();
        // Two helpers with one description: ambiguous, so the step links neither.
        const twin = convo("p:sub:3", { title: "Premise-check loop #791" });
        expect(helperForStep(step("Premise-check loop #791"), [a, twin])).toBeUndefined();
    });

    it("anchors each child to the turn it started in", () => {
        const turns = [
            { key: "1", startTs: T0 },
            { key: "9", startTs: T0 + 100_000 },
        ];
        const early = convo("e", { created_at: T0 - 5_000 });
        const first = convo("f", { created_at: T0 + 5_000 });
        const second = convo("s", { created_at: T0 + 150_000 });
        const map = helpersByTurn(turns, [second, first, early], false);
        expect(map.get("1")?.map((c) => c.id)).toEqual(["e", "f"]);
        expect(map.get("9")?.map((c) => c.id)).toEqual(["s"]);
        // With older history unloaded, a child from before the first loaded turn waits for it.
        expect(helpersByTurn(turns, [early], true).size).toBe(0);
    });
});

describe("client helper reads", () => {
    function withStore(messages: jest.Mock): { client: MatronJournalClient; putHistory: jest.Mock } {
        const client = new MatronJournalClient();
        const putHistory = jest.fn(async () => undefined);
        const store = { putHistory, events: jest.fn(async () => []) };
        Object.assign(client as unknown as Record<string, unknown>, { api: { messages }, database: store });
        return { client, putHistory };
    }

    it("shares one tail request between concurrent cards and stores it once", async () => {
        let resolve!: (value: { events: JournalEvent[] }) => void;
        const messages = jest.fn(() => new Promise<{ events: JournalEvent[] }>((r) => (resolve = r)));
        const { client, putHistory } = withStore(messages);
        const first = client.refreshConversationTail("p:sub:a");
        const second = client.refreshConversationTail("p:sub:a");
        expect(messages).toHaveBeenCalledTimes(1);
        resolve({ events: [text("p:sub:a", "hi", 1)] });
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
        expect(putHistory).toHaveBeenCalledTimes(1);
        // Settled: later cards do not refetch this session.
        await client.refreshConversationTail("p:sub:a");
        expect(messages).toHaveBeenCalledTimes(1);
    });

    it("a stale request timing out after a reset never evicts the newer request", async () => {
        jest.useFakeTimers();
        try {
            const messages = jest.fn(() => new Promise<never>(() => undefined));
            const { client } = withStore(messages);
            void client.refreshConversationTail("p:sub:a");
            (client as unknown as { conversationTailFetches: Map<string, unknown> }).conversationTailFetches.clear();
            jest.advanceTimersByTime(10_000);
            void client.refreshConversationTail("p:sub:a"); // newer request, 10s into the old one
            jest.advanceTimersByTime(5_000); // the OLD one times out
            await Promise.resolve();
            await Promise.resolve();
            void client.refreshConversationTail("p:sub:a"); // shares the newer, still in flight
            expect(messages).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it("gives up on a stalled request and lets a later card retry", async () => {
        jest.useFakeTimers();
        try {
            const messages = jest.fn(() => new Promise<never>(() => undefined));
            const { client } = withStore(messages);
            const pending = client.refreshConversationTail("p:sub:a");
            jest.advanceTimersByTime(15_000);
            await expect(pending).resolves.toBe(false);
            void client.refreshConversationTail("p:sub:a");
            expect(messages).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe("subagent card + sidebar child row (rendered)", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        localStorage.clear();
        resetShowTheWorkForTests();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        localStorage.clear();
        resetShowTheWorkForTests();
    });

    function setup(): MatronJournalClient {
        seq = 100;
        const parentEvents = [ev("p", "text", { body: "go" }, "user:op", 0), text("p", "🔀 Subtask: Wave 2: units", 2)];
        const child = convo("p:sub:a", {
            title: "Wave 2: units",
            parent_convo_id: "p",
            created_at: T0 + 3_000,
            snippet: "🔧 `sed -n 1,60p anton/core/paths.py | grep -n PATHS`",
        });
        const childEvents = [
            text(child.id, "Starting.", 4),
            text(child.id, "📖 /r/anton/core/paths.py", 5),
            text(child.id, "🔧 `sed -n 1,60p anton/core/paths.py | grep -n PATHS`", 6),
        ];
        const instance = new MatronJournalClient();
        (instance as unknown as { state: ClientState }).state = {
            ...instance.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: [convo("p", { title: "Parent", created_at: T0 - 1000 }), child],
            selectedConversationId: "p",
            events: parentEvents,
            pendingMessages: [],
            connection: "online",
            archivedIds: archiveStore.read(SESSION).ids,
            pinnedIds: pinnedStore.read(SESSION).ids,
            favoriteIds: favoriteStore.read(SESSION).ids,
            unreadOverrideIds: unreadStore.read(SESSION).ids,
        };
        (instance as unknown as { conversationEvents: () => Promise<JournalEvent[]> }).conversationEvents = async () =>
            childEvents;
        (instance as unknown as { refreshConversationTail: () => Promise<boolean> }).refreshConversationTail =
            async () => false;
        return instance;
    }

    it("Developer view off: a card with plain-English activity, no command line anywhere", async () => {
        const client = setup();
        await act(async () => root.render(<MatronApp client={client} />));
        const card = container.querySelector(".mj_SubagentCard");
        expect(card).not.toBeNull();
        expect(card?.querySelector(".mj_SubagentCard_name")?.textContent).toBe("Wave 2: units");
        expect(card?.querySelector(".mj_TurnCard_spinner")).not.toBeNull();
        expect(card?.querySelector(".mj_SubagentCard_meta")?.textContent).toContain("Reading paths.py…");
        expect(card?.querySelector(".mj_SubagentCard_kind")?.textContent).toBe("Claude");

        await act(async () => (card?.querySelector(".mj_SubagentCard_toggle") as HTMLButtonElement).click());
        expect(card?.querySelector(".mj_TurnCard_embedded")).not.toBeNull();
        expect(card?.querySelector(".mj_TurnCard_helperOpen")?.textContent).toContain("Open helper");

        // Nowhere in the thread or the sidebar does the raw command or its emoji line appear.
        expect(container.textContent).not.toContain("sed -n");
        expect(container.textContent).not.toContain("🔀 Subtask");
        const row = container.querySelector(".mj_RoomListItem_sub");
        expect(row?.querySelector(".mj_RoomListPreview")?.textContent).toBe("Reading paths.py…");
        expect(row?.querySelector(".mj_RoomListSubStatus_running .mj_TurnCard_spinner")).not.toBeNull();
        expect(row?.querySelector(".mj_AnthropicMark, .mj_OpenAIMark")).toBeNull();
        expect(row?.querySelector(".mj_RoomListName")?.textContent).toBe("Wave 2: units");
    });

    it("Developer view on keeps the raw lines: the sidebar snippet and the card's steps", async () => {
        localStorage.setItem(SHOW_THE_WORK_KEY, "true");
        const client = setup();
        await act(async () => root.render(<MatronApp client={client} />));
        const row = container.querySelector(".mj_RoomListItem_sub");
        expect(row?.querySelector(".mj_RoomListPreview")?.textContent).toContain("sed -n 1,60p");
        const card = container.querySelector(".mj_SubagentCard");
        expect(card).not.toBeNull();
        await act(async () => (card?.querySelector(".mj_SubagentCard_toggle") as HTMLButtonElement).click());
        expect(card?.querySelector(".mj_SubagentCard_raw")?.textContent).toContain("sed -n 1,60p");
    });
});
