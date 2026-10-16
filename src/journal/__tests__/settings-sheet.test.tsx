/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApiError } from "../api";
import { favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import { getSnapshot, setTheme } from "../theme";
import type { ClientState, Conversation, DeviceDTO, ServerFrame, Session, UserDefaults } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = { serverUrl: "https://chat.example", token: "t", deviceId: 85, userId: 2, username: "alice" };
const CONVERSATION: Conversation = {
    id: "c1",
    title: "One",
    session_state: "idle",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 1,
};

function signedInClient(): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: "c1",
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: new Set(),
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

describe("Settings sheet (Mac grouped form)", () => {
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
        setTheme(null);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    async function openSettings(client = signedInClient()): Promise<MatronJournalClient> {
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        return client;
    }

    const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"].mj_SettingsSheet');

    it("opens a labelled dialog with Account, Appearance and Sign out", async () => {
        await openSettings();
        const dialog = sheet()!;
        expect(dialog).not.toBeNull();
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(dialog.querySelector("h2")?.textContent).toBe("Settings");
        const text = dialog.textContent ?? "";
        expect(text).toContain("alice");
        expect(text).toContain("https://chat.example");
        expect(text).toContain("85");
        expect([...dialog.querySelectorAll(".mj_SettingsSheet_groupTitle")].map((el) => el.textContent)).toEqual([
            "Account",
            "Appearance",
            "Devices",
            "Notifications",
            "Developer",
            "New chats",
        ]);
        expect(dialog.querySelector('button[data-action="sign-out"]')?.textContent).toBe("Sign out");
    });

    it("sets the theme from the Appearance segmented control", async () => {
        await openSettings();
        const option = (value: string): HTMLButtonElement =>
            sheet()!.querySelector<HTMLButtonElement>(`.mj_SettingsSheet_appearance button[data-theme="${value}"]`)!;
        expect(option("system").getAttribute("aria-pressed")).toBe("true");
        await act(async () => option("dark").click());
        expect(getSnapshot()).toBe("dark");
        expect(option("dark").getAttribute("aria-pressed")).toBe("true");
        await act(async () => option("system").click());
        expect(getSnapshot()).toBeNull();
    });

    it("signs out from the sheet and closes on Escape", async () => {
        const client = signedInClient();
        const logout = jest.spyOn(client, "logout").mockResolvedValue(undefined);
        await openSettings(client);
        await act(async () => sheet()!.querySelector<HTMLButtonElement>('button[data-action="sign-out"]')!.click());
        expect(logout).toHaveBeenCalled();
        await act(async () => root.unmount());
        root = createRoot(container);
        await openSettings();
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(sheet()).toBeNull();
    });

    it("closes on Escape without also leaving a subagent conversation", async () => {
        const client = signedInClient();
        const internals = client as unknown as { state: ClientState };
        internals.state = {
            ...internals.state,
            conversations: [CONVERSATION, { ...CONVERSATION, id: "s1", title: "child", parent_convo_id: "c1" }],
            selectedConversationId: "s1",
        };
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        await openSettings(client);
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        });
        expect(sheet()).toBeNull();
        expect(select).not.toHaveBeenCalled();
    });

    it("traps Tab inside the sheet", async () => {
        await openSettings();
        const buttons = [...sheet()!.querySelectorAll<HTMLButtonElement>("button")];
        buttons[buttons.length - 1].focus();
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        });
        expect(document.activeElement).toBe(buttons[0]);
    });

    it("wraps Shift+Tab from the dialog itself (where focus lands on open) to the last button", async () => {
        await openSettings();
        expect(document.activeElement).toBe(sheet());
        const buttons = [...sheet()!.querySelectorAll<HTMLButtonElement>("button")];
        await act(async () => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
            );
        });
        expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    });

    it("closes when signing out so a second press cannot start another logout", async () => {
        const client = signedInClient();
        const logout = jest.spyOn(client, "logout").mockReturnValue(new Promise(() => undefined));
        await openSettings(client);
        await act(async () => sheet()!.querySelector<HTMLButtonElement>('button[data-action="sign-out"]')!.click());
        expect(sheet()).toBeNull();
        expect(logout).toHaveBeenCalledTimes(1);
    });

    it("names the connection state on the Settings button", async () => {
        await act(async () => root.render(<MatronApp client={signedInClient()} />));
        expect(container.querySelector(".mj_NavRail_settings")?.getAttribute("aria-label")).toBe("Settings, connected");
    });

    it("keeps only settings in the rail foot, with the connection dot on it", async () => {
        await act(async () => root.render(<MatronApp client={signedInClient()} />));
        const footer = container.querySelector('[data-testid="nav-rail"] .mj_NavRail_footer')!;
        expect(footer.querySelectorAll("button").length).toBe(1);
        expect(footer.querySelector(".mj_NavRail_settings .mj_NavRail_status_online")).not.toBeNull();
    });

    describe("For you: the notices switch", () => {
        type Api = { settings: jest.Mock; patchSettings: jest.Mock };
        const withApi = (api: Partial<Api>): MatronJournalClient => {
            const client = signedInClient();
            (client as unknown as { api: Partial<Api> }).api = api;
            return client;
        };
        const toggle = (): HTMLButtonElement | null =>
            sheet()?.querySelector<HTMLButtonElement>('button[role="switch"][data-setting="notices"]') ?? null;

        it("loads the setting on open and shows the switch with its help text", async () => {
            const settings = jest.fn().mockResolvedValue({ notices: true });
            await openSettings(withApi({ settings }));
            expect(settings).toHaveBeenCalledTimes(1);
            expect(toggle()?.getAttribute("aria-checked")).toBe("true");
            const text = sheet()!.textContent ?? "";
            expect(text).toContain("Send things I need to read to For you");
            expect(text).toContain(
                "Agents file things you should read as items with a Seen button, instead of leaving them in chat.",
            );
        });

        it("saves a flip with PATCH /settings", async () => {
            const patchSettings = jest.fn().mockResolvedValue({ notices: false });
            await openSettings(withApi({ settings: jest.fn().mockResolvedValue({ notices: true }), patchSettings }));
            await act(async () => toggle()!.click());
            expect(patchSettings).toHaveBeenCalledWith({ notices: false });
            expect(toggle()?.getAttribute("aria-checked")).toBe("false");
        });

        it("follows a settings frame from another device while open", async () => {
            const client = withApi({ settings: jest.fn().mockResolvedValue({ notices: true }) });
            await openSettings(client);
            await act(async () => {
                await (client as unknown as { handleFrame(frame: unknown): Promise<void> }).handleFrame({
                    kind: "control",
                    op: "settings",
                    settings: { notices: false },
                });
            });
            expect(toggle()?.getAttribute("aria-checked")).toBe("false");
        });

        it("hides the switch when the journal has no /settings (404)", async () => {
            const { JournalApiError } = await import("../api");
            const client = withApi({ settings: jest.fn().mockRejectedValue(new JournalApiError("Not found", 404)) });
            // Even a value from hello_ok gives way to the 404.
            (client as unknown as { state: ClientState }).state.userSettings = {
                notices: true,
                auto_approve_coordinator_spawns: true,
            };
            await openSettings(client);
            expect(toggle()).toBeNull();
            expect(sheet()!.textContent).not.toContain("For you");
            expect(spawnToggle()).toBeNull();
        });

        const spawnToggle = (): HTMLButtonElement | null =>
            sheet()?.querySelector('button[data-setting="auto_approve_coordinator_spawns"]') ?? null;

        it("shows spawn auto-approval off and saves both directions with the exact setting key", async () => {
            const patchSettings = jest.fn().mockImplementation(async (patch) => ({ notices: true, ...patch }));
            await openSettings(
                withApi({
                    settings: jest.fn().mockResolvedValue({ notices: true, auto_approve_coordinator_spawns: false }),
                    patchSettings,
                }),
            );
            expect(spawnToggle()?.getAttribute("aria-checked")).toBe("false");
            expect(sheet()!.textContent).toContain("Auto-approve spawns the Coordinator requests");
            expect(sheet()!.textContent).toContain(
                "When on, a session the Coordinator starts on one of your own online boxes starts at once, without a consent card. Other requests still ask you.",
            );
            await act(async () => spawnToggle()!.click());
            expect(patchSettings).toHaveBeenLastCalledWith({ auto_approve_coordinator_spawns: true });
            expect(spawnToggle()?.getAttribute("aria-checked")).toBe("true");
            expect(toggle()?.getAttribute("aria-checked")).toBe("true");
            await act(async () => spawnToggle()!.click());
            expect(patchSettings).toHaveBeenLastCalledWith({ auto_approve_coordinator_spawns: false });
            expect(spawnToggle()?.getAttribute("aria-checked")).toBe("false");
        });

        it("hides spawn auto-approval on an older journal", async () => {
            await openSettings(withApi({ settings: jest.fn().mockResolvedValue({ notices: true }) }));
            expect(spawnToggle()).toBeNull();
            expect(toggle()).not.toBeNull();
        });

        it("updates spawn auto-approval live and rolls back a failed save with an error", async () => {
            const client = withApi({
                settings: jest.fn().mockResolvedValue({ notices: true, auto_approve_coordinator_spawns: false }),
                patchSettings: jest.fn().mockRejectedValue(new Error("offline")),
            });
            await openSettings(client);
            await act(async () => {
                await (client as unknown as { handleFrame(frame: unknown): Promise<void> }).handleFrame({
                    kind: "control",
                    op: "settings",
                    settings: { notices: false, auto_approve_coordinator_spawns: true },
                });
            });
            expect(spawnToggle()?.getAttribute("aria-checked")).toBe("true");
            await act(async () => spawnToggle()!.click());
            expect(spawnToggle()?.getAttribute("aria-checked")).toBe("true");
            expect(sheet()!.textContent).toContain("Couldn't save: offline");
        });
    });
});

