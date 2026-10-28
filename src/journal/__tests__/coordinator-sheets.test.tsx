/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import type { ClientState, Conversation, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = { serverUrl: "https://chat.example", token: "t", deviceId: 85, userId: 2, username: "alice" };

const convo = (id: string, title: string, over: Partial<Conversation> = {}): Conversation => ({
    id,
    title,
    session_state: "idle",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 1,
    ...over,
});

const CONVERSATIONS = [convo("c1", "Release notes"), convo("c_coord", "Coordinator desk", { unread_count: 2 })];

type ApiMock = Record<string, jest.Mock>;

function signedInClient(api: ApiMock, over: Partial<ClientState> = {}): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = client as unknown as { state: ClientState; api: ApiMock };
    internals.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: CONVERSATIONS,
        selectedConversationId: "c1",
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: new Set(),
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
        ...over,
    };
    internals.api = api;
    return client;
}

function routineRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "rt_1",
        name: "daily-sweep",
        title: "Daily sweep",
        schedule: "5 7 * * *",
        trigger: null,
        tz: "Europe/London",
        prompt: "Run the daily sweep.",
        enabled: true,
        origin: "seed",
        next_at: null,
        last_fired_at: null,
        last_outcome: null,
        created_at: 1,
        updated_at: 2,
        ...over,
    };
}

