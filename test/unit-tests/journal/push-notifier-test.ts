/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type LiveListener, MatronJournalClient } from "../../../src/journal/client";
import { DesktopNotifier, notificationTag, type NotificationConstructorLike } from "../../../src/journal/notifications";
import type { ClientState, Session } from "../../../src/journal/types";

const session: Session = {
    serverUrl: "https://example.com",
    token: "alice-token",
    userId: 1,
    deviceId: 1,
    username: "alice",
};
const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};
const stops: (() => void)[] = [];
let originalServiceWorker: PropertyDescriptor | undefined;
beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
});
afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    if (originalServiceWorker) Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
    else Reflect.deleteProperty(navigator, "serviceWorker");
});
function setup(permission: NotificationPermission = "granted", signedIn = true) {
    const client = new MatronJournalClient();
    const internals = client as unknown as { state: ClientState; emit(): void };
    function state(patch: Partial<ClientState> = {}) {
        internals.state = { ...client.getSnapshot(), phase: "signed-in", session, connection: "online", ...patch };
        internals.emit();
    }
    if (signedIn) state();
    const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
    const worker = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
    const focus = jest.spyOn(window, "focus").mockImplementation(() => {});
    const webPush = {
        sync: jest.fn().mockResolvedValue(undefined),
        unregister: jest.fn().mockResolvedValue(undefined),
    };
    const shown: NotificationOptions[] = [];
    class FakeNotification {
        constructor(_title: string, options: NotificationOptions = {}) {
            shown.push(options);
        }
        static permission = permission;
        static requestPermission = jest.fn().mockResolvedValue(permission);
        onclick = null;
        close() {}
    }
    const notifier = new DesktopNotifier(client, {
        Notification: FakeNotification as NotificationConstructorLike,
        webPush,
        window,
        document,
        storage: localStorage,
        channel: () => undefined,
        now: () => 1000,
        api: () => ({
            notifySettings: jest.fn().mockResolvedValue({ mode: "all", events: {}, convos: [], device_level: "all" }),
            updateNotify: jest.fn().mockResolvedValue(null),
            coordinator: jest.fn().mockResolvedValue({ convo_id: null }),
        }),
    });
    const stop = notifier.start();
    stops.push(stop);
    return { notifier, webPush, select, worker, focus, state, stop, shown, client, notification: FakeNotification };
}
it("enabling while signed in and online syncs the enabled snapshot", async () => {
    const f = setup();
    await f.notifier.enable();
    await settle();
    expect(f.webPush.sync).toHaveBeenCalledWith(session, true);
});
it("disabling unregisters the previous registration", async () => {
    const f = setup();
    await f.notifier.enable();
    await settle();
    f.notifier.disable();
    await settle();
    expect(f.webPush.unregister).toHaveBeenCalledWith(session);
});
it("reconnect syncs enabled notifications and sign-out unregisters the old session", async () => {
    const f = setup();
    await f.notifier.enable();
    await settle();
    f.webPush.sync.mockClear();
    f.state({ connection: "connecting" });
    f.state({ connection: "online" });
    await settle();
    expect(f.webPush.sync).toHaveBeenCalledWith(session, true);
    f.state({ phase: "signed-out", session: undefined });
    await settle();
    expect(f.webPush.unregister).toHaveBeenCalledWith(session);
});
it("worker messages focus and select a conversation, and detach removes the listener", async () => {
    const f = setup();
    f.worker.dispatchEvent(new MessageEvent("message", { data: { type: "matron-open-convo", convoId: "c1" } }));
    expect(f.focus).toHaveBeenCalledTimes(1);
    expect(f.select).toHaveBeenCalledWith("c1");
    f.stop();
    f.select.mockClear();
    f.focus.mockClear();
    f.worker.dispatchEvent(new MessageEvent("message", { data: { type: "matron-open-convo", convoId: "c2" } }));
    expect(f.select).not.toHaveBeenCalled();
    expect(f.focus).not.toHaveBeenCalled();
    await settle();
    expect(f.webPush.unregister).toHaveBeenCalledWith(session);
});
it("reads and clears the conversation hash once on first sign-in", async () => {
    window.history.replaceState(null, "", "/#convo=c1");
    const f = setup("granted", false);
    expect(f.select).not.toHaveBeenCalled();
    f.state();
    await settle();
    expect(f.select).toHaveBeenCalledWith("c1");
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "/#convo=c2");
    f.state();
    await settle();
    expect(f.select).toHaveBeenCalledTimes(1);
});
it("denied permission never requests registration, then granted permission enables sync", async () => {
    const f = setup("denied");
    await f.notifier.enable();
    await settle();
    expect(f.webPush.sync.mock.calls.some(([, wanted]) => wanted === true)).toBe(false);
    f.notification.permission = "granted";
    await f.notifier.enable();
    await settle();
    expect(f.webPush.sync).toHaveBeenCalledWith(session, true);
});

it("shares the actual in-page notification tag with the worker contract", async () => {
    const f = setup();
    await f.notifier.enable();
    await settle();
    const internals = f.client as unknown as { emitLive(call: (listener: LiveListener) => void): void };
    internals.emitLive((listener) =>
        listener.journalEvent?.(
            {
                kind: "journal",
                seq: 7,
                convo_id: "c1",
                ts: 1000,
                sender: "agent:1",
                type: "prompt",
                payload: { text: "Needs you" },
            },
            undefined,
        ),
    );
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0].tag).toBe(notificationTag("c1"));
});
