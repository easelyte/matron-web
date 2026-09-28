/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Helper thread opens expanded (operator decision 2026-09-28): inside a subagent's or a Codex
 * run's own thread, with Developer view off, the newest turns show their headlines with the
 * multi-step ones open. The parent thread's turn cards and helper cards stay collapsed, and a
 * user's own open / close sticks.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { EXPANDED_HELPER_TURNS, MatronApp } from "../components";
import {
    EXPANDED_GROUPS_OPEN,
    EXPANDED_HEADLINES_SHOWN,
    HEADLINE_STEP_CAP,
    HeadlineList,
    resetRememberedToggles,
} from "../headline-list";
import { resetShowTheWorkForTests, SHOW_THE_WORK_KEY } from "../show-the-work";
import type { Step, TurnItem } from "../turn-grouping";
import type { ClientState, Conversation, JournalEvent, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: Session = { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 2, username: "op" };
const T0 = 1_790_000_000_000;

let stepSeq = 0;
const read = (path: string): Step => ({
    kind: "step",
    id: `e${++stepSeq}`,
    tool: "Read",
    input: { path },
    status: "ok",
});
const bash = (command: string): Step => ({
    kind: "step",
    id: `e${++stepSeq}`,
    tool: "Bash",
    input: { command },
    status: "ok",
});

/** `groups` multi-step headlines (two reads each), separated by a single command. */
function groupedItems(groups: number, readsPerGroup = 2): TurnItem[] {
    const items: TurnItem[] = [];
    for (let g = 0; g < groups; g += 1) {
        for (let r = 0; r < readsPerGroup; r += 1) items.push(read(`/r/g${g}/file${r}.ts`));
        items.push(bash(`git status --short # ${g}`));
    }
    return items;
}

const groupRows = (container: HTMLElement): HTMLButtonElement[] =>
    [...container.querySelectorAll<HTMLButtonElement>(".mj_Headline_row")].filter((row) =>
        /\d+ steps/.test(row.querySelector(".mj_TurnCard_count")?.textContent ?? ""),
    );

describe("HeadlineList expanded", () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        resetRememberedToggles();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        resetRememberedToggles();
    });

    const render = async (items: TurnItem[], extra: Partial<React.ComponentProps<typeof HeadlineList>> = {}) =>
        act(async () =>
            root.render(
                <HeadlineList items={items} active={false} renderDetail={() => <div>detail</div>} {...extra} />,
            ),
        );

    it("compact (the default) keeps multi-step headlines closed and lists the last 8", async () => {
        await render(groupedItems(6));
        const rows = groupRows(container);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelector(".mj_Headlines_more")?.textContent).toBe("Show all 12");
    });

    it("expanded opens the multi-step headlines onto their steps and lists every headline", async () => {
        await render(groupedItems(6), { expanded: true });
        const rows = groupRows(container);
        expect(rows).toHaveLength(6);
        for (const row of rows) expect(row.getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelectorAll(".mj_TurnCard_steps .mj_TurnCard_step")).toHaveLength(12);
        expect(container.querySelector(".mj_Headlines_more")).toBeNull();
    });

    it("bounds the DOM: only the newest groups open, the list and each group are capped", async () => {
        const groups = EXPANDED_HEADLINES_SHOWN; // 2 headlines per group → half are listed
        await render(groupedItems(groups, HEADLINE_STEP_CAP + 5), { expanded: true });
        const open = groupRows(container).filter((row) => row.getAttribute("aria-expanded") === "true");
        expect(open).toHaveLength(EXPANDED_GROUPS_OPEN);
        // The open ones are the newest: the last listed group is open, the first is not.
        const rows = groupRows(container);
        expect(rows.at(-1)?.getAttribute("aria-expanded")).toBe("true");
        expect(rows[0].getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelectorAll(".mj_Headline_row")).toHaveLength(EXPANDED_HEADLINES_SHOWN);
        expect(container.querySelector(".mj_Headlines_more")?.textContent).toBe(`Show all ${groups * 2}`);
        expect(container.querySelectorAll(".mj_TurnCard_steps .mj_TurnCard_step")).toHaveLength(
            EXPANDED_GROUPS_OPEN * HEADLINE_STEP_CAP,
        );
        // "Show all {k}" inside a group lists the rest of its steps.
        const more = [...container.querySelectorAll<HTMLButtonElement>(".mj_TurnCard_steps .mj_TurnCard_more")];
        expect(more).toHaveLength(EXPANDED_GROUPS_OPEN);
        expect(more[0].textContent).toBe(`Show all ${HEADLINE_STEP_CAP + 5}`);
        await act(async () => more[0].click());
        expect(container.querySelectorAll(".mj_TurnCard_steps .mj_TurnCard_step")).toHaveLength(
            EXPANDED_GROUPS_OPEN * HEADLINE_STEP_CAP + 5,
        );
    });

    it("a user's collapse sticks through a re-render with new steps and a remount", async () => {
        const items = groupedItems(3);
        await render(items, { expanded: true, persistKey: "c:1" });
        const firstId = () => groupRows(container)[0];
        await act(async () => firstId().click());
        expect(firstId().getAttribute("aria-expanded")).toBe("false");

        // New work arrives: the collapsed group stays collapsed, the new one opens.
        await render([...items, ...groupedItems(1)], { expanded: true, persistKey: "c:1" });
        expect(firstId().getAttribute("aria-expanded")).toBe("false");
        expect(groupRows(container).at(-1)?.getAttribute("aria-expanded")).toBe("true");

        // Remount (a conversation switch and back): still the user's choice.
        await act(async () => root.unmount());
        root = createRoot(container);
        await render([...items, ...groupedItems(1)], { expanded: true, persistKey: "c:1" });
        expect(firstId().getAttribute("aria-expanded")).toBe("false");
    });

    it("a running group stays capped, its newest steps and the running one in view", async () => {
        const items: TurnItem[] = Array.from({ length: HEADLINE_STEP_CAP * 3 }, (_, i) => read(`/r/live/f${i}.ts`));
        const running = { ...read("/r/live/now.ts"), status: "running" as const };
        await render(items, { expanded: true, active: true, running });
        const steps = [...container.querySelectorAll(".mj_TurnCard_steps .mj_TurnCard_step")];
        expect(steps).toHaveLength(HEADLINE_STEP_CAP);
        expect(steps.at(-1)?.textContent).toContain("now");
        const more = container.querySelector<HTMLButtonElement>(".mj_TurnCard_steps .mj_TurnCard_more");
        expect(more?.textContent).toBe(`Show all ${HEADLINE_STEP_CAP * 3 + 1}`);
        await act(async () => more!.click());
        expect(container.querySelectorAll(".mj_TurnCard_steps .mj_TurnCard_step")).toHaveLength(
            HEADLINE_STEP_CAP * 3 + 1,
        );
    });

    it("a remembered choice survives the turn's key changing (older history loaded)", async () => {
        const items = groupedItems(2);
        await render(items, { expanded: true, persistKey: "c:3", turnKey: "10" });
        await act(async () => groupRows(container)[0].click());
        expect(groupRows(container)[0].getAttribute("aria-expanded")).toBe("false");
        await act(async () => root.unmount());
        root = createRoot(container);
        await render(items, { expanded: true, persistKey: "c:3", turnKey: "4" });
        expect(groupRows(container)[0].getAttribute("aria-expanded")).toBe("false");
        // Another conversation does not inherit it.
        await act(async () => root.unmount());
        root = createRoot(container);
        await render(items, { expanded: true, persistKey: "c:other", turnKey: "4" });
        expect(groupRows(container)[0].getAttribute("aria-expanded")).toBe("true");
    });

    it("a remembered choice survives older steps joining the group (a history page prepended)", async () => {
        const later = [read("/r/p/b.ts"), read("/r/p/c.ts"), bash("git status --short")];
        const earlier = read("/r/p/a.ts");
        await render(later, { expanded: true, persistKey: "c:4", turnKey: "20" });
        expect(groupRows(container)).toHaveLength(1);
        await act(async () => groupRows(container)[0].click());
        await act(async () => root.unmount());
        root = createRoot(container);
        await render([earlier, ...later], { expanded: true, persistKey: "c:4", turnKey: "19" });
        const [row] = groupRows(container);
        expect(row.querySelector(".mj_TurnCard_count")?.textContent).toBe("3 steps");
        expect(row.getAttribute("aria-expanded")).toBe("false");
    });

    it("a user's open sticks after the group leaves the newest window", async () => {
        const items = groupedItems(2);
        await render(items, { persistKey: "c:2" });
        await act(async () => groupRows(container)[0].click());
        expect(groupRows(container)[0].getAttribute("aria-expanded")).toBe("true");
        await render([...items, ...groupedItems(EXPANDED_GROUPS_OPEN + 2)], { expanded: true, persistKey: "c:2" });
        expect(groupRows(container)[0].getAttribute("aria-expanded")).toBe("true");
        expect(groupRows(container)[2].getAttribute("aria-expanded")).toBe("false");
    });
});

