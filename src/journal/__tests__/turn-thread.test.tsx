/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Redesign v6 thread assembly with Show the work OFF (the default): one agent tile per operator
 * turn with a collapsed turn card, break-throughs after it, system notices as one quiet line.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import { TurnCard, type TurnCardMode } from "../turn-card";
import type { Step } from "../turn-grouping";
import { resetShowTheWorkForTests, SHOW_THE_WORK_KEY, writeShowTheWork } from "../show-the-work";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: Session = { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 2, username: "op" };
const T0 = 1_790_000_000_000;

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, sender = "agent:box", sec?: number): JournalEvent {
    seq += 1;
    return { seq, convo_id: "c1", ts: T0 + (sec ?? seq) * 1000, sender, type, payload };
}
const user = (body: string, sec?: number): JournalEvent => ev("text", { body }, "user:op", sec);
const say = (body: string, sec?: number): JournalEvent => ev("text", { body, from: "assistant" }, "agent:box", sec);
const cmd = (command: string, exit_code: number | null = 0, sec?: number): JournalEvent =>
    ev("tool_output", { command, exit_code, snippet: `ran ${command}` }, "agent:box", sec);

function client(
    events: JournalEvent[],
    overrides: Partial<ClientState> = {},
    sessionState = "idle",
): MatronJournalClient {
    const conversation: Conversation = {
        id: "c1",
        title: "One",
        session_state: sessionState,
        last_seq: events.length,
        unread_count: 0,
        snippet: "",
        created_at: 1,
        read_up_to_seq: events.length,
    };
    const instance = new MatronJournalClient();
    (instance as unknown as { state: ClientState }).state = {
        ...instance.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [conversation],
        selectedConversationId: "c1",
        events,
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
        ...overrides,
    };
    return instance;
}

let container: HTMLDivElement;
let root: Root;

async function render(instance: MatronJournalClient): Promise<void> {
    await act(async () => root.render(<MatronApp client={instance} />));
}

const card = (): HTMLElement | null => container.querySelector(".mj_TurnCard");
const toggle = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>(".mj_TurnCard_toggle")!;
const click = async (element: Element | null | undefined): Promise<void> => {
    if (!element) throw new Error("missing element");
    await act(async () => (element as HTMLElement).click());
};

