/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    chatSidePane,
    clampSidePaneWidth,
    resolveSubtaskTarget,
    subtaskCandidates,
    subtaskDescription,
} from "../../../src/journal/subtask";
import type { Conversation } from "../../../src/journal/types";

const convo = (
    id: string,
    title: string,
    session_state = "done",
    parent_convo_id?: string,
    created_at = 0,
): Conversation => ({
    id,
    title,
    session_state,
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at,
    parent_convo_id,
    read_up_to_seq: 0,
});

describe("subtaskDescription", () => {
    it("reads the description of a bridge subtask line", () => {
        expect(subtaskDescription("🔀 Subtask: Explore auth call sites")).toBe("Explore auth call sites");
        expect(subtaskDescription("\n  🔀 Subtask: padded  \n")).toBe("padded");
    });

    it("rejects anything that is not a whole subtask line", () => {
        expect(subtaskDescription("🔀 Subtask: ")).toBeUndefined();
        expect(subtaskDescription("prefix 🔀 Subtask: x")).toBeUndefined();
        expect(subtaskDescription("a long message\nwith 🔀 Subtask: inside")).toBeUndefined();
        expect(subtaskDescription("Subtask: no marker")).toBeUndefined();
    });
});

describe("resolveSubtaskTarget", () => {
    it("matches a title exactly", () => {
        const children = [convo("a", "lint"), convo("b", "test suites")];
        expect(resolveSubtaskTarget("test suites", children)?.id).toBe("b");
        expect(resolveSubtaskTarget("unknown", children)).toBeUndefined();
    });

    // What the bridge does: the line carries description.slice(0, 80); the watcher titles the
    // child description.slice(0, 37) + "…" once the description is longer than 40.
    const bridgeLine = (description: string): string => description.slice(0, 80);
    const watcherTitle = (description: string): string =>
        description.length > 40 ? `${description.slice(0, 37)}…` : description;

    it("matches a long description to the title the watcher cut short", () => {
        const description = "Explore every auth call site and list the ones that skip the check";
        const children = [convo("a", watcherTitle(description))];
        expect(resolveSubtaskTarget(bridgeLine(description), children)?.id).toBe("a");
    });

    it("matches a description cut at 80 to the same cut title, behind a session short", () => {
        const description = `${"Audit the payment retry path end to end, ".repeat(3)}and report`;
        expect(bridgeLine(description)).toHaveLength(80);
        const children = [convo("a", `🐣 [7a] ${watcherTitle(description)}`)];
        expect(resolveSubtaskTarget(subtaskDescription(`🔀 Subtask: ${bridgeLine(description)}`)!, children)?.id).toBe(
            "a",
        );
    });

    it("matches a description cut at 80 to a full title that starts with it", () => {
        const description = "x".repeat(79) + " and more";
        const children = [convo("a", description)];
        expect(resolveSubtaskTarget(bridgeLine(description), children)?.id).toBe("a");
    });

    it("survives a cut through an emoji on either side", () => {
        const description = `${"a".repeat(36)}🦊 ${"b".repeat(60)}`;
        const title = watcherTitle(description); // ends with half of the fox, then "…"
        expect(resolveSubtaskTarget(bridgeLine(description), [convo("a", title)])?.id).toBe("a");
        expect(
            resolveSubtaskTarget(bridgeLine(description), [convo("a", title.replace(/\uD83E…$/, "\uFFFD…"))])?.id,
        ).toBe("a");
    });

    it("does not link a short description to a longer title that merely starts with it", () => {
        // "lint" may be a child that has not arrived yet: a card for "linting tool" would be wrong.
        expect(resolveSubtaskTarget("lint", [convo("long", "linting tool")])).toBeUndefined();
        expect(
            resolveSubtaskTarget("Explore every auth call site", [convo("a", "Explore every auth call site and fix")]),
        ).toBeUndefined();
    });

    it("does not link a description that only shares a short cut title's start", () => {
        expect(resolveSubtaskTarget("Explore the cache layer", [convo("a", "Explore…")])).toBeUndefined();
        const other = "Explore every auth call site and list the ones that skip the check";
        expect(resolveSubtaskTarget("Explore every auth call", [convo("a", watcherTitle(other))])).toBeUndefined();
    });

    it("prefers an exact match over a longer title with the same start", () => {
        const children = [convo("long", "linting tool"), convo("exact", "lint")];
        expect(resolveSubtaskTarget("lint", children)?.id).toBe("exact");
    });

    it("prefers a running child, then the newest, among duplicate titles", () => {
        const running = [convo("old", "lint", "running"), convo("new", "lint", "done")];
        expect(resolveSubtaskTarget("lint", running)?.id).toBe("old");
        const done = [convo("old", "lint"), convo("new", "lint")];
        expect(resolveSubtaskTarget("lint", done)?.id).toBe("new");
    });

    it("matches a child whose title carries a session short and marker", () => {
        const children = [convo("a", "🐣 [7a] test triage"), convo("b", "[WIP] notes")];
        expect(resolveSubtaskTarget("test triage", children)?.id).toBe("a");
        expect(resolveSubtaskTarget("test tri", children)).toBeUndefined();
        expect(resolveSubtaskTarget("[WIP] notes", children)?.id).toBe("b");
    });

    it("matches an untitled child by its id, as the sidebar names it", () => {
        expect(resolveSubtaskTarget("room:sub:1", [convo("room:sub:1", "")])?.id).toBe("room:sub:1");
    });
});

