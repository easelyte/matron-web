/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Matron File Explorer — client-side file API (Phase 1 read + Phase 2 writes).
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
 * Phase 2 adds the write half (upload / mkdir / move / write / delete). Those methods exist on the
 * client unconditionally; what gates them is the SERVER — `GET /files/list` returns `writable`, and
 * the pane renders no write affordance unless it is true. The backend ships dormant behind
 * MATRON_FILE_ENABLE_WRITES (routes unregistered → 404) and can also run in dry-run mode (routes
 * live, validated + audited, no fs mutation, `{dry_run:true}` + `writable:false`), so "the call
 * exists" never implies "the server will write". Every guard (write-root containment, sensitivity
 * denylist, overwrite/confirm flags, size caps) is SERVER-side; the client only asks and reports.
 *
 * DESKTOP (Electron): this uses renderer fetch, which the packaged app
 * can't use from the matron:// origin (no CORS preflight; desktop transport is IPC). The Files
 * entry point is feature-gated OFF when window.electron is present — see components.tsx. TODO:
 * desktop support needs the bridge to return binary bodies over journalRequest (follow-up).
 */

import { JournalApiError } from "../api";
import { endpointUrl } from "../types";
import { joinPath } from "./format";
import { DOWNLOAD_URL_TTL_MS, FETCH_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "./limits";

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
    /**
     * Phase 2: the server will accept writes INTO this directory (it is inside a write-root, writes
     * are enabled, and it is not in dry-run). Absent on a Phase-1 server ⇒ false ⇒ the pane renders
     * a pure read-only browser. This is a CAPABILITY HINT for the UI, never the enforcement point.
     */
    writable: boolean;
}

/** Result of a write that produced bytes (`POST /files/upload`, `POST /files/write`). */
export interface FileWriteResult {
    path: string;
    bytes: number;
    /** Server ran in dry-run: it validated + audited the intent and changed nothing on disk. */
    dryRun: boolean;
}

/** Result of `POST /files/mkdir`. */
export interface DirWriteResult {
    path: string;
    dryRun: boolean;
}

/** Result of `POST /files/move` (also the rename path — rename is a move within one directory). */
export interface MoveResult {
    from: string;
    to: string;
    dryRun: boolean;
}

/**
 * Result of `DELETE /files`. Discriminated per the wire contract: a real delete returns the trash
 * destination in `trashed`; an idempotent delete of an already-absent path returns
 * `{trashed:null, alreadyMissing:true}` rather than inventing a synthetic trash path.
 */
export interface DeleteResult {
    path: string;
    trashed: string | null;
    alreadyMissing: boolean;
    dryRun: boolean;
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

