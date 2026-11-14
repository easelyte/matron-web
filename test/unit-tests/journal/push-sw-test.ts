/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import fixture from "../../fixtures/webpush-payload.json";
import { notificationTag } from "../../../src/journal/notifications";
import {
    parsePushPayload,
    fallbackContent,
    decidePushDisplay,
    buildNotification,
    routeNotificationClick,
    parseConvoHash,
    installPushHandlers,
    type PushContent,
    type ServiceWorkerScopeLike,
    type WorkerEventLike,
} from "../../../src/journal/push-sw";

const content: PushContent = { v: 1, title: "Chat", body: "Needs you", convo_id: "c1", seq: 7, kind: "attention" };
const scopeUrl = "https://example.com/app/";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

it("accepts every field of the sender fixture", () => {
    expect(parsePushPayload(fixture)).toEqual(fixture);
});
it("preserves subtitle and item fields", () => {
    const item = { id: "i1", num: 3, kind: "question", actions: ["reply"], reply_to: "i0" };
    const raw = { ...content, subtitle: "alice", item };
    expect(parsePushPayload(raw)).toEqual(raw);
});
it("rejects malformed and hostile payloads while accepting a valid control", () => {
    const invalid: unknown[] = [
        undefined,
        null,
        [],
        "text",
        42,
        {},
        { ...content, v: 2 },
        { ...content, convo_id: undefined },
        { ...content, convo_id: "" },
        { ...content, convo_id: "x".repeat(129) },
        { ...content, title: 1 },
        { ...content, body: false },
        { ...content, title: "x".repeat(1_000_000) },
        { ...content, body: "x".repeat(1_000_000) },
        { ...content, seq: 1.5 },
        { ...content, seq: Infinity },
        { ...content, seq: NaN },
        { ...content, seq: "1" },
        { ...content, kind: "unknown" },
    ];
    for (const raw of invalid) {
        expect(() => parsePushPayload(raw)).not.toThrow();
        expect(parsePushPayload(raw)).toBeNull();
    }
    expect(parsePushPayload(content)).toEqual(content);
});
it("skips only when a visible focused window covers the push", () => {
    const focused = { visibilityState: "visible", focused: true };
    const hidden = { visibilityState: "hidden", focused: true };
    expect(
        [[], [focused], [{ ...focused, focused: false }], [hidden], [hidden, focused]].map(decidePushDisplay),
    ).toEqual(["show", "skip", "show", "show", "skip"]);
});
it.each(["attention", "done", "activity"] as const)("builds safe options and a shared tag for %s", (kind) => {
    const built = buildNotification({ ...content, kind });
    expect(built).toEqual({
        title: "Chat",
        options: {
            body: "Needs you",
            tag: "matron:c1",
            renotify: kind !== "activity",
            data: { convo_id: "c1", seq: 7 },
        },
    });
    expect(notificationTag("c1")).toBe("matron:c1");
    expect(built.options.tag).toBe(notificationTag("c1"));
    expect(buildNotification(parsePushPayload({ ...content, title: { url: "https://example.com/evil" } }))).toEqual(
        buildNotification(null),
    );
});
it("uses fixed fallback text for missing content and every kind", () => {
    expect(fallbackContent()).toEqual({ title: "Matron", body: "New activity from your agent" });
    expect(fallbackContent("attention").body).toBe("Your agent needs you");
    expect(fallbackContent("done").body).toBe("Your agent finished its turn");
    expect(fallbackContent("activity").body).toBe("New activity from your agent");
    expect(buildNotification(null)).toMatchObject({
        title: "Matron",
        options: { body: "New activity from your agent" },
    });
});
it("focuses a same-scope window, preferring focused then first", () => {
    const windows = [
        { url: scopeUrl, focused: false },
        { url: scopeUrl + "#old", focused: true },
    ];
    expect(routeNotificationClick({ convoId: "c1", windows, scope: scopeUrl })).toEqual({
        action: "focus",
        index: 1,
        message: { type: "matron-open-convo", convoId: "c1" },
    });
    windows[1].focused = false;
    expect(routeNotificationClick({ convoId: "c1", windows, scope: scopeUrl })).toMatchObject({
        action: "focus",
        index: 0,
    });
});
it("opens inside scope, ignores other origins and paths, and round-trips hostile ids", () => {
    const convoId = "/../?#%雪";
    const windows = [
        { url: "https://other.example.com/app/", focused: true },
        { url: "https://example.com/application/", focused: true },
    ];
    const result = routeNotificationClick({ convoId, windows, scope: scopeUrl });
    expect(result).toEqual({ action: "open", url: scopeUrl + "#convo=" + encodeURIComponent(convoId) });
    expect(routeNotificationClick({ convoId, windows: [], scope: scopeUrl })).toEqual(result);
    const url = new URL(result?.action === "open" ? result.url : scopeUrl);
    expect(url.origin + url.pathname).toBe(scopeUrl.slice(0, -1) + "/");
    expect(parseConvoHash(url.hash)).toBe(convoId);
});
it("decodes only bounded conversation hashes", () => {
    for (const hash of ["", "#other=c1", "#convo=%", "#convo=", "#convo=" + "x".repeat(129)])
        expect(parseConvoHash(hash)).toBeNull();
    expect(parseConvoHash("#convo=c1")).toBe("c1");
});

