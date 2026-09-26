/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import { readShowTheWork, resetShowTheWorkForTests } from "../show-the-work";
import type { ClientState, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: Session = { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 2, username: "op" };

function client(): MatronJournalClient {
    const instance = new MatronJournalClient();
    (instance as unknown as { state: ClientState }).state = {
        ...instance.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [],
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return instance;
}

let container: HTMLDivElement;
let root: Root;
const settingsButton = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!;
const menu = (): HTMLElement | null => container.querySelector('.mj_AccountMenu[role="menu"]');

beforeEach(async () => {
    localStorage.clear();
    resetShowTheWorkForTests();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<MatronApp client={client()} />));
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

describe("Settings menu (v6 + round 2)", () => {
    it("is the last sidebar-header action, after Files and Tracker; theme lives in the menu", () => {
        const actions = [...container.querySelectorAll(".mj_RoomListHeaderActions > button")].map((button) =>
            button.getAttribute("aria-label"),
        );
        expect(actions.at(-1)).toBe("Settings");
        expect(actions.some((label) => label?.startsWith("Theme"))).toBe(false);
        expect(settingsButton().getAttribute("aria-haspopup")).toBe("menu");
    });

    it("lists identity · connection · Theme · Developer view · Sign out, and no Edit a file", async () => {
        await act(async () => settingsButton().click());
        expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
        const text = menu()!.textContent ?? "";
        expect(text).toContain("op");
        expect(text).toContain("https://journal.example");
        expect(menu()!.querySelector(".mj_AccountStatus")?.textContent).toContain("Connected");
        const items = [...menu()!.querySelectorAll('[role^="menuitem"]')].map(
            (item) => item.querySelector(".mj_MenuLabel")?.textContent,
        );
        expect(items).toEqual(["Theme", "Developer view", "Sign out"]);
        expect(text).not.toContain("Edit a file");
        // No descriptive hint lines (round 2).
        expect(menu()!.querySelector(".mj_MenuHint")).toBeNull();
        expect(document.activeElement?.textContent).toContain("Theme");
    });

    it("toggles Developer view as a checked menu item backed by the shared preference", async () => {
        await act(async () => settingsButton().click());
        const item = menu()!.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
        expect(item.getAttribute("aria-checked")).toBe("false");
        await act(async () => item.click());
        expect(item.getAttribute("aria-checked")).toBe("true");
        expect(readShowTheWork()).toBe(true);
        expect(item.querySelector(".mj_Switch.is-on")).not.toBeNull();
    });

    it("cycles the theme from the menu", async () => {
        await act(async () => settingsButton().click());
        const theme = (): HTMLButtonElement => menu()!.querySelector<HTMLButtonElement>('[aria-label^="Theme:"]')!;
        expect(theme().getAttribute("aria-label")).toBe("Theme: System");
        await act(async () => theme().click());
        expect(theme().getAttribute("aria-label")).not.toBe("Theme: System");
    });

    it("closes on Escape and returns focus to the Settings button", async () => {
        await act(async () => settingsButton().click());
        await act(async () => {
            menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(menu()).toBeNull();
        expect(document.activeElement).toBe(settingsButton());
    });

    it("stays open while the thread scrolls, and closes on Tab out", async () => {
        await act(async () => settingsButton().click());
        await act(async () => {
            document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        expect(menu()).not.toBeNull();
        await act(async () => {
            menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        });
        expect(menu()).toBeNull();
    });
});
