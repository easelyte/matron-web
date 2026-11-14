/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApi, JournalApiError } from "../../../src/journal/api";
import { WebPushRegistrar, type WebPushEnvironment } from "../../../src/journal/web-push";
import type { Session } from "../../../src/journal/types";

const session: Session = {
    serverUrl: "https://example.com",
    token: "alice-token",
    userId: 1,
    deviceId: 1,
    username: "alice",
};
// A deterministic uncompressed P-256 public point, encoded as the journal sends it.
const keyBytes = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
const publicKey = Buffer.from(keyBytes).toString("base64url");
function setup(patch: Partial<WebPushEnvironment> = {}) {
    const body = { endpoint: "https://example.com/push/alice", keys: { p256dh: "key", auth: "auth" } };
    const subscription = {
        endpoint: body.endpoint,
        options: { applicationServerKey: keyBytes.buffer },
        toJSON: jest.fn(() => body),
        unsubscribe: jest.fn().mockResolvedValue(true),
    };
    const pushManager = {
        getSubscription: jest.fn().mockResolvedValue(null),
        subscribe: jest.fn().mockResolvedValue(subscription),
    };
    const register = jest.fn().mockResolvedValue({ pushManager });
    const api = {
        webPushVapidKey: jest.fn().mockResolvedValue({ public_key: publicKey }),
        registerWebPush: jest.fn().mockResolvedValue({ ok: true }),
    };
    const env: WebPushEnvironment = {
        serviceWorker: { register },
        PushManager: {},
        Notification: { permission: "granted" },
        api: () => api,
        scope: "/",
        ...patch,
    };
    return { registrar: new WebPushRegistrar(env), api, register, pushManager, subscription, body, env };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

it.each(["serviceWorker", "PushManager", "Notification"] as const)(
    "ignores unsupported %s and can register on a supported browser",
    async (feature) => {
        const unsupported = setup({ [feature]: undefined });
        await expect(unsupported.registrar.sync(session, true)).resolves.toBeUndefined();
        expect(unsupported.api.webPushVapidKey).not.toHaveBeenCalled();
        expect(unsupported.register).not.toHaveBeenCalled();
        const supported = setup();
        await supported.registrar.sync(session, true);
        expect(supported.api.registerWebPush).toHaveBeenCalledWith(supported.body);
    },
);
it.each(["denied", "default"] as const)("waits for permission %s to become granted", async (permission) => {
    const f = setup({ Notification: { permission } });
    await expect(f.registrar.sync(session, true)).resolves.toBeUndefined();
    expect(f.pushManager.subscribe).not.toHaveBeenCalled();
    expect(f.api.registerWebPush).not.toHaveBeenCalled();
    f.env.Notification!.permission = "granted";
    await f.registrar.sync(session, true);
    expect(f.api.registerWebPush).toHaveBeenCalledWith(f.body);
});
it("remembers a disabled sender for one session and retries for a new token", async () => {
    const f = setup();
    f.api.webPushVapidKey.mockRejectedValueOnce(new JournalApiError("off", 404, "web_push_disabled"));
    await expect(f.registrar.sync(session, true)).resolves.toBeUndefined();
    await f.registrar.sync(session, true);
    expect(f.register).not.toHaveBeenCalled();
    expect(f.api.registerWebPush).not.toHaveBeenCalled();
    expect(f.registrar.lastError).toBeNull();
    expect(f.api.webPushVapidKey).toHaveBeenCalledTimes(1);
    await f.registrar.sync({ ...session, token: "bob-token" }, true);
    expect(f.api.registerWebPush).toHaveBeenCalledWith(f.body);
});
it("registers a worker, decodes the key and posts only endpoint and keys", async () => {
    const f = setup();
    await f.registrar.sync(session, true);
    expect(f.register).toHaveBeenCalledWith("sw.js", { scope: "/" });
    expect(f.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: keyBytes });
    expect(f.api.registerWebPush).toHaveBeenCalledTimes(1);
    expect(f.api.registerWebPush).toHaveBeenCalledWith(f.body);
});
it("posts once per session token and endpoint across repeated syncs", async () => {
    const f = setup();
    await f.registrar.sync(session, true);
    await f.registrar.sync(session, true);
    expect(f.api.registerWebPush).toHaveBeenCalledTimes(1);
    await f.registrar.sync({ ...session, token: "bob-token" }, true);
    expect(f.api.registerWebPush).toHaveBeenCalledTimes(2);
});
it("reuses an existing subscription with the same server key", async () => {
    const f = setup();
    f.pushManager.getSubscription.mockResolvedValue(f.subscription);
    await f.registrar.sync(session, true);
    expect(f.pushManager.subscribe).not.toHaveBeenCalled();
    expect(f.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(f.api.registerWebPush).toHaveBeenCalledWith(f.body);
});
it("replaces an existing subscription with a different server key", async () => {
    const f = setup();
    const previous = {
        ...f.subscription,
        options: { applicationServerKey: new Uint8Array([0]).buffer },
        unsubscribe: jest.fn().mockResolvedValue(true),
    };
    f.pushManager.getSubscription.mockResolvedValue(previous);
    await f.registrar.sync(session, true);
    expect(previous.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: keyBytes });
    expect(f.api.registerWebPush).toHaveBeenCalledWith(f.body);
});
it("turning wanted off unregisters the endpoint and browser subscription", async () => {
    const f = setup();
    await f.registrar.sync(session, true);
    await f.registrar.sync(session, false);
    expect(f.api.registerWebPush).toHaveBeenLastCalledWith({ endpoint: null });
    expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
});
it("explicit unregister is best effort even if the POST fails", async () => {
    const f = setup();
    await f.registrar.sync(session, true);
    f.api.registerWebPush.mockRejectedValue(new Error("offline"));
    await expect(f.registrar.unregister(session)).resolves.toBeUndefined();
    expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.api.registerWebPush).toHaveBeenLastCalledWith({ endpoint: null });
});
it.each(["subscribe", "POST", "worker", "vapid"])("contains %s failures and records a quiet error", async (failure) => {
    const f = setup();
    const error = new Error("push failed");
    if (failure === "subscribe") f.pushManager.subscribe.mockRejectedValue(error);
    if (failure === "POST") f.api.registerWebPush.mockRejectedValue(error);
    if (failure === "worker") f.register.mockRejectedValue(error);
    if (failure === "vapid") f.api.webPushVapidKey.mockRejectedValue(error);
    await expect(f.registrar.sync(session, true)).resolves.toBeUndefined();
    expect(f.registrar.lastError).toEqual(expect.any(String));
    expect(f.registrar.lastError).not.toBe("");
});
it("API methods use the authenticated key and registration routes", async () => {
    const api = new JournalApi(session.serverUrl, session.token);
    const json = jest
        .spyOn(api as unknown as { json(path: string, options?: unknown): Promise<unknown> }, "json")
        .mockResolvedValue({ ok: true });
    await api.webPushVapidKey();
    await api.registerWebPush({ endpoint: null });
    expect(json).toHaveBeenNthCalledWith(1, "/push/web/vapid-key");
    expect(json).toHaveBeenNthCalledWith(2, "/push/web/register", { method: "POST", body: { endpoint: null } });
});
