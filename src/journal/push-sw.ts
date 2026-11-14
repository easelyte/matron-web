/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

export type PushKind = "attention" | "done" | "activity";
export interface PushContent {
    v: 1;
    title: string;
    subtitle?: string;
    body: string;
    convo_id: string;
    seq: number;
    kind: PushKind;
    item?: { id: string; num: number; kind: string; actions: string[]; reply_to?: string };
}
export interface WindowClientLike {
    url: string;
    focused: boolean;
    visibilityState: string;
    focus(): Promise<unknown>;
    postMessage(message: unknown): void;
}
export interface WorkerEventLike {
    data?: { json(): unknown } | null;
    notification?: { data?: { convo_id?: string; seq?: number } | null; close(): void };
    waitUntil(promise: Promise<unknown>): void;
}
export interface ServiceWorkerScopeLike {
    registration: {
        scope: string;
        showNotification(title: string, options: NotificationOptions & { renotify?: boolean }): Promise<void>;
    };
    clients: {
        matchAll(options: { type: "window"; includeUncontrolled?: boolean }): Promise<WindowClientLike[]>;
        openWindow(url: string): Promise<unknown>;
        claim(): Promise<void>;
    };
    skipWaiting(): Promise<void>;
    addEventListener(type: string, listener: (event: WorkerEventLike) => void): void;
}
function boundedString(value: unknown, cap: number): value is string {
    return typeof value === "string" && value.length <= cap;
}

function validConvoId(value: unknown): value is string {
    return boundedString(value, 128) && value.length > 0;
}

export function notificationTag(convoId: string): string {
    return `matron:${convoId}`;
}

export function parsePushPayload(raw: unknown): PushContent | null {
    try {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const obj = raw as Record<string, unknown>;
        if (
            obj.v !== 1 ||
            !boundedString(obj.title, 256) ||
            obj.title.length === 0 ||
            !boundedString(obj.body, 4096) ||
            !validConvoId(obj.convo_id) ||
            typeof obj.seq !== "number" ||
            !Number.isFinite(obj.seq) ||
            !Number.isInteger(obj.seq) ||
            !["attention", "done", "activity"].includes(obj.kind as string)
        )
            return null;
        const content: PushContent = {
            v: 1,
            title: obj.title,
            body: obj.body,
            convo_id: obj.convo_id,
            seq: obj.seq,
            kind: obj.kind as PushKind,
        };
        if (obj.subtitle !== undefined) {
            if (!boundedString(obj.subtitle, 256)) return null;
            content.subtitle = obj.subtitle;
        }
        if (obj.item !== undefined) {
            if (!obj.item || typeof obj.item !== "object" || Array.isArray(obj.item)) return null;
            const item = obj.item as Record<string, unknown>;
            if (
                !boundedString(item.id, 128) ||
                !boundedString(item.kind, 128) ||
                typeof item.num !== "number" ||
                !Number.isSafeInteger(item.num) ||
                !Array.isArray(item.actions) ||
                item.actions.length > 32 ||
                !item.actions.every((action) => boundedString(action, 128)) ||
                (item.reply_to !== undefined && !boundedString(item.reply_to, 128))
            )
                return null;
            content.item = { id: item.id, num: item.num, kind: item.kind, actions: [...item.actions] };
            if (typeof item.reply_to === "string") content.item.reply_to = item.reply_to;
        }
        return content;
    } catch {
        return null;
    }
}

export function fallbackContent(kind?: PushKind): { title: string; body: string } {
    return {
        title: "Matron",
        body:
            kind === "attention"
                ? "Your agent needs you"
                : kind === "done"
                  ? "Your agent finished its turn"
                  : "New activity from your agent",
    };
}

export function decidePushDisplay(windows: { visibilityState: string; focused: boolean }[]): "show" | "skip" {
    return windows.some((win) => win.visibilityState === "visible" && win.focused) ? "skip" : "show";
}

export function buildNotification(content: PushContent | null): {
    title: string;
    options: NotificationOptions & { renotify?: boolean };
} {
    if (!content) {
        const fallback = fallbackContent();
        return { title: fallback.title, options: { body: fallback.body } };
    }
    return {
        title: content.title,
        options: {
            body: content.body,
            tag: notificationTag(content.convo_id),
            renotify: content.kind !== "activity",
            data: { convo_id: content.convo_id, seq: content.seq },
        },
    };
}

/** Whether a window is one of the app's own pages: same origin, under the worker's scope. */
function inScope(url: string, scope: URL): boolean {
    try {
        const parsed = new URL(url);
        return parsed.origin === scope.origin && parsed.pathname.startsWith(scope.pathname);
    } catch {
        return false;
    }
}

export function routeNotificationClick(input: {
    convoId: string | null;
    windows: { url: string; focused: boolean }[];
    scope: string;
}):
    | { action: "focus"; index: number; message?: { type: "matron-open-convo"; convoId: string } }
    | { action: "open"; url: string }
    | null {
    try {
        const scope = new URL(input.scope);
        // A notification without a usable conversation (the generic wake hint) still opens the app.
        const convoId = validConvoId(input.convoId) ? input.convoId : null;
        const candidates = input.windows
            .map((win, index) => ({ ...win, index }))
            .filter((win) => inScope(win.url, scope));
        const target = candidates.find((win) => win.focused) ?? candidates[0];
        if (target)
            return convoId
                ? { action: "focus", index: target.index, message: { type: "matron-open-convo", convoId } }
                : { action: "focus", index: target.index };
        return { action: "open", url: convoId ? input.scope + "#convo=" + encodeURIComponent(convoId) : input.scope };
    } catch {
        return null;
    }
}

export function parseConvoHash(hash: string): string | null {
    if (!hash.startsWith("#convo=") || hash.length > 7 + 128 * 12) return null;
    try {
        const id = decodeURIComponent(hash.slice(7));
        return validConvoId(id) ? id : null;
    } catch {
        return null;
    }
}

export function installPushHandlers(scope: ServiceWorkerScopeLike): void {
    // Pages of the same origin outside the app (an admin page, say) have no notifier, so only the
    // app's own windows can cover a push.
    const appWindows = async (): Promise<WindowClientLike[]> => {
        const all = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
        const appScope = new URL(scope.registration.scope);
        return all.filter((win) => inScope(win.url, appScope));
    };
    const show = async (content: PushContent | null): Promise<void> => {
        const built = buildNotification(content);
        await scope.registration.showNotification(built.title, built.options);
    };
    scope.addEventListener("push", (event) => {
        event.waitUntil(
            (async () => {
                try {
                    const content = parsePushPayload(event.data?.json());
                    const windows = await appWindows();
                    if (decidePushDisplay(windows) === "show") await show(content);
                } catch {
                    // Even an unreadable payload or failed lookup must produce a visible wake hint.
                    try {
                        await show(null);
                    } catch {
                        /* The browser may refuse notifications. */
                    }
                }
            })(),
        );
    });
    scope.addEventListener("notificationclick", (event) => {
        event.notification?.close();
        event.waitUntil(
            (async () => {
                try {
                    const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
                    const route = routeNotificationClick({
                        convoId: event.notification?.data?.convo_id ?? null,
                        windows,
                        scope: scope.registration.scope,
                    });
                    if (route?.action === "focus") {
                        await windows[route.index].focus();
                        if (route.message) windows[route.index].postMessage(route.message);
                    } else if (route?.action === "open") await scope.clients.openWindow(route.url);
                } catch {
                    /* A closed window or denied navigation needs no further action. */
                }
            })(),
        );
    });
    scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
    scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));
}
