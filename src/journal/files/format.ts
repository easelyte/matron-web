/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Pure display helpers for the Files pane. Unit-tested; no DOM, no React.

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Human-readable byte size. 0 → "0 B"; keeps one decimal above KB (e.g. "1.4 MB"). */
export function humanizeSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${UNITS[unit]}`;
}

/**
 * Relative mtime for browsing ("just now", "5m ago", "3d ago"), falling back to an absolute
 * short date beyond a week. `mtimeMs` is epoch milliseconds; `now` is injectable for tests.
 */
export function humanizeMtime(mtimeMs: number, now: number = Date.now()): string {
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "";
    const deltaSec = Math.max(0, Math.round((now - mtimeMs) / 1000));
    if (deltaSec < 45) return "just now";
    const min = Math.round(deltaSec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(mtimeMs).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Lowercase extension without the dot (e.g. "ts"), or "" when there is none. */
export function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) return "";
    return name.slice(dot + 1).toLowerCase();
}

/** Join a directory path with a child name (single separator, no trailing slash). */
export function joinPath(dir: string, name: string): string {
    return `${dir.replace(/\/+$/, "")}/${name}`;
}

export interface Crumb {
    label: string;
    path: string;
}

function basename(path: string): string {
    const clean = path.replace(/\/+$/, "");
    return clean === "" ? "/" : clean.slice(clean.lastIndexOf("/") + 1) || "/";
}

/**
 * Breadcrumb from the configured read-`root` DOWN to `path`, inclusive — NEVER above the jail (F4).
 * The first crumb is the root (labelled by its basename); segments above root are never rendered or
 * navigable. When `path` is not under `root` (shouldn't happen), only the root crumb is returned.
 */
export function breadcrumb(root: string, path: string): Crumb[] {
    const cleanRoot = root.replace(/\/+$/, "") || "/";
    const cleanPath = path.replace(/\/+$/, "") || "/";
    const crumbs: Crumb[] = [{ label: basename(cleanRoot), path: cleanRoot }];
    if (cleanPath === cleanRoot) return crumbs;
    const prefix = cleanRoot === "/" ? "/" : `${cleanRoot}/`;
    if (!cleanPath.startsWith(prefix)) return crumbs;
    const rest = cleanPath
        .slice(cleanRoot === "/" ? 1 : cleanRoot.length)
        .split("/")
        .filter(Boolean);
    let acc = cleanRoot === "/" ? "" : cleanRoot;
    for (const part of rest) {
        acc += `/${part}`;
        crumbs.push({ label: part, path: acc });
    }
    return crumbs;
}
