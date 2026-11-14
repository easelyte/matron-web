/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Review follow-ups for Web Push: one alert per event, cleanup of subscriptions the page no
// longer knows about, notifications that open the app even without a conversation, and windows
// outside the app's scope never swallowing a push.

import { type LiveListener, MatronJournalClient } from "../../../src/journal/client";
import { DesktopNotifier, type NotificationConstructorLike } from "../../../src/journal/notifications";
import {
    installPushHandlers,
    parsePushPayload,
    routeNotificationClick,
    type ServiceWorkerScopeLike,
    type WorkerEventLike,
} from "../../../src/journal/push-sw";
import type { ClientState, JournalEvent, Session } from "../../../src/journal/types";
import { pushScope, WebPushRegistrar, type WebPushEnvironment } from "../../../src/journal/web-push";

const session: Session = {
    serverUrl: "https://example.com",
    token: "alice-token",
    userId: 1,
    deviceId: 1,
    username: "alice",
};
const scopeUrl = "https://example.com/app/";
const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
});

// ── the worker ──

function worker(windows: Partial<{ url: string; focused: boolean; visibilityState: string }>[] = [{}]) {
    const listeners = new Map<string, (event: WorkerEventLike) => void>();
    const clients = windows.map((win) => ({
        url: scopeUrl,
        focused: false,
        visibilityState: "hidden",
        focus: jest.fn().mockResolvedValue(undefined),
        postMessage: jest.fn(),
        ...win,
    }));
    const scope = {
        registration: { scope: scopeUrl, showNotification: jest.fn().mockResolvedValue(undefined) },
        clients: {
            matchAll: jest.fn().mockResolvedValue(clients),
            openWindow: jest.fn().mockResolvedValue(undefined),
            claim: jest.fn().mockResolvedValue(undefined),
        },
        skipWaiting: jest.fn().mockResolvedValue(undefined),
        addEventListener: (type: string, listener: (event: WorkerEventLike) => void) => {
            listeners.set(type, listener);
        },
    } satisfies ServiceWorkerScopeLike;
    installPushHandlers(scope);
    async function fire(type: string, fields: Partial<WorkerEventLike> = {}) {
        const pending: Promise<unknown>[] = [];
        listeners.get(type)?.({ ...fields, waitUntil: (promise) => void pending.push(promise) });
        await Promise.all(pending);
    }
    return { scope, clients, fire };
}
const valid = { v: 1, title: "Chat", body: "Needs you", convo_id: "c1", seq: 7, kind: "attention" };

it("a focused page outside the app's scope does not swallow a push", async () => {
    const { scope, fire } = worker([{ url: "https://example.com/admin/", focused: true, visibilityState: "visible" }]);
    await fire("push", { data: { json: () => valid } });
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1);
});
it("a focused page inside the scope still covers the push", async () => {
    const { scope, fire } = worker([{ focused: true, visibilityState: "visible" }]);
    await fire("push", { data: { json: () => valid } });
    expect(scope.registration.showNotification).not.toHaveBeenCalled();
});
it("clicking a fallback notification (no conversation) focuses the app without a message", async () => {
    const { clients, fire } = worker();
    await fire("notificationclick", { notification: { data: undefined as never, close: jest.fn() } });
    expect(clients[0].focus).toHaveBeenCalledTimes(1);
    expect(clients[0].postMessage).not.toHaveBeenCalled();
});
it("clicking a fallback notification with no window opens the app scope", async () => {
    const { scope, fire } = worker([]);
    await fire("notificationclick", { notification: { data: undefined as never, close: jest.fn() } });
    expect(scope.clients.openWindow).toHaveBeenCalledWith(scopeUrl);
});
it("routeNotificationClick without a conversation never builds a hash", () => {
    expect(routeNotificationClick({ convoId: null, windows: [], scope: scopeUrl })).toEqual({
        action: "open",
        url: scopeUrl,
    });
    expect(
        routeNotificationClick({ convoId: "", windows: [{ url: scopeUrl, focused: false }], scope: scopeUrl }),
    ).toEqual({ action: "focus", index: 0 });
});
it("a payload with an empty title is not trusted", () => {
    expect(parsePushPayload({ ...valid, title: "" })).toBeNull();
});

// ── the registrar ──

const keyBytes = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
function registrar(existing: boolean) {
    const subscription = {
        endpoint: "https://push.example.com/alice",
        options: { applicationServerKey: keyBytes.buffer },
        toJSON: jest.fn(() => ({ endpoint: "https://push.example.com/alice", keys: { p256dh: "k", auth: "a" } })),
        unsubscribe: jest.fn().mockResolvedValue(true),
    };
    const pushManager = {
        getSubscription: jest.fn().mockResolvedValue(existing ? subscription : null),
        subscribe: jest.fn().mockResolvedValue(subscription),
    };
    const api = {
        webPushVapidKey: jest.fn().mockResolvedValue({ public_key: Buffer.from(keyBytes).toString("base64url") }),
        registerWebPush: jest.fn().mockResolvedValue({ ok: true }),
    };
    const env: WebPushEnvironment = {
        serviceWorker: {
            register: jest.fn().mockResolvedValue({ pushManager }),
            getRegistration: jest.fn().mockResolvedValue({ pushManager }),
        },
        PushManager: {},
        Notification: { permission: "granted" },
        api: () => api,
        scope: "/",
    };
    return { registrar: new WebPushRegistrar(env), api, subscription, pushManager };
}