describe("Coordinator rail entry, chooser and Routines sheet", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
        });
    });

    beforeEach(() => {
        localStorage.clear();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    async function render(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
    }

    const railCoordinator = (): HTMLButtonElement =>
        container.querySelector<HTMLButtonElement>('[data-testid="nav-rail"] button[data-nav="coordinator"]')!;
    const chooser = (): HTMLElement | null => document.querySelector('[data-testid="coordinator-chooser"]');
    const routinesSheet = (): HTMLElement | null => document.querySelector('[data-testid="routines-sheet"]');
    const settingsSheet = (): HTMLElement | null => document.querySelector(".mj_SettingsSheet");
    const button = (scope: ParentNode, text: string): HTMLButtonElement =>
        [...scope.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text)!;

    it("badges the Coordinator entry with its conversation's unread count and opens it", async () => {
        const client = signedInClient(
            { coordinator: jest.fn().mockResolvedValue({ convo_id: "c_coord", consent: true }) },
            { coordinatorConvoId: "c_coord" },
        );
        const select = jest.spyOn(client, "selectConversation").mockImplementation(async (id: string) => {
            (client as unknown as { patch(update: Partial<ClientState>): void }).patch({ selectedConversationId: id });
        });
        await render(client);
        expect(railCoordinator().getAttribute("aria-label")).toBe("Coordinator, 2 unread");
        expect(railCoordinator().getAttribute("aria-current")).toBeNull();

        await act(async () => railCoordinator().click());
        expect(select).toHaveBeenCalledWith("c_coord", { suppressNotFound: true });
        expect(railCoordinator().getAttribute("aria-current")).toBe("page");
        // The Coordinator's conversation sits under Conversations, but its own entry is the current one.
        expect(container.querySelector('button[data-nav="conversations"]')!.getAttribute("aria-current")).toBeNull();
    });

    it("offers the chooser when there is no Coordinator, and stores the pick", async () => {
        const putCoordinator = jest.fn().mockResolvedValue({ convo_id: "c1", consent: true });
        const client = signedInClient(
            { coordinator: jest.fn().mockResolvedValue({ convo_id: null, consent: true }), putCoordinator },
            { coordinatorConvoId: null },
        );
        await render(client);
        await act(async () => railCoordinator().click());
        expect(chooser()).not.toBeNull();
        expect(chooser()!.textContent).toContain("New coordinator chat…");

        const search = chooser()!.querySelector<HTMLInputElement>("input")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(search, "release");
            search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const rows = [...chooser()!.querySelectorAll<HTMLButtonElement>("button[data-convo]")];
        expect(rows.map((row) => row.dataset.convo)).toEqual(["c1"]);

        await act(async () => rows[0].click());
        expect(putCoordinator).toHaveBeenCalledWith("c1");
        expect(client.getSnapshot().coordinatorConvoId).toBe("c1");
        expect(chooser()).toBeNull();
    });

    it("goes back to the chooser when the new coordinator chat is closed", async () => {
        const client = signedInClient(
            { coordinator: jest.fn().mockResolvedValue({ convo_id: null, consent: true }) },
            { coordinatorConvoId: null },
        );
        jest.spyOn(client, "listAgents").mockResolvedValue([]);
        await render(client);
        await act(async () => railCoordinator().click());
        await act(async () => button(chooser()!, "New coordinator chat…").click());
        expect(chooser()).toBeNull();
        const title = document.querySelector("#mj-new-session-title");
        expect(title?.textContent).toBe("New coordinator chat");
        await act(async () =>
            title!
                .closest(".mj_NewSessionSheet")!
                .querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
                .click(),
        );
        expect(document.querySelector("#mj-new-session-title")).toBeNull();
        expect(chooser()).not.toBeNull();
    });

    it("keeps the chooser away while a new coordinator chat becomes the Coordinator", async () => {
        let answer!: (value: unknown) => void;
        const putCoordinator = jest.fn().mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const client = signedInClient(
            { coordinator: jest.fn().mockResolvedValue({ convo_id: null, consent: true }), putCoordinator },
            { coordinatorConvoId: null },
        );
        jest.spyOn(client, "listAgents").mockResolvedValue([
            { device_id: 10, kind: "agent", name: "box-a", connected: true, is_self: false },
        ]);
        jest.spyOn(client, "newSessionOffer").mockResolvedValue({
            folders: [],
            agentOptions: [],
            defaultAgent: null,
            modelOptions: [],
            defaultModel: null,
            effortOptions: [],
            defaultEffort: null,
        });
        jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "created", convoId: "c_new" });
        jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        await render(client);
        await act(async () => railCoordinator().click());
        await act(async () => button(chooser()!, "New coordinator chat…").click());
        const sheet = document
            .querySelector<HTMLElement>("#mj-new-session-title")!
            .closest<HTMLElement>(".mj_NewSessionSheet")!;
        expect(sheet.contains(document.activeElement)).toBe(true);
        await act(async () => button(sheet, "Start").click());
        expect(putCoordinator).toHaveBeenCalledWith("c_new");
        expect(document.querySelector("#mj-new-session-title")).toBeNull();
        expect(chooser()).toBeNull();
        // The rail asked before the assignment landed: no Coordinator yet, but no chooser either.
        await act(async () => railCoordinator().click());
        expect(chooser()).toBeNull();
        await act(async () => answer({ convo_id: "c_new", consent: true }));
        expect(chooser()).toBeNull();
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_new");
    });

    it("shows the Coordinator in Settings with Change… and Clear, and returns to Settings from the chooser", async () => {
        const putCoordinator = jest.fn().mockResolvedValue({ convo_id: null, consent: true });
        const client = signedInClient({
            coordinator: jest.fn().mockResolvedValue({ convo_id: "c_coord", consent: true }),
            putCoordinator,
        });
        await render(client);
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        const row = settingsSheet()!.querySelector<HTMLElement>('[data-setting="coordinator"]')!;
        expect(row.textContent).toContain("Coordinator desk");

        await act(async () => button(row, "Change…").click());
        expect(settingsSheet()).toBeNull();
        expect(chooser()).not.toBeNull();
        await act(async () => button(chooser()!, "Cancel").click());
        expect(chooser()).toBeNull();
        expect(settingsSheet()).not.toBeNull();

        const again = settingsSheet()!.querySelector<HTMLElement>('[data-setting="coordinator"]')!;
        await act(async () => button(again, "Clear").click());
        expect(putCoordinator).toHaveBeenCalledWith(null);
        expect(settingsSheet()!.textContent).toContain("No coordinator conversation yet.");
    });

    it("lists routines from Settings with words, pauses one and runs one", async () => {
        const today = new Date();
        const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 7, 5).getTime();
        const routines = jest.fn().mockResolvedValue({
            routines: [
                routineRow({ next_at: next, last_fired_at: Date.now() - 3_600_000, last_outcome: "applied now" }),
                routineRow({
                    id: "rt_2",
                    name: "disk-low",
                    title: "Disk low",
                    schedule: null,
                    trigger: { kind: "disk_under", pct: 20 },
                    last_fired_at: Date.now() - 60_000,
                    last_outcome: "failed agent_unreachable",
                }),
            ],
        });
        const patchRoutine = jest.fn().mockResolvedValue({ routine: routineRow({ enabled: false, next_at: null }) });
        const runRoutine = jest.fn().mockResolvedValue({ delivered: false, reason: "no_coordinator" });
        const client = signedInClient({
            coordinator: jest.fn().mockResolvedValue({ convo_id: "c_coord", consent: true }),
            routines,
            patchRoutine,
            runRoutine,
        });
        await render(client);
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        await act(async () =>
            settingsSheet()!.querySelector<HTMLButtonElement>('button[data-setting="routines"]')!.click(),
        );
        expect(settingsSheet()).toBeNull();
        expect(routines).toHaveBeenCalledTimes(1);

        const rows = [...routinesSheet()!.querySelectorAll<HTMLElement>(".mj_RoutineRow")];
        expect(rows.map((row) => row.dataset.routine)).toEqual(["daily-sweep", "disk-low"]);
        expect(rows[0].textContent).toContain("Every day at 07:05 (Europe/London)");
        expect(rows[0].textContent).toContain("Next: tomorrow at");
        expect(rows[0].textContent).toContain("Last: 1h ago · Delivered");
        expect(rows[1].textContent).toContain("When a box drops under 20% free disk");
        expect(rows[1].querySelector(".mj_RoutineRow_failed")?.textContent).toBe("Failed: agent_unreachable");

        await act(async () => rows[0].querySelector<HTMLButtonElement>('[role="switch"]')!.click());
        expect(patchRoutine).toHaveBeenCalledWith("rt_1", { enabled: false });
        const paused = routinesSheet()!.querySelector<HTMLElement>('[data-routine="daily-sweep"]')!;
        expect(paused.querySelector(".mj_RoutineRow_paused")?.textContent).toBe("Paused");
        expect(paused.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");

        await act(async () => button(paused, "Run now").click());
        expect(runRoutine).toHaveBeenCalledWith("rt_1");
        expect(routinesSheet()!.textContent).toContain("Not sent: there is no Coordinator to run it.");

        await act(async () => button(routinesSheet()!, "Done").click());
        expect(routinesSheet()).toBeNull();
        expect(settingsSheet()).not.toBeNull();
    });

    it("creates a routine from the editor, refusing a bad schedule first", async () => {
        const createRoutine = jest.fn().mockResolvedValue({
            routine: routineRow({ id: "rt_9", name: "weekly", title: "Weekly", schedule: "0 9 * * 1-5" }),
        });
        const client = signedInClient({
            coordinator: jest.fn().mockResolvedValue({ convo_id: "c_coord", consent: true }),
            routines: jest.fn().mockResolvedValue({ routines: [] }),
            createRoutine,
        });
        await render(client);
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        await act(async () =>
            settingsSheet()!.querySelector<HTMLButtonElement>('button[data-setting="routines"]')!.click(),
        );
        expect(routinesSheet()!.textContent).toContain("No routines yet.");
        await act(async () =>
            routinesSheet()!.querySelector<HTMLButtonElement>('button[data-action="new-routine"]')!.click(),
        );

        const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
            const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
            await act(async () => {
                Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(element, value);
                element.dispatchEvent(new Event("input", { bubbles: true }));
            });
        };
        const sheet = routinesSheet()!;
        await type(sheet.querySelector<HTMLInputElement>("#mj-routine-name")!, "weekly");
        await type(sheet.querySelector<HTMLInputElement>("#mj-routine-title")!, "Weekly");
        await type(sheet.querySelector<HTMLTextAreaElement>("#mj-routine-prompt")!, "Review the week.");
        expect(sheet.querySelector('[data-testid="routine-schedule-preview"]')?.textContent).toBe(
            "Monday to Friday at 09:00",
        );
        const minute = sheet.querySelector<HTMLInputElement>('input[aria-label="Minute"]')!;
        await type(minute, "*/5");
        expect(sheet.querySelector('[data-testid="routine-schedule-preview"]')?.textContent).toBe(
            "A routine fires at most every 15 minutes.",
        );
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[data-action="save-routine"]')!.click());
        expect(createRoutine).not.toHaveBeenCalled();
        expect(sheet.querySelector('[role="alert"]')?.textContent).toBe("A routine fires at most every 15 minutes.");

        await type(minute, "0");
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[data-action="save-routine"]')!.click());
        expect(createRoutine).toHaveBeenCalledWith({
            name: "weekly",
            title: "Weekly",
            prompt: "Review the week.",
            schedule: "0 9 * * 1-5",
            tz: "Europe/London",
            enabled: true,
        });
        expect(routinesSheet()!.querySelector('[data-routine="weekly"]')).not.toBeNull();
    });
    it("deletes only after the confirmation, and hands focus back to the row the editor came from", async () => {
        const deleteRoutine = jest.fn().mockResolvedValue({ ok: true });
        const client = signedInClient({
            coordinator: jest.fn().mockResolvedValue({ convo_id: "c_coord", consent: true }),
            routines: jest.fn().mockResolvedValue({
                routines: [routineRow(), routineRow({ id: "rt_2", name: "unseen-digest", title: "Unseen digest" })],
            }),
            deleteRoutine,
        });
        await render(client);
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        await act(async () =>
            settingsSheet()!.querySelector<HTMLButtonElement>('button[data-setting="routines"]')!.click(),
        );
        const sheet = routinesSheet()!;
        expect(sheet.contains(document.activeElement)).toBe(true);
        const main = (name: string): HTMLButtonElement =>
            sheet.querySelector<HTMLButtonElement>(`[data-routine="${name}"] .mj_RoutineRow_main`)!;
        // The row's words are its accessible name, not just "Edit …".
        expect(main("daily-sweep").getAttribute("aria-label")).toBeNull();

        await act(async () => main("unseen-digest").click());
        expect(sheet.contains(document.activeElement)).toBe(true);
        await act(async () => button(sheet, "Cancel").click());
        expect(document.activeElement).toBe(main("unseen-digest"));

        await act(async () => main("daily-sweep").click());
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[data-action="delete-routine"]')!.click());
        expect(deleteRoutine).not.toHaveBeenCalled();
        expect(sheet.textContent).toContain("Delete this routine?");
        await act(async () => button(sheet, "Cancel").click());
        expect(deleteRoutine).not.toHaveBeenCalled();
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[data-action="delete-routine"]')!.click());
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[data-action="confirm-delete"]')!.click());
        expect(deleteRoutine).toHaveBeenCalledWith("rt_1");
        expect([...sheet.querySelectorAll<HTMLElement>(".mj_RoutineRow")].map((row) => row.dataset.routine)).toEqual([
            "unseen-digest",
        ]);
    });

    it("creates a triggered routine with a threshold off the arrows' step", async () => {
        const createRoutine = jest.fn().mockResolvedValue({
            routine: routineRow({
                id: "rt_9",
                name: "ctx",
                schedule: null,
                trigger: { kind: "context_over", pct: 42 },
            }),
        });
        const client = signedInClient({
            coordinator: jest.fn().mockResolvedValue({ convo_id: "c_coord", consent: true }),
            routines: jest.fn().mockResolvedValue({ routines: [] }),
            createRoutine,
        });
        await render(client);
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        await act(async () =>
            settingsSheet()!.querySelector<HTMLButtonElement>('button[data-setting="routines"]')!.click(),
        );
        await act(async () =>
            routinesSheet()!.querySelector<HTMLButtonElement>('button[data-action="new-routine"]')!.click(),
        );
        const sheet = routinesSheet()!;
        const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
            const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
            await act(async () => {
                Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(element, value);
                element.dispatchEvent(new Event("input", { bubbles: true }));
            });
        };
        await type(sheet.querySelector<HTMLInputElement>("#mj-routine-name")!, "ctx");
        await type(sheet.querySelector<HTMLInputElement>("#mj-routine-title")!, "Context");
        await type(sheet.querySelector<HTMLTextAreaElement>("#mj-routine-prompt")!, "Look at it.");
        await act(async () => button(sheet, "When something happens").click());
        const form = sheet.querySelector<HTMLFormElement>("form.mj_RoutineEditor")!;
        // The browser's step check would block 42 (min 1) without a word: the journal's rules decide.
        expect(form.noValidate).toBe(true);
        await type(sheet.querySelector<HTMLInputElement>('input[aria-label="Percent"]')!, "42");
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[data-action="save-routine"]')!.click());
        expect(createRoutine).toHaveBeenCalledWith({
            name: "ctx",
            title: "Context",
            prompt: "Look at it.",
            trigger: { kind: "context_over", pct: 42 },
            tz: "Europe/London",
            enabled: true,
        });
    });
    it("creates a spare-allowance routine in tiers, editing, adding and removing one", async () => {
        const createRoutine = jest.fn().mockResolvedValue({
            routine: routineRow({
                id: "rt_10",
                name: "spare",
                schedule: null,
                trigger: { kind: "disk_under", pct: 20 },
            }),
        });
        const client = signedInClient({
            coordinator: jest.fn().mockResolvedValue({ convo_id: "c_coord", consent: true }),
            routines: jest.fn().mockResolvedValue({ routines: [] }),
            createRoutine,
        });
        await render(client);
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        await act(async () =>
            settingsSheet()!.querySelector<HTMLButtonElement>('button[data-setting="routines"]')!.click(),
        );
        await act(async () =>
            routinesSheet()!.querySelector<HTMLButtonElement>('button[data-action="new-routine"]')!.click(),
        );
        const sheet = routinesSheet()!;
        const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
            const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
            await act(async () => {
                Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(element, value);
                element.dispatchEvent(new Event("input", { bubbles: true }));
            });
        };
        await type(sheet.querySelector<HTMLInputElement>("#mj-routine-name")!, "spare");
        await type(sheet.querySelector<HTMLInputElement>("#mj-routine-title")!, "Spare");
        await type(sheet.querySelector<HTMLTextAreaElement>("#mj-routine-prompt")!, "Spend it.");
        await act(async () => button(sheet, "When something happens").click());
        const select = sheet.querySelector<HTMLSelectElement>("#mj-routine-trigger")!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
                select,
                "allowance_expiring",
            );
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(sheet.querySelector('input[aria-label="Percent"]')).toBeNull();
        expect(sheet.textContent).toContain(
            "When a weekly limit has 50% unused with 12 h left or 25% unused with 2 h left",
        );
        await type(sheet.querySelector<HTMLInputElement>('input[aria-label="Tier 2 hours left"]')!, "3");
        await act(async () => button(sheet, "Add tier").click());
        await type(sheet.querySelector<HTMLInputElement>('input[aria-label="Tier 3 unused percent"]')!, "10");
        await type(sheet.querySelector<HTMLInputElement>('input[aria-label="Tier 3 hours left"]')!, "1");
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[aria-label="Remove tier 1"]')!.click());
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[data-action="save-routine"]')!.click());
        expect(createRoutine).toHaveBeenCalledWith({
            name: "spare",
            title: "Spare",
            prompt: "Spend it.",
            trigger: {
                kind: "allowance_expiring",
                tiers: [
                    { unused_pct: 25, hours_left: 3 },
                    { unused_pct: 10, hours_left: 1 },
                ],
            },
            tz: "Europe/London",
            enabled: true,
        });
    });
});
