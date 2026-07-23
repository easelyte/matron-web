/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

export const THEME_STORAGE_KEY = "matron-theme";
export const THEME_VALUES = ["light", "dark"] as const;

export type ThemePref = (typeof THEME_VALUES)[number] | null;
export type ResolvedTheme = Exclude<ThemePref, null>;

const colorScheme =
    typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : { matches: false, addEventListener: (): void => undefined };
let warnedStorageUnavailable = false;

function warnStorageUnavailable(): void {
    if (warnedStorageUnavailable) return;
    warnedStorageUnavailable = true;
    console.warn("[theme] localStorage unavailable; preference will not persist");
}

export function getThemePref(): ThemePref {
    try {
        const value = window.localStorage.getItem(THEME_STORAGE_KEY);
        return value === "light" || value === "dark" ? value : null;
    } catch {
        warnStorageUnavailable();
        return null;
    }
}

export function applyTheme(explicit?: ThemePref): ResolvedTheme {
    const preference = explicit !== undefined ? explicit : getThemePref();
    const resolved = preference ?? (colorScheme.matches ? "dark" : "light");

    document.documentElement.dataset.theme = resolved;
    if (preference === null) {
        delete document.documentElement.dataset.themeUser;
    } else {
        document.documentElement.dataset.themeUser = preference;
    }

    return resolved;
}

export function setTheme(preference: ThemePref): ThemePref {
    try {
        if (preference === null) {
            window.localStorage.removeItem(THEME_STORAGE_KEY);
        } else {
            window.localStorage.setItem(THEME_STORAGE_KEY, preference);
        }
    } catch {
        warnStorageUnavailable();
    }

    applyTheme(preference);
    return preference;
}

export function nextThemePref(current: ThemePref): ThemePref {
    if (current === null) return "light";
    if (current === "light") return "dark";
    return null;
}

colorScheme.addEventListener("change", () => applyTheme());