beforeEach(() => {
    seq = 0;
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

function sheetTurn(): JournalEvent[] {
    return [
        user("why is the sheet cryptic?", 0),
        say("Let me read the sheet component first.", 2),
        cmd("cat src/journal/components.tsx", 0, 3),
        cmd("rg -n startSessionRpc src", 0, 4),
        cmd("pnpm tsc --noEmit", 2, 5),
        cmd("pnpm tsc --noEmit", 0, 6),
        say("The labels sit too close to the wrong field.", 192),
    ];
}

describe("Show the work OFF (default)", () => {
    it("renders one collapsed card per turn with the done meta, then the answer prose", async () => {
        await render(client(sheetTurn()));
        expect(card()).not.toBeNull();
        expect(toggle().getAttribute("aria-expanded")).toBe("false");
        // No visible title (operator decision 2026-09-26): the summary is the label, and the
        // toggle keeps an accessible name of its own plus the status as its description.
        expect(toggle().textContent).not.toContain("Under the hood");
        expect(toggle().getAttribute("aria-label")).toBe("Show steps");
        const describedBy = toggle().getAttribute("aria-describedby");
        expect(describedBy && document.getElementById(describedBy)?.textContent).toContain("4 steps");
        expect(container.querySelector(".mj_TurnCard_metaVisible")?.textContent).toBe("4 steps·3m 12s");
        expect(toggle().querySelector(".mj_TurnCard_chevron")).not.toBeNull();
        // The step cards are tucked away; the answer and the operator bubble read as a chat.
        expect(container.querySelector(".mj_ToolCard")).toBeNull();
        expect(container.textContent).toContain("The labels sit too close to the wrong field.");
        expect(container.querySelector('[data-self="true"]')?.textContent).toContain("why is the sheet cryptic?");
        // A step failed along the way → amber dot instead of the check.
        expect(card()?.querySelector(".mj_TurnCard_glyph .mj_TurnCard_dot_warn")).not.toBeNull();
    });

    it("expands to narration + groups, opens a group, and deep detail opens in place with Back", async () => {
        await render(client(sheetTurn()));
        await click(toggle());
        const rows = [...container.querySelectorAll(".mj_TurnCard_groupRow")].map(
            (row) => row.querySelector(".mj_TurnCard_sentence")?.textContent,
        );
        expect(rows).toEqual([
            "Read components.tsx",
            "Searched the code",
            "Checked the types: failed once, then passed",
        ]);
        expect(container.querySelector(".mj_TurnCard_narration")?.textContent).toBe(
            "Let me read the sheet component first.",
        );

        await click(container.querySelectorAll(".mj_TurnCard_groupRow")[2]);
        const steps = [...container.querySelectorAll(".mj_TurnCard_step .mj_TurnCard_name")].map((s) => s.textContent);
        expect(steps).toEqual(["Checked the types", "Checked the types again"]);

        const failedStep = container.querySelectorAll<HTMLButtonElement>(".mj_TurnCard_step")[0];
        await click(failedStep);
        const deep = container.querySelector(".mj_TurnCard_deep");
        expect(deep?.querySelector(".mj_TurnCard_back")?.textContent).toBe("Back to steps");
        // The failed command AND its passing rerun, both as open tool cards (mono lives here only).
        const tools = deep?.querySelectorAll("details.mj_ToolCard") ?? [];
        expect(tools).toHaveLength(2);
        expect((tools[0] as HTMLDetailsElement).open).toBe(true);
        expect(tools[0].textContent).toContain("exit 2");

        // Escape closes the deep layer, returns focus to its row, and never collapses the card.
        await act(async () => {
            deep!.querySelector<HTMLButtonElement>(".mj_TurnCard_back")!.focus();
            deep!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(container.querySelector(".mj_TurnCard_deep")).toBeNull();
        expect(toggle().getAttribute("aria-expanded")).toBe("true");
        expect(toggle().getAttribute("aria-label")).toBe("Hide steps");
        expect(document.activeElement).toBe(container.querySelectorAll(".mj_TurnCard_step")[0]);
    });

    it("gives a turn with no steps no card at all", async () => {
        await render(client([user("hi", 0), say("Hello.", 1)]));
        expect(card()).toBeNull();
        expect(container.textContent).toContain("Hello.");
    });

    it("turns bridge notices into quiet lines and a turn-ending error into an alert row", async () => {
        await render(
            client([
                user("tests are failing", 0),
                cmd("pnpm vitest run", 1, 1),
                say("The session couldn’t resume. Send a message to start fresh.", 2),
                say("✅ Compacted — context now 3.7k/1m", 3),
            ]),
        );
        const error = container.querySelector(".mj_TurnError");
        expect(error?.getAttribute("role")).toBe("alert");
        expect(error?.textContent).toBe("The session couldn’t resume. Send a message to start fresh.");
        const notice = container.querySelector(".mj_SystemNotice");
        expect(notice?.textContent).toBe("Compacted — context now 3.7k/1m");
        expect(notice?.querySelector(".mj_MsgAvatar")).toBeNull();
        // The failing run still reads as a failed group, in red, not recovered.
        await click(toggle());
        expect(container.querySelector(".mj_TurnCard_group_failed")).not.toBeNull();
    });

    it("keeps break-throughs after the card in the order they happened", async () => {
        await render(
            client([
                user("ship it", 0),
                cmd("pnpm vitest run", 0, 1),
                ev("prompt", { question: "Open a PR as well?", options: ["Open PR", "Not yet"] }, "agent:box", 2),
                say("Done.", 3),
            ]),
        );
        const blocks = [...container.querySelectorAll(".mj_AgentTurn_blocks > *")].map((node) =>
            node.classList.contains("mj_TurnCard") ? "card" : node.querySelector(".mj_PromptCard") ? "prompt" : "text",
        );
        expect(blocks).toEqual(["card", "prompt", "text"]);
    });

    it("shows the running step as the live line, without the live tool card or typing indicator", async () => {
        const events = [user("run the tests", 0), cmd("cat package.json", 0, 1)];
        await render(
            client(
                events,
                {
                    toolStreams: {
                        live: {
                            messageRef: "live",
                            command: "pnpm vitest run",
                            tool: "Bash",
                            content: "",
                            offset: 0,
                            headTruncated: false,
                        },
                    },
                    activity: { state: "tool", detail: "pnpm vitest run" },
                },
                "running",
            ),
        );
        expect(card()?.classList.contains("mj_TurnCard_running")).toBe(true);
        expect(container.querySelector(".mj_TurnCard_liveText")?.textContent).toBe("Running the tests…");
        expect(container.querySelector(".mj_TurnCard_glyph .mj_TurnCard_spinner")).not.toBeNull();
        expect(container.querySelector(".mj_TurnCard .mj_LiveDot")).toBeNull();
        expect(container.querySelector(".mj_TurnCard_metaVisible")?.textContent).toBe("Running the tests…");
        expect(container.querySelector(".mj_LiveTool")).toBeNull();
        expect(container.querySelector(".mj_Activity")).toBeNull();
        expect(container.querySelector('.mj_TurnCard_statusRegion[role="status"]')?.textContent).toContain(
            "Working: Running the tests…",
        );
    });

    it("shows the card for a turn whose first step is still running (nothing journaled yet)", async () => {
        const stream = {
            messageRef: "s",
            command: "pnpm test",
            tool: "Bash",
            content: "",
            offset: 0,
            headTruncated: false,
        };
        await render(client([user("run the tests", 0)], { toolStreams: { s: stream } }, "running"));
        expect(card()?.classList.contains("mj_TurnCard_running")).toBe(true);
        expect(container.querySelector(".mj_TurnCard_liveText")?.textContent).toBe("Running the tests…");
    });

    it("never files agent prose that happens to start with an emoji as a notice", async () => {
        await render(client([user("status?", 0), say("⚡ Quick summary: all green.\n\n- tests pass", 1)]));
        expect(container.querySelector(".mj_SystemNotice")).toBeNull();
        expect(container.textContent).toContain("tests pass");
    });

    it("keeps the typing indicator while a running turn has no card yet", async () => {
        await render(client([user("hi", 0)], { activity: { state: "thinking" } }, "running"));
        expect(card()).toBeNull();
        expect(container.querySelector(".mj_Activity")).not.toBeNull();
    });

    it("reads 'Waiting for you' while a permission request in the turn is unanswered", async () => {
        await render(
            client(
                [
                    user("push it", 0),
                    cmd("git commit -m x", 0, 1),
                    ev("permission_request", { question: "Allow: push?", options: ["Allow", "Deny"] }, "agent:box", 2),
                ],
                {},
                "running",
            ),
        );
        expect(card()?.classList.contains("mj_TurnCard_waiting")).toBe(true);
        expect(container.querySelector(".mj_TurnCard_liveText")?.textContent).toBe("Waiting for you");
    });

    it("hides a picked prompt reply (the card shows it) and keeps later steps in the same card", async () => {
        const question = { question: "Open a PR as well?", options: ["Open PR", "Not yet"] };
        const events = [user("ship it", 0), cmd("pnpm vitest run", 0, 1)];
        events.push(ev("prompt", question, "agent:box", 2));
        events.push(ev("prompt_reply", { target_seq: events[2].seq, choice: "Open PR" }, "user:op", 3));
        events.push(cmd("gh pr create --fill", 0, 4));
        await render(client(events));
        expect(container.querySelectorAll(".mj_TurnCard")).toHaveLength(1);
        expect(container.querySelector(".mj_TurnCard_metaVisible")?.textContent).toContain("2 steps");
        expect(container.querySelectorAll('[data-self="true"]')).toHaveLength(1);
    });

    it("renders today's per-event thread when Show the work is ON, and switches back instantly", async () => {
        localStorage.setItem(SHOW_THE_WORK_KEY, "true");
        await render(client(sheetTurn()));
        expect(card()).toBeNull();
        expect(container.querySelectorAll("details.mj_ToolCard")).toHaveLength(4);
        await act(async () => writeShowTheWork(false));
        expect(card()).not.toBeNull();
        expect(container.querySelectorAll("details.mj_ToolCard")).toHaveLength(0);
    });

    it("keeps the row menu on answer prose inside the tile", async () => {
        await render(client(sheetTurn()));
        const answer = container.querySelector<HTMLElement>('.mj_TurnBlock[data-event-id="7"]');
        expect(answer).not.toBeNull();
        await act(async () => {
            answer!.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
            );
        });
        const items = [...container.querySelectorAll('.mj_EventRowMenu [role="menuitem"]')].map(
            (item) => item.textContent,
        );
        expect(items).toContain("Copy");
    });
});

describe("TurnCard resolve state", () => {
    const done: Step = { kind: "step", id: "a", tool: "Bash", input: { command: "ls" }, status: "ok", exit: 0 };
    const live: Step = {
        kind: "step",
        id: "b",
        tool: "Bash",
        input: { command: "pnpm vitest run" },
        status: "running",
    };
    const renderCard = async (mode: TurnCardMode): Promise<void> => {
        await act(async () =>
            root.render(
                <TurnCard
                    turnKey="t"
                    items={[done]}
                    mode={mode}
                    running={mode === "running" ? live : null}
                    durationMs={1000}
                    renderDetail={() => null}
                />,
            ),
        );
    };

    it("drops the resolve fade when work resumes after waiting, so the spinner keeps turning", async () => {
        await renderCard("running");
        expect(card()?.classList.contains("is-resolved")).toBe(false);
        await renderCard("waiting");
        expect(card()?.classList.contains("is-resolved")).toBe(true);
        await renderCard("running");
        expect(card()?.classList.contains("is-resolved")).toBe(false);
        expect(card()?.querySelector(".mj_TurnCard_glyph .mj_TurnCard_spinner")).not.toBeNull();
        await renderCard("done");
        expect(card()?.classList.contains("is-resolved")).toBe(true);
    });
});