describe("subtaskCandidates", () => {
    const conversations = [
        convo("parent", "Parent"),
        convo("b", "second", "done", "parent", 2),
        convo("a", "first", "done", "parent", 1),
        convo("other", "Other"),
    ];

    it("offers a parent's children in creation order", () => {
        expect(subtaskCandidates(conversations, "parent").map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("offers a subagent's siblings, since nested agents are flattened", () => {
        expect(subtaskCandidates(conversations, "a").map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("offers nothing in a chat without subagents", () => {
        expect(subtaskCandidates(conversations, "other")).toEqual([]);
    });
});

describe("chatSidePane", () => {
    const subChatPane = { parentId: "parent", childId: "child" };

    it("shows the subagent beside the chat it was opened from", () => {
        expect(chatSidePane({ subChatPane, selectedConversationId: "parent" })).toEqual({
            kind: "subchat",
            parentId: "parent",
            childId: "child",
        });
    });

    it("is never inherited by another chat", () => {
        expect(chatSidePane({ subChatPane, selectedConversationId: "other" })).toBeUndefined();
    });

    it("shows nothing beside the tracker", () => {
        expect(
            chatSidePane({
                subChatPane,
                selectedConversationId: "parent",
                trackerView: { open: true, view: "missions" } as never,
            }),
        ).toBeUndefined();
    });
});

describe("chatSidePane with the Tasks pane", () => {
    const conversations = [convo("parent", "Parent"), convo("child", "lint", "running", "parent")];
    const chatTasks = { open: true } as never;

    it("shows the Tasks pane beside the chat on screen", () => {
        expect(chatSidePane({ chatTasks, conversations, selectedConversationId: "parent" })).toEqual({
            kind: "tasks",
            convoId: "parent",
        });
    });

    it("lets a subagent win the slot, so both never show at once", () => {
        expect(
            chatSidePane({
                chatTasks,
                conversations,
                subChatPane: { parentId: "parent", childId: "child" },
                selectedConversationId: "parent",
            }),
        ).toEqual({ kind: "subchat", parentId: "parent", childId: "child" });
    });

    it("shows Tasks in another chat when the subagent pane belongs elsewhere", () => {
        expect(
            chatSidePane({
                chatTasks,
                conversations: [...conversations, convo("other", "Other")],
                subChatPane: { parentId: "parent", childId: "child" },
                selectedConversationId: "other",
            }),
        ).toEqual({ kind: "tasks", convoId: "other" });
    });

    it("shows nothing beside a subagent opened on its own, or beside the tracker", () => {
        expect(chatSidePane({ chatTasks, conversations, selectedConversationId: "child" })).toBeUndefined();
        expect(
            chatSidePane({
                chatTasks,
                conversations,
                selectedConversationId: "parent",
                trackerView: { open: true, view: "missions" } as never,
            }),
        ).toBeUndefined();
    });
});

describe("clampSidePaneWidth", () => {
    it("keeps the pane at least 380px and the chat at least 420px", () => {
        expect(clampSidePaneWidth(200, 1200)).toBe(380);
        expect(clampSidePaneWidth(500, 1200)).toBe(500);
        expect(clampSidePaneWidth(1000, 1200)).toBe(780);
        // Too little room for both minimums: the pane keeps its own.
        expect(clampSidePaneWidth(600, 700)).toBe(380);
    });
});
