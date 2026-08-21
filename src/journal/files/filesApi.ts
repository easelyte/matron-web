/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Matron File Explorer — client-side file API (Phase 1, read-only).
 *
 * Extends the existing JournalApi Bearer-fetch pattern (see api.ts JournalApi.request) for the
 * `/files/*` endpoints the matron-journal server exposes. Same origin, same Bearer token as chat.
 * All enforcement (path-jail, secret denylist, size caps) is SERVER-SIDE — this client only renders
 * what the server returns and surfaces uniform denials (403/413/404) without leaking the reason.
 *
 * Lifecycle safety (mirrors client.mediaUrl's session-generation guard): the instance holds a
 * lifecycle AbortController and a `disposed` flag. On sign-out the client calls dispose(), which
 * aborts every in-flight request and revokes every object URL; any response that resolves AFTER
 * dispose is dropped and any URL it minted is revoked, so old-session bytes never reach the DOM or
 * a download. Per-view cancellation flows through an AbortSignal threaded into every method.
 *
 * NO write methods (Phase 2). DESKTOP (Electron): this uses renderer fetch, which the packaged app
 * can't use from the matron:// origin (no CORS preflight; desktop transport is IPC). The Files
 * entry point is feature-gated OFF when window.electron is present — see components.tsx. TODO:
 * desktop support needs the bridge to return binary bodies over journalRequest (follow-up).
 */

import { JournalApiError } from "../api";
import { endpointUrl } from "../types";
import { DOWNLOAD_URL_TTL_MS, FETCH_TIMEOUT_MS } from "./limits";

export type FileEntryKind = "dir" | "file" | "other";

export interface FileEntry {
    name: string;
    kind: FileEntryKind;
    size: number;
    /** Epoch milliseconds (server derives it from fs stat mtimeMs). */
    mtime: number;
    mime: string;
}

export interface FileListing {
    path: string;
    /**
     * The configured read-root that CONTAINS `path` (realpath-canonical), per the F4 contract.
     * Breadcrumbs are built from `root` down to `path` ONLY — never above the jail.
     */
    root: string;
    /** Parent directory, or null when `path` IS a read-root (the top boundary — never fabricated). */
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
 * The surface FilesPane depends on. The real FilesApi and the fixture mock both implement it, so
 * the visual harness can drive every state without a live backend (mirrors the mediaUrl stub).
 */
export interface FilesApiLike {
    listDir(path: string, all?: boolean, signal?: AbortSignal): Promise<FileListing>;
    fileMeta(path: string, signal?: AbortSignal): Promise<FileMeta>;
    /** Text bytes decoded as UTF-8 (markdown/code preview). Never cached — always current. */
    textContent(path: string, signal?: AbortSignal): Promise<string>;
    /** Raw bytes for the pdf.js/canvas renderer (F1). pdf.js takes ownership of the buffer. */
    fileBytes(path: string, opts?: { mtime?: number; signal?: AbortSignal }): Promise<ArrayBuffer>;
    /**
     * Blob object URL for inline media (image/audio/video). Cached by (disposition, mtime, path) so
     * an agent rewriting the file at the same path busts the cache (F7). Revoked on dispose.
     */
    contentUrl(
        path: string,
        opts: { disposition?: ContentDisposition; mtime: number; signal?: AbortSignal },
    ): Promise<string>;
    /** Stream a file to the browser's downloads. NOT session-cached; URL revoked shortly after. */
    download(path: string, filename: string, signal?: AbortSignal): Promise<void>;
    /** Abort every in-flight request and revoke every object URL. Called on sign-out / teardown. */
    dispose(): void;
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
    private disposed = false;
    // Aborts every request minted by this instance in one shot (sign-out / teardown).
    private readonly lifecycle = new AbortController();
    // Inline-content object URLs, keyed by (disposition, mtime, path) so a changed mtime busts it.
    private readonly urls = new Map<string, string>();
    private readonly inflight = new Map<string, Promise<string>>();
    // One-shot download URLs — deliberately NOT cached; revoked on a TTL and on dispose.
    private readonly transientUrls = new Set<string>();

    public constructor(
        private readonly serverUrl: string,
        private readonly token: string,
    ) {}

    public async listDir(path: string, all = false, signal?: AbortSignal): Promise<FileListing> {
        const query = new URLSearchParams({ path });
        if (all) query.set("all", "1");
        const raw = await this.fetchJson(`/files/list?${query.toString()}`, signal);
        if (!isObject(raw)) throw new JournalApiError("The server returned a malformed directory listing.", 200);
        const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
        const entries = rawEntries.map(parseEntry).filter((entry): entry is FileEntry => entry !== undefined);
        const resolvedPath = asString(raw.path) || path;
        return {
            path: resolvedPath,
            // Older server without the F4 field: fall back to the path itself so the breadcrumb
            // degrades to a single root crumb rather than manufacturing ancestors above the jail.
            root: asString(raw.root) || resolvedPath,
            parent: typeof raw.parent === "string" ? raw.parent : null,
            entries,
            truncated: raw.truncated === true,
        };
    }

    public async fileMeta(path: string, signal?: AbortSignal): Promise<FileMeta> {
        const query = new URLSearchParams({ path });
        const raw = await this.fetchJson(`/files/meta?${query.toString()}`, signal);
        if (!isObject(raw)) throw new JournalApiError("The server returned malformed file metadata.", 200);
        return {
            kind: parseKind(raw.kind),
            size: asNumber(raw.size),
            mtime: asNumber(raw.mtime),
            mime: asString(raw.mime),
            isText: raw.is_text === true,
        };
    }

    public async textContent(path: string, signal?: AbortSignal): Promise<string> {
        const response = await this.fetchContent(path, "inline", signal);
        return new TextDecoder().decode(await response.arrayBuffer());
    }

    public async fileBytes(path: string, opts?: { mtime?: number; signal?: AbortSignal }): Promise<ArrayBuffer> {
        const response = await this.fetchContent(path, "inline", opts?.signal);
        return response.arrayBuffer();
    }

    public contentUrl(
        path: string,
        opts: { disposition?: ContentDisposition; mtime: number; signal?: AbortSignal },
    ): Promise<string> {
        const disposition = opts.disposition ?? "inline";
        const cacheKey = `${disposition}:${opts.mtime}:${path}`;
        const cached = this.urls.get(cacheKey);
        if (cached) return Promise.resolve(cached);
        const pending = this.inflight.get(cacheKey);
        if (pending) return pending;
        const request = (async (): Promise<string> => {
            try {
                const response = await this.fetchContent(path, disposition, opts.signal);
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                if (this.disposed) {
                    // Resolved after sign-out: drop it and revoke so it can't leak into the next session.
                    URL.revokeObjectURL(url);
                    throw new JournalApiError("The session ended.", 0, "disposed");
                }
                this.urls.set(cacheKey, url);
                return url;
            } finally {
                this.inflight.delete(cacheKey);
            }
        })();
        this.inflight.set(cacheKey, request);
        return request;
    }

    public async download(path: string, filename: string, signal?: AbortSignal): Promise<void> {
        const response = await this.fetchContent(path, "attachment", signal);
        const blob = await response.blob();
        // Completed after sign-out → drop it; never save old-session bytes to disk (F3).
        if (this.disposed) return;
        const url = URL.createObjectURL(blob);
        this.transientUrls.add(url);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // Not session-cached: revoke shortly after the browser has claimed the blob.
        setTimeout(() => {
            if (this.transientUrls.delete(url)) URL.revokeObjectURL(url);
        }, DOWNLOAD_URL_TTL_MS);
    }

    public dispose(): void {
        this.disposed = true;
        this.lifecycle.abort();
        for (const url of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear();
        for (const url of this.transientUrls) URL.revokeObjectURL(url);
        this.transientUrls.clear();
    }

    private async fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
        const response = await this.fetchRaw(path, signal);
        const text = new TextDecoder().decode(await response.arrayBuffer());
        try {
            return JSON.parse(text);
        } catch {
            throw new JournalApiError("The server returned malformed JSON.", response.status);
        }
    }

    private fetchContent(path: string, disposition: ContentDisposition, signal?: AbortSignal): Promise<Response> {
        const query = new URLSearchParams({ path, disposition });
        return this.fetchRaw(`/files/content?${query.toString()}`, signal);
    }

    // Mirrors JournalApi.request + client.mediaUrl's lifecycle guard: Bearer auth, a bounded
    // timeout, lifecycle + per-view + timeout aborts combined, and a typed throw for any non-2xx so
    // callers branch on `.status` (403/413/404 uniform denial).
    private async fetchRaw(path: string, signal?: AbortSignal): Promise<Response> {
        if (this.disposed) throw new JournalApiError("The session ended.", 0, "disposed");
        if (!this.token) throw new JournalApiError("Not signed in.", 401, "unauthenticated");

        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT_MS);
        const signals = [this.lifecycle.signal, timeout.signal];
        if (signal) signals.push(signal);
        const combined = AbortSignal.any(signals);

        let response: Response;
        try {
            response = await fetch(endpointUrl(this.serverUrl, path), {
                headers: { Authorization: `Bearer ${this.token}` },
                signal: combined,
            });
        } catch (error) {
            if (this.lifecycle.signal.aborted) throw new JournalApiError("The session ended.", 0, "disposed");
            if (timeout.signal.aborted) throw new JournalApiError("The request timed out.", 0, "timeout");
            if (signal?.aborted) throw new JournalApiError("Cancelled.", 0, "aborted");
            throw new JournalApiError(error instanceof Error ? error.message : "Could not reach the server.", 0);
        } finally {
            clearTimeout(timer);
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

// Uniform, reason-agnostic operator-facing copy. The server deliberately does not leak WHY a path
// was denied (sensitive vs outside-scope both map to 403), so the client mustn't either.
export function messageForFileStatus(status: number, code?: string): string {
    if (code === "timeout") return "This took too long to load. Try again.";
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