describe("Settings sheet: Coordinator consent approval", () => {
    let root: Root;
    let container: HTMLDivElement;

    type CoordinatorApi = { coordinator: jest.Mock; putCoordinatorConsent: jest.Mock };

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
    });

    function withApi(api: Partial<CoordinatorApi>): MatronJournalClient {
        const client = signedInClient();
        (client as unknown as { api: Partial<CoordinatorApi> }).api = api;
        return client;
    }

    async function openSettings(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
    }

    const toggle = (): HTMLButtonElement | null =>
        document.querySelector<HTMLButtonElement>('.mj_SettingsSheet button[data-setting="coordinator-consent"]');

    it("loads the switch with GET /coordinator and shows it under Coordinator", async () => {
        const coordinator = jest.fn().mockResolvedValue({ convo_id: "c9", consent: true });
        await openSettings(withApi({ coordinator }));

        expect(coordinator).toHaveBeenCalled();
        expect(toggle()?.getAttribute("aria-checked")).toBe("true");
        expect(toggle()?.getAttribute("role")).toBe("switch");
        const group = toggle()!.closest("section")!;
        expect(group.querySelector(".mj_SettingsSheet_groupTitle")?.textContent).toBe("Coordinator");
        expect(group.textContent).toContain("Let the Coordinator approve chats and spawns");
    });

    it("saves a flip with PUT /coordinator {consent}", async () => {
        const putCoordinatorConsent = jest.fn().mockResolvedValue({ convo_id: "c9", consent: false });
        await openSettings(
            withApi({
                coordinator: jest.fn().mockResolvedValue({ convo_id: "c9", consent: true }),
                putCoordinatorConsent,
            }),
        );

        await act(async () => toggle()!.click());
        expect(putCoordinatorConsent).toHaveBeenCalledWith(false);
        expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    });

    it("moves at once, and puts the switch back with an error when the write fails", async () => {
        let reject!: (error: unknown) => void;
        const putCoordinatorConsent = jest.fn().mockReturnValue(new Promise((_, fail) => (reject = fail)));
        await openSettings(
            withApi({
                coordinator: jest.fn().mockResolvedValue({ convo_id: null, consent: true }),
                putCoordinatorConsent,
            }),
        );

        await act(async () => toggle()!.click());
        expect(toggle()?.getAttribute("aria-checked")).toBe("false");

        await act(async () => reject(new JournalApiError("The journal refused the change.", 500)));
        expect(toggle()?.getAttribute("aria-checked")).toBe("true");
        expect(toggle()!.closest("section")!.querySelector('[role="alert"]')?.textContent).toBe(
            "Couldn't save: The journal refused the change.",
        );
    });

    it("sends taps one at a time, so the journal ends on the last one", async () => {
        const answers: Array<(body: unknown) => void> = [];
        const putCoordinatorConsent = jest.fn(() => new Promise((resolve) => answers.push(resolve)));
        await openSettings(
            withApi({
                coordinator: jest.fn().mockResolvedValue({ convo_id: null, consent: true }),
                putCoordinatorConsent,
            }),
        );

        await act(async () => toggle()!.click());
        await act(async () => toggle()!.click());
        expect(putCoordinatorConsent).toHaveBeenCalledTimes(1);
        expect(toggle()?.getAttribute("aria-checked")).toBe("true");

        await act(async () => answers[0]({ convo_id: null, consent: false }));
        // The first answer is not the latest tap's: the switch stays where the user left it.
        expect(toggle()?.getAttribute("aria-checked")).toBe("true");
        expect(putCoordinatorConsent).toHaveBeenLastCalledWith(true);
        await act(async () => answers[1]({ convo_id: null, consent: true }));
        expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    });

    it("hides the switch on a journal that returns no consent", async () => {
        await openSettings(withApi({ coordinator: jest.fn().mockResolvedValue({ convo_id: "c9" }) }));

        expect(toggle()).toBeNull();
        expect(document.querySelector(".mj_SettingsSheet")?.textContent).not.toContain("Let the Coordinator approve");
    });

    it("hides the switch when GET /coordinator fails", async () => {
        await openSettings(
            withApi({ coordinator: jest.fn().mockRejectedValue(new JournalApiError("Not found", 404)) }),
        );

        expect(toggle()).toBeNull();
    });
});

