/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

type ThemeModule = typeof import("../../../src/journal/theme");
type ThemeToggleComponent = typeof import("../../../src/journal/components").ThemeToggle;

let theme: ThemeModule;
let ThemeToggle: ThemeToggleComponent;
let systemPrefersDark = false;
const mediaQueryListeners = new Set<() => void>();

const mediaQuery = {
    get matches(): boolean {
        return systemPrefersDark;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: () => void): void => {
        mediaQueryListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void): void => {
        mediaQueryListeners.delete(listener);
    },
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
} as unknown as MediaQueryList;

function dispatchSystemTheme(dark: boolean): void {
    systemPrefersDark = dark;
    for (const listener of mediaQueryListeners) listener();
}

function bootstrapScript(): string {
    const html = readFileSync("src/index.html", "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!script) throw new Error("Missing inline theme bootstrap script");
    return script[1];
}

beforeAll(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: jest.fn(() => mediaQuery),
    });

    theme = await import("../../../src/journal/theme");
    ({ ThemeToggle } = await import("../../../src/journal/components"));
});

beforeEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    theme.setTheme(null);
    systemPrefersDark = false;
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeUser;
});

describe("theme preference state machine", () => {
    it.each(["light", "dark"] as const)("returns a stored %s preference", (preference) => {
        localStorage.setItem(theme.THEME_STORAGE_KEY, preference);
        expect(theme.getThemePref()).toBe(preference);
    });

    it.each(["blue", "null", ""])("rejects invalid stored preference %p", (preference) => {
        localStorage.setItem(theme.THEME_STORAGE_KEY, preference);
        expect(theme.getThemePref()).toBeNull();
    });

    it("persists explicit preferences and removes System instead of writing null", () => {
        const setItem = jest.spyOn(Storage.prototype, "setItem");
        const removeItem = jest.spyOn(Storage.prototype, "removeItem");

        expect(theme.setTheme("light")).toBe("light");
        expect(setItem).toHaveBeenCalledWith(theme.THEME_STORAGE_KEY, "light");
        expect(theme.setTheme("dark")).toBe("dark");
        expect(setItem).toHaveBeenCalledWith(theme.THEME_STORAGE_KEY, "dark");
        expect(theme.setTheme(null)).toBeNull();
        expect(removeItem).toHaveBeenCalledWith(theme.THEME_STORAGE_KEY);
        expect(setItem).not.toHaveBeenCalledWith(theme.THEME_STORAGE_KEY, "null");
    });

    it("applies explicit or System preferences and only follows OS changes in System", () => {
        theme.setTheme("light");
        expect(theme.applyTheme()).toBe("light");
        expect(document.documentElement.dataset.theme).toBe("light");
        expect(document.documentElement.dataset.themeUser).toBe("light");

        dispatchSystemTheme(true);
        expect(document.documentElement.dataset.theme).toBe("light");

        theme.setTheme(null);
        dispatchSystemTheme(true);
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(document.documentElement.dataset.themeUser).toBeUndefined();

        dispatchSystemTheme(false);
        expect(document.documentElement.dataset.theme).toBe("light");
    });

    it("cycles System to Light to Dark to System", () => {
        expect(theme.nextThemePref(null)).toBe("light");
        expect(theme.nextThemePref("light")).toBe("dark");
        expect(theme.nextThemePref("dark")).toBeNull();
    });

    it("survives denied storage, warns once, and applies explicit session preferences", () => {
        const securityError = new DOMException("denied", "SecurityError");
        jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw securityError;
        });
        jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw securityError;
        });
        jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw securityError;
        });
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(theme.getThemePref()).toBeNull();
        expect(() => theme.applyTheme()).not.toThrow();
        expect(theme.setTheme("dark")).toBe("dark");
        expect(document.documentElement.dataset.theme).toBe("dark");
        dispatchSystemTheme(false);
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(theme.setTheme("light")).toBe("light");
        expect(document.documentElement.dataset.theme).toBe("light");
        dispatchSystemTheme(true);
        expect(document.documentElement.dataset.theme).toBe("light");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("[theme] localStorage unavailable; preference will not persist");
    });

    it("applies validated preference changes from another tab", () => {
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: theme.THEME_STORAGE_KEY,
                newValue: "dark",
                storageArea: localStorage,
            }),
        );
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(document.documentElement.dataset.themeUser).toBe("dark");

        systemPrefersDark = false;
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: theme.THEME_STORAGE_KEY,
                newValue: "invalid",
                storageArea: localStorage,
            }),
        );
        expect(document.documentElement.dataset.theme).toBe("light");
        expect(document.documentElement.dataset.themeUser).toBeUndefined();
    });
});

describe("pre-paint bootstrap parity", () => {
    const cases = [
        { stored: "light", dark: true, expected: "light" },
        { stored: "dark", dark: false, expected: "dark" },
        { stored: "blue", dark: true, expected: "dark" },
        { stored: null, dark: false, expected: "light" },
    ] as const;

    it.each(cases)("resolves stored=$stored and OS-dark=$dark to $expected", ({ stored, dark, expected }) => {
        jest.spyOn(Storage.prototype, "getItem").mockReturnValue(stored);
        jest.mocked(window.matchMedia).mockReturnValue({ ...mediaQuery, matches: dark });

        expect(() => new Function(bootstrapScript())()).not.toThrow();
        expect(document.documentElement.dataset.theme).toBe(expected);
        expect(document.documentElement.dataset.themeUser).toBe(
            stored === "light" || stored === "dark" ? stored : undefined,
        );
    });

    it("falls back to the OS preference when storage throws", () => {
        jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new DOMException("denied", "SecurityError");
        });
        jest.mocked(window.matchMedia).mockReturnValue({ ...mediaQuery, matches: true });

        expect(() => new Function(bootstrapScript())()).not.toThrow();
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(document.documentElement.dataset.themeUser).toBeUndefined();
    });

    it("pins the storage key and valid values shared with the inline script", () => {
        const key = bootstrapScript().match(/localStorage\.getItem\("([^"]+)"\)/)?.[1];
        expect(key).toBe(theme.THEME_STORAGE_KEY);
        expect(theme.THEME_VALUES).toEqual(["light", "dark"]);
    });
});

describe("ThemeToggle", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(ThemeToggle));
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it("advances the label, glyph state, and document theme on three consecutive clicks", async () => {
        const button = (): HTMLButtonElement => {
            const element = container.querySelector<HTMLButtonElement>("button");
            if (!element) throw new Error("Missing theme toggle");
            return element;
        };

        expect(button().getAttribute("aria-label")).toBe("Theme: System");
        expect(button().querySelector("rect")).not.toBeNull();

        await act(async () => button().click());
        expect(button().getAttribute("aria-label")).toBe("Theme: Light");
        expect(button().querySelector("circle")).not.toBeNull();
        expect(document.documentElement.dataset.theme).toBe("light");

        await act(async () => button().click());
        expect(button().getAttribute("aria-label")).toBe("Theme: Dark");
        expect(button().querySelector("rect, circle")).toBeNull();
        expect(button().querySelector("path")).not.toBeNull();
        expect(document.documentElement.dataset.theme).toBe("dark");

        await act(async () => button().click());
        expect(button().getAttribute("aria-label")).toBe("Theme: System");
        expect(button().querySelector("rect")).not.toBeNull();
        expect(document.documentElement.dataset.theme).toBe("light");
    });
});
