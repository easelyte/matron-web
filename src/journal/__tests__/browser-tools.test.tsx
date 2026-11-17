/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { browserRestartCommand, browserToolsState } from "../browser-tools";
import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seq = 0;
const ev = (body: string, sender = "agent:box"): JournalEvent => {
    seq += 1;
    return { seq, convo_id: "c1", ts: 1_790_000_000_000 + seq * 1000, sender, type: "text", payload: { body } };
};
const op = (body: string): JournalEvent => ev(body, "user:op");
const RESTARTED_ON = "Claude session restarted.\nSession: 1234abcd...\nWorkdir: /repo\nExtras: browser";
const RESTARTED_OFF = "Claude session restarted.\nSession: 1234abcd...\nWorkdir: /repo";

beforeEach(() => {
    seq = 0;
});

describe("browserToolsState (read from the bridge's replies)", () => {
    it("is unknown without extras (older bridge), idle with none, on when the spawn has browser", () => {
        expect(browserToolsState([], false, undefined)).toBe("unknown");
        expect(browserToolsState([], false, [])).toBe("idle");
        expect(browserToolsState([], false, ["share", "browser"])).toBe("on");
    });

    it("never reads on/off from the transcript: a restart notice listing the extra is not data", () => {
        const events = [op("/restart --browser"), ev("🔄 Restarting Claude session..."), ev(RESTARTED_ON)];
        expect(browserToolsState(events, false, [])).toBe("idle");
        expect(browserToolsState(events, false, undefined)).toBe("unknown");
        expect(browserToolsState(events, false, ["browser"])).toBe("on");
    });

    it("trusts the status frame over a stale pending request (windowed or reconnected transcript)", () => {
        expect(browserToolsState([op("/restart --browser")], true, ["browser"])).toBe("on");
    });

    it("walks queued → restarting → done, then reads on from the new status frame", () => {
        const events = [op("/restart --browser")];
        expect(browserToolsState(events, true, [])).toBe("queued");
        events.push(
            ev("Waiting for turn to finish before restarting. Send again with --force to restart immediately."),
        );
        expect(browserToolsState(events, true, [])).toBe("queued");
        events.push(ev("🔄 Restarting Claude session..."));
        expect(browserToolsState(events, false, [])).toBe("restarting");
        events.push(ev(RESTARTED_ON));
        expect(browserToolsState(events, false, [])).toBe("idle");
        expect(browserToolsState(events, false, ["browser"])).toBe("on");
    });

    it("reports a pending request's phase on an older bridge too (the queued chip)", () => {
        expect(browserToolsState([op("/restart --browser")], true, undefined)).toBe("queued");
    });

    it("reads an idle agent's request as restarting straight away", () => {
        expect(browserToolsState([op("/restart --browser")], false, [])).toBe("restarting");
    });

    it("goes back to idle on a refusal or a later restart without the extra", () => {
        expect(
            browserToolsState(
                [
                    op("/restart --browser"),
                    ev("--browser is a Claude-only session extra. Codex uses MCP servers from its own config."),
                ],
                false,
                [],
            ),
        ).toBe("idle");
        expect(
            browserToolsState(
                [op("/restart --browser"), ev(RESTARTED_ON), op("/restart --model sonnet"), ev(RESTARTED_OFF)],
                false,
                [],
            ),
        ).toBe("idle");
    });

    it("reads Restart now (--force) as restarting straight away, even mid-task", () => {
        expect(browserToolsState([op("/restart --browser --force")], true, [])).toBe("restarting");
    });

    it("drops a pending request the bridge abandoned", () => {
        expect(
            browserToolsState([op("/restart --browser"), ev("No active session. Use !start to begin.")], false, []),
        ).toBe("idle");
        expect(
            browserToolsState(
                [op("/restart --browser"), ev("Waiting for turn to finish before restarting."), ev("Session stopped.")],
                false,
                [],
            ),
        ).toBe("idle");
        // Waiting on a prompt reads 'waiting' too: a parked request stays queued until answered.
        expect(
            browserToolsState(
                [op("/restart --browser"), ev("Waiting for turn to finish before restarting.")],
                false,
                [],
            ),
        ).toBe("queued");
        expect(
            browserToolsState(
                [op("/restart --browser"), ev("🔄 Restarting Claude session..."), ev("Couldn't restart: spawn failed")],
                false,
                [],
            ),
        ).toBe("idle");
        expect(
            browserToolsState(
                [
                    op("/restart --browser"),
                    ev("Waiting for turn to finish before restarting."),
                    ev("Deferred /restart failed: boom"),
                ],
                true,
                [],
            ),
        ).toBe("idle");
    });

    it("keeps a queued request while the agent's own prose streams in", () => {
        expect(
            browserToolsState(
                [
                    op("/restart --browser"),
                    ev("Waiting for turn to finish before restarting."),
                    ev("Still reading files."),
                ],
                true,
                [],
            ),
        ).toBe("queued");
    });

    it("ignores other restarts' queue replies", () => {
        expect(browserToolsState([op("/restart"), ev("Waiting for turn to finish before restarting.")], true, [])).toBe(
            "idle",
        );
    });
});