describe("Settings sheet: New chats defaults", () => {
    let root: Root;
    let container: HTMLDivElement;

    type DefaultsApi = {
        defaults: jest.Mock<Promise<UserDefaults>, []>;
        putDefaults: jest.Mock<Promise<UserDefaults>, [Partial<UserDefaults>]>;
        devices: jest.Mock;
    };

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
        setTheme(null);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    function clientWithDefaults(stored: UserDefaults): { client: MatronJournalClient; api: DefaultsApi } {
        const client = signedInClient();
        const api: DefaultsApi = {
            defaults: jest.fn().mockResolvedValue(stored),
            putDefaults: jest.fn((body: Partial<UserDefaults>) => Promise.resolve({ ...stored, ...body })),
            devices: jest.fn().mockResolvedValue({ devices: [] }),
        };
        (client as unknown as { api: DefaultsApi }).api = api;
        return { client, api };
    }

    async function openSettings(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
    }

    const select = (key: string): HTMLSelectElement =>
        document.querySelector<HTMLSelectElement>(`.mj_SettingsSheet select[data-setting="${key}"]`)!;
    const optionValues = (key: string): string[] => [...select(key).options].map((option) => option.value);

    async function choose(key: string, value: string): Promise<void> {
        await act(async () => {
            select(key).value = value;
            select(key).dispatchEvent(new Event("change", { bubbles: true }));
        });
    }

    it("loads the stored defaults with GET /defaults when the sheet opens", async () => {
        const { client, api } = clientWithDefaults({ default_model: "sonnet", default_effort: null });
        await openSettings(client);

        expect(api.defaults).toHaveBeenCalledTimes(1);
        expect(select("default_model").value).toBe("sonnet");
        expect(select("default_model").disabled).toBe(false);
        expect(select("default_effort").value).toBe("");
        expect(select("default_effort").selectedOptions[0].textContent).toBe("Box default");
        expect(optionValues("default_model")).toEqual([
            "",
            "opus",
            "opus[1m]",
            "sonnet",
            "sonnet[1m]",
            "haiku",
            "opusplan",
            "fable",
        ]);
        expect(optionValues("default_effort")).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
        expect(document.querySelector(".mj_SettingsSheet")!.textContent).toContain(
            "Used when a new chat starts without a choice of its own. Box default uses each box's setting.",
        );
    });

    it("shows the selects disabled until the defaults load", async () => {
        const { client, api } = clientWithDefaults({ default_model: null, default_effort: null });
        api.defaults.mockReturnValue(new Promise(() => undefined));
        await openSettings(client);

        expect(select("default_model").disabled).toBe(true);
        expect(select("default_model").selectedOptions[0].textContent).toBe("Loading…");
    });

    it("PUTs only the changed key, with null for Box default", async () => {
        const { client, api } = clientWithDefaults({ default_model: "opus", default_effort: "high" });
        await openSettings(client);

        await choose("default_model", "opus[1m]");
        expect(api.putDefaults).toHaveBeenLastCalledWith({ default_model: "opus[1m]" });
        expect(select("default_model").value).toBe("opus[1m]");

        await choose("default_effort", "xhigh");
        expect(api.putDefaults).toHaveBeenLastCalledWith({ default_effort: "xhigh" });

        await choose("default_model", "");
        expect(api.putDefaults).toHaveBeenLastCalledWith({ default_model: null });
        expect(select("default_model").value).toBe("");
        expect(api.putDefaults).toHaveBeenCalledTimes(3);
    });

    it("shows the change at once, then reverts it with an error when the journal refuses", async () => {
        const { client, api } = clientWithDefaults({ default_model: "sonnet", default_effort: "low" });
        let reject!: (error: unknown) => void;
        api.putDefaults.mockReturnValue(new Promise((_, fail) => (reject = fail)));
        await openSettings(client);

        await choose("default_model", "haiku");
        expect(select("default_model").value).toBe("haiku");

        await act(async () => reject(new JournalApiError("The journal did not accept that model.", 400, "bad_model")));
        expect(select("default_model").value).toBe("sonnet");
        expect(select("default_effort").value).toBe("low");
        expect(document.querySelector('.mj_SettingsSheet [role="alert"]')?.textContent).toBe(
            "Couldn't save the default model: The journal did not accept that model.",
        );
    });

    it("applies a live defaults frame from another device", async () => {
        const { client } = clientWithDefaults({ default_model: null, default_effort: null });
        await openSettings(client);

        await act(async () => {
            await (client as unknown as { handleFrame(frame: ServerFrame): Promise<void> }).handleFrame({
                kind: "defaults",
                default_model: "fable",
                default_effort: "max",
            });
        });
        expect(select("default_model").value).toBe("fable");
        expect(select("default_effort").value).toBe("max");
    });

    it("shows a stored model outside the list as an extra option", async () => {
        const { client } = clientWithDefaults({ default_model: "claude-opus-5-5", default_effort: null });
        await openSettings(client);

        expect(optionValues("default_model")).toContain("claude-opus-5-5");
        expect(select("default_model").value).toBe("claude-opus-5-5");
        expect(select("default_model").selectedOptions[0].textContent).toBe("claude-opus-5-5");
    });

    it("says the journal predates defaults when GET /defaults is a 404", async () => {
        const { client, api } = clientWithDefaults({ default_model: null, default_effort: null });
        api.defaults.mockRejectedValue(new JournalApiError("The requested item was not found.", 404, "not_found"));
        await openSettings(client);

        expect(document.querySelector(".mj_SettingsSheet select")).toBeNull();
        expect(document.querySelector(".mj_SettingsSheet")!.textContent).toContain(
            "This journal does not support default settings yet.",
        );
    });

    it("counts the selects as sheet controls, so Tab from one is not pulled back to the top", async () => {
        const { client } = clientWithDefaults({ default_model: null, default_effort: null });
        await openSettings(client);
        select("default_effort").focus();
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        });
        // Not the last control: the trap leaves Tab to the browser (jsdom moves nothing).
        expect(document.activeElement).toBe(select("default_effort"));
    });
});