    // ── Phase-2 writes. Only reachable from UI that the server said is `writable`. ──────────────
    /**
     * Stream a file into `targetDir`. Raw HTTP carries no `File.name`, so the FULL destination path
     * goes in the query (`?path=<dir>/<sanitized-name>`); the server sanitizes the basename again.
     * An `Idempotency-Key` is generated when the caller does not supply one, so a retry after a lost
     * response replays the prior result instead of writing twice.
     */
    upload(
        file: File,
        opts: { targetDir: string; name?: string; idempotencyKey?: string; signal?: AbortSignal },
    ): Promise<FileWriteResult>;
    /** Create a directory (mkdir-p on the server; creating an existing dir is idempotent). */
    mkdir(path: string, signal?: AbortSignal): Promise<DirWriteResult>;
    /** Move / rename. The server refuses an existing destination (409) — it never clobbers. */
    move(from: string, to: string, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<MoveResult>;
    /**
     * Write text content. Replacing an existing file REQUIRES `overwrite:true` (server-enforced
     * explicit confirm); the server copies the prior version into `.matron-trash/` first, so an
     * overwrite stays recoverable.
     */
    writeFile(
        path: string,
        content: string,
        opts?: { overwrite?: boolean; idempotencyKey?: string; signal?: AbortSignal },
    ): Promise<FileWriteResult>;
    /**
     * Delete → the server MOVES the target into `.matron-trash/` (recoverable, not an unlink).
     * `confirm` is a required literal `true` so no call site can reach a destructive delete without
     * having written the confirmation down; it is sent as `confirm=1`, which the server also
     * enforces. A directory needs `recursive` unless it is empty.
     */
    deleteEntry(
        path: string,
        opts: { confirm: true; recursive?: boolean; signal?: AbortSignal },
    ): Promise<DeleteResult>;
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

/** Internal shape for the extra request knobs a write needs (method/body/headers/timeout). */
interface RequestInit_ {
    method?: string;
    body?: BodyInit;
    contentType?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
}

/**
 * Reduce an operator-typed or OS-supplied name to a single safe path component. This is UX, NOT
 * enforcement — the server sanitizes the basename again and re-validates the whole target against
 * the write-roots. Strips any directory part (so "../../etc/passwd" collapses to "passwd"), drops
 * control characters, and refuses the dot-only names that would resolve to a directory.
 */
export function sanitizeFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? "";
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (cleaned === "" || cleaned === "." || cleaned === "..") return "";
    return cleaned.slice(0, 255);
}

function newIdempotencyKey(): string {
    // Same source the client uses for pending-message ids; a retry of a lost response replays the
    // server's stored result instead of writing twice.
    return crypto.randomUUID();
}

function isDryRun(raw: unknown): boolean {
    return isObject(raw) && raw.dry_run === true;
}

/**
 * A write response that does not match the contract is NOT a success. Fabricating the result from
 * the request (echoing the path we asked for, defaulting `bytes` to 0, `trashed` to null) would let
 * a proxy-truncated body, a partial rollout, or schema drift close the dialog and advance an upload
 * queue while the client has no idea whether anything was written, dry-run, or trashed. Fail loud
 * instead and tell the operator to go look.
 */
function unconfirmed(): never {
    throw new JournalApiError(
        "The server's reply didn't match what this version expects, so the change could not be confirmed. Reload the folder to see what actually happened.",
        0,
        "unconfirmed",
    );
}

function requiredString(value: unknown): string {
    if (typeof value !== "string" || value === "") unconfirmed();
    return value;
}

function parseWriteResult(raw: unknown): FileWriteResult {
    if (isDryRun(raw)) return { path: "", bytes: 0, dryRun: true };
    if (!isObject(raw) || typeof raw.bytes !== "number" || !Number.isFinite(raw.bytes)) unconfirmed();
    return { path: requiredString(raw.path), bytes: raw.bytes, dryRun: false };
}

function parseDirResult(raw: unknown): DirWriteResult {
    if (isDryRun(raw)) return { path: "", dryRun: true };
    if (!isObject(raw)) unconfirmed();
    return { path: requiredString(raw.path), dryRun: false };
}

function parseMoveResult(raw: unknown): MoveResult {
    if (isDryRun(raw)) return { from: "", to: "", dryRun: true };
    if (!isObject(raw)) unconfirmed();
    return { from: requiredString(raw.from), to: requiredString(raw.to), dryRun: false };
}

function parseDeleteResult(raw: unknown): DeleteResult {
    if (isDryRun(raw)) return { path: "", trashed: null, alreadyMissing: false, dryRun: true };
    // `trashed` is string|null and `already_missing` boolean per the contract — both discriminate a
    // real delete from an idempotent no-op, so neither may be guessed.
    if (!isObject(raw) || typeof raw.already_missing !== "boolean") unconfirmed();
    if (raw.trashed !== null && typeof raw.trashed !== "string") unconfirmed();
    return {
        path: requiredString(raw.path),
        trashed: raw.trashed === null || raw.trashed === "" ? null : raw.trashed,
        alreadyMissing: raw.already_missing,
        dryRun: false,
    };
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
            // Phase-1 servers omit the flag entirely — absent ⇒ read-only, never assumed writable.
            writable: raw.writable === true,
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

    // ── Phase-2 writes ────────────────────────────────────────────────────────────────────────
    // Every write goes through the same request() core as the reads: Bearer auth, lifecycle +
    // per-view + timeout aborts, and a typed JournalApiError carrying the server's status so the
    // caller can branch (403 denied / 409 conflict / 413 too large / 507 storage / 404 disabled).

    public async upload(
        file: File,
        opts: { targetDir: string; name?: string; idempotencyKey?: string; signal?: AbortSignal },
    ): Promise<FileWriteResult> {
        const name = sanitizeFileName(opts.name ?? file.name);
        // An empty sanitized name means the input was ONLY separators/dots/control chars. Refuse
        // locally rather than POST a directory-shaped target and let the server guess (P19a: all
        // validation before the mutation).
        if (!name) throw new JournalApiError("That file name can't be used.", 0, "invalid-name");
        const target = joinPath(opts.targetDir, name);
        const query = new URLSearchParams({ path: target });
        // The body is the File itself — the browser streams it, so a large upload never has to be
        // buffered into an ArrayBuffer first (mirrors the server's streamed receiveBlob).
        const raw = await this.fetchJson(`/files/upload?${query.toString()}`, opts.signal, {
            method: "POST",
            body: file,
            contentType: file.type || "application/octet-stream",
            idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
            timeoutMs: WRITE_TIMEOUT_MS,
        });
        const result = parseWriteResult(raw);
        return result.dryRun ? { ...result, path: target } : result;
    }

    public async mkdir(path: string, signal?: AbortSignal): Promise<DirWriteResult> {
        const raw = await this.postJson("/files/mkdir", { path }, signal);
        const result = parseDirResult(raw);
        return result.dryRun ? { ...result, path } : result;
    }

    public async move(
        from: string,
        to: string,
        opts?: { idempotencyKey?: string; signal?: AbortSignal },
    ): Promise<MoveResult> {
        const raw = await this.postJson("/files/move", { from, to }, opts?.signal, opts?.idempotencyKey);
        const result = parseMoveResult(raw);
        return result.dryRun ? { ...result, from, to } : result;
    }

    public async writeFile(
        path: string,
        content: string,
        opts?: { overwrite?: boolean; idempotencyKey?: string; signal?: AbortSignal },
    ): Promise<FileWriteResult> {
        // `overwrite` is only sent when true: the server treats its absence as "create only" and
        // answers 409 overwrite-conflict, which is the safe default for a lost/garbled flag.
        const payload: Record<string, unknown> = { path, content };
        if (opts?.overwrite) payload.overwrite = true;
        const raw = await this.postJson(
            "/files/write",
            payload,
            opts?.signal,
            opts?.idempotencyKey ?? newIdempotencyKey(),
            WRITE_TIMEOUT_MS,
        );
        const result = parseWriteResult(raw);
        return result.dryRun ? { ...result, path } : result;
    }

    public async deleteEntry(
        path: string,
        opts: { confirm: true; recursive?: boolean; signal?: AbortSignal },
    ): Promise<DeleteResult> {
        const query = new URLSearchParams({ path, recursive: opts.recursive ? "1" : "0", confirm: "1" });
        const raw = await this.fetchJson(`/files?${query.toString()}`, opts.signal, { method: "DELETE" });
        const result = parseDeleteResult(raw);
        return result.dryRun ? { ...result, path } : result;
    }

    private postJson(
        path: string,
        payload: Record<string, unknown>,
        signal?: AbortSignal,
        idempotencyKey?: string,
        timeoutMs?: number,
    ): Promise<unknown> {
        return this.fetchJson(path, signal, {
            method: "POST",
            body: JSON.stringify(payload),
            contentType: "application/json",
            idempotencyKey,
            timeoutMs,
        });
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

    private fetchJson(path: string, signal?: AbortSignal, init?: RequestInit_): Promise<unknown> {
        return this.request(
            path,
            signal,
            async (response) => {
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
            },
            init,
        );
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
        init?: RequestInit_,
    ): Promise<T> {
        if (this.disposed) throw new JournalApiError("The session ended.", 0, "disposed");
        if (!this.token) throw new JournalApiError("Not signed in.", 401, "unauthenticated");

        const timeout = new AbortController();
        // Writes carry a body over a phone link and get the longer WRITE_TIMEOUT_MS; reads keep the
        // 30 s read deadline. Bounded either way — a stalled socket always fails visibly.
        const timer = setTimeout(() => timeout.abort(), init?.timeoutMs ?? FETCH_TIMEOUT_MS);
        const signals = [this.lifecycle.signal, timeout.signal];
        if (signal) signals.push(signal);
        const combined = AbortSignal.any(signals);

        const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
        if (init?.contentType) headers["Content-Type"] = init.contentType;
        if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

        try {
            const response = await fetch(endpointUrl(this.serverUrl, path), {
                method: init?.method ?? "GET",
                body: init?.body,
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
                throw new JournalApiError(messageForFileStatus(response.status), response.status, code);
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

/**
 * Load a file for the inline EDITOR, decoding strictly.
 *
 * `textContent` decodes non-fatally (a preview should render something for a stray bad byte), but
 * an editor must not: saving a non-fatally-decoded string writes U+FFFD back over the original
 * bytes and corrupts the file. A fatal decode is also the only way to tell "these bytes are not
 * UTF-8" from "this valid file legitimately CONTAINS U+FFFD" — a content sniff cannot, and would
 * refuse to edit a perfectly good file.
 *
 * Returns a discriminated result rather than throwing for the not-text case, so the caller can
 * render a specific refusal instead of the uniform transport-error copy.
 */
export async function readEditableText(
    api: Pick<FilesApiLike, "fileBytes">,
    path: string,
    signal?: AbortSignal,
): Promise<EditableText> {
    const bytes = await api.fileBytes(path, { signal });
    try {
        // `ignoreBOM: true` is a misnomer for "do not EAT the BOM": without it TextDecoder strips a
        // leading U+FEFF, and since this string seeds both the editor and the staleness baseline,
        // saving would write back three fewer bytes than were read — an ordinary edit silently
        // dropping a valid byte sequence that downstream Windows/legacy tooling sniffs for.
        return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
        return { ok: false };
    }
}

export type EditableText = { ok: true; text: string } | { ok: false };

// Uniform, reason-agnostic operator-facing copy. The server deliberately does not leak WHY a path
// was denied (sensitive vs outside-scope both map to 403), so the client mustn't either.
export function messageForFileStatus(status: number, code?: string): string {
    if (code === "timeout") return "This took too long to load. Try again.";
    switch (status) {
        case 403:
            return "This file or folder can't be accessed.";
        case 404:
            return "This file or folder no longer exists.";
        case 409:
            // 409 covers every "the server refused because the change would collide or was not
            // explicitly confirmed": name already taken, destination exists, folder not empty,
            // overwrite without the flag. Uniform + reason-agnostic, like the 403 above.
            return "That change conflicts with what's already there. Check the name and try again.";
        case 413:
            return "This file is too large to preview — download it instead.";
        case 507:
            return "The server couldn't complete this safely. Nothing was changed.";
        case 401:
            return "Your session expired. Sign in again.";
        default:
            return status === 0 ? "Couldn't reach the server." : "Something went wrong loading this file.";
    }
}
