/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Matron File Explorer — client-side file API (Phase 1, read-only).
 *
 * Extends the existing JournalApi Bearer-fetch pattern (see api.ts JournalApi.request) for the
 * `/files/*` endpoints the matron-journal server exposes. Same origin, same Bearer token as
 * chat — no new auth surface. Kept in src/journal/files/ to bound fork drift; the only shared
 * touch-points are ClientState.filesView, the client accessor, and the SignedInApp branch.
 *
 * All enforcement (path-jail, secret denylist, size caps) is SERVER-SIDE — this client never
 * decides what is allowed; it only renders what the server returns and surfaces uniform denials
 * (403/413/404) without leaking which reason applied.
 *
 * NO write methods here: writes (upload/mkdir/move/write/delete) are Phase 2, behind the
 * server's MATRON_FILE_ENABLE_WRITES kill switch.
 */

import { JournalApiError } from "../api";
import { endpointUrl } from "../types";

export type FileEntryKind = "dir" | "file" | "other";

export interface FileEntry {
    name: string;
    kind: FileEntryKind;
    size: number;
    /** Epoch milliseconds (assumed — the server derives it from fs stat mtimeMs). */
    mtime: number;
    mime: string;
}

export interface FileListing {
    path: string;
    /** Parent directory path, or null at a read-root boundary. */
    parent: string | null;
    entries: FileEntry[];
    /** True when the directory exceeded MATRON_FILE_LIST_MAX and was capped. */
    truncated: boolean;
}

export interface FileMeta {
    kind: FileEntryKind;
    size: number;
    mtime: number;
    mime: string;
    /** Server-side text sniff — drives the markdown/code vs binary preview split. */
    isText: boolean;
}

export type ContentDisposition = "inline" | "attachment";

/**
 * The surface FilesPane depends on. The real FilesApi and the fixture mock both implement it,
 * so the visual harness can drive every state without a live backend (mirrors how the fixture
 * stubs client.mediaUrl).
 */
export interface FilesApiLike {
    listDir(path: string, all?: boolean): Promise<FileListing>;
    fileMeta(path: string): Promise<FileMeta>;
    /** Fetch a text file's bytes decoded as UTF-8 (markdown/code preview). */
    textContent(path: string): Promise<string>;
    /** Blob object URL for inline media (image/pdf/audio/video); cached + revoked on teardown. */
    contentUrl(path: string, disposition?: ContentDisposition): Promise<string>;
    /** Stream a file to the browser's downloads (attachment disposition). */
    download(path: string, filename: string): Promise<void>;
    /** Revoke every cached object URL. Called on session teardown / pane unmount. */
    revokeAll(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseKind(value: unknown): FileEntryKind {
    return value === "dir" || value === "other" ? value : "file";
}

function parseEntry(raw: unknown): FileEntry | undefined {
    if (!isObject(raw)) return undefined;
    const name = asString(raw.name);
    if (!name) return undefined;
    return {
        name,
        kind: parseKind(raw.kind),
        size: asNumber(raw.size),
        mtime: asNumber(raw.mtime),
        mime: asString(raw.mime),
    };
}

export class FilesApi implements FilesApiLike {
    private readonly urls = new Map<string, string>();
    private readonly inflight = new Map<string, Promise<string>>();

    public constructor(
        private readonly serverUrl: string,
        private readonly token: string,
    ) {}

    public async listDir(path: string, all = false): Promise<FileListing> {
        const query = new URLSearchParams({ path });
        if (all) query.set("all", "1");
        const raw = await this.fetchJson(`/files/list?${query.toString()}`);
        if (!isObject(raw)) throw new JournalApiError("The server returned a malformed directory listing.", 200);
        const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
        const entries = rawEntries.map(parseEntry).filter((entry): entry is FileEntry => entry !== undefined);
        return {
            path: asString(raw.path) || path,
            parent: typeof raw.parent === "string" ? raw.parent : null,
            entries,
            truncated: raw.truncated === true,
        };
    }

    public async fileMeta(path: string): Promise<FileMeta> {
        const query = new URLSearchParams({ path });
        const raw = await this.fetchJson(`/files/meta?${query.toString()}`);
        if (!isObject(raw)) throw new JournalApiError("The server returned malformed file metadata.", 200);
        return {
            kind: parseKind(raw.kind),
            size: asNumber(raw.size),
            mtime: asNumber(raw.mtime),
            mime: asString(raw.mime),
            isText: raw.is_text === true,
        };
    }

    public async textContent(path: string): Promise<string> {
        const response = await this.fetchContent(path, "inline");
        return new TextDecoder().decode(await response.arrayBuffer());
    }

    public contentUrl(path: string, disposition: ContentDisposition = "inline"): Promise<string> {
        const cacheKey = `${disposition}:${path}`;
        const cached = this.urls.get(cacheKey);
        if (cached) return Promise.resolve(cached);
        const pending = this.inflight.get(cacheKey);
        if (pending) return pending;
        const request = (async (): Promise<string> => {
            try {
                const response = await this.fetchContent(path, disposition);
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                this.urls.set(cacheKey, url);
                return url;
            } finally {
                this.inflight.delete(cacheKey);
            }
        })();
        this.inflight.set(cacheKey, request);
        return request;
    }

    public async download(path: string, filename: string): Promise<void> {
        const url = await this.contentUrl(path, "attachment");
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    public revokeAll(): void {
        for (const url of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear();
    }

    private async fetchJson(path: string): Promise<unknown> {
        const response = await this.fetchRaw(path);
        const text = new TextDecoder().decode(await response.arrayBuffer());
        try {
            return JSON.parse(text);
        } catch {
            throw new JournalApiError("The server returned malformed JSON.", response.status);
        }
    }

    private async fetchContent(path: string, disposition: ContentDisposition): Promise<Response> {
        const query = new URLSearchParams({ path, disposition });
        return this.fetchRaw(`/files/content?${query.toString()}`);
    }

    // Mirrors JournalApi.request: Bearer auth, network errors as status-0 JournalApiError, and a
    // typed throw for any non-2xx so callers can branch on `.status` (403/413/404 uniform denial).
    private async fetchRaw(path: string): Promise<Response> {
        if (!this.token) throw new JournalApiError("Not signed in.", 401, "unauthenticated");
        let response: Response;
        try {
            response = await fetch(endpointUrl(this.serverUrl, path), {
                headers: { Authorization: `Bearer ${this.token}` },
            });
        } catch (error) {
            throw new JournalApiError(error instanceof Error ? error.message : "Could not reach the server.", 0);
        }
        if (response.status < 200 || response.status >= 300) {
            let code: string | undefined;
            try {
                const parsed: unknown = JSON.parse(await response.clone().text());
                if (isObject(parsed) && typeof parsed.error === "string") code = parsed.error;
            } catch {
                // Non-JSON error body — fall back to the status-only message.
            }
            throw new JournalApiError(messageForFileStatus(response.status), response.status, code);
        }
        return response;
    }
}

// Uniform, reason-agnostic operator-facing copy. The server deliberately does not leak WHY a
// path was denied (sensitive vs outside-scope both map to 403), so the client mustn't either.
export function messageForFileStatus(status: number): string {
    switch (status) {
        case 403:
            return "This file or folder can't be accessed.";
        case 404:
            return "This file or folder no longer exists.";
        case 413:
            return "This file is too large to preview — download it instead.";
        case 401:
            return "Your session expired. Sign in again.";
        default:
            return status === 0 ? "Couldn't reach the server." : "Something went wrong loading this file.";
    }
}