describe("Settings sheet: Boxes defaults", () => {
    let root: Root;
    let container: HTMLDivElement;

    type BoxPut = Record<string, string | null>;
    type BoxApi = {
        defaults: jest.Mock<Promise<UserDefaults>, []>;
        putDefaults: jest.Mock;
        devices: jest.Mock<Promise<{ devices: DeviceDTO[] }>, []>;
        putBoxDefaults: jest.Mock<Promise<Record<string, unknown>>, [number, BoxPut]>;
    };

    const ELM: DeviceDTO = {
        device_id: 10,
        kind: "agent",
        name: "elm",
        connected: true,
        is_self: false,
        defaults: { agent: "codex", model: "gpt-5.1-codex", effort: "high" },
    };
    const MAPLE: DeviceDTO = {
        device_id: 11,
        kind: "agent",
        name: "maple",
        connected: true,
        is_self: false,
        defaults: { agent: "claude", model: "opus", effort: null },
    };

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
        setTheme(null);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    function clientWithBoxes(devices: DeviceDTO[]): { client: MatronJournalClient; api: BoxApi } {
        const client = signedInClient();
        const api: BoxApi = {
            defaults: jest.fn().mockResolvedValue({ default_model: null, default_effort: null }),
            putDefaults: jest.fn(),
            devices: jest.fn().mockResolvedValue({ devices }),
            putBoxDefaults: jest.fn((deviceId: number, body: BoxPut) => {
                const current = devices.find((device) => device.device_id === deviceId)!.defaults!;
                return Promise.resolve({
                    device_id: deviceId,
                    default_agent: "default_agent" in body ? body.default_agent : current.agent,
                    default_model: "default_model" in body ? body.default_model : current.model,
                    default_effort: "default_effort" in body ? body.default_effort : current.effort,
                });
            }),
        };
        (client as unknown as { api: BoxApi }).api = api;
        return { client, api };
    }

    async function openSettings(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
    }

    const box = (id: number): HTMLElement =>
        document.querySelector<HTMLElement>(`.mj_SettingsSheet [data-box="${id}"]`)!;
    const field = <T extends HTMLElement = HTMLSelectElement>(id: number, key: string): T =>
        box(id).querySelector<T>(`[data-box-setting="${key}"]`)!;
    const optionValues = (id: number, key: string): string[] =>
        [...field(id, key).options].map((option) => option.value);

    async function choose(id: number, key: string, value: string): Promise<void> {
        await act(async () => {
            field(id, key).value = value;
            field(id, key).dispatchEvent(new Event("change", { bubbles: true }));
        });
    }

    it("lists each agent box under Boxes with its agent, model and effort", async () => {
        const { client, api } = clientWithBoxes([ELM, MAPLE]);
        await openSettings(client);

        expect(api.devices).toHaveBeenCalled();
        expect(
            [...document.querySelectorAll(".mj_SettingsSheet .mj_SettingsSheet_groupTitle")].map(
                (el) => el.textContent,
            ),
        ).toEqual(["Account", "Appearance", "Devices", "Notifications", "Developer", "New chats", "Boxes"]);
        expect(box(10).querySelector(".mj_SettingsSheet_boxName")?.textContent).toBe("elm");
        expect(optionValues(10, "agent")).toEqual(["", "claude", "codex"]);
        expect([...field(10, "agent").options].map((option) => option.textContent)).toEqual([
            "Box default",
            "Claude",
            "Codex",
        ]);
        expect(field(10, "agent").value).toBe("codex");
        expect(field(11, "agent").value).toBe("claude");
    });

    it("offers the Claude models and efforts on a Claude box", async () => {
        const { client } = clientWithBoxes([MAPLE]);
        await openSettings(client);

        expect(field(11, "model").tagName).toBe("SELECT");
        expect(optionValues(11, "model")).toEqual([
            "",
            "opus",
            "opus[1m]",
            "sonnet",
            "sonnet[1m]",
            "haiku",
            "opusplan",
            "fable",
        ]);
        expect(field(11, "model").value).toBe("opus");
        expect(optionValues(11, "effort")).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
        expect(field(11, "effort").value).toBe("");
    });

    it("offers a free-text model and the Codex efforts on a Codex box", async () => {
        const { client } = clientWithBoxes([ELM]);
        await openSettings(client);

        const model = field<HTMLInputElement>(10, "model");
        expect(model.tagName).toBe("INPUT");
        expect(model.value).toBe("gpt-5.1-codex");
        expect(model.placeholder).toBe("Codex default");
        expect(optionValues(10, "effort")).toEqual(["", "minimal", "low", "medium", "high", "xhigh"]);
        expect(field(10, "effort").value).toBe("high");
    });

    it("PUTs an agent change, which clears the model", async () => {
        const { client, api } = clientWithBoxes([MAPLE]);
        await openSettings(client);

        await choose(11, "agent", "codex");

        expect(api.putBoxDefaults).toHaveBeenLastCalledWith(11, { default_agent: "codex", default_model: null });
        expect(field<HTMLInputElement>(11, "model").tagName).toBe("INPUT");
        expect(field<HTMLInputElement>(11, "model").value).toBe("");
    });

    it("PUTs a model and an effort pick, with null for the default", async () => {
        const { client, api } = clientWithBoxes([MAPLE]);
        await openSettings(client);

        await choose(11, "model", "fable");
        expect(api.putBoxDefaults).toHaveBeenLastCalledWith(11, { default_model: "fable" });
        await choose(11, "effort", "max");
        expect(api.putBoxDefaults).toHaveBeenLastCalledWith(11, { default_effort: "max" });
        await choose(11, "model", "");
        expect(api.putBoxDefaults).toHaveBeenLastCalledWith(11, { default_model: null });
    });

    it("saves a typed Codex model on Enter and clears it when emptied", async () => {
        const { client, api } = clientWithBoxes([ELM]);
        await openSettings(client);
        const model = (): HTMLInputElement => field<HTMLInputElement>(10, "model");
        const type = async (text: string): Promise<void> => {
            await act(async () => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
                setter.call(model(), text);
                model().dispatchEvent(new Event("input", { bubbles: true }));
            });
        };

        await type(" gpt-5.2 ");
        expect(api.putBoxDefaults).not.toHaveBeenCalled();
        await act(async () => {
            model().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(api.putBoxDefaults).toHaveBeenLastCalledWith(10, { default_model: "gpt-5.2" });

        await type("");
        await act(async () => {
            model().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        });
        expect(api.putBoxDefaults).toHaveBeenLastCalledWith(10, { default_model: null });
        expect(api.putBoxDefaults).toHaveBeenCalledTimes(2);
    });

    it("shows the error and the journal's value when a save is refused", async () => {
        const { client, api } = clientWithBoxes([MAPLE]);
        api.putBoxDefaults.mockRejectedValueOnce(
            new JournalApiError("The journal did not accept that effort level.", 400, "bad_effort"),
        );
        await openSettings(client);

        await choose(11, "effort", "low");

        expect(field(11, "effort").value).toBe("");
        expect(document.querySelector('.mj_SettingsSheet [role="alert"]')?.textContent).toBe(
            "Couldn't save maple's defaults: The journal did not accept that effort level.",
        );
    });

    it("applies a live box_defaults frame", async () => {
        const { client } = clientWithBoxes([MAPLE]);
        await openSettings(client);

        await act(async () => {
            await (client as unknown as { handleFrame(frame: ServerFrame): Promise<void> }).handleFrame({
                kind: "box_defaults",
                device_id: 11,
                default_agent: "claude",
                default_model: "sonnet",
                default_effort: "xhigh",
            } as unknown as ServerFrame);
        });

        expect(field(11, "model").value).toBe("sonnet");
        expect(field(11, "effort").value).toBe("xhigh");
    });

    it("shows the group with the error when the first load fails", async () => {
        const { client, api } = clientWithBoxes([MAPLE]);
        api.devices.mockRejectedValue(new JournalApiError("The journal server returned HTTP 500.", 500));
        await openSettings(client);

        expect(
            [...document.querySelectorAll(".mj_SettingsSheet .mj_SettingsSheet_groupTitle")].map(
                (el) => el.textContent,
            ),
        ).toContain("Boxes");
        expect(
            document.querySelector('.mj_SettingsSheet [aria-labelledby="mj-settings-boxes"] [role="alert"]')
                ?.textContent,
        ).toBe("Couldn't load the box defaults: The journal server returned HTTP 500.");
    });

    it("hides the group on a journal without per-box defaults", async () => {
        const { client } = clientWithBoxes([{ ...ELM, defaults: undefined }]);
        await openSettings(client);

        expect(
            [...document.querySelectorAll(".mj_SettingsSheet .mj_SettingsSheet_groupTitle")].map(
                (el) => el.textContent,
            ),
        ).not.toContain("Boxes");
        expect(document.querySelector(".mj_SettingsSheet [data-box]")).toBeNull();
    });
});
