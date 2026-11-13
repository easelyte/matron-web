/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApiError } from "../api";
import { endpointUrl } from "../types";
import { DOWNLOAD_URL_TTL_MS, FETCH_TIMEOUT_MS } from "./limits";

export type FileEntryKind = "dir" | "file" | "other";

export interface FileMeta {
    kind: FileEntryKind;
    size: number;
    mtime: number;
    mime: string;
    /** Server-side text sniff — drives the markdown/code vs binary preview split. */
    isText: boolean;
}

export type ContentDisposition = "inline" | "attachment";

export interface FilesApiLike {
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

export class FilesApi implements FilesApiLike {
    private disposed = false;
    // Aborts every request minted by this instance in one shot (sign-out / teardown).
    private readonly lifecycle = new AbortController();
    // Inline-content object URLs, keyed by (disposition, mtime, path) so a changed mtime busts it.
    private readonly urls = new Map<string, string>();
    // Current cache key per (disposition, path): lets us revoke the PRIOR mtime generation when a
    // newer one is cached, so a long session doesn't retain every previewed revision (F2).
    private readonly generations = new Map<string, string>();
    private readonly inflight = new Map<string, Promise<string>>();
    // One-shot download URLs — deliberately NOT cached; revoked on a TTL and on dispose.
    private readonly transientUrls = new Set<string>();

    public constructor(
        private readonly serverUrl: string,
        private readonly token: string,
    ) {}

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

    public textContent(path: string, signal?: AbortSignal): Promise<string> {
        return this.request(this.contentPath(path, "inline"), signal, async (response) =>
            new TextDecoder().decode(await response.arrayBuffer()),
        );
    }

    public fileBytes(path: string, opts?: { mtime?: number; signal?: AbortSignal }): Promise<ArrayBuffer> {
        return this.request(this.contentPath(path, "inline"), opts?.signal, (response) => response.arrayBuffer());
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
                // The shared request is deliberately NOT tied to `opts.signal` (F3): a sibling
                // subscriber's teardown (StrictMode effect replay, rapid close→reopen) must not abort
                // a fetch another subscriber is still awaiting — that stranded the preview in Loading.
                // It stays bounded by the lifecycle + timeout signals inside request(); a superseded
                // view simply ignores the result (useAsyncResource's `cancelled` guard).
                const blob = await this.request(this.contentPath(path, disposition), undefined, (response) =>
                    response.blob(),
                );
                const url = URL.createObjectURL(blob);
                if (this.disposed) {
                    // Resolved after sign-out: drop it and revoke so it can't leak into the next session.
                    URL.revokeObjectURL(url);
                    throw new JournalApiError("The session ended.", 0, "disposed");
                }
                // Supersede the prior mtime generation for this (disposition, path): revoke the stale
                // URL so repeatedly previewing a rewritten file doesn't accumulate every revision (F2).
                const genKey = `${disposition}:${path}`;
                const prevKey = this.generations.get(genKey);
                if (prevKey && prevKey !== cacheKey) {
                    const prevUrl = this.urls.get(prevKey);
                    if (prevUrl) {
                        URL.revokeObjectURL(prevUrl);
                        this.urls.delete(prevKey);
                    }
                }
                this.generations.set(genKey, cacheKey);
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
        // Single-owner (not deduped) → safe to abort on the caller's signal; body read stays inside
        // the timeout via request() so a stalled attachment stream can't hang forever (F1).
        const blob = await this.request(this.contentPath(path, "attachment"), signal, (response) => response.blob());
        // Completed after sign-out → mint nothing; never save old-session bytes to disk (F3).
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
        this.generations.clear();
        for (const url of this.transientUrls) URL.revokeObjectURL(url);
        this.transientUrls.clear();
    }

    private fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
        return this.request(path, signal, async (response) => {
            const text = new TextDecoder().decode(await response.arrayBuffer());
            // An empty 2xx body is NOT "done, nothing to say": every endpoint in the contract
            // returns a body, so an empty one means something between us and the journal
            // dropped it and the outcome is unknown. The strict parsers reject it below.
            if (text.trim() === "") return undefined;
            try {
                return JSON.parse(text);
            } catch {
                throw new JournalApiError("The server returned malformed JSON.", response.status);
            }
        });
    }

    private contentPath(path: string, disposition: ContentDisposition): string {
        const query = new URLSearchParams({ path, disposition });
        return `/files/content?${query.toString()}`;
    }

    // Mirrors JournalApi.request + client.mediaUrl's lifecycle guard: Bearer auth, a bounded timeout,
    // lifecycle + per-view + timeout aborts combined, and a typed throw for any non-2xx so callers
    // branch on `.status` (403/413/404 uniform denial). Crucially the response BODY is consumed by
    // `consume` INSIDE this timeout scope (F1): a server that returns 2xx headers then stalls the body
    // aborts on the deadline instead of leaving the pane loading forever.
    private async request<T>(
        path: string,
        signal: AbortSignal | undefined,
        consume: (response: Response) => Promise<T>,
    ): Promise<T> {
        if (this.disposed) throw new JournalApiError("The session ended.", 0, "disposed");
        if (!this.token) throw new JournalApiError("Not signed in.", 401, "unauthenticated");

        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT_MS);
        const signals = [this.lifecycle.signal, timeout.signal];
        if (signal) signals.push(signal);
        const combined = AbortSignal.any(signals);

        const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };

        try {
            const response = await fetch(endpointUrl(this.serverUrl, path), {
                method: "GET",
                headers,
                signal: combined,
            });
            if (response.status < 200 || response.status >= 300) {
                let code: string | undefined;
                try {
                    const parsed: unknown = JSON.parse(await response.clone().text());
                    if (isObject(parsed) && typeof parsed.error === "string") code = parsed.error;
                } catch {
                    // Non-JSON error body — fall back to the status-only message.
                }
                throw new JournalApiError(messageForFileStatus(response.status, code), response.status, code);
            }
            return await consume(response);
        } catch (error) {
            if (this.lifecycle.signal.aborted) throw new JournalApiError("The session ended.", 0, "disposed");
            if (timeout.signal.aborted) throw new JournalApiError("The request timed out.", 0, "timeout");
            if (signal?.aborted) throw new JournalApiError("Cancelled.", 0, "aborted");
            if (error instanceof JournalApiError) throw error;
            throw new JournalApiError(error instanceof Error ? error.message : "Could not reach the server.", 0);
        } finally {
            clearTimeout(timer);
        }
    }
}

// Uniform, reason-agnostic operator-facing copy. The server deliberately does not leak WHY a path
// was denied (sensitive vs outside-scope both map to 403), so the client mustn't either.
export function messageForFileStatus(status: number, code?: string): string {
    // `timeout` is minted LOCALLY and always with status 0. Now that server-supplied `error`
    // strings reach this function, honouring the code ahead of the status would let a response body
    // rename its own status: a 401 carrying `{"error":"timeout"}` would read as a slow load rather
    // than an expired session, and invite a retry that cannot work. Transport codes only apply to
    // transport failures.
    if (code === "timeout" && status === 0) return "This took too long to load. Try again.";
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