function worker() {
    const listeners = new Map<string, (event: WorkerEventLike) => void>();
    const win = {
        url: scopeUrl,
        focused: false,
        visibilityState: "hidden",
        focus: jest.fn().mockResolvedValue(undefined),
        postMessage: jest.fn(),
    };
    const scope = {
        registration: { scope: scopeUrl, showNotification: jest.fn().mockResolvedValue(undefined) },
        clients: {
            matchAll: jest.fn().mockResolvedValue([win]),
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
        listeners.get(type)?.({
            ...fields,
            waitUntil: (promise) => {
                pending.push(promise);
            },
        });
        await Promise.all(pending);
    }
    return { scope, win, listeners, fire };
}
it("a valid push shows exactly one built notification", async () => {
    const { scope, fire } = worker();
    await fire("push", { data: { json: () => content } });
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1);
    const built = buildNotification(content);
    expect(scope.registration.showNotification).toHaveBeenCalledWith(built.title, built.options);
});
it.each(["invalid JSON", "missing data"])("shows fallback for %s", async (mode) => {
    const { scope, fire } = worker();
    await fire("push", {
        data:
            mode === "missing data"
                ? null
                : {
                      json: () => {
                          throw new Error("invalid JSON");
                      },
                  },
    });
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(scope.registration.showNotification).toHaveBeenCalledWith(
        "Matron",
        expect.objectContaining({ body: "New activity from your agent" }),
    );
});
it("suppresses covered pushes and resumes after focus is lost", async () => {
    const { scope, win, fire } = worker();
    win.focused = true;
    win.visibilityState = "visible";
    await fire("push", { data: { json: () => content } });
    expect(scope.registration.showNotification).not.toHaveBeenCalled();
    win.focused = false;
    await fire("push", { data: { json: () => content } });
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1);
});
it("contains display failures without rejecting the event lifetime", async () => {
    const { scope, fire } = worker();
    scope.registration.showNotification.mockRejectedValue(new Error("display failed"));
    await expect(fire("push", { data: { json: () => content } })).resolves.toBeUndefined();
    expect(scope.registration.showNotification).toHaveBeenCalled();
});
it("a failed window lookup still shows fallback", async () => {
    const { scope, fire } = worker();
    scope.clients.matchAll.mockRejectedValue(new Error("lookup failed"));
    await expect(fire("push", { data: { json: () => content } })).resolves.toBeUndefined();
    expect(scope.registration.showNotification).toHaveBeenCalledWith(
        "Matron",
        expect.objectContaining({ body: "New activity from your agent" }),
    );
});
it("click closes, focuses and posts to the existing window", async () => {
    const { win, fire } = worker();
    const close = jest.fn();
    await fire("notificationclick", { notification: { data: { convo_id: "c1" }, close } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.postMessage).toHaveBeenCalledWith({ type: "matron-open-convo", convoId: "c1" });
});
it("click opens a window when there are none", async () => {
    const { scope, fire } = worker();
    scope.clients.matchAll.mockResolvedValue([]);
    const close = jest.fn();
    await fire("notificationclick", { notification: { data: { convo_id: "c1" }, close } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(scope.clients.openWindow).toHaveBeenCalledWith(scopeUrl + "#convo=c1");
});
it("installs and activates immediately without fetch or caching handlers", async () => {
    const { scope, listeners, fire } = worker();
    await fire("install");
    await fire("activate");
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1);
    expect(scope.clients.claim).toHaveBeenCalledTimes(1);
    expect([...listeners.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push"]);
});
