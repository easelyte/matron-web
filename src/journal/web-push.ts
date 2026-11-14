/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApi, JournalApiError } from "./api";
import type { Session } from "./types";

export interface WebPushSubscriptionLike {
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer | null };
    toJSON(): { endpoint?: string; keys?: Record<string, string> };
    unsubscribe(): Promise<boolean>;
}
export interface WebPushEnvironment {
    serviceWorker?: {
        /** The page's existing registration, if any: it may hold a subscription an earlier page made. */
        getRegistration?(): Promise<{ pushManager: { getSubscription(): Promise<WebPushSubscriptionLike | null> } } | undefined>;
        register(
            url: string,
            options: { scope: string },
        ): Promise<{
            pushManager: {
                getSubscription(): Promise<WebPushSubscriptionLike | null>;
                subscribe(options: {
                    userVisibleOnly: boolean;
                    applicationServerKey: Uint8Array<ArrayBuffer>;
                }): Promise<WebPushSubscriptionLike>;
            };
        }>;
    };
    PushManager?: unknown;
    Notification?: { permission: NotificationPermission };
    api(session: Session): {
        webPushVapidKey(): Promise<unknown>;
        registerWebPush(body: Record<string, unknown>): Promise<unknown>;
    };
    scope: string;
}
/**
 * The worker's scope for a build's public path, or null when the assets are served from another
 * origin: a worker script and its scope must be on the page's own origin, so push is then off.
 */
export function pushScope(publicPath: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(publicPath)) return null;
    return ("/" + publicPath.replace(/^\/+/, "")).replace(/\/*$/, "/");
}

function defaultEnvironment(): WebPushEnvironment {
    const scope = pushScope(process.env.PUBLIC_PATH || "/");
    return {
        serviceWorker:
            typeof navigator === "undefined" || !navigator.serviceWorker || scope === null
                ? undefined
                : {
                      getRegistration: () => navigator.serviceWorker.getRegistration(scope),
                      // Resolve against the app scope even when the page is on a nested route.
                      register: (url, options) =>
                          navigator.serviceWorker.register(
                              new URL(url, new URL(options.scope, location.href)).href,
                              options,
                          ),
                  },
        PushManager: typeof PushManager === "undefined" ? undefined : PushManager,
        Notification: typeof Notification === "undefined" ? undefined : Notification,
        api: (session) => new JournalApi(session.serverUrl, session.token),
        scope: scope ?? "/",
    };
}

function sessionKey(session: Session): string {
    return JSON.stringify([session.serverUrl, session.token]);
}

export class WebPushRegistrar {
    public lastError: string | null = null;
    private readonly env: WebPushEnvironment;
    private readonly off = new Set<string>();
    private readonly posted = new Map<string, string>();
    private subscription: WebPushSubscriptionLike | null = null;
    private pending: Promise<void> = Promise.resolve();

    public constructor(env: WebPushEnvironment = defaultEnvironment()) {
        this.env = env;
    }

    // Serialize browser subscription changes with sign-out and preference changes.
    private enqueue(work: () => Promise<void>): Promise<void> {
        this.pending = this.pending.then(async () => {
            try {
                this.lastError = null;
                await work();
            } catch (error) {
                this.lastError = error instanceof Error ? error.message : "Web Push unavailable";
            }
        });
        return this.pending;
    }

    /** Whether this page has registered a subscription for the session (the journal covers it). */
    public active(session: Session): boolean {
        return this.posted.has(sessionKey(session));
    }

    /** The browser's own subscription, which outlives a page: an earlier page may have made it. */
    private async existing(): Promise<WebPushSubscriptionLike | null> {
        if (this.subscription) return this.subscription;
        try {
            const registration = await this.env.serviceWorker?.getRegistration?.();
            return (await registration?.pushManager.getSubscription()) ?? null;
        } catch {
            return null;
        }
    }

    public sync(session: Session, wanted: boolean): Promise<void> {
        return this.enqueue(async () => {
            const key = sessionKey(session);
            const env = this.env;
            if (!wanted || !env.serviceWorker || !env.PushManager || env.Notification?.permission !== "granted") {
                if (this.posted.has(key) || (await this.existing())) await this.remove(session);
                return;
            }
            if (this.off.has(key)) return;
            let raw: unknown;
            try {
                raw = await env.api(session).webPushVapidKey();
            } catch (error) {
                if (error instanceof JournalApiError && error.status === 404) {
                    this.off.add(key);
                    return;
                }
                throw error;
            }
            const publicKey = (raw as { public_key?: unknown } | null)?.public_key;
            if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(publicKey))
                throw new Error("Invalid Web Push key");
            const encoded = publicKey.replace(/-/g, "+").replace(/_/g, "/");
            const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), (c) =>
                c.charCodeAt(0),
            );
            if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid Web Push key");
            const workerUrl = env.scope === "/" ? "sw.js" : env.scope.replace(/\/*$/, "/") + "sw.js";
            const registration = await env.serviceWorker.register(workerUrl, { scope: env.scope });
            let subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                const old = subscription.options.applicationServerKey;
                if (!old || old.byteLength !== bytes.length || !new Uint8Array(old).every((b, i) => b === bytes[i])) {
                    await subscription.unsubscribe();
                    subscription = null;
                }
            }
            subscription ??= await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: bytes,
            });
            this.subscription = subscription;
            if (this.posted.get(key) === subscription.endpoint) return;
            const body = subscription.toJSON();
            await env.api(session).registerWebPush({ endpoint: body.endpoint, keys: body.keys });
            this.posted.set(key, subscription.endpoint);
        });
    }

    private async remove(session: Session): Promise<void> {
        const subscription = await this.existing();
        this.subscription = null;
        this.posted.delete(sessionKey(session));
        try {
            await this.env.api(session).registerWebPush({ endpoint: null });
        } finally {
            if (subscription) await subscription.unsubscribe();
        }
    }

    public unregister(session: Session): Promise<void> {
        return this.enqueue(() => this.remove(session));
    }
}