it("turning push off after a reload removes a subscription an earlier page created", async () => {
    const f = registrar(true);
    await f.registrar.sync(session, false);
    expect(f.api.registerWebPush).toHaveBeenCalledWith({ endpoint: null });
    expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
});
it("turning push off with no subscription costs no request", async () => {
    const f = registrar(false);
    await f.registrar.sync(session, false);
    expect(f.api.registerWebPush).not.toHaveBeenCalled();
});
it("signing out unsubscribes the browser subscription even when this page never synced", async () => {
    const f = registrar(true);
    f.api.registerWebPush.mockRejectedValue(new Error("401"));
    await f.registrar.unregister(session);
    expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
});
it("an absolute public path (assets on another origin) has no usable scope", () => {
    expect(pushScope("/")).toBe("/");
    expect(pushScope("/app")).toBe("/app/");
    expect(pushScope("https://cdn.example.com/app/")).toBeNull();
});

// ── the notifier ──

function notifier(options: { active: boolean; focused: boolean }) {
    const client = new MatronJournalClient();
    const internals = client as unknown as { state: ClientState; emit(): void };
    const state = (patch: Partial<ClientState> = {}) => {
        internals.state = { ...client.getSnapshot(), phase: "signed-in", session, connection: "online", ...patch };
        internals.emit();
    };
    state();
    const shown: string[] = [];
    class FakeNotification {
        constructor(title: string) {
            shown.push(title);
        }
        static permission = "granted" as NotificationPermission;
        static requestPermission = jest.fn().mockResolvedValue("granted");
        onclick = null;
        close() {}
    }
    const webPush = {
        sync: jest.fn().mockResolvedValue(undefined),
        unregister: jest.fn().mockResolvedValue(undefined),
        active: jest.fn(() => options.active),
    };
    const doc = {
        title: "Matron",
        visibilityState: "visible",
        hasFocus: () => options.focused,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    } as unknown as Document;
    const n = new DesktopNotifier(client, {
        Notification: FakeNotification as unknown as NotificationConstructorLike,
        webPush,
        window: { focus: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn() } as unknown as Window,
        document: doc,
        storage: localStorage,
        channel: () => undefined,
        now: () => 1000,
        api: () => ({
            notifySettings: jest.fn().mockResolvedValue({ mode: "all", events: {}, convos: [], device_level: "all" }),
            updateNotify: jest.fn().mockResolvedValue(null),
            coordinator: jest.fn().mockResolvedValue({ convo_id: null }),
        }),
    });
    const stop = n.start();
    const prompt = (): JournalEvent => ({
        kind: "journal",
        seq: 5,
        convo_id: "c2",
        ts: 1000,
        sender: "agent:3",
        type: "permission_request",
        payload: { description: "ok?" },
    });
    const deliver = () =>
        (client as unknown as { emitLive(call: (l: LiveListener) => void): void }).emitLive((l) =>
            l.journalEvent?.(prompt(), undefined),
        );
    return { n, webPush, shown, deliver, state, stop };
}

it("an unfocused tab leaves the alert to the push once the push is registered", async () => {
    const f = notifier({ active: true, focused: false });
    f.deliver();
    await settle();
    expect(f.shown).toEqual([]);
    f.stop();
});
it("an unfocused tab still alerts in-page when no push is registered", async () => {
    const f = notifier({ active: false, focused: false });
    f.deliver();
    await settle();
    expect(f.shown).toHaveLength(1);
    f.stop();
});
it("a focused tab on another conversation still alerts in-page (the worker stays quiet for it)", async () => {
    const f = notifier({ active: true, focused: true });
    f.deliver();
    await settle();
    expect(f.shown).toHaveLength(1);
    f.stop();
});
it("a stale tab re-reads the shared preference before it syncs push", async () => {
    const f = notifier({ active: false, focused: false });
    await f.n.enable();
    await settle();
    f.webPush.sync.mockClear();
    localStorage.setItem("matron_desktop_notifications_v1", JSON.stringify({ enabled: false }));
    f.state({ connection: "connecting" });
    f.state({ connection: "online" });
    await settle();
    expect(f.webPush.sync).not.toHaveBeenCalledWith(session, true);
    expect(f.webPush.sync).toHaveBeenCalledWith(session, false);
    f.stop();
});