describe("helper thread in the app (Developer view off)", () => {
    let container: HTMLDivElement;
    let root: Root;
    let seq = 0;

    const ev = (convo: string, type: string, payload: Record<string, unknown>, sender: string, sec: number) => {
        seq += 1;
        return { seq, convo_id: convo, ts: T0 + sec * 1000, sender, type, payload } as JournalEvent;
    };
    const say = (convo: string, body: string, sec: number) =>
        ev(convo, "text", { body, from: "assistant" }, "agent:box", sec);
    const op = (convo: string, body: string, sec: number) => ev(convo, "text", { body }, "user:op", sec);

    function convo(id: string, extra: Partial<Conversation> = {}): Conversation {
        return {
            id,
            title: id,
            session_state: "done",
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

    /** One helper turn: two reads (a multi-step headline), a command, then an answer. */
    const helperTurn = (id: string, n: number, sec: number): JournalEvent[] => [
        ...(n > 0 ? [op(id, `Continue ${n}`, sec)] : []),
        say(id, `📖 /r/src/a${n}.ts`, sec + 1),
        say(id, `📖 /r/src/b${n}.ts`, sec + 2),
        say(id, "🔧 `git status --short`", sec + 3),
        say(id, `Done with part ${n}.`, sec + 4),
    ];

    beforeEach(() => {
        localStorage.clear();
        resetShowTheWorkForTests();
        resetRememberedToggles();
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

    function setup(selected: "parent" | "child", turns = EXPANDED_HELPER_TURNS + 1): MatronJournalClient {
        seq = 100;
        const child = convo("p:sub:a", { title: "Wave 2: units", parent_convo_id: "p", created_at: T0 + 3_000 });
        const parentEvents = [
            op("p", "go", 0),
            say("p", "📖 /r/README.md", 1),
            say("p", "📖 /r/CLAUDE.md", 2),
            say("p", "🔀 Subtask: Wave 2: units", 3),
            say("p", "Started the helper.", 4),
        ];
        const childEvents: JournalEvent[] = [];
        for (let n = 0; n < turns; n += 1) childEvents.push(...helperTurn(child.id, n, 10 + n * 10));
        const instance = new MatronJournalClient();
        (instance as unknown as { state: ClientState }).state = {
            ...instance.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            conversations: [convo("p", { title: "Parent", created_at: T0 - 1000 }), child],
            selectedConversationId: selected === "parent" ? "p" : child.id,
            events: selected === "parent" ? parentEvents : childEvents,
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

    it("opens the newest turns' grouped steps; older turns keep the compact list", async () => {
        const client = setup("child");
        await act(async () => root.render(<MatronApp client={client} />));
        const lists = [...container.querySelectorAll(".mj_AgentTurn_helper .mj_Headlines")];
        expect(lists).toHaveLength(EXPANDED_HELPER_TURNS + 1);
        const state = lists.map((list) => groupRows(list as HTMLElement)[0]?.getAttribute("aria-expanded"));
        expect(state[0]).toBe("false");
        for (const value of state.slice(1)) expect(value).toBe("true");
        // Open groups read as plain-English steps, never the command line.
        expect(lists.at(-1)?.querySelectorAll(".mj_TurnCard_steps .mj_TurnCard_step")).toHaveLength(2);
        expect(container.querySelector(".mj_AgentTurn_helper section.mj_TurnCard")).toBeNull();
    });

    it("the parent thread is unchanged: its turn card and helper card start collapsed", async () => {
        const client = setup("parent");
        await act(async () => root.render(<MatronApp client={client} />));
        const toggle = container.querySelector(".mj_AgentTurn .mj_TurnCard_toggle");
        expect(toggle?.getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelector(".mj_TurnCard.is-open:not(.mj_TurnCard_embedded)")).toBeNull();
        const card = container.querySelector(".mj_SubagentCard");
        expect(card).not.toBeNull();
        expect(card?.querySelector(".mj_TurnCard_embedded")).toBeNull();
        expect(container.querySelector(".mj_Headlines")).toBeNull();
    });

    it("Developer view on keeps today's flat timeline in the helper thread", async () => {
        localStorage.setItem(SHOW_THE_WORK_KEY, "true");
        const client = setup("child");
        await act(async () => root.render(<MatronApp client={client} />));
        expect(container.querySelector(".mj_Headlines")).toBeNull();
        expect(container.textContent).toContain("git status --short");
    });
});
