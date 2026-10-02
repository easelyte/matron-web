/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { browserRestartNoticeSeqs, browserToolsState } from "../browser-tools";
import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import { resetShowTheWorkForTests } from "../show-the-work";
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

    it("marks only the restart notices that answer a browser request", () => {
        const events = [
            op("/restart"),
            ev("🔄 Restarting Claude session..."),
            ev(RESTARTED_OFF),
            op("/restart --browser"),
            ev("🔄 Restarting Claude session..."),
        ];
        expect([...browserRestartNoticeSeqs(events)]).toEqual([5]);
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
        resetShowTheWorkForTests();
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
        [...container.querySelectorAll<HTMLButtonElement>(".mj_RoomItemMenu_item")].find((node) =>
            /browser tools/i.test(node.textContent ?? ""),
        )!;

    it("opens the confirm (one primary, no Restart now while idle) and sends /restart --browser", async () => {
        const instance = client([op("hi")]);
        const send = jest.spyOn(instance, "sendMessage").mockResolvedValue(true);
        await act(async () => root.render(<MatronApp client={instance} />));
        await openMenu();
        expect(item().textContent).toBe("Enable browser tools");
        expect(item().querySelector(".mj_MenuHint")).toBeNull();
        await act(async () => item().click());
        const dialog = container.querySelector('[role="dialog"]')!;
        expect(dialog.textContent).toContain("Browser tools use about 400 MB of memory while on.");
        expect([...dialog.querySelectorAll(".mj_UploadConfirm_actions button")].map((b) => b.textContent)).toEqual([
            "Cancel",
            "Restart with browser tools",
        ]);
        expect(document.activeElement?.textContent).toBe("Restart with browser tools");
        await act(async () => dialog.querySelector<HTMLButtonElement>(".mj_UploadConfirm_send")!.click());
        expect(send).toHaveBeenCalledWith("/restart --browser", "c1");
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Conversation actions");
    });

    it("offers Restart now (the forced variant) while the agent is mid-task", async () => {
        const instance = client([op("hi")], { session_state: "running" });
        const send = jest.spyOn(instance, "sendMessage").mockResolvedValue(true);
        await act(async () => root.render(<MatronApp client={instance} />));
        await openMenu();
        await act(async () => item().click());
        const dialog = container.querySelector('[role="dialog"]')!;
        expect(dialog.querySelector(".mj_ConfirmBusy")?.textContent).toContain("The restart waits until it finishes.");
        await act(async () => dialog.querySelector<HTMLButtonElement>(".mj_UploadConfirm_skip")!.click());
        expect(send).toHaveBeenCalledWith("/restart --browser --force", "c1");
    });

    it("shows the queued chip and a disabled row with its reason", async () => {
        await act(async () =>
            root.render(<MatronApp client={client([op("/restart --browser")], { session_state: "running" })} />),
        );
        expect(container.querySelector(".mj_HeaderChip")?.textContent).toBe("Restarting after this step");
        await openMenu();
        expect(item().getAttribute("aria-disabled")).toBe("true");
        expect(item().querySelector(".mj_MenuHint")?.textContent).toBe("Restarting after this step");
    });

    it("shows 'Browser tools on' as a checked, disabled item, from the status frame's extras", async () => {
        await act(async () => root.render(<MatronApp client={client([op("hi")], {}, ["browser"])} />));
        await openMenu();
        expect(item().getAttribute("role")).toBe("menuitemcheckbox");
        expect(item().getAttribute("aria-checked")).toBe("true");
        expect(item().getAttribute("aria-disabled")).toBe("true");
        expect(item().textContent).toBe("Browser tools on");
    });

    it("stays on for a stopped session with no restart in its loaded events (offline / reconnect)", async () => {
        await act(async () => root.render(<MatronApp client={client([], { session_state: "done" }, ["browser"])} />));
        await openMenu();
        expect(item().textContent).toBe("Browser tools on");
    });

    it("does not turn on from a transcript notice while the status frame says no extras", async () => {
        await act(async () => root.render(<MatronApp client={client([op("/restart --browser"), ev(RESTARTED_ON)])} />));
        await openMenu();
        expect(item().textContent).toBe("Enable browser tools");
    });

    it("hides the row, never guesses, when the bridge reports no extras (older bridge)", async () => {
        await act(async () =>
            root.render(<MatronApp client={client([op("/restart --browser"), ev(RESTARTED_ON)], {}, null)} />),
        );
        await openMenu();
        expect(container.querySelector('[role="menu"], .mj_RoomItemMenu')).not.toBeNull();
        expect(item()).toBeUndefined();
    });

    it("keeps the row hidden on an older bridge even while a browser restart is pending", async () => {
        await act(async () =>
            root.render(<MatronApp client={client([op("/restart --browser")], { session_state: "running" }, null)} />),
        );
        // The transient chip still reflects the operator's own request...
        expect(container.querySelector(".mj_HeaderChip")?.textContent).toBe("Restarting after this step");
        await openMenu();
        // ...but the row never appears without the bridge's extras.
        expect(item()).toBeUndefined();
    });

    it("is unavailable for Codex sessions", async () => {
        await act(async () => root.render(<MatronApp client={client([op("hi")], { agent_kind: "codex" })} />));
        await openMenu();
        expect(item().getAttribute("aria-disabled")).toBe("true");
        expect(item().querySelector(".mj_MenuHint")?.textContent).toBe("Not available for Codex sessions");
    });

    it("words the restart notice for a browser restart", async () => {
        await act(async () =>
            root.render(
                <MatronApp client={client([op("/restart --browser"), ev("🔄 Restarting Claude session...")])} />,
            ),
        );
        expect(container.querySelector(".mj_SystemNotice")?.textContent).toBe("Restarting with browser tools…");
    });
});