describe("browserRestartCommand", () => {
    it("adds browser to the extras already on, skipping odd names", () => {
        expect(browserRestartCommand(undefined)).toBe("/restart --browser");
        expect(browserRestartCommand([])).toBe("/restart --browser");
        expect(browserRestartCommand(["circleci", "browser", "bad name", "--x"])).toBe("/restart --browser --circleci");
    });
});

describe("Enable browser tools in the session menu", () => {
    let container: HTMLDivElement;
    let root: Root;
    const SESSION: Session = {
        serverUrl: "https://journal.example",
        token: "t",
        deviceId: 1,
        userId: 2,
        username: "op",
    };

    // Default: a current bridge reporting no extras. Pass `null` for an older bridge (no extras).
    function client(
        events: JournalEvent[],
        conversation: Partial<Conversation> = {},
        extras: string[] | null = [],
    ): MatronJournalClient {
        const instance = new MatronJournalClient();
        (instance as unknown as { state: ClientState }).state = {
            ...instance.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: [
                {
                    id: "c1",
                    title: "One",
                    session_state: "idle",
                    last_seq: events.length,
                    unread_count: 0,
                    snippet: "",
                    created_at: 1,
                    read_up_to_seq: events.length,
                    ...conversation,
                },
            ],
            selectedConversationId: "c1",
            sessionStatus: extras === null ? { model: "claude-fable-5" } : { model: "claude-fable-5", extras },
            events,
            pendingMessages: [],
            connection: "online",
            archivedIds: archiveStore.read(SESSION).ids,
            pinnedIds: pinnedStore.read(SESSION).ids,
            favoriteIds: favoriteStore.read(SESSION).ids,
            unreadOverrideIds: unreadStore.read(SESSION).ids,
        };
        return instance;
    }

    beforeEach(() => {
        localStorage.clear();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const openMenu = async (): Promise<void> => {
        await act(async () =>
            container.querySelector<HTMLButtonElement>('button[aria-label="Conversation actions"]')!.click(),
        );
    };
    const item = (): HTMLButtonElement =>
        [...container.querySelectorAll<HTMLButtonElement>(".mj_ConversationMenu_item")].find((node) =>
            /browser tools/i.test(node.textContent ?? ""),
        )!;

    it("sends /restart --browser from the row and closes the menu", async () => {
        const instance = client([op("hi")]);
        const send = jest.spyOn(instance, "sendMessage").mockResolvedValue(true);
        await act(async () => root.render(<MatronApp client={instance} />));
        await openMenu();
        expect(item().textContent).toBe("Enable browser tools");
        await act(async () => item().click());
        expect(send).toHaveBeenCalledWith("/restart --browser", "c1");
        expect(container.querySelector(".mj_ConversationMenu")).toBeNull();
    });

    it("keeps the session's other opt-in extras when it adds browser tools", async () => {
        const instance = client([op("hi")], {}, ["circleci", "share"]);
        const send = jest.spyOn(instance, "sendMessage").mockResolvedValue(true);
        await act(async () => root.render(<MatronApp client={instance} />));
        await openMenu();
        await act(async () => item().click());
        expect(send).toHaveBeenCalledWith("/restart --browser --circleci --share", "c1");
    });

    it("disables the row while the restart is queued or under way", async () => {
        const instance = client([op("/restart --browser")], { session_state: "running" });
        const send = jest.spyOn(instance, "sendMessage").mockResolvedValue(true);
        await act(async () => root.render(<MatronApp client={instance} />));
        await openMenu();
        expect(item().getAttribute("aria-disabled")).toBe("true");
        expect(item().textContent).toBe("Browser tools: restarting after this step");
        await act(async () => item().click());
        expect(send).not.toHaveBeenCalled();
    });

    it("hides the row once browser tools are on, from the status frame's extras", async () => {
        await act(async () => root.render(<MatronApp client={client([op("hi")], {}, ["browser"])} />));
        await openMenu();
        expect(item()).toBeUndefined();
    });

    it("does not treat a transcript notice as on while the status frame says no extras", async () => {
        await act(async () => root.render(<MatronApp client={client([op("/restart --browser"), ev(RESTARTED_ON)])} />));
        await openMenu();
        expect(item().textContent).toBe("Enable browser tools");
    });

    it("hides the row, never guesses, when the bridge reports no extras (older bridge)", async () => {
        await act(async () =>
            root.render(<MatronApp client={client([op("/restart --browser"), ev(RESTARTED_ON)], {}, null)} />),
        );
        await openMenu();
        expect(container.querySelector(".mj_ConversationMenu")).not.toBeNull();
        expect(item()).toBeUndefined();
    });
});
